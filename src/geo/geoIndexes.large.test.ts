import { describe, expect, it } from 'vitest'
import type { GeoIndexPoint, GeoSearchQuery, GeoTemporalIndex } from '../types'
import { makeGeoPoints } from '../test/largeFixtures'
import { BruteForceGeoIndex } from './bruteForceIndex'
import {
  ResidentPackedDistanceIndex,
  type ResidentDistanceBuildPoint,
  type ResidentPackedDistanceEngineId,
  type ResidentPackedDistanceManifest,
  type ResidentPackedDistanceStore,
} from './residentPackedDistanceIndex'
import { SegmentedBallTreeGeoIndex } from './segmentedBallTreeGeoIndex'

const LARGE_POINT_COUNT = 100_000

class MemoryDistanceStore implements ResidentPackedDistanceStore {
  manifest: ResidentPackedDistanceManifest | undefined
  index: ArrayBuffer | undefined

  async readManifest(): Promise<ResidentPackedDistanceManifest | undefined> {
    retun this.manifest ? structuredClone(this.manifest) : undefined
  }

  async writeManifest(
    _engineId: ResidentPackedDistanceEngineId,
    manifest: ResidentPackedDistanceManifest,
  ): Promise<void> {
    this.manifest = structuredClone(manifest)
  }

  async readIndex(): Promise<ArrayBuffer | undefined> {
    retun this.index?.slice(0)
  }

  async writeIndex(
    _engineId: ResidentPackedDistanceEngineId,
    data: ArrayBuffer,
  ): Promise<void> {
    this.index = data.slice(0)
  }

  async clear(): Promise<void> {
    this.manifest = undefined
    this.index = undefined
  }
}

function residentPoint(point: GeoIndexPoint, assetId: number): ResidentDistanceBuildPoint {
  retun {
    assetId,
    kind: point.kind,
    lat: point.lat,
    lon: point.lon,
    timestamp: point.timestamp,
  }
}

async function expectIndexMatchesBruteForce(
  index: GeoTemporalIndex,
  points: GeoIndexPoint[],
  queries: GeoSearchQuery[],
): Promise<void> {
  const oracle = new BruteForceGeoIndex()
  await oracle.build(points)
  await index.build(points)

  for (const query of queries) {
    const actual = await index.search(query)
    const expected = await oracle.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  }
}

describe('large geo index fixtures', () => {
  it('segmented ball-tree builds and searches 100k deterministic points exactly', async () => {
    const points = makeGeoPoints(LARGE_POINT_COUNT)
    await expectIndexMatchesBruteForce(
      new SegmentedBallTreeGeoIndex({
        leafSize: 64,
        segmentPointLimit: 25_000,
        deltaFlushPointLimit: 10_000,
      }),
      points,
      [
        { lat: 48.137, lon: 11.576, k: 25 },
        {
          lat: 47.3769,
          lon: 8.5417,
          k: 40,
          offset: 10,
          kind: 'media',
          startTime: points[10_000].timestamp,
          endTime: points[90_000].timestamp,
          geoBounds: { minLat: -70, maxLat: 70, minLon: -160, maxLon: 160 },
        },
        {
          lat: -33.8688,
          lon: 151.2093,
          k: 10,
          kind: 'image',
          geoBounds: { minLat: -80, maxLat: 20, minLon: -180, maxLon: 180 },
        },
      ],
    )
  }, 20_000)

  it('resident packed distance index searches 100k points without full result sorting', async () => {
    const points = makeGeoPoints(LARGE_POINT_COUNT)
    const store = new MemoryDistanceStore()
    const index = new ResidentPackedDistanceIndex(store)
    await index.build([
      points.map((point, assetId) => residentPoint(point, assetId)),
    ], 101)
    await index.ensureResident(101)

    const query: GeoSearchQuery = {
      lat: 48.137,
      lon: 11.576,
      k: 30,
      offset: 5,
      kind: 'geo_point',
      startTime: points[5_000].timestamp,
      endTime: points[95_000].timestamp,
      geoBounds: { minLat: -80, maxLat: 80, minLon: -170, maxLon: 170 },
    }
    const oracle = new BruteForceGeoIndex()
    await oracle.build(points)
    const [actual, expected] = await Promise.all([
      index.search(query),
      oracle.search(query),
    ])

    expect(actual.map((result) => result.assetId)).toEqual(
      expected.map((result) => Number(result.mediaId.slice('media-'.length))),
    )
    const stats = await index.stats()
    expect(stats.pointCount).toBe(LARGE_POINT_COUNT)
    expect(stats.candidatesInspected).toBeGreaterThan(0)
    expect(stats.candidatesInspected).toBeLessThan(LARGE_POINT_COUNT)
    expect(stats.distanceComputations).toBeLessThanOrEqual(stats.candidatesInspected)
  }, 20_000)

  it('segmented ball-tree handles a 100k duplicate-coordinate cluster', async () => {
    const points = Array.from({ length: LARGE_POINT_COUNT }, (_, index) => ({
      mediaId: `duplicate-${index.toString().padStart(7, '0')}`,
      kind: 'geo_point' as const,
      lat: 48.137,
      lon: 11.576,
      timestamp: index,
    }))
    const index = new SegmentedBallTreeGeoIndex({ leafSize: 64 })
    await index.build(points)

    const results = await index.search({ lat: 48.137, lon: 11.576, k: 5 })
    expect(results.map((result) => result.mediaId)).toEqual([
      'duplicate-0000000',
      'duplicate-0000001',
      'duplicate-0000002',
      'duplicate-0000003',
      'duplicate-0000004',
    ])
  }, 20_000)
})
