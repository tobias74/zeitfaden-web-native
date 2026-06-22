import { haversineMeters } from '../lib/distance'
import { overlapsTimeRange } from '../lib/time'
import type {
  GeoBounds,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MediaKind,
  ValidationReport,
} from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'
import {
  SegmentedBallTreeGeoIndex,
  type SegmentedBallTreeNode,
  type SegmentedBallTreeSnapshot,
  type SegmentedBallTreeSnapshotSegment,
} from './segmentedBallTreeGeoIndex'
import {
  decodeSegmentedBallTreeSnapshot,
  encodeSegmentedBallTreeSnapshot,
} from './segmentedBallTreePersistence'
import {
  SegmentedKdTreeGeoIndex,
  type SegmentedKdTreeNode,
  type SegmentedKdTreeSnapshot,
  type SegmentedKdTreeSnapshotSegment,
} from './segmentedKdTreeGeoIndex'
import {
  decodeSegmentedKdTreeSnapshot,
  encodeSegmentedKdTreeSnapshot,
} from './segmentedKdTreePersistence'

export type DiskSegmentedEngineId =
  | 'segmented-kd-tree'
  | 'segmented-ball-tree'

export type DiskSegmentRoot =
  | ({ treeKind: 'kd' } & SegmentedKdTreeNode)
  | ({ treeKind: 'ball' } & SegmentedBallTreeNode)

export type DiskSegmentedTreeManifest = {
  engineId: DiskSegmentedEngineId
  engineVersion: 2
  catalogEpoch: number
  leafSize: number
  segmentPointLimit: number
  deltaFlushPointLimit: number
  pointCount: number
  segmentCount: number
  createdAt: number
  segments: DiskSegmentRef[]
}

export type DiskSegmentRef = {
  id: string
  isDelta: boolean
  pointCount: number
  maxLeafSize: number
  byteLength: number
  root: DiskSegmentRoot
}

export type DiskSegmentedTreeStore = {
  readManifest(engineId: DiskSegmentedEngineId): Promise<DiskSegmentedTreeManifest | undefined>
  writeManifest(
    engineId: DiskSegmentedEngineId,
    manifest: DiskSegmentedTreeManifest,
  ): Promise<void>
  readSegment(
    engineId: DiskSegmentedEngineId,
    segmentId: string,
  ): Promise<ArrayBuffer | undefined>
  writeSegment(
    engineId: DiskSegmentedEngineId,
    segmentId: string,
    data: ArrayBuffer,
  ): Promise<void>
  clear(engineId: DiskSegmentedEngineId): Promise<void>
}

type SegmentCacheEntry = {
  segment: SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment
  byteLength: number
}

export type DiskSegmentedBatchProducer = (
  onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
) => Promise<number>

type DiskQueryMetrics = {
  distanceComputations: number
  nodesVisited: number
  pagesRead: number
  candidatesInspected: number
  prunedByGeo: number
  prunedByTime: number
  diskReadBytes: number
  diskReadCount: number
  pageCacheHits: number
  pageCacheMisses: number
}

const DEFAULT_SEGMENT_POINT_LIMIT = 100_000
const DEFAULT_DELTA_FLUSH_POINT_LIMIT = 50_000
const DEFAULT_LEAF_SIZE = 64
const MAX_CACHED_SEGMENTS = 4
const EARTH_RADIUS_METERS = 6_371_008.8
const DISTANCE_TIE_EPSILON_METERS = 1e-6

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function normalizeLon(lon: number): number {
  const normalized = ((((lon + 180) % 360) + 360) % 360) - 180
  return normalized === -180 ? 180 : normalized
}

function kindMask(kind: MediaKind | undefined): number {
  if (kind === 'image') return 1
  if (kind === 'video') return 2
  if (kind === 'geo_point') return 4
  return 8
}

function queryKindMask(query: GeoSearchQuery): number {
  if (!query.kind || query.kind === 'all') return 15
  if (query.kind === 'media') return 1 | 2
  return kindMask(query.kind)
}

function nodeOverlapsGeoBounds(node: DiskSegmentRoot, bounds: GeoBounds): boolean {
  return !(
    node.latMax < bounds.minLat ||
    node.latMin > bounds.maxLat ||
    node.lonMax < bounds.minLon ||
    node.lonMin > bounds.maxLon
  )
}

