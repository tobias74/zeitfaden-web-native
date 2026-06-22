import { describe, expect, it } from 'vitest'
import type { GeoIndexPoint, GeoSearchQuery, GeoTemporalIndex } from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'
import { DynamicZOrderGeoIndex } from './dynamicZOrderGeoIndex'
import { GeoIndexRegistry } from './registry'
import { SegmentedBallTreeGeoIndex } from './segmentedBallTreeGeoIndex'
import {
  decodeSegmentedBallTreeSnapshot,
  encodeSegmentedBallTreeSnapshot,
} from './segmentedBallTreePersistence'
import { SegmentedKdTreeGeoIndex } from './segmentedKdTreeGeoIndex'

const points: GeoIndexPoint[] = [
  { mediaId: 'zurich-a', lat: 47.3769, lon: 8.5417, timestamp: 100 },
  { mediaId: 'zurich-b', lat: 47.3769, lon: 8.5417, timestamp: 200 },
  { mediaId: 'basel', lat: 47.5596, lon: 7.5886, timestamp: 300 },
  { mediaId: 'munich', lat: 48.1351, lon: 11.582, timestamp: 400 },
  { mediaId: 'dateline-east', lat: 0, lon: 179.9, timestamp: 500 },
  { mediaId: 'dateline-west', lat: 0, lon: -179.9, timestamp: 600 },
  { mediaId: 'north-pole', lat: 89.9, lon: 15, timestamp: 700 },
  { mediaId: 'missing-time', lat: 45.4408, lon: 12.3155 },
]

async function expectMatchesBruteForce(
  index: GeoTemporalIndex,
  query: GeoSearchQuery,
) {
  const oracle = new BruteForceGeoIndex()
  await oracle.build(points)
  await index.build(points)

  const actual = await index.search(query)
  const expected = await oracle.search(query)

  expect(actual.map((result) => result.mediaId)).toEqual(
    expected.map((result) => result.mediaId),
  )
}

