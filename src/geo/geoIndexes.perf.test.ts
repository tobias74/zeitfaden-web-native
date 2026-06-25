import { describe, expect, it } from 'vitest'
import { makeGeoPoints } from '../test/largeFixtures'
import { BruteForceGeoIndex } from './bruteForceIndex'
import { SegmentedBallTreeGeoIndex } from './segmentedBallTreeGeoIndex'

const env = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> }
}).process?.env
const describePerf = env?.RUN_PERF_TESTS === '1' ? describe : describe.skip
const PERF_POINT_COUNT = Number(env?.GEO_PERF_POINT_COUNT ?? 150_000)

describePerf('geo index performance', () => {
  it('builds and queries a large segmented ball-tree fixture', async () => {
    const points = makeGeoPoints(PERF_POINT_COUNT)
    const index = new SegmentedBallTreeGeoIndex({
      leafSize: 64,
      segmentPointLimit: 25_000,
      deltaFlushPointLimit: 10_000,
    })

    const buildStartedAt = performance.now()
    await index.build(points)
    const buildMs = performance.now() - buildStartedAt

    const query = {
      lat: 48.137,
      lon: 11.576,
      k: 50,
      kind: 'geo_point' as const,
      startTime: points[10_000].timestamp,
      endTime: points[PERF_POINT_COUNT - 10_000]?.timestamp,
    }
    const queryStartedAt = performance.now()
    const actual = await index.search(query)
    const queryMs = performance.now() - queryStartedAt

    const oracle = new BruteForceGeoIndex()
    await oracle.build(points)
    const expected = await oracle.search(query)

    console.info('[perf] segmented ball-tree', {
      points: PERF_POINT_COUNT,
      buildMs: Math.round(buildMs),
      queryMs: Math.round(queryMs),
      rows: actual.length,
    })
    expect(actual.map((result) => result.mediaId)).toEqual(
      expected.map((result) => result.mediaId),
    )
  }, 120_000)
})