function angularLonDistanceToInterval(
  lon: number,
  lonMin: number,
  lonMax: number,
): number {
  if (lon >= lonMin && lon <= lonMax) return 0
  const direct = Math.min(Math.abs(lon - lonMin), Math.abs(lon - lonMax))
  return Math.min(direct, 360 - direct)
}

function kdLowerBoundMeters(
  node: SegmentedKdTreeNode,
  query: GeoSearchQuery,
): number {
  const queryLon = normalizeLon(query.lon)
  const latDelta =
    query.lat < node.latMin
      ? node.latMin - query.lat
      : query.lat > node.latMax
        ? query.lat - node.latMax
        : 0
  const lonDelta = angularLonDistanceToInterval(
    queryLon,
    node.lonMin,
    node.lonMax,
  )
  const maxAbsLat = Math.min(
    90,
    Math.max(Math.abs(query.lat), Math.abs(node.latMin), Math.abs(node.latMax)),
  )
  const latMeters = EARTH_RADIUS_METERS * toRadians(latDelta)
  const lonMeters =
    EARTH_RADIUS_METERS *
    toRadians(lonDelta) *
    Math.max(0, Math.cos(toRadians(maxAbsLat)))
  return Math.max(latMeters, lonMeters)
}

function segmentLowerBoundMeters(
  root: DiskSegmentRoot,
  query: GeoSearchQuery,
): number {
  if (root.treeKind === 'kd') return kdLowerBoundMeters(root, query)
  return Math.max(
    0,
    haversineMeters(root.centerLat, root.centerLon, query.lat, query.lon) -
      root.radiusMeters,
  )
}

function rootMatchesQuery(
  root: DiskSegmentRoot,
  query: GeoSearchQuery,
  metrics: DiskQueryMetrics,
): boolean {
  if (!overlapsTimeRange(root.minTimestamp, root.maxTimestamp, query)) {
    metrics.prunedByTime += 1
    return false
  }
  if ((root.kindMask & queryKindMask(query)) === 0) {
    metrics.prunedByGeo += 1
    return false
  }
  if (query.geoBounds && !nodeOverlapsGeoBounds(root, query.geoBounds)) {
    metrics.prunedByGeo += 1
    return false
  }
  return true
}

function sortResults(results: GeoSearchResult[]): GeoSearchResult[] {
  return [...results].sort((a, b) => {
    const distanceDelta = a.distanceMeters - b.distanceMeters
    if (Math.abs(distanceDelta) > DISTANCE_TIE_EPSILON_METERS) {
      return distanceDelta
    }
    return a.mediaId.localeCompare(b.mediaId)
  })
}

function trimResultsInPlace(results: GeoSearchResult[], limit: number): void {
  const trimmed = sortResults(results).slice(0, limit)
  results.length = trimmed.length
  for (let index = 0; index < trimmed.length; index += 1) {
    results[index] = trimmed[index]
  }
}

function snapshotForSegment(
  engineId: DiskSegmentedEngineId,
  segment: SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment,
): SegmentedKdTreeSnapshot | SegmentedBallTreeSnapshot {
  const common = {
    version: 1 as const,
    leafSize: DEFAULT_LEAF_SIZE,
    segmentPointLimit: DEFAULT_SEGMENT_POINT_LIMIT,
    deltaFlushPointLimit: DEFAULT_DELTA_FLUSH_POINT_LIMIT,
    pointCount: segment.pointCount,
    segmentCount: 1,
    segments: [segment as never],
    pendingPoints: [],
  }
  return engineId === 'segmented-kd-tree'
    ? { ...common, engineId } as SegmentedKdTreeSnapshot
    : { ...common, engineId } as SegmentedBallTreeSnapshot
}

function encodeSegment(
  engineId: DiskSegmentedEngineId,
  segment: SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment,
): ArrayBuffer {
  const snapshot = snapshotForSegment(engineId, segment)
  return engineId === 'segmented-kd-tree'
    ? encodeSegmentedKdTreeSnapshot(snapshot as SegmentedKdTreeSnapshot)
    : encodeSegmentedBallTreeSnapshot(snapshot as SegmentedBallTreeSnapshot)
}

function decodeSegment(
  engineId: DiskSegmentedEngineId,
  data: ArrayBuffer,
): SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment {
  return engineId === 'segmented-kd-tree'
    ? decodeSegmentedKdTreeSnapshot(data).segments[0]
    : decodeSegmentedBallTreeSnapshot(data).segments[0]
}

