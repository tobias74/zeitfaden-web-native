import { describe, expect, it } from 'vitest'
import type { CatalogQuery, MediaItem, MediaKind } from '../../types'
import {
  FIXTURE_START_TIME,
  fixtureKind,
  fixtureLat,
  fixtureLon,
  fixtureTimestamp,
  makeMediaItems,
} from '../../test/largeFixtures'
import {
  AssetTable,
  ResidentPackedGeoIndex,
  catalogWorkerTestConstants as constants,
  encodeTimeGeoIndexForTests,
  type PackedIndexRecord,
} from './catalog.worker'

const LARGE_RECORD_COUNT = 100_000
const textEncoder = new TextEncoder()

type MemoryFileHandle = {
  getFile(): Promise<File>
}

class MemoryDirectoryHandle {
  readonly files = new Map<string, File>()

  async getFileHandle(name: string): Promise<MemoryFileHandle> {
    const file = this.files.get(name)
    if (!file) throw new Error(`Missing memory file: ${name}`)
    return {
      getFile: async () => file,
    }
  }
}

function timestampSeconds(value: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.floor(value / 1000)))
}

function coordinateE7(value: number): number {
  return Math.round(value * 10_000_000)
}

function kindFlags(kind: MediaKind, hasGeo = true): number {
  const encoded =
    kind === 'video'
      ? constants.KIND_FLAG_VIDEO
      : kind === 'geo_point'
        ? constants.KIND_FLAG_GEO_POINT
        : constants.KIND_FLAG_IMAGE
  return encoded | (hasGeo ? constants.KIND_FLAG_HAS_GEO : 0)
}

function makePackedRecord(index: number, kind: MediaKind = fixtureKind(index)): PackedIndexRecord {
  return {
    timestampSec: timestampSeconds(fixtureTimestamp(index)),
    latE7: coordinateE7(fixtureLat(index)),
    lonE7: coordinateE7(fixtureLon(index)),
    assetId: index,
    kindFlags: kindFlags(kind),
  }
}

function makePackedRecords(
  count: number,
  kindForIndex: (index: number) => MediaKind = fixtureKind,
): PackedIndexRecord[] {
  return Array.from({ length: count }, (_, index) =>
    makePackedRecord(index, kindForIndex(index)),
  )
}

function makePackedIndex(records: PackedIndexRecord[]): ResidentPackedGeoIndex {
  const index = ResidentPackedGeoIndex.fromArrayBuffer(
    encodeTimeGeoIndexForTests(records, {
      assetCount: records.length,
      catalogVersion: 7,
    }),
    constants.INDEX_KIND_TIME_GEO,
  )
  if (!index) throw new Error('Failed to create packed fixture index')
  return index
}

function mediaKindFromFlags(flags: number): MediaKind {
  const encoded = flags & 0b11
  if (encoded === constants.KIND_FLAG_VIDEO) return 'video'
  if (encoded === constants.KIND_FLAG_GEO_POINT) return 'geo_point'
  return 'image'
}

function bruteForceAssetIds(
  records: PackedIndexRecord[],
  query: CatalogQuery,
  direction: 'asc' | 'desc',
): number[] {
  const minTime = query.startTime === undefined ? 0 : timestampSeconds(query.startTime)
  const maxTime = query.endTime === undefined ? 0xffffffff : timestampSeconds(query.endTime)
  const filtered = records
    .filter((record) => record.timestampSec >= minTime && record.timestampSec <= maxTime)
    .filter((record) => {
      const kind = mediaKindFromFlags(record.kindFlags)
      if (query.kind === 'media' && kind !== 'image' && kind !== 'video') return false
      if (query.kind && query.kind !== 'all' && query.kind !== 'media' && kind !== query.kind) {
        return false
      }
      const hasGeo = (record.kindFlags & constants.KIND_FLAG_HAS_GEO) !== 0
      if (query.hasGeo === true && !hasGeo) return false
      if (query.hasGeo === false && hasGeo) return false
      if (query.geoBounds) {
        const lat = record.latE7 / 10_000_000
        const lon = record.lonE7 / 10_000_000
        if (lat < query.geoBounds.minLat || lat > query.geoBounds.maxLat) return false
        if (lon < query.geoBounds.minLon || lon > query.geoBounds.maxLon) return false
      }
      return true
    })
    .sort((left, right) =>
      left.timestampSec - right.timestampSec || left.assetId - right.assetId,
    )
  if (direction === 'desc') filtered.reverse()
  return filtered.map((record) => record.assetId)
}