describe('geo indexes', () => {
  it('brute force returns deterministic duplicate-coordinate ordering', async () => {
    const index = new BruteForceGeoIndex()
    await index.build(points)
    const results = await index.search({ lat: 47.3769, lon: 8.5417, k: 2 })
    expect(results.map((result) => result.mediaId)).toEqual([
      'zurich-a',
      'zurich-b',
    ])
  })

  it('brute force excludes missing timestamps when a timeframe is active', async () => {
    const index = new BruteForceGeoIndex()
    await index.build(points)
    const results = await index.search({
      lat: 45.4408,
      lon: 12.3155,
      startTime: 0,
      endTime: 1_000,
      k: 10,
    })
    expect(results.map((result) => result.mediaId)).not.toContain(
      'missing-time',
    )
  })

  it('registry exposes only incrementally insertable engines', () => {
    const registry = new GeoIndexRegistry()
    expect(
      registry.indexes.every(
        (index) => index.capabilities.incrementalInsert,
      ),
    ).toBe(true)
  })

  it('registry exposes the segmented KD-tree distance engine', () => {
    const registry = new GeoIndexRegistry()
    expect(registry.get('segmented-kd-tree').label).toBe('Segmented KD-tree')
  })

  it('registry exposes the segmented ball-tree distance engine', () => {
    const registry = new GeoIndexRegistry()
    expect(registry.get('segmented-ball-tree').label).toBe(
      'Segmented ball tree',
    )
  })

  it('dynamic Z-order index matches brute force for k=1', async () => {
    await expectMatchesBruteForce(new DynamicZOrderGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      k: 1,
    })
  })

  it('dynamic Z-order index matches brute force for k greater than point count', async () => {
    await expectMatchesBruteForce(new DynamicZOrderGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      k: 100,
    })
  })

  it('dynamic Z-order index matches brute force across the dateline', async () => {
    await expectMatchesBruteForce(new DynamicZOrderGeoIndex(), {
      lat: 0,
      lon: 180,
      k: 3,
    })
  })

  it('dynamic Z-order index matches brute force with sparse timeframe matches', async () => {
    await expectMatchesBruteForce(new DynamicZOrderGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      startTime: 550,
      endTime: 750,
      k: 4,
    })
  })

  it('dynamic Z-order index returns no results when timeframe has no matches', async () => {
    await expectMatchesBruteForce(new DynamicZOrderGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      startTime: 10_000,
      endTime: 20_000,
      k: 10,
    })
  })

  it('dynamic Z-order index supports one-by-one inserts', async () => {
    const index = new DynamicZOrderGeoIndex()
    const oracle = new BruteForceGeoIndex()
    await index.build([])
    await oracle.build([])

    for (const point of points) {
      await index.insert(point)
      await oracle.insert(point)
    }

    const query = { lat: 47.38, lon: 8.54, k: 5 }
    const actual = await index.search(query)
    const expected = await oracle.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  })

  it('dynamic Z-order index supports removes', async () => {
    const index = new DynamicZOrderGeoIndex()
    const oracle = new BruteForceGeoIndex()
    await index.build(points)
    await oracle.build(points)

    await index.remove('zurich-a')
    await oracle.remove('zurich-a')

    const query = { lat: 47.3769, lon: 8.5417, k: 3 }
    const actual = await index.search(query)
    const expected = await oracle.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
    expect(actual.map((result) => result.mediaId)).not.toContain('zurich-a')
  })

  it('dynamic Z-order index builds dense cells with chunk progress', async () => {
    const densePoints = Array.from({ length: 100_000 }, (_, index) => ({
      mediaId: `dense-${index.toString().padStart(6, '0')}`,
      lat: 48.137,
      lon: 11.576,
      timestamp: index,
    }))
    const index = new DynamicZOrderGeoIndex()
    const processedCounts: number[] = []

    await index.build(densePoints, {
      yieldEvery: 10_000,
      onProgress: (progress) => {
        processedCounts.push(progress.processedPoints)
      },
    })

    await index.remove('dense-000000')
    const stats = await index.stats()
    expect(stats.pointCount).toBe(densePoints.length - 1)
    expect(processedCounts[0]).toBe(0)
    expect(processedCounts).toContain(50_000)
    expect(processedCounts.at(-1)).toBe(densePoints.length)
  })

  it('segmented KD-tree index matches brute force for distance queries', async () => {
    await expectMatchesBruteForce(new SegmentedKdTreeGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      k: 5,
    })
  })

  it('segmented KD-tree index matches brute force with filters and paging', async () => {
    await expectMatchesBruteForce(new SegmentedKdTreeGeoIndex({ leafSize: 2 }), {
      lat: 47.38,
      lon: 8.54,
      startTime: 100,
      endTime: 650,
      kind: 'geo_point',
      geoBounds: { minLat: -1, maxLat: 60, minLon: -180, maxLon: 180 },
      k: 3,
      offset: 1,
    })
  })

  it('segmented KD-tree supports incremental inserts', async () => {
    const index = new SegmentedKdTreeGeoIndex({ leafSize: 2 })
    const oracle = new BruteForceGeoIndex()
    await index.build(points.slice(0, 2))
    await oracle.build(points.slice(0, 2))

    await index.insertMany(points.slice(2))
    await index.flushPending(1)
    await oracle.insertMany(points.slice(2))

    const query = { lat: 47.38, lon: 8.54, k: 8 }
    const actual = await index.search(query)
    const expected = await oracle.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  })

  it('segmented ball-tree index matches brute force for distance queries', async () => {
    await expectMatchesBruteForce(new SegmentedBallTreeGeoIndex(), {
      lat: 47.38,
      lon: 8.54,
      k: 5,
    })
  })

  it('segmented ball-tree index matches brute force with filters and paging', async () => {
    await expectMatchesBruteForce(
      new SegmentedBallTreeGeoIndex({ leafSize: 2 }),
      {
        lat: 47.38,
        lon: 8.54,
        startTime: 100,
        endTime: 650,
        kind: 'geo_point',
        geoBounds: { minLat: -1, maxLat: 60, minLon: -180, maxLon: 180 },
        k: 3,
        offset: 1,
      },
    )
  })

  it('segmented ball-tree supports incremental inserts', async () => {
    const index = new SegmentedBallTreeGeoIndex({ leafSize: 2 })
    const oracle = new BruteForceGeoIndex()
    await index.build(points.slice(0, 2))
    await oracle.build(points.slice(0, 2))

    await index.insertMany(points.slice(2))
    await index.flushPending(1)
    await oracle.insertMany(points.slice(2))

    const query = { lat: 47.38, lon: 8.54, k: 8 }
    const actual = await index.search(query)
    const expected = await oracle.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  })

  it('segmented ball-tree snapshot round-trips', async () => {
    const index = new SegmentedBallTreeGeoIndex({ leafSize: 2 })
    await index.build(points)
    const restored = new SegmentedBallTreeGeoIndex({ leafSize: 2 })
    restored.restore(index.snapshot())

    const query = { lat: 47.38, lon: 8.54, k: 8 }
    const actual = await restored.search(query)
    const expected = await index.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  })

  it('segmented ball-tree binary snapshot round-trips', async () => {
    const index = new SegmentedBallTreeGeoIndex({ leafSize: 2 })
    await index.build(points)
    const restored = new SegmentedBallTreeGeoIndex({ leafSize: 2 })
    restored.restore(
      decodeSegmentedBallTreeSnapshot(
        encodeSegmentedBallTreeSnapshot(index.snapshot()),
      ),
    )

    const query = { lat: 47.38, lon: 8.54, k: 8 }
    const actual = await restored.search(query)
    const expected = await index.search(query)
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  })
})