function rootForSegment(
  engineId: DiskSegmentedEngineId,
  segment: SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment,
): DiskSegmentRoot {
  const root = segment.nodes[0]
  if (!root) throw new Error('Segmented disk index segment has no root node.')
  return engineId === 'segmented-kd-tree'
    ? { ...(root as SegmentedKdTreeNode), treeKind: 'kd' }
    : { ...(root as SegmentedBallTreeNode), treeKind: 'ball' }
}

export class DiskSegmentedTreeIndex {
  readonly id: DiskSegmentedEngineId
  readonly label: string
  readonly capabilities = {
    exact: true,
    persistent: true,
    incrementalInsert: true,
    incrementalDelete: false,
    supportsTimePruning: true,
  }

  private readonly store: DiskSegmentedTreeStore
  private manifest: DiskSegmentedTreeManifest | undefined
  private readonly cache = new Map<string, SegmentCacheEntry>()
  private lastStats: GeoIndexStats = this.emptyStats()

  constructor(
    engineId: DiskSegmentedEngineId,
    store: DiskSegmentedTreeStore,
  ) {
    this.id = engineId
    this.label =
      engineId === 'segmented-kd-tree'
        ? 'Segmented KD-tree'
        : 'Segmented ball tree'
    this.store = store
  }

  async prepare(catalogEpoch: number): Promise<boolean> {
    const manifest = await this.store.readManifest(this.id)
    if (
      !manifest ||
      manifest.engineId !== this.id ||
      manifest.engineVersion !== 2 ||
      manifest.catalogEpoch !== catalogEpoch
    ) {
      return false
    }
    this.manifest = manifest
    this.cache.clear()
    this.lastStats = this.emptyStats()
    return true
  }

  async build(
    batches: AsyncIterable<GeoIndexPoint[]> | DiskSegmentedBatchProducer,
    catalogEpoch: number,
    onProgress?: (processedPoints: number, totalPoints?: number) => void,
  ): Promise<number> {
    const startedAt = performance.now()
    await this.store.clear(this.id)
    this.cache.clear()
    const segments: DiskSegmentRef[] = []
    let pointCount = 0
    let segmentIndex = 0

    const writeBatch = async (
      batch: GeoIndexPoint[],
      processedPoints?: number,
    ) => {
      const segment = await this.buildSegment(
        `segment-${String(segmentIndex).padStart(6, '0')}`,
        batch,
        false,
      )
      if (!segment) return
      const data = encodeSegment(this.id, segment)
      await this.store.writeSegment(this.id, segment.id, data.slice(0))
      segments.push({
        id: segment.id,
        isDelta: false,
        pointCount: segment.pointCount,
        maxLeafSize: segment.maxLeafSize,
        byteLength: data.byteLength,
        root: rootForSegment(this.id, segment),
      })
      pointCount += segment.pointCount
      segmentIndex += 1
      onProgress?.(processedPoints ?? pointCount)
    }

    if (typeof batches === 'function') {
      pointCount = await batches(async (batch, processedPoints) => {
        await writeBatch(batch, processedPoints)
      })
    } else {
      for await (const batch of batches) {
        await writeBatch(batch)
      }
    }

    this.manifest = {
      engineId: this.id,
      engineVersion: 2,
      catalogEpoch,
      leafSize: DEFAULT_LEAF_SIZE,
      segmentPointLimit: DEFAULT_SEGMENT_POINT_LIMIT,
      deltaFlushPointLimit: DEFAULT_DELTA_FLUSH_POINT_LIMIT,
      pointCount,
      segmentCount: segments.length,
      createdAt: Date.now(),
      segments,
    }
    await this.store.writeManifest(this.id, this.manifest)
    this.lastStats = {
      ...this.emptyStats(),
      buildTimeMs: performance.now() - startedAt,
    }
    return pointCount
  }

  async insertMany(points: GeoIndexPoint[], catalogEpoch: number): Promise<void> {
    if (!this.manifest || points.length === 0) return
    const segment = await this.buildSegment(
      `delta-${Date.now().toString(36)}-${this.manifest.segments.length}`,
      points,
      true,
    )
    if (!segment) return
    const data = encodeSegment(this.id, segment)
    await this.store.writeSegment(this.id, segment.id, data.slice(0))
    this.manifest = {
      ...this.manifest,
      catalogEpoch,
      pointCount: this.manifest.pointCount + segment.pointCount,
      segmentCount: this.manifest.segmentCount + 1,
      segments: [
        ...this.manifest.segments,
        {
          id: segment.id,
          isDelta: true,
          pointCount: segment.pointCount,
          maxLeafSize: segment.maxLeafSize,
          byteLength: data.byteLength,
          root: rootForSegment(this.id, segment),
        },
      ],
    }
    await this.store.writeManifest(this.id, this.manifest)
    this.lastStats = this.emptyStats()
  }