function encodeAssetTableFiles(items: MediaItem[]): MemoryDirectoryHandle {
  const directory = new MemoryDirectoryHandle()
  const recordIndexBytes = new Uint8Array(
    constants.ASSET_TABLE_HEADER_SIZE +
      items.length * constants.ASSET_RECORD_INDEX_ENTRY_SIZE,
  )
  const recordIndexView = new DataView(recordIndexBytes.buffer)
  recordIndexView.setUint32(0, constants.ASSET_TABLE_MAGIC, true)
  recordIndexView.setUint32(4, constants.BINARY_SCHEMA_VERSION, true)
  recordIndexView.setFloat64(8, 1, true)
  recordIndexView.setFloat64(16, items.length, true)
  recordIndexView.setUint32(24, constants.ASSET_RECORD_INDEX_ENTRY_SIZE, true)

  for (let offset = 0; offset < items.length; offset += constants.ASSET_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + constants.ASSET_CHUNK_SIZE)
    const payloads = chunk.map((item) => textEncoder.encode(JSON.stringify(item)))
    const chunkBytes = new Uint8Array(
      payloads.reduce((total, payload) => total + 4 + payload.byteLength, 0),
    )
    const chunkView = new DataView(chunkBytes.buffer)
    let chunkOffset = 0
    for (let index = 0; index < payloads.length; index += 1) {
      const assetId = offset + index
      const payload = payloads[index]
      chunkView.setUint32(chunkOffset, payload.byteLength, true)
      chunkBytes.set(payload, chunkOffset + 4)
      const recordOffset =
        constants.ASSET_TABLE_HEADER_SIZE +
        assetId * constants.ASSET_RECORD_INDEX_ENTRY_SIZE
      recordIndexView.setUint32(recordOffset, offset / constants.ASSET_CHUNK_SIZE, true)
      recordIndexView.setUint32(recordOffset + 4, chunkOffset, true)
      recordIndexView.setUint32(recordOffset + 8, payload.byteLength, true)
      chunkOffset += 4 + payload.byteLength
    }
    const chunkId = String(offset / constants.ASSET_CHUNK_SIZE).padStart(6, '0')
    directory.files.set(
      `${constants.ASSET_CHUNK_PREFIX}${chunkId}${constants.ASSET_BINARY_CHUNK_EXTENSION}`,
      new File([chunkBytes], `chunk-${chunkId}.bin`),
    )
  }

  directory.files.set(
    constants.ASSET_RECORD_INDEX_FILE,
    new File([recordIndexBytes], constants.ASSET_RECORD_INDEX_FILE),
  )
  return directory
}

