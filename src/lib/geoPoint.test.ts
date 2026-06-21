import { describe, expect, it } from 'vitest'
import {
  geoPointContentHash,
  geoPointIdentityInput,
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
})