  async search(query: GeoSearchQuery): Promise<GeoSearchResult[]> {
    const startedAt = performance.now()
    const manifest = this.manifest
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.max(0, Math.trunc(query.k))
    const retainedLimit = offset + limit
    const metrics: DiskQueryMetrics = {
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
      diskReadBytes: 0,
      diskReadCount: 0,
      pageCacheHits: 0,
      pageCacheMisses: 0,
    }
    if (!manifest || limit <= 0 || manifest.pointCount === 0) {
      this.lastStats = {
        ...this.emptyStats(),
        lastQueryTimeMs: performance.now() - startedAt,
      }
      return []
    }

    const normalizedQuery = { ...query, lon: normalizeLon(query.lon) }
    const queue = manifest.segments.flatMap((segment) => {
      if (!rootMatchesQuery(segment.root, normalizedQuery, metrics)) return []
      return [
        {
          segment,
          lowerBound: segmentLowerBoundMeters(segment.root, normalizedQuery),
        },
      ]
    })
    queue.sort((a, b) => a.lowerBound - b.lowerBound || a.segment.id.localeCompare(b.segment.id))

    const topK: GeoSearchResult[] = []
    while (queue.length > 0) {
      const entry = queue.shift()
      if (!entry) break
      const worst =
        topK.length === retainedLimit
          ? topK[topK.length - 1]?.distanceMeters ?? Infinity
          : Infinity
      if (topK.length === retainedLimit && entry.lowerBound > worst) {
        metrics.prunedByGeo += queue.length + 1
        break
      }
      const segment = await this.loadSegment(entry.segment, metrics)
      metrics.nodesVisited += 1
      metrics.pagesRead += 1
      const segmentResults = await this.searchSegment(
        segment,
        normalizedQuery,
        retainedLimit,
      )
      const stats = await segmentResults.stats()
      metrics.distanceComputations += stats.distanceComputations
      metrics.nodesVisited += stats.nodesVisited
      metrics.pagesRead += stats.pagesRead
      metrics.candidatesInspected += stats.candidatesInspected
      metrics.prunedByGeo += stats.prunedByGeo
      metrics.prunedByTime += stats.prunedByTime
      topK.push(...segmentResults.results)
      if (topK.length >= retainedLimit) trimResultsInPlace(topK, retainedLimit)
    }

    this.lastStats = {
      ...this.emptyStats(),
      lastQueryTimeMs: performance.now() - startedAt,
      distanceComputations: metrics.distanceComputations,
      nodesVisited: metrics.nodesVisited,
      pagesRead: metrics.pagesRead,
      candidatesInspected: metrics.candidatesInspected,
      prunedByGeo: metrics.prunedByGeo,
      prunedByTime: metrics.prunedByTime,
      diskReadBytes: metrics.diskReadBytes,
      diskReadCount: metrics.diskReadCount,
      pageCacheHits: metrics.pageCacheHits,
      pageCacheMisses: metrics.pageCacheMisses,
      loadedPages: this.cache.size,
    }

    return sortResults(topK).slice(offset, offset + limit)
  }

  async stats(): Promise<GeoIndexStats> {
    return this.lastStats
  }

  async validateAgainstBruteForce(query: GeoSearchQuery): Promise<ValidationReport> {
    const manifest = this.manifest
    if (!manifest) {
      return {
        checked: false,
        equal: false,
        comparedWith: 'brute-force',
        message: 'Disk index is not prepared.',
      }
    }
    const points: GeoIndexPoint[] = []
    for (const segment of manifest.segments) {
      const loaded = await this.loadSegment(segment, {
        distanceComputations: 0,
        nodesVisited: 0,
        pagesRead: 0,
        candidatesInspected: 0,
        prunedByGeo: 0,
        prunedByTime: 0,
        diskReadBytes: 0,
        diskReadCount: 0,
        pageCacheHits: 0,
        pageCacheMisses: 0,
      })
      points.push(...loaded.points)
    }
    const oracle = new BruteForceGeoIndex()
    await oracle.build(points)
    const [actual, expected] = await Promise.all([
      this.search(query),
      oracle.search(query),
    ])
    const equal =
      actual.length === expected.length &&
      actual.every(
        (result, index) =>
          result.mediaId === expected[index]?.mediaId &&
          Math.abs(result.distanceMeters - expected[index].distanceMeters) < 1e-6,
      )
    return {
      checked: true,
      equal,
      comparedWith: oracle.id,
      message: equal
        ? 'Result order matches brute force.'
        : 'Result order differs from brute force.',
    }
  }

