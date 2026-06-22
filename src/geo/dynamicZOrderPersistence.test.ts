import { describe, expect, it } from 'vitest'
import { DynamicZOrderGeoIndex } from './dynamicZOrderGeoIndex'
import {
  createDynamicZOrderManifest,
  decodeDynamicZOrderSnapshot,
  encodeDynamicZOrderSnapshot,
  sha256Hex,
  validateDynamicZOrderManifest,
} from './dynamicZOrderPersistence'
import type { GeoIndexPoint, GeoSearchQuery } from '../types'

const points: GeoIndexPoint[] = [
  {
    mediaId: 'a',
    kind: 'geo_point',
    lat: 48.1,
    lon: 11.5,
    timestamp: 1_000,
  },
  {
    mediaId: 'b',
    kind: 'image',
    lat: 48.2,
    lon: 11.6,
    timestamp: 2_000,
  },
  {
    mediaId: 'c',
    kind: 'video',
    lat: 49,
    lon: 12,
    timestamp: 3_000,
  },
]

const query: GeoSearchQuery = {
  lat: 48.15,
  lon: 11.55,
  k: 10,
}

describe('dynamic Z-order persistence', () => {
  it('round-trips a snapshot and preserves search order', async () => {
    const fresh = new DynamicZOrderGeoIndex()
    await fresh.build(points)
    const expected = await fresh.search(query)

    const encoded = encodeDynamicZOrderSnapshot(fresh.snapshot())
    const restored = new DynamicZOrderGeoIndex()
    restored.restore(decodeDynamicZOrderSnapshot(encoded))

    expect(await restored.search(query)).toEqual(expected)
  })

  it('rejects a manifest with the wrong catalog epoch', async () => {
    const index = new DynamicZOrderGeoIndex()
    await index.build(points)
    const encoded = encodeDynamicZOrderSnapshot(index.snapshot())
    const manifest = createDynamicZOrderManifest(
      index.snapshot(),
      7,
      await sha256Hex(encoded),
    )

    expect(() => validateDynamicZOrderManifest(manifest, 8)).toThrow(
      /does not match/,
    )
  })

  it('rejects corrupt binary snapshot data', async () => {
    const index = new DynamicZOrderGeoIndex()
    await index.build(points)
    const encoded = new Uint8Array(encodeDynamicZOrderSnapshot(index.snapshot()))
    encoded[0] = 0

    expect(() => decodeDynamicZOrderSnapshot(encoded.buffer)).toThrow(
      /invalid header/,
    )
  })
})
