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

const MAP_TILE_SIZE = 256
const MAP_MERCATOR_MAX_LAT = 85.0511287798066

// Independent re-implementations of the worker's Web-Mercator projection and the
// MapView bubble radii, so the overlap assertion below is a true black-box check.
function lonLatToScreenPixel(
  lon: number,
  lat: number,
  worldSize: number,
): { x: number; y: number } {
  const clampedLat = Math.max(
    -MAP_MERCATOR_MAX_LAT,
    Math.min(MAP_MERCATOR_MAX_LAT, lat),
  )
  const sinLat = Math.sin((clampedLat * Math.PI) / 180)
  return {
    x: ((Math.max(-180, Math.min(180, lon)) + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * worldSize,
  }
}

function bubbleRadiusPx(count: number): number {
  if (count <= 1) return 8 + 2
  const radius = count >= 1_000 ? 18 : count >= 100 ? 15 : count >= 10 ? 12 : 10
  return radius + 2
}

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
  const encoded = {
    image: constants.KIND_CODE_IMAGE,
    video: constants.KIND_CODE_VIDEO,
    geo_point: constants.KIND_CODE_GEO_POINT,
    timeline_visit: constants.KIND_CODE_TIMELINE_VISIT,
    timeline_activity: constants.KIND_CODE_TIMELINE_ACTIVITY,
    activity_sample: constants.KIND_CODE_ACTIVITY_SAMPLE,
    frequent_place: constants.KIND_CODE_FREQUENT_PLACE,
  }[kind]
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

function withGroupSequence(
  record: PackedIndexRecord,
  sequence: number,
  groupHashLo = 1,
): PackedIndexRecord {
  return {
    ...record,
    qualityFlags:
      (record.qualityFlags ?? 0) |
      constants.LINE_QUALITY_HAS_GROUP |
      constants.LINE_QUALITY_HAS_SEQUENCE,
    groupHashLo,
    groupHashHi: 0,
    sequence,
  }
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
  const encoded = flags & 0x7f
  if (encoded === constants.KIND_CODE_VIDEO) return 'video'
  if (encoded === constants.KIND_CODE_GEO_POINT) return 'geo_point'
  if (encoded === constants.KIND_CODE_TIMELINE_VISIT) return 'timeline_visit'
  if (encoded === constants.KIND_CODE_TIMELINE_ACTIVITY) return 'timeline_activity'
  if (encoded === constants.KIND_CODE_ACTIVITY_SAMPLE) return 'activity_sample'
  if (encoded === constants.KIND_CODE_FREQUENT_PLACE) return 'frequent_place'
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

function bruteForcePolylinePoints(
  records: PackedIndexRecord[],
  query: CatalogQuery,
  direction: 'asc' | 'desc',
): Array<{ lat: number; lon: number }> {
  return bruteForceAssetIds(records, query, direction).map((assetId) => {
    const record = records[assetId]
    return {
      lat: record.latE7 / 10_000_000,
      lon: record.lonE7 / 10_000_000,
    }
  })
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

  it('round-trips every catalog kind through packed kind filters', async () => {
    const kinds: MediaKind[] = [
      'image',
      'video',
      'geo_point',
      'timeline_visit',
      'timeline_activity',
      'activity_sample',
      'frequent_place',
    ]
    const records = kinds.map((kind, index): PackedIndexRecord => ({
      timestampSec: 1_700_000_000 + index,
      latE7: coordinateE7(48 + index / 100),
      lonE7: coordinateE7(11 + index / 100),
      assetId: index,
      kindFlags: kindFlags(kind, kind !== 'activity_sample'),
    }))
    const index = makePackedIndex(records)

    for (const [assetId, kind] of kinds.entries()) {
      const page = await index.scanAssetIds(
        0,
        0xffffffff,
        'asc',
        { sort: 'timestamp_asc', kind, limit: 10 },
        10,
        () => false,
      )
      expect(page.assetIds, kind).toEqual([assetId])
    }
  })

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
    expect(page.points.every((point) => point.count === 1)).toBe(true)
    expect(page.points.every((point) => point.bounds)).toBe(true)
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

  it('places aggregated bubbles so they never overlap on screen', async () => {
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

    const worldSize = MAP_TILE_SIZE * 2 ** page.aggregationZoom
    const cellSize = page.aggregationCellSizePx
    const bubbles = page.points.map((point) => ({
      ...lonLatToScreenPixel(point.lon, point.lat, worldSize),
      radius: bubbleRadiusPx(point.count ?? 1),
    }))

    // Bucket bubbles by cell so each is only compared against nearby ones. Any
    // overlapping pair is within 2*maxRadius (< cellSize) of each other, so it
    // always lands in an adjacent bucket and is checked.
    const grid = new Map<string, typeof bubbles>()
    for (const bubble of bubbles) {
      const key = `${Math.floor(bubble.x / cellSize)}/${Math.floor(bubble.y / cellSize)}`
      const list = grid.get(key)
      if (list) list.push(bubble)
      else grid.set(key, [bubble])
    }

    let minEdgeGap = Number.POSITIVE_INFINITY
    for (const bubble of bubbles) {
      const gx = Math.floor(bubble.x / cellSize)
      const gy = Math.floor(bubble.y / cellSize)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const neighbours = grid.get(`${gx + dx}/${gy + dy}`)
          if (!neighbours) continue
          for (const other of neighbours) {
            if (other === bubble) continue
            const distance = Math.hypot(bubble.x - other.x, bubble.y - other.y)
            minEdgeGap = Math.min(
              minEdgeGap,
              distance - bubble.radius - other.radius,
            )
          }
        }
      }
    }

    expect(page.points.some((point) => (point.count ?? 1) > 1)).toBe(true)
    // Guard against a vacuous pass: at least one neighbouring pair was compared.
    expect(Number.isFinite(minEdgeGap)).toBe(true)
    // No bubble fills overlap: closest edge-to-edge gap stays non-negative.
    expect(minEdgeGap).toBeGreaterThanOrEqual(-1e-6)
  })

  it('merges more bubbles as the bubble scale grows', async () => {
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
    const scanAtScale = (bubbleScale: number) =>
      index.scanMapPoints(
        0,
        0xffffffff,
        'asc',
        query,
        {
          zoom: 4,
          viewportWidthPx: 1024,
          viewportHeightPx: 768,
          bubbleCellSizePx: 64,
          bubbleScale,
        },
        5_000,
        0,
        () => false,
      )

    const small = await scanAtScale(0.75)
    const large = await scanAtScale(1.35)

    // Bigger bubbles overlap (and therefore merge) more, so fewer remain.
    expect(large.points.length).toBeLessThan(small.points.length)
    // Merging never drops records: every point is still accounted for.
    const totalCount = (page: typeof small) =>
      page.points.reduce((sum, point) => sum + (point.count ?? 1), 0)
    expect(totalCount(small)).toBe(records.length)
    expect(totalCount(large)).toBe(records.length)
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

  it('keeps singleton bubble bounds exact so nearby points are not selected', async () => {
    const records: PackedIndexRecord[] = [
      {
        timestampSec: 1_700_000_000,
        latE7: coordinateE7(47),
        lonE7: coordinateE7(8),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
      },
      {
        timestampSec: 1_700_000_001,
        latE7: coordinateE7(47.00004),
        lonE7: coordinateE7(8),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
      },
    ]
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      geoBounds: { minLat: 47, maxLat: 47, minLon: 8, maxLon: 8 },
      limit: 5_000,
      offset: 0,
    }

    const mapPage = await index.scanMapPoints(
      0,
      0xffffffff,
      'asc',
      query,
      {
        zoom: 24,
        viewportWidthPx: 1024,
        viewportHeightPx: 768,
        bubbleCellSizePx: 48,
      },
      5_000,
      0,
      () => false,
    )
    const assetPage = await index.scanAssetIds(
      0,
      0xffffffff,
      'asc',
      query,
      5_000,
      () => false,
    )

    expect(mapPage.matchedRecords).toBe(1)
    expect(mapPage.points).toHaveLength(1)
    expect(mapPage.points[0].assetId).toBe(0)
    expect(mapPage.points[0].bounds).toEqual(query.geoBounds)
    expect(assetPage.assetIds).toEqual([0])
  })

  it('scans map polylines in chronological timestamp order', async () => {
    const records = makePackedRecords(2_000, () => 'geo_point').map((record, index) =>
      withGroupSequence(record, index),
    )
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      limit: 10_000,
      offset: 0,
    }
    const expected = bruteForcePolylinePoints(records, query, 'asc')
    const page = await index.scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      query,
      { zoom: 12, viewportWidthPx: 1024, viewportHeightPx: 768, bubbleCellSizePx: 64 },
      { tolerancePx: 0, maxPoints: 10_000 },
      () => false,
    )

    expect(page.points).toEqual([])
    expect(page.polyline?.points).toEqual(expected)
    expect(page.sourceLinePoints).toBe(expected.length)
    expect(page.renderedLinePoints).toBe(expected.length)
    expect(page.polyline?.bounds).toBeTruthy()
  })

  it('applies time, visible bounds, and geo point filtering to map polylines', async () => {
    const records = makePackedRecords(5_000, (index) =>
      index % 3 === 0 ? 'image' : 'geo_point',
    ).map((record, index) => withGroupSequence(record, index))
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      geoBounds: { minLat: -20, maxLat: 20, minLon: -80, maxLon: 80 },
      startTime: FIXTURE_START_TIME + 1_000 * 500,
      endTime: FIXTURE_START_TIME + 1_000 * 3_500,
      limit: 10_000,
      offset: 0,
    }
    const expected = bruteForcePolylinePoints(records, query, 'asc')
    const page = await index.scanMapPolyline(
      timestampSeconds(query.startTime!),
      timestampSeconds(query.endTime!),
      'asc',
      query,
      { zoom: 10, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      { tolerancePx: 0, maxPoints: 10_000 },
      () => false,
    )

    expect(page.polyline?.points).toEqual(expected)
    expect(page.matchedRecords).toBe(expected.length)
    expect(
      page.polyline?.points.every(
        (point) =>
          point.lat >= query.geoBounds!.minLat &&
          point.lat <= query.geoBounds!.maxLat &&
          point.lon >= query.geoBounds!.minLon &&
          point.lon <= query.geoBounds!.maxLon,
      ),
    ).toBe(true)
  })

  it('renders grouped line segments without standalone dots in grouped-only mode', async () => {
    const baseTime = 1_700_000_000
    const records: PackedIndexRecord[] = [
      {
        timestampSec: baseTime,
        latE7: coordinateE7(47),
        lonE7: coordinateE7(8),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags:
          constants.LINE_QUALITY_HAS_GROUP |
          constants.LINE_QUALITY_HAS_SEQUENCE,
        groupHashLo: 1,
        groupHashHi: 0,
        sequence: 0,
      },
      {
        timestampSec: baseTime + 1,
        latE7: coordinateE7(47.1),
        lonE7: coordinateE7(8.1),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags:
          constants.LINE_QUALITY_HAS_GROUP |
          constants.LINE_QUALITY_HAS_SEQUENCE,
        groupHashLo: 1,
        groupHashHi: 0,
        sequence: 1,
      },
      {
        timestampSec: baseTime + 2,
        latE7: coordinateE7(48),
        lonE7: coordinateE7(9),
        assetId: 2,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 3,
        latE7: coordinateE7(49),
        lonE7: coordinateE7(10),
        assetId: 3,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags:
          constants.LINE_QUALITY_HAS_GROUP |
          constants.LINE_QUALITY_HAS_SEQUENCE,
        groupHashLo: 2,
        groupHashHi: 0,
        sequence: 0,
      },
      {
        timestampSec: baseTime + 4,
        latE7: coordinateE7(49.1),
        lonE7: coordinateE7(10.1),
        assetId: 4,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags:
          constants.LINE_QUALITY_HAS_GROUP |
          constants.LINE_QUALITY_HAS_SEQUENCE,
        groupHashLo: 2,
        groupHashHi: 0,
        sequence: 1,
      },
    ]
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 10, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: true,
          allowedSources: ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
          removeIsolatedJumps: true,
        },
      },
      () => false,
    )

    expect(page.polyline?.segments).toHaveLength(2)
    expect(page.polyline?.segments?.map((segment) => segment.points.length)).toEqual([2, 2])
    expect(page.points).toHaveLength(0)
    expect(page.renderedLineDots).toBe(0)
  })

  it('splits grouped map polylines when sequence values are not consecutive', async () => {
    const baseTime = 1_700_050_000
    const records: PackedIndexRecord[] = [
      withGroupSequence({
        timestampSec: baseTime,
        latE7: coordinateE7(47),
        lonE7: coordinateE7(8),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      }, 0),
      withGroupSequence({
        timestampSec: baseTime + 1,
        latE7: coordinateE7(47.1),
        lonE7: coordinateE7(8.1),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      }, 1),
      withGroupSequence({
        timestampSec: baseTime + 2,
        latE7: coordinateE7(48),
        lonE7: coordinateE7(9),
        assetId: 2,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      }, 3),
      withGroupSequence({
        timestampSec: baseTime + 3,
        latE7: coordinateE7(48.1),
        lonE7: coordinateE7(9.1),
        assetId: 3,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      }, 4),
    ]
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 10, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: false,
          allowedSources: ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
          removeIsolatedJumps: true,
        },
      },
      () => false,
    )

    expect(page.polyline?.segments).toHaveLength(2)
    expect(page.polyline?.segments?.map((segment) => segment.points)).toEqual([
      [
        { lat: 47, lon: 8 },
        { lat: 47.1, lon: 8.1 },
      ],
      [
        { lat: 48, lon: 9 },
        { lat: 48.1, lon: 9.1 },
      ],
    ])
    expect(page.points).toHaveLength(0)
  })

  it('prepares full-range line tile sources from grouped sequence runs only', async () => {
    const baseTime = 1_700_060_000
    const records: PackedIndexRecord[] = [
      withGroupSequence({
        timestampSec: baseTime,
        latE7: coordinateE7(47),
        lonE7: coordinateE7(8),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
      }, 0),
      withGroupSequence({
        timestampSec: baseTime + 1,
        latE7: coordinateE7(47.1),
        lonE7: coordinateE7(8.1),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
      }, 1),
      withGroupSequence({
        timestampSec: baseTime + 2,
        latE7: coordinateE7(48),
        lonE7: coordinateE7(9),
        assetId: 2,
        kindFlags: kindFlags('geo_point'),
      }, 3),
      withGroupSequence({
        timestampSec: baseTime + 3,
        latE7: coordinateE7(48.1),
        lonE7: coordinateE7(9.1),
        assetId: 3,
        kindFlags: kindFlags('geo_point'),
      }, 4),
      {
        timestampSec: baseTime + 4,
        latE7: coordinateE7(49),
        lonE7: coordinateE7(10),
        assetId: 4,
        kindFlags: kindFlags('geo_point'),
      },
      withGroupSequence({
        timestampSec: baseTime + 5,
        latE7: coordinateE7(50),
        lonE7: coordinateE7(11),
        assetId: 5,
        kindFlags: kindFlags('image'),
      }, 0),
    ]

    const source = await makePackedIndex(records).scanLineTileSource(
      0,
      0xffffffff,
      () => false,
    )

    expect(source.sourcePointCount).toBe(4)
    expect(source.sourceGroupCount).toBe(1)
    expect(source.segments).toHaveLength(2)
    expect(source.segments.map((segment) => segment.candidates.map((point) => point.sequence))).toEqual([
      [0, 1],
      [3, 4],
    ])
    expect(source.segments.every((segment) => segment.groupKey === '0:1'))
      .toBe(true)
  })

  it('does not filter map polylines by source or accuracy payload fields', async () => {
    const baseTime = 1_700_100_000
    const records: PackedIndexRecord[] = [
      withGroupSequence({
        timestampSec: baseTime,
        latE7: coordinateE7(47),
        lonE7: coordinateE7(8),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags: constants.LINE_QUALITY_HAS_ACCURACY,
        accuracyMeters: 10,
      }, 0),
      withGroupSequence({
        timestampSec: baseTime + 1,
        latE7: coordinateE7(47.01),
        lonE7: coordinateE7(8.01),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_CELL,
        qualityFlags: constants.LINE_QUALITY_HAS_ACCURACY,
        accuracyMeters: 10,
      }, 1),
      withGroupSequence({
        timestampSec: baseTime + 2,
        latE7: coordinateE7(47.02),
        lonE7: coordinateE7(8.02),
        assetId: 2,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags: constants.LINE_QUALITY_HAS_ACCURACY,
        accuracyMeters: 500,
      }, 2),
      withGroupSequence({
        timestampSec: baseTime + 3,
        latE7: coordinateE7(47.03),
        lonE7: coordinateE7(8.03),
        assetId: 3,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
        qualityFlags: constants.LINE_QUALITY_HAS_ACCURACY,
        accuracyMeters: 12,
      }, 3),
    ]
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 12, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: false,
          allowedSources: ['GPS'],
          maxAccuracyMeters: 100,
          removeIsolatedJumps: true,
        },
      },
      () => false,
    )

    expect(page.matchedRecords).toBe(4)
    expect(page.acceptedLinePoints).toBe(4)
    expect(page.filteredQualityPoints).toBe(0)
    expect(page.polyline?.points).toEqual([
      { lat: 47, lon: 8 },
      { lat: 47.01, lon: 8.01 },
      { lat: 47.02, lon: 8.02 },
      { lat: 47.03, lon: 8.03 },
    ])
  })

  it('removes isolated jump points before speed splitting map polylines', async () => {
    const baseTime = 1_700_200_000
    const records: PackedIndexRecord[] = [
      {
        timestampSec: baseTime,
        latE7: coordinateE7(48.137),
        lonE7: coordinateE7(11.575),
        assetId: 0,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 60,
        latE7: coordinateE7(5),
        lonE7: coordinateE7(30),
        assetId: 1,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 120,
        latE7: coordinateE7(48.1371),
        lonE7: coordinateE7(11.5751),
        assetId: 2,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
    ].map((record, index) => withGroupSequence(record, index))
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 12, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: false,
          allowedSources: ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
          breakSpeedKmh: 300,
          removeIsolatedJumps: true,
        },
      },
      () => false,
    )

    expect(page.filteredJumpPoints).toBe(1)
    expect(page.lineSpeedBreaks).toBe(0)
    expect(page.polyline?.points).toEqual([
      { lat: 48.137, lon: 11.575 },
      { lat: 48.1371, lon: 11.5751 },
    ])
  })

  it('breaks map polylines by maximum segment distance and renders singleton fragments as dots', async () => {
    const baseTime = 1_700_250_000
    const records: PackedIndexRecord[] = [
      {
        timestampSec: baseTime,
        latE7: coordinateE7(48.137),
        lonE7: coordinateE7(11.575),
        assetId: 10,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 60,
        latE7: coordinateE7(51.5),
        lonE7: coordinateE7(0),
        assetId: 11,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 120,
        latE7: coordinateE7(51.5005),
        lonE7: coordinateE7(0.0005),
        assetId: 12,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
    ].map((record, index) => withGroupSequence(record, index))
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 12, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: false,
          allowedSources: ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
          maxSegmentDistanceKm: 25,
          removeIsolatedJumps: true,
        },
      },
      () => false,
    )

    expect(page.lineDistanceBreaks).toBe(1)
    expect(page.polyline?.segments).toHaveLength(1)
    expect(page.polyline?.points).toEqual([
      { lat: 51.5, lon: 0 },
      { lat: 51.5005, lon: 0.0005 },
    ])
    expect(page.points).toHaveLength(0)
    expect(page.renderedLineDots).toBe(0)
  })

  it('can suppress singleton map polyline dots after distance splitting', async () => {
    const baseTime = 1_700_260_000
    const records: PackedIndexRecord[] = [
      {
        timestampSec: baseTime,
        latE7: coordinateE7(48.137),
        lonE7: coordinateE7(11.575),
        assetId: 20,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 60,
        latE7: coordinateE7(51.5),
        lonE7: coordinateE7(0),
        assetId: 21,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
      {
        timestampSec: baseTime + 120,
        latE7: coordinateE7(51.5005),
        lonE7: coordinateE7(0.0005),
        assetId: 22,
        kindFlags: kindFlags('geo_point'),
        sourceCode: constants.LINE_SOURCE_GPS,
      },
    ].map((record, index) => withGroupSequence(record, index))
    const page = await makePackedIndex(records).scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      { sort: 'timestamp_asc', kind: 'geo_point', hasGeo: true },
      { zoom: 12, viewportWidthPx: 900, viewportHeightPx: 430, bubbleCellSizePx: 64 },
      {
        tolerancePx: 0,
        maxPoints: 10_000,
        cleanup: {
          enabled: true,
          groupLinesOnly: false,
          allowedSources: ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
          maxSegmentDistanceKm: 25,
          removeIsolatedJumps: true,
          showDots: false,
        },
      },
      () => false,
    )

    expect(page.lineDistanceBreaks).toBe(1)
    expect(page.polyline?.segments).toHaveLength(1)
    expect(page.points).toHaveLength(0)
    expect(page.renderedLineDots).toBe(0)
    expect(page.limitReached).toBe(false)
  })

  it('preserves accepted map polyline vertices without Douglas-Peucker simplification', async () => {
    const records = Array.from({ length: 2_000 }, (_, index): PackedIndexRecord =>
      withGroupSequence({
        timestampSec: 1_700_000_000 + index,
        latE7: coordinateE7(46 + index / 20_000 + Math.sin(index / 8) / 1_000),
        lonE7: coordinateE7(7 + index / 18_000),
        assetId: index,
        kindFlags: kindFlags('geo_point'),
      }, index),
    )
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      limit: 10,
      offset: 0,
    }
    const page = await index.scanMapPolyline(
      0,
      0xffffffff,
      'asc',
      query,
      { zoom: 14, viewportWidthPx: 1200, viewportHeightPx: 700, bubbleCellSizePx: 64 },
      { tolerancePx: 0.25, maxPoints: 10 },
      () => false,
    )
    const points = page.polyline?.points ?? []

    expect(points).toHaveLength(records.length)
    expect(points[0]).toEqual({
      lat: records[0].latE7 / 10_000_000,
      lon: records[0].lonE7 / 10_000_000,
    })
    expect(points[points.length - 1]).toEqual({
      lat: records[records.length - 1].latE7 / 10_000_000,
      lon: records[records.length - 1].lonE7 / 10_000_000,
    })
    expect(page.limitReached).toBe(false)
    expect(page.sourceLinePoints).toBe(records.length)
    expect(page.renderedLinePoints).toBe(points.length)
  })

  it('aborts packed map polyline scans', async () => {
    const records = makePackedRecords(20_000, () => 'geo_point')
    const index = makePackedIndex(records)
    const query: CatalogQuery = {
      sort: 'timestamp_asc',
      kind: 'geo_point',
      hasGeo: true,
      limit: 10_000,
      offset: 0,
    }

    await expect(
      index.scanMapPolyline(
        0,
        0xffffffff,
        'asc',
        query,
        { zoom: 10, viewportWidthPx: 1024, viewportHeightPx: 768, bubbleCellSizePx: 64 },
        { tolerancePx: 2, maxPoints: 10_000 },
        () => true,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
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
