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
  it('normalizes identity with 9 coordinate decimals and epoch milliseconds', () => {
    const timestamp = Date.parse('2026-06-21T10:15:30.123Z')

    expect(geoPointIdentityInput(48.1234567894, 11.9876543214, timestamp)).toBe(
      'geo_point:v1:48.123456789:11.987654321:1782036930123',
    )

    expect(geoPointContentHash(48.1234567894, 11.9876543214, timestamp)).toBe(
      'geo_point:v1:48.123456789:11.987654321:1782036930123',
    )
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
        timestamp: Date.parse('2026-06-21T10:00:00Z'),
      },
      {
        index: 4,
        latitude: 48.3,
        longitude: 11.7,
        timestamp: Date.parse('2026-06-21T10:02:00Z'),
      },
      {
        index: 5,
        latitude: 48.4,
        longitude: 11.8,
        timestamp: Date.parse('2026-06-21T10:03:00Z'),
      },
    ])
  })

  it('parses GPX without DOMParser so it can run in workers', () => {
    vi.stubGlobal('DOMParser', undefined)

    try {
      const result = parseGpxPoints(`
        <gpx>
          <wpt lat="48.4" lon="11.8"><time>2026-06-21T10:03:00Z</time></wpt>
        </gpx>
      `)

      expect(result.points).toEqual([
        {
          index: 1,
          latitude: 48.4,
          longitude: 11.8,
          timestamp: Date.parse('2026-06-21T10:03:00Z'),
        },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
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
    expect(result.points).toMatchObject([
      {
        index: 1,
        kind: 'geo_point',
        latitude: 48.1370673,
        longitude: 11.5775995,
        accuracyMeters: 540,
        sourceDataset: 'google_records',
        sourceType: 'CELL',
        timestamp: Date.parse('2012-10-28T14:21:22.010Z'),
      },
      {
        index: 2,
        kind: 'geo_point',
        latitude: 48.1374628,
        longitude: 11.5781587,
        accuracyMeters: 22,
        sourceDataset: 'google_records',
        sourceType: 'CELL',
        metadata: {
          activity: [
            {
              activity: [{ type: 'STILL', confidence: 100 }],
              timestamp: '2012-10-28T14:21:46.568Z',
            },
          ],
        },
        timestamp: Date.parse('2012-10-28T14:22:24.784Z'),
      },
      {
        index: 4,
        kind: 'geo_point',
        latitude: 48.1374628,
        longitude: 11.5781587,
        sourceDataset: 'google_records',
        timestamp: 1_351_434_205_077,
      },
      {
        index: 5,
        kind: 'geo_point',
        latitude: 48.1374629,
        longitude: 11.5781588,
        sourceDataset: 'google_records',
        timestamp: 1_351_434_206_077,
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

    expect(() =>
      parseGeoFilePoints(
        '2024_JANUARY.json',
        JSON.stringify({ timelineObjects: [{ placeVisit: {} }] }),
      ),
    ).toThrow('Google Semantic Location History')
  })

  it('parses Google Timeline semantic JSON', () => {
    const result = parseGeoFilePoints(
      'Zeitachse.json',
      JSON.stringify({
        semanticSegments: [
          {
            startTime: '2026-06-01T10:00:00.000+02:00',
            endTime: '2026-06-01T11:00:00.000+02:00',
            timelinePath: [
              {
                point: '48.1370673°, 11.5775995°',
                time: '2026-06-01T10:10:00.000+02:00',
              },
            ],
            visit: {
              hierarchyLevel: 0,
              probability: 0.9,
              topCandidate: {
                placeId: 'place-1',
                semanticType: 'UNKNOWN',
                probability: 0.8,
                placeLocation: { latLng: '48.1370673°, 11.5775995°' },
              },
            },
            activity: {
              distanceMeters: 1234,
              start: { latLng: '48.1370673°, 11.5775995°' },
              end: { latLng: '48.2°, 11.6°' },
              topCandidate: { type: 'WALKING', probability: 0.75 },
            },
          },
        ],
        rawSignals: [
          {
            position: {
              latitudeE7: 482000000,
              longitudeE7: 116000000,
              accuracy: 12,
              altitude: 366,
              verticalAccuracy: 2,
              velocity: 3.5,
              heading: 80,
              source: 'GPS',
              timestamp: '2026-06-01T12:00:00.000+02:00',
            },
          },
          {
            activityRecord: {
              timestamp: '2026-06-01T12:05:00.000+02:00',
              probableActivities: [{ type: 'STILL', probability: 0.9 }],
            },
          },
          {
            wifiScan: {
              deliveryTime: '2026-06-01T12:00:00.000+02:00',
              devicesRecords: [{ mac: 1, rawRssi: -50 }],
            },
          },
        ],
        userLocationProfile: {
          frequentPlaces: [
            {
              placeId: 'home',
              label: 'HOME',
              placeLocation: { latLng: '48.3°, 11.7°' },
            },
          ],
        },
      }),
    )

    expect(result.points).toHaveLength(2)
    const items = result.items ?? []
    expect(items).toMatchObject([
      {
        kind: 'geo_point',
        sourceDataset: 'google_timeline_raw_signals',
        sourceType: 'GPS',
        accuracyMeters: 12,
        altitudeMeters: 366,
        verticalAccuracyMeters: 2,
        velocityMetersPerSecond: 3.5,
        headingDegrees: 80,
      },
      {
        kind: 'activity_sample',
        sourceType: 'activity_record',
      },
      {
        kind: 'geo_point',
        sourceDataset: 'google_timeline',
        sourceType: 'timeline_path',
      },
      {
        kind: 'timeline_visit',
        sourceType: 'visit',
        endTimestamp: Date.parse('2026-06-01T11:00:00.000+02:00'),
      },
      {
        kind: 'timeline_activity',
        sourceType: 'activity',
        endTimestamp: Date.parse('2026-06-01T11:00:00.000+02:00'),
        metadata: {
          distanceMeters: 1234,
          activityType: 'WALKING',
        },
      },
      {
        kind: 'frequent_place',
        sourceType: 'frequent_place',
      },
    ])
    expect(items[2].groupId).toBeUndefined()
    expect(items[2].sequence).toBeUndefined()
    expect(items[3].groupId).toBeUndefined()
    expect(items[4].groupId).toBeUndefined()
  })

  it('only assigns timeline path group ids to real multi-point paths', () => {
    const result = parseGeoFilePoints(
      'Zeitachse.json',
      JSON.stringify({
        semanticSegments: [
          {
            startTime: '2026-06-01T10:00:00.000+02:00',
            endTime: '2026-06-01T11:00:00.000+02:00',
            timelinePath: [
              {
                point: '48.1370673°, 11.5775995°',
                time: '2026-06-01T10:10:00.000+02:00',
              },
            ],
          },
          {
            startTime: '2026-06-01T12:00:00.000+02:00',
            endTime: '2026-06-01T13:00:00.000+02:00',
            timelinePath: [
              {
                point: '48.2000000°, 11.6000000°',
                time: '2026-06-01T12:10:00.000+02:00',
              },
              {
                point: '48.2100000°, 11.6100000°',
                time: '2026-06-01T12:20:00.000+02:00',
              },
            ],
          },
        ],
      }),
    )

    const items = result.items ?? []
    const singleton = items[0]
    const grouped = items.slice(1)
    expect(singleton).toMatchObject({
      kind: 'geo_point',
      sourceType: 'timeline_path',
    })
    expect(singleton.groupId).toBeUndefined()
    expect(singleton.sequence).toBeUndefined()
    expect(grouped).toHaveLength(2)
    expect(grouped[0].groupId).toBe(grouped[1].groupId)
    expect(grouped[0].groupId).toMatch(/^google_timeline_segment:v1:2:/)
    expect(grouped.map((item) => item.sequence)).toEqual([0, 1])
  })

  it('rejects files whose geo format cannot be detected', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() => parseGeoFilePoints('notes.txt', 'plain text')).toThrow(
      'not a supported geo import format',
    )

    logSpy.mockRestore()
  })
})