describe('catalog worker packed query hot paths', () => {
  it('scans 100k timestamp records and terminates when a kind filter has no matches', async () => {
    const records = makePackedRecords(LARGE_RECORD_COUNT, () => 'geo_point')
    const index = makePackedIndex(records)
    const page = await index.scanAssetIds(
      0,
      0xffffffff,
      'desc',
      { sort: 'timestamp_desc', kind: 'image', limit: 500 },
      500,
      () => false,
    )

    expect(page.assetIds).toEqual([])
    expect(page.limitReached).toBe(false)
    expect(page.metrics.candidatesInspected).toBe(LARGE_RECORD_COUNT)
    expect(page.metrics.pagesRead).toBeGreaterThanOrEqual(1)
  }, 15_000)

  it('returns sparse kind matches in timestamp order without enriching every record', async () => {
    const records = makePackedRecords(LARGE_RECORD_COUNT, (index) =>
      index % 25_000 === 0 ? 'image' : 'geo_point',
    )
    const index = makePackedIndex(records)
    const page = await index.scanAssetIds(
      0,
      0xffffffff,
      'desc',
      { sort: 'timestamp_desc', kind: 'image', limit: 3 },
      3,
      () => false,
    )

    expect(page.assetIds).toEqual([75_000, 50_000, 25_000])
    expect(page.limitReached).toBe(true)
    expect(page.metrics.candidatesInspected).toBeGreaterThan(25_000)
    expect(page.metrics.candidatesInspected).toBeLessThanOrEqual(LARGE_RECORD_COUNT)
  }, 15_000)

  it('returns map points with time, kind, bounds, offset, and limit filters', async () => {
    const records = makePackedRecords(20_000)
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      geoBounds: { minLat: -20, maxLat: 20, minLon: -70, maxLon: 70 },
      startTime: FIXTURE_START_TIME + 1_000 * 2_000,
      endTime: FIXTURE_START_TIME + 1_000 * 6_000,
      limit: 5_000,
      offset: 0,
    }
    const expected = bruteForceAssetIds(records, query, 'asc').slice(0, 5_000)
    const page = await index.scanMapPoints(
      timestampSeconds(query.startTime!),
      timestampSeconds(query.endTime!),
      'asc',
      query,
      {
        zoom: 24,
        viewportWidthPx: 4096,
        viewportHeightPx: 4096,
        bubbleCellSizePx: 1,
      },
      5_000,
      0,
      () => false,
    )

    expect(page.points.map((point) => point.assetId)).toEqual(expected)
    expect(page.points.every((point) => point.kind === 'geo_point')).toBe(true)
    expect(page.points.every((point) => point.cellId)).toBe(true)
    expect(page.limitReached).toBe(false)
    expect(page.matchedRecords).toBe(expected.length)
    expect(page.renderedBubbles).toBe(expected.length)
  })

  it('groups dense map point results without hiding matching records', async () => {
    const records = makePackedRecords(20_000, () => 'geo_point')
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      geoBounds: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 },
      limit: 5_000,
      offset: 0,
    }
    const page = await index.scanMapPoints(
      0,
      0xffffffff,
      'asc',
      query,
      {
        zoom: 4,
        viewportWidthPx: 1024,
        viewportHeightPx: 768,
        bubbleCellSizePx: 64,
      },
      5_000,
      0,
      () => false,
    )

    expect(page.limitReached).toBe(false)
    expect(page.points.length).toBeLessThanOrEqual(5_000)
    expect(page.points.some((point) => (point.count ?? 1) > 1)).toBe(true)
    expect(page.points.every((point) => point.cellId)).toBe(true)
    expect(page.points.reduce((total, point) => total + (point.count ?? 1), 0)).toBe(
      records.length,
    )
    expect(page.matchedRecords).toBe(records.length)
    expect(page.renderedBubbles).toBe(page.points.length)
    expect(page.largestBubbleCount).toBeGreaterThan(1)
    expect(page.aggregationZoom).toBe(4)
    expect(page.aggregationCellSizePx).toBe(64)
    expect(
      page.points.every(
        (point) =>
          point.lat >= query.geoBounds!.minLat &&
          point.lat <= query.geoBounds!.maxLat &&
          point.lon >= query.geoBounds!.minLon &&
          point.lon <= query.geoBounds!.maxLon,
      ),
    ).toBe(true)
  })

  it('uses stable globally anchored map bucket ids at integer zoom levels', async () => {
    const records = makePackedRecords(5_000, () => 'geo_point')
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      geoBounds: { minLat: -90, maxLat: 90, minLon: -180, maxLon: 180 },
      limit: 5_000,
      offset: 0,
    }
    const scanAtZoom = (zoom: number) =>
      index.scanMapPoints(
        0,
        0xffffffff,
        'asc',
        query,
        {
          zoom,
          viewportWidthPx: 1024,
          viewportHeightPx: 768,
          bubbleCellSizePx: 64,
        },
        5_000,
        0,
        () => false,
      )

    const zoomSixA = await scanAtZoom(6.1)
    const zoomSixB = await scanAtZoom(6.9)
    const zoomSeven = await scanAtZoom(7)

    const idsAtSixA = zoomSixA.points.map((point) => point.cellId).sort()
    const idsAtSixB = zoomSixB.points.map((point) => point.cellId).sort()
    const idsAtSeven = zoomSeven.points.map((point) => point.cellId).sort()

    expect(idsAtSixA.length).toBeGreaterThan(0)
    expect(idsAtSixA).toEqual(idsAtSixB)
    expect(idsAtSeven).not.toEqual(idsAtSixA)
    expect(zoomSixA.points.reduce((total, point) => total + (point.count ?? 1), 0))
      .toBe(zoomSixA.matchedRecords)
  })

  it('reads selected asset records by chunk while preserving requested order', async () => {
    const items = makeMediaItems(30_000)
    const directory = encodeAssetTableFiles(items)
    const table = new AssetTable(
      directory as unknown as FileSystemDirectoryHandle,
      {
        catalogVersion: 1,
        count: items.length,
        entrySize: constants.ASSET_RECORD_INDEX_ENTRY_SIZE,
      },
      directory.files.get(constants.ASSET_RECORD_INDEX_FILE)!,
    )
    const result = await table.readByAssetIds([
      20_010,
      5,
      10_005,
      5,
      29_999,
      999_999,
    ])

    expect(result.items.map((row) => row.assetId)).toEqual([
      20_010,
      5,
      10_005,
      5,
      29_999,
    ])
    expect(result.items.map((row) => row.item.id)).toEqual([
      'media-0020010',
      'media-0000005',
      'media-0010005',
      'media-0000005',
      'media-0029999',
    ])
    expect(result.metrics.diskReadCount).toBeLessThan(10)
  })
})