  private async buildSegment(
    id: string,
    points: GeoIndexPoint[],
    isDelta: boolean,
  ): Promise<SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment | undefined> {
    if (points.length === 0) return undefined
    if (this.id === 'segmented-kd-tree') {
      const index = new SegmentedKdTreeGeoIndex()
      await index.build(points)
      const segment = index.snapshot().segments[0]
      return segment ? { ...segment, id, isDelta } : undefined
    }
    const index = new SegmentedBallTreeGeoIndex()
    await index.build(points)
    const segment = index.snapshot().segments[0]
    return segment ? { ...segment, id, isDelta } : undefined
  }

  private async loadSegment(
    ref: DiskSegmentRef,
    metrics: DiskQueryMetrics,
  ): Promise<SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment> {
    const cached = this.cache.get(ref.id)
    if (cached) {
      metrics.pageCacheHits += 1
      this.cache.delete(ref.id)
      this.cache.set(ref.id, cached)
      return cached.segment
    }
    metrics.pageCacheMisses += 1
    const data = await this.store.readSegment(this.id, ref.id)
    if (!data) throw new Error(`Missing disk index segment ${ref.id}.`)
    metrics.diskReadBytes += data.byteLength
    metrics.diskReadCount += 1
    const segment = decodeSegment(this.id, data)
    this.cache.set(ref.id, { segment, byteLength: data.byteLength })
    while (this.cache.size > MAX_CACHED_SEGMENTS) {
      const firstKey = this.cache.keys().next().value as string | undefined
      if (!firstKey) break
      this.cache.delete(firstKey)
    }
    return segment
  }

  private async searchSegment(
    segment: SegmentedKdTreeSnapshotSegment | SegmentedBallTreeSnapshotSegment,
    query: GeoSearchQuery,
    retainedLimit: number,
  ): Promise<{ results: GeoSearchResult[]; stats: () => Promise<GeoIndexStats> }> {
    const segmentQuery = {
      ...query,
      offset: 0,
      k: retainedLimit,
    }
    if (this.id === 'segmented-kd-tree') {
      const index = new SegmentedKdTreeGeoIndex()
      index.restore(snapshotForSegment(this.id, segment) as SegmentedKdTreeSnapshot)
      const results = await index.search(segmentQuery)
      return { results, stats: () => index.stats() }
    }
    const index = new SegmentedBallTreeGeoIndex()
    index.restore(snapshotForSegment(this.id, segment) as SegmentedBallTreeSnapshot)
    const results = await index.search(segmentQuery)
    return { results, stats: () => index.stats() }
  }

  private pointCount(): number {
    return this.manifest?.pointCount ?? 0
  }

  private deltaSegmentCount(): number {
    return this.manifest?.segments.filter((segment) => segment.isDelta).length ?? 0
  }

  private maxLeafSize(): number {
    return Math.max(0, ...(this.manifest?.segments.map((segment) => segment.maxLeafSize) ?? []))
  }

  private residentBytes(): number {
    return JSON.stringify(this.manifest ?? {}).length
  }

  private indexSizeBytes(): number {
    return this.manifest?.segments.reduce((total, segment) => total + segment.byteLength, 0) ?? 0
  }

  private emptyStats(): GeoIndexStats {
    return {
      engineId: this.id,
      pointCount: this.pointCount(),
      indexSizeBytes: this.indexSizeBytes(),
      residentBytes: this.residentBytes(),
      diskReadBytes: 0,
      diskReadCount: 0,
      pageCacheHits: 0,
      pageCacheMisses: 0,
      loadedPages: this.cache.size,
      indexStorage: 'disk',
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
      segmentCount: this.manifest?.segmentCount ?? 0,
      deltaSegmentCount: this.deltaSegmentCount(),
      loadedSegments: this.cache.size,
      maxLeafSize: this.maxLeafSize(),
      pendingPointCount: 0,
      needsOptimization: this.deltaSegmentCount() >= 8,
    }
  }
}
