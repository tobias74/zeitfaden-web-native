import { describe, expect, it } from 'vitest'
import {
  FIXTURE_START_TIME,
  fixtureLat,
  fixtureLon,
  fixtureTimestamp,
} from '../../test/largeFixtures'
import {
  ResidentPackedGeoIndex,
  catalogWorkerTestConstants as constants,
  encodeTimeGeoIndexForTests,
  type PackedIndexRecord,
} from './catalog.worker'

const env = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> }
}).process?.env
const describePerf = env?.RUN_PERF_TESTS === '1' ? describe : describe.skip
const PERF_RECORD_COUNT = Number(env?.CATALOG_PERF_RECORD_COUNT ?? 250_000)

function timestampSeconds(value: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.floor(value / 1000)))
}

function makeNoImagePackedRecords(count: number): PackedIndexRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    timestampSec: timestampSeconds(fixtureTimestamp(index)),
    latE7: Math.round(fixtureLat(index) * 10_000_000),
    lonE7: Math.round(fixtureLon(index) * 10_000_000),
    assetId: index,
    kindFlags: constants.KIND_FLAG_GEO_POINT | constants.KIND_FLAG_HAS_GEO,
  }))
}

describePerf('catalog worker packed query performance', () => {
  it('scans a large no-match kind query without hanging', async () => {
    const records = makeNoImagePackedRecords(PERF_RECORD_COUNT)
    const index = ResidentPackedGeoIndex.fromArrayBuffer(
      encodeTimeGeoIndexForTests(records, {
        assetCount: records.length,
        catalogVersion: 99,
      }),
      constants.INDEX_KIND_TIME_GEO,
    )
    if (!index) throw new Error('Failed to create packed performance index')

    const startedAt = performance.now()
    const page = await index.scanAssetIds(
      timestampSeconds(FIXTURE_START_TIME),
      timestampSeconds(FIXTURE_START_TIME + PERF_RECORD_COUNT * 1_000),
      'desc',
      { sort: 'timestamp_desc', kind: 'image', limit: 500 },
      500,
      () => false,
    )
    const elapsedMs = performance.now() - startedAt

    console.info('[perf] packed no-match scan', {
      records: PERF_RECORD_COUNT,
      elapsedMs: Math.round(elapsedMs),
      candidatesInspected: page.metrics.candidatesInspected,
      pagesRead: page.metrics.pagesRead,
    })
    expect(page.assetIds).toHaveLength(0)
    expect(page.metrics.candidatesInspected).toBe(PERF_RECORD_COUNT)
  }, 120_000)
})
