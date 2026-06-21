import { describe, expect, it, vi } from 'vitest'
import {
  detectGeoFileFormat,
  geoPointContentHash,
  geoPointIdentityInput,
  parseGeoFilePoints,
  parseGoogleTakeoutLocationPoints,
  parseGpxPoints,
} from './geoPoint'

describe('geo point helpers', () => {
  it('normalizes identity with 9 coordinate decimals and epoch milliseconds', async () => {
    const capturedAt = Date.parse('2026-06-21T10:15:30.123Z')

    expect(geoPointIdentityInput(48.1234567894, 11.9876543214, capturedAt)).toBe(
      'geo_point:v1\n48.123456789\n11.987654321\n1782036930123',
    )

    await expect(
      geoPointContentHash(48.1234567894, 11.9876543214, capturedAt),
    ).resolves.toMatch(/^[a-f0-9]{64}$/)
  })

  it('parses timed GPX track, route, and waypoint entries only', () => {
    const result = parseGpxPoints(`
      <gpx>
        <trk><trkseg>
          <trkpt lat="48.1" lon="11.5"><time>2026-06-21T10:00:00Z</time></trkpt>
          <trkpt lat="91" lon="11.5"><time>2026-06-21T10:01:00Z</time></trkpt>
          <trkpt lat="48.2" lon="11.6"></trkpt>
        </trkseg></trk>
        <rte><rtept lat="48.3" lon="11.7"><time>2026-06-21T10:02:00Z</time></rtept></rte>
        <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
      </gpx>
    `)

    expect(result.skippedPoints).toBe(2)
    expect(result.points).toEqual([
      {
        index: 1,
        latitude: 48.1,
        longitude: 11.5,
        capturedAt: Date.parse('2026-06-21T10:00:00Z'),
      },
      {
        index: 4,
        latitude: 48.3,
        longitude: 11.7,
        capturedAt: Date.parse('2026-06-21T10:02:00Z'),
      },
      {
        index: 5,
        latitude: 48.4,
        longitude: 11.8,
        capturedAt: Date.parse('2026-06-21T10:03:00Z'),
      },
    ])
  })

  it('parses Google Takeout location JSON entries', () => {
    const result = parseGoogleTakeoutLocationPoints(
      JSON.stringify({
        locations: [
          {
            latitudeE7: 481370673,
            longitudeE7: 115775995,
            accuracy: 540,
            source: 'CELL',
            timestamp: '2012-10-28T14:21:22.010Z',
          },
          {
            latitudeE7: 481374628,
            longitudeE7: 115781587,
            accuracy: 22,
            activity: [
              {
                activity: [{ type: 'STILL', confidence: 100 }],
                timestamp: '2012-10-28T14:21:46.568Z',
              },
            ],
            source: 'CELL',
            timestamp: '2012-10-28T14:22:24.784Z',
          },
          {
            latitudeE7: 481374628,
            longitudeE7: 115781587,
          },
          {
            latitudeE7: '481374628',
            longitudeE7: '115781587',
            timestampMs: '1351434205077',
          },
          {
            latitudeE7: '481374629',
            longitudeE7: '115781588',
            timestampMS: '1351434206077',
          },
        ],
      }),
    )

    expect(result.mimeType).toBe('application/json')
    expect(result.skippedPoints).toBe(1)
    expect(result.points).toEqual([
      {
        index: 1,
        latitude: 48.1370673,
        longitude: 11.5775995,
        capturedAt: Date.parse('2012-10-28T14:21:22.010Z'),
      },
      {
        index: 2,
        latitude: 48.1374628,
        longitude: 11.5781587,
        capturedAt: Date.parse('2012-10-28T14:22:24.784Z'),
      },
      {
        index: 4,
        latitude: 48.1374628,
        longitude: 11.5781587,
        capturedAt: 1_351_434_205_077,
      },
      {
        index: 5,
        latitude: 48.1374629,
        longitude: 11.5781588,
        capturedAt: 1_351_434_206_077,
      },
    ])
  })

  it('selects the JSON parser for imported geo JSON files', () => {
    const result = parseGeoFilePoints(
      'Records.gpx',
      JSON.stringify({
        locations: [
          {
            latitudeE7: 481370673,
            longitudeE7: 115775995,
            timestamp: '2012-10-28T14:21:22.010Z',
          },
        ],
      }),
    )

    expect(result.mimeType).toBe('application/json')
    expect(result.points).toHaveLength(1)
  })

  it('detects GPX content without relying on the file extension', () => {
    const gpx = `
      <gpx>
        <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
      </gpx>
    `

    expect(detectGeoFileFormat('track.json', gpx)).toBe('gpx')
    expect(parseGeoFilePoints('track.json', gpx).points).toHaveLength(1)
  })

  it('rejects unsupported JSON geo formats with a clear error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() =>
      parseGeoFilePoints(
        'places.geojson',
        JSON.stringify({
          type: 'FeatureCollection',
          features: [],
        }),
      ),
    ).toThrow('GeoJSON files are not supported yet')

    expect(() =>
      parseGeoFilePoints('unknown.json', JSON.stringify({ items: [] })),
    ).toThrow('not a supported geo import format')

    expect(logSpy).toHaveBeenCalledWith(
      '[geo-import]',
      expect.objectContaining({
        fileName: 'unknown.json',
        reason: 'unsupported JSON geo format',
        topLevelKeys: ['items'],
      }),
    )

    logSpy.mockRestore()
  })

  it('identifies Google Semantic Location History JSON as valid but unsupported', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() =>
      parseGeoFilePoints(
        '2024_JANUARY.json',
        JSON.stringify({
          timelineObjects: [{ placeVisit: {} }],
        }),
      ),
    ).toThrow('Google Semantic Location History')

    expect(logSpy).toHaveBeenCalledWith(
      '[geo-import]',
      expect.objectContaining({
        fileName: '2024_JANUARY.json',
        reason: 'Google Semantic Location History is not supported yet',
        timelineObjectsCount: 1,
        firstTimelineObjectKeys: ['placeVisit'],
      }),
    )

    logSpy.mockRestore()
  })

  it('rejects files whose geo format cannot be detected', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() => parseGeoFilePoints('notes.txt', 'plain text')).toThrow(
      'not a supported geo import format',
    )

    logSpy.mockRestore()
  })
})
