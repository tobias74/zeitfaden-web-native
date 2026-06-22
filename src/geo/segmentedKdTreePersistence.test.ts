import { describe, expect, it } from 'vitest'
import { SegmentedKdTreeGeoIndex } from './segmentedKdTreeGeoIndex'
import {
  createSegmentedKdTreeManifest,
  decodeSegmentedKdTreeSnapshot,
  encodeSegmentedKdTreeSnapshot,
  validateSegmentedKdTreeManifest,
} from './segmentedKdTreePersistence'
import { sha256Hex } from './dynamicZOrderPersistence'
import type { GeoIndexPoint, GeoSearchQuery } from '../types'

const points: GeoIndexPoint[] = [
  { mediaId: 'a', kind: 'geo_point', lat: 48.1, lon: 11.5, timestamp: 1_000 },
  { mediaId: 'b', kind: 'image', lat: 48.2, lon: 11.6, timestamp: 2_000 },
  { mediaId: 'c', kind: 'video', lat: 49, lon: 12, timestamp: 3_000 },
  { mediaId: 'd', kind: 'geo_point', lat: 47.9, lon: 11.2, timestamp: 4_000 },
]

const query: GeoSearchQuery = {
  lat: 48.15,
  lon: 11.55,
  k: 10,
}

describe('segmented KD-tree persistence', () => {
  it('round-trips a snapshot and preserves search order', async () => {
    const fresh = new SegmentedKdTreeGeoIndex({ leafSize: 2 })
    await fresh.build(points)
    const expected = await fresh.search(query)

    const encoded = encodeSegmentedKdTreeSnapshot(fresh.snapshot())
    const restored = new SegmentedKdTreeGeoIndex({ leafSize: 2 })
    restored.restore(decodeSegmentedKdTreeSnapshot(encoded))

    expect(await restored.search(query)).toEqual(expected)
  })

  it('rejects a manifest with the wrong catalog epoch', async () => {
    const index = new SegmentedKdTreeGeoIndex({ leafSize: 2 })
    await index.build(points)
    const encoded = encodeSegmentedKdTreeSnapshot(index.snapshot())
    const manifest = createSegmentedKdTreeManifest(
      index.snapshot(),
      7,
      await sha256Hex(encoded),
    )

    expect(() => validateSegmentedKdTreeManifest(manifest, 8)).toThrow(
      /does not match/,
    )
  })

  it('rejects corrupt binary snapshot data', async () => {
    const index = new SegmentedKdTreeGeoIndex({ leafSize: 2 })
    await index.build(points)
    const encoded = new Uint8Array(
      encodeSegmentedKdTreeSnapshot(index.snapshot()),
    )
    encoded[0] = 0

    expect(() => decodeSegmentedKdTreeSnapshot(encoded.buffer)).toThrow(
      /invalid header/,
    )
  })
})
