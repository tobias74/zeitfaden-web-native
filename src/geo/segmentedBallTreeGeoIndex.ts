import { distanceToQueryMeters, haversineMeters } from '../lib/distance'
import { matchesTimeRange, overlapsTimeRange } from '../lib/time'
import type {
  GeoBounds,
  GeoIndexBuildOptions,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  GeoTemporalIndex,
  MediaKind,
  ValidationReport,
} from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'

export type SegmentedBallTreeNode = {
  left?: number
  right?: number
  pointStart: number
  pointEnd: number
  centerLat: number
  centerLon: number
  radiusMeters: number
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
  minTimestamp?: number
  maxTimestamp?: number
  kindMask: number
}

export type SegmentedBallTreeSegment = {
  id: string
  isDelta: boolean
  nodes: SegmentedBallTreeNode[]
  points: GeoIndexPoint[]
  pointCount: number
  maxLeafSize: number
}

export type SegmentedBallTreeSnapshotSegment = SegmentedBallTreeSegment

export type SegmentedBallTreeSnapshot = {
  engineId: 'segmented-ball-tree'
  version: 1
  leafSize: number
  segmentPointLimit: number
  deltaFlushPointLimit: number
  pointCount: number
  segmentCount: number
  segments: SegmentedBallTreeSnapshotSegment[]
  pendingPoints: GeoIndexPoint[]
}

type QueueEntry = {
  segment: SegmentedBallTreeSegment
  nodeIndex: number
  lowerBound: number
}

type QueryMetrics = {
  distanceComputations: number
  nodesVisited: number
  pagesRead: number
  candidatesInspected: number
  prunedByGeo: number
  prunedByTime: number
}

const DISTANCE_TIE_EPSILON_METERS = 1e-6
const DEFAULT_SEGMENT_POINT_LIMIT = 100_000
const DEFAULT_DELTA_FLUSH_POINT_LIMIT = 50_000
const DEFAULT_LEAF_SIZE = 64

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

function matchesKind(point: GeoIndexPoint, query: GeoSearchQuery): boolean {
  if (!query.kind || query.kind === 'all') return true
  if (query.kind === 'media') {
    return point.kind === 'image' || point.kind === 'video'
  }
  return point.kind === query.kind
}

function matchesGeoBounds(point: GeoIndexPoint, query: GeoSearchQuery): boolean {
  if (!query.geoBounds) return true
  return (
    point.lat >= query.geoBounds.minLat &&
    point.lat <= query.geoBounds.maxLat &&
    point.lon >= query.geoBounds.minLon &&
    point.lon <= query.geoBounds.maxLon
  )
}

function nodeOverlapsGeoBounds(
  node: SegmentedBallTreeNode,
  bounds: GeoBounds,
): boolean {
  return !(
    node.latMax < bounds.minLat ||
    node.latMin > bounds.maxLat ||
    node.lonMax < bounds.minLon ||
    node.lonMin > bounds.maxLon
  )
}

function matchesSearchQuery(
  point: GeoIndexPoint,
  query: GeoSearchQuery,
): boolean {
  return (
    matchesTimeRange(point.timestamp, query) &&
    matchesKind(point, query) &&
    matchesGeoBounds(point, query)
  )
}

function compareSearchResults(left: GeoSearchResult, right: GeoSearchResult): number {
  const distanceDelta = left.distanceMeters - right.distanceMeters
  if (Math.abs(distanceDelta) > DISTANCE_TIE_EPSILON_METERS) return distanceDelta
  return left.mediaId.localeCompare(right.mediaId)
}

function insertBoundedResult(
  results: GeoSearchResult[],
  result: GeoSearchResult,
  limit: number,
): void {
  if (limit <= 0) return
  if (
    results.length === limit &&
    compareSearchResults(result, results[results.length - 1]) >= 0
  ) {
    return
  }
  let insertAt = 0
  while (
    insertAt < results.length &&
    compareSearchResults(results[insertAt], result) <= 0
  ) {
    insertAt += 1
  }
  results.splice(insertAt, 0, result)
  if (results.length > limit) results.pop()
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

class MinHeap {
  private readonly items: QueueEntry[] = []

  get length(): number {
    return this.items.length
  }

  push(entry: QueueEntry): void {
    this.items.push(entry)
    this.bubbleUp(this.items.length - 1)
  }

  pop(): QueueEntry | undefined {
    const first = this.items[0]
    const last = this.items.pop()
    if (!first || !last) return first
    if (this.items.length > 0) {
      this.items[0] = last
      this.bubbleDown(0)
    }
    return first
  }

  private compare(a: QueueEntry, b: QueueEntry): number {
    return a.lowerBound - b.lowerBound || a.nodeIndex - b.nodeIndex
  }

  private bubbleUp(index: number): void {
    let current = index
    while (current > 0) {
      const parent = Math.floor((current - 1) / 2)
      if (this.compare(this.items[parent], this.items[current]) <= 0) break
      ;[this.items[parent], this.items[current]] = [
        this.items[current],
        this.items[parent],
      ]
      current = parent
    }
  }

  private bubbleDown(index: number): void {
    let current = index
    while (true) {
      const left = current * 2 + 1
      const right = left + 1
      let smallest = current
      if (
        left < this.items.length &&
        this.compare(this.items[left], this.items[smallest]) < 0
      ) {
        smallest = left
      }
      if (
        right < this.items.length &&
        this.compare(this.items[right], this.items[smallest]) < 0
      ) {
        smallest = right
      }
      if (smallest === current) break
      ;[this.items[current], this.items[smallest]] = [
        this.items[smallest],
        this.items[current],
      ]
      current = smallest
    }
  }
}

export class SegmentedBallTreeGeoIndex implements GeoTemporalIndex {
  readonly id = 'segmented-ball-tree'
  readonly label = 'Segmented ball tree'
  readonly capabilities = {
    exact: true,
    persistent: true,
    incrementalInsert: true,
    incrementalDelete: false,
    supportsTimePruning: true,
  }

  private readonly leafSize: number
  private readonly segmentPointLimit: number
  private readonly deltaFlushPointLimit: number
  private segments: SegmentedBallTreeSegment[] = []
  private pendingPoints = new Map<string, GeoIndexPoint>()
  private lastStats: GeoIndexStats = this.emptyStats()

  constructor({
    leafSize = DEFAULT_LEAF_SIZE,
    segmentPointLimit = DEFAULT_SEGMENT_POINT_LIMIT,
    deltaFlushPointLimit = DEFAULT_DELTA_FLUSH_POINT_LIMIT,
  }: {
    leafSize?: number
    segmentPointLimit?: number
    deltaFlushPointLimit?: number
  } = {}) {
    this.leafSize = leafSize
    this.segmentPointLimit = segmentPointLimit
    this.deltaFlushPointLimit = deltaFlushPointLimit
  }

  async build(
    points: GeoIndexPoint[],
    options?: GeoIndexBuildOptions,
  ): Promise<void> {
    const start = performance.now()
    this.segments = []
    this.pendingPoints.clear()

    const validPoints = points.flatMap((point) => {
      const normalized = this.normalizePoint(point)
      return normalized ? [normalized] : []
    })
    const reportProgress = (processedPoints: number) => {
      options?.onProgress?.({
        indexId: this.id,
        indexLabel: this.label,
        processedPoints,
        totalPoints: validPoints.length,
      })
    }

    reportProgress(0)
    for (
      let offset = 0;
      offset < validPoints.length;
      offset += this.segmentPointLimit
    ) {
      const chunk = validPoints.slice(offset, offset + this.segmentPointLimit)
      const segment = this.buildSegment(
        `segment-${String(this.segments.length).padStart(6, '0')}`,
        chunk,
        false,
      )
      if (segment) this.segments.push(segment)
      reportProgress(Math.min(offset + chunk.length, validPoints.length))
      await yieldToEventLoop()
    }

    this.lastStats = {
      ...this.emptyStats(),
      buildTimeMs: performance.now() - start,
    }
  }

  async insert(point: GeoIndexPoint): Promise<void> {
    await this.insertMany([point])
  }

  async insertMany(points: GeoIndexPoint[]): Promise<void> {
    const start = performance.now()
    for (const point of points) {
      const normalized = this.normalizePoint(point)
      if (normalized) this.pendingPoints.set(normalized.mediaId, normalized)
    }
    if (this.pendingPoints.size >= this.deltaFlushPointLimit) {
      await this.flushPending(0)
    }
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.pointCount(),
      insertTimeMs: performance.now() - start,
      pendingPointCount: this.pendingPoints.size,
      needsOptimization: this.needsOptimization(),
    }
  }

  async flushPending(_catalogEpoch = 0): Promise<void> {
    void _catalogEpoch
    if (this.pendingPoints.size === 0) return
    const points = [...this.pendingPoints.values()]
    this.pendingPoints.clear()
    const segment = this.buildSegment(
      `delta-${Date.now().toString(36)}-${this.segments.length}`,
      points,
      true,
    )
    if (segment) this.segments.push(segment)
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.pointCount(),
      segmentCount: this.segments.length,
      deltaSegmentCount: this.deltaSegmentCount(),
      pendingPointCount: 0,
      maxLeafSize: this.maxLeafSize(),
      needsOptimization: this.needsOptimization(),
    }
  }

  async remove(): Promise<void> {
    this.segments = []
    this.pendingPoints.clear()
    this.lastStats = this.emptyStats()
  }

  async search(query: GeoSearchQuery): Promise<GeoSearchResult[]> {
    const start = performance.now()
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.max(0, Math.trunc(query.k))
    const retainedLimit = offset + limit
    const metrics: QueryMetrics = {
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    }
    if (limit <= 0 || this.pointCount() === 0) {
      this.lastStats = {
        ...this.emptyStats(),
        lastQueryTimeMs: performance.now() - start,
      }
      return []
    }

    const queryWithNormalizedLon = {
      ...query,
      lon: normalizeLon(query.lon),
    }
    const topK: GeoSearchResult[] = []
    const heap = new MinHeap()

    for (const segment of this.segments) {
      if (segment.nodes.length === 0) continue
      this.enqueueNode(segment, 0, queryWithNormalizedLon, metrics, heap)
    }

    while (heap.length > 0) {
      const entry = heap.pop()
      if (!entry) break
      const worst = this.worstDistance(topK, retainedLimit)
      if (topK.length === retainedLimit && entry.lowerBound > worst) {
        metrics.prunedByGeo += heap.length + 1
        break
      }

      const node = entry.segment.nodes[entry.nodeIndex]
      metrics.nodesVisited += 1
      if (typeof node.left === 'number' || typeof node.right === 'number') {
        if (typeof node.left === 'number') {
          this.enqueueNode(
            entry.segment,
            node.left,
            queryWithNormalizedLon,
            metrics,
            heap,
          )
        }
        if (typeof node.right === 'number') {
          this.enqueueNode(
            entry.segment,
            node.right,
            queryWithNormalizedLon,
            metrics,
            heap,
          )
        }
        continue
      }

      metrics.pagesRead += 1
      for (let index = node.pointStart; index < node.pointEnd; index += 1) {
        const point = entry.segment.points[index]
        metrics.candidatesInspected += 1
        if (!matchesSearchQuery(point, queryWithNormalizedLon)) continue
        metrics.distanceComputations += 1
        insertBoundedResult(topK, {
          mediaId: point.mediaId,
          distanceMeters: distanceToQueryMeters(point, queryWithNormalizedLon),
        }, retainedLimit)
      }
    }

    for (const point of this.pendingPoints.values()) {
      metrics.candidatesInspected += 1
      if (!matchesSearchQuery(point, queryWithNormalizedLon)) continue
      metrics.distanceComputations += 1
      insertBoundedResult(topK, {
        mediaId: point.mediaId,
        distanceMeters: distanceToQueryMeters(point, queryWithNormalizedLon),
      }, retainedLimit)
    }

    this.lastStats = {
      ...this.emptyStats(),
      lastQueryTimeMs: performance.now() - start,
      ...metrics,
    }

    return topK.slice(offset, offset + limit)
  }

  async stats(): Promise<GeoIndexStats> {
    return this.lastStats
  }

  snapshot(): SegmentedBallTreeSnapshot {
    return {
      engineId: this.id,
      version: 1,
      leafSize: this.leafSize,
      segmentPointLimit: this.segmentPointLimit,
      deltaFlushPointLimit: this.deltaFlushPointLimit,
      pointCount: this.pointCount(),
      segmentCount: this.segments.length,
      segments: this.segments.map((segment) => ({
        ...segment,
        nodes: segment.nodes.map((node) => ({ ...node })),
        points: segment.points.map((point) => ({ ...point })),
      })),
      pendingPoints: [...this.pendingPoints.values()].map((point) => ({
        ...point,
      })),
    }
  }

  restore(snapshot: SegmentedBallTreeSnapshot): void {
    if (
      snapshot.engineId !== this.id ||
      snapshot.version !== 1 ||
      snapshot.leafSize !== this.leafSize
    ) {
      throw new Error('Segmented ball-tree index snapshot is incompatible.')
    }
    this.segments = snapshot.segments.map((segment) => ({
      ...segment,
      nodes: segment.nodes.map((node) => ({ ...node })),
      points: segment.points.map((point) => ({ ...point })),
    }))
    this.pendingPoints = new Map(
      snapshot.pendingPoints.map((point) => [point.mediaId, point]),
    )
    if (
      snapshot.pointCount !== this.pointCount() ||
      snapshot.segmentCount !== this.segments.length
    ) {
      this.segments = []
      this.pendingPoints.clear()
      throw new Error('Segmented ball-tree index snapshot is incomplete.')
    }
    this.lastStats = {
      ...this.emptyStats(),
      buildTimeMs: 0,
    }
  }

  async validateAgainstBruteForce(
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    const oracle = new BruteForceGeoIndex()
    await oracle.build([
      ...this.segments.flatMap((segment) => segment.points),
      ...this.pendingPoints.values(),
    ])
    const [actual, expected] = await Promise.all([
      this.search(query),
      oracle.search(query),
    ])
    const equal =
      actual.length === expected.length &&
      actual.every(
        (result, index) =>
          result.mediaId === expected[index]?.mediaId &&
          Math.abs(result.distanceMeters - expected[index].distanceMeters) <
            1e-6,
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

  private enqueueNode(
    segment: SegmentedBallTreeSegment,
    nodeIndex: number,
    query: GeoSearchQuery,
    metrics: QueryMetrics,
    heap: MinHeap,
  ): void {
    const node = segment.nodes[nodeIndex]
    if (!node) return
    if (!overlapsTimeRange(node.minTimestamp, node.maxTimestamp, query)) {
      metrics.prunedByTime += 1
      return
    }
    if ((node.kindMask & queryKindMask(query)) === 0) {
      metrics.prunedByGeo += 1
      return
    }
    if (query.geoBounds && !nodeOverlapsGeoBounds(node, query.geoBounds)) {
      metrics.prunedByGeo += 1
      return
    }
    heap.push({
      segment,
      nodeIndex,
      lowerBound: Math.max(
        0,
        haversineMeters(node.centerLat, node.centerLon, query.lat, query.lon) -
          node.radiusMeters,
      ),
    })
  }

  private buildSegment(
    id: string,
    sourcePoints: GeoIndexPoint[],
    isDelta: boolean,
  ): SegmentedBallTreeSegment | undefined {
    const points = sourcePoints.flatMap((point) => {
      const normalized = this.normalizePoint(point)
      return normalized ? [normalized] : []
    })
    if (points.length === 0) return undefined

    const segment: SegmentedBallTreeSegment = {
      id,
      isDelta,
      nodes: [],
      points: [],
      pointCount: points.length,
      maxLeafSize: 0,
    }
    this.buildNode(segment, points)
    return segment
  }

  private buildNode(
    segment: SegmentedBallTreeSegment,
    points: GeoIndexPoint[],
  ): number {
    const rootIndex = segment.nodes.length
    segment.nodes.push(this.nodeForPoints(points))
    const stack: Array<{ nodeIndex: number; points: GeoIndexPoint[] }> = [
      { nodeIndex: rootIndex, points },
    ]

    while (stack.length > 0) {
      const frame = stack.pop()
      if (!frame) break
      const nodeBase = segment.nodes[frame.nodeIndex]

      if (frame.points.length <= this.leafSize) {
        const pointStart = segment.points.length
        const sortedPoints = [...frame.points].sort((a, b) =>
          a.mediaId.localeCompare(b.mediaId),
        )
        segment.points.push(...sortedPoints)
        segment.nodes[frame.nodeIndex] = {
          ...nodeBase,
          pointStart,
          pointEnd: pointStart + sortedPoints.length,
        }
        segment.maxLeafSize = Math.max(
          segment.maxLeafSize,
          sortedPoints.length,
        )
        continue
      }

      const [leftPoints, rightPoints] = this.splitPoints(frame.points, nodeBase)
      if (leftPoints.length === 0 || rightPoints.length === 0) {
        const pointStart = segment.points.length
        const sortedPoints = [...frame.points].sort((a, b) =>
          a.mediaId.localeCompare(b.mediaId),
        )
        segment.points.push(...sortedPoints)
        segment.nodes[frame.nodeIndex] = {
          ...nodeBase,
          pointStart,
          pointEnd: pointStart + sortedPoints.length,
        }
        segment.maxLeafSize = Math.max(
          segment.maxLeafSize,
          sortedPoints.length,
        )
        continue
      }

      const left = segment.nodes.length
      segment.nodes.push(this.nodeForPoints(leftPoints))
      const right = segment.nodes.length
      segment.nodes.push(this.nodeForPoints(rightPoints))
      segment.nodes[frame.nodeIndex] = {
        ...nodeBase,
        left,
        right,
      }
      stack.push({ nodeIndex: right, points: rightPoints })
      stack.push({ nodeIndex: left, points: leftPoints })
    }

    return rootIndex
  }

  private splitPoints(
    points: GeoIndexPoint[],
    node: SegmentedBallTreeNode,
  ): [GeoIndexPoint[], GeoIndexPoint[]] {
    const seed = points[0]
    const pivotA = this.farthestPoint(seed, points)
    const pivotB = this.farthestPoint(pivotA, points)
    const left: GeoIndexPoint[] = []
    const right: GeoIndexPoint[] = []

    for (const point of points) {
      const distanceA = distanceToQueryMeters(point, pivotA)
      const distanceB = distanceToQueryMeters(point, pivotB)
      if (
        distanceA < distanceB ||
        (distanceA === distanceB && point.mediaId <= pivotA.mediaId)
      ) {
        left.push(point)
      } else {
        right.push(point)
      }
    }

    const smallestPartition = Math.min(left.length, right.length)
    const minBalancedPartition = Math.max(1, Math.floor(points.length / 8))
    if (
      left.length > 0 &&
      right.length > 0 &&
      smallestPartition >= minBalancedPartition
    ) {
      return [left, right]
    }

    const axis =
      node.lonMax - node.lonMin > node.latMax - node.latMin ? 'lon' : 'lat'
    const sorted = [...points].sort((a, b) =>
      axis === 'lon'
        ? a.lon - b.lon || a.mediaId.localeCompare(b.mediaId)
        : a.lat - b.lat || a.mediaId.localeCompare(b.mediaId),
    )
    const middle = Math.max(1, Math.floor(sorted.length / 2))
    return [sorted.slice(0, middle), sorted.slice(middle)]
  }

  private farthestPoint(
    from: GeoIndexPoint,
    points: GeoIndexPoint[],
  ): GeoIndexPoint {
    let farthest = points[0]
    let farthestDistance = -1
    for (const point of points) {
      const distance = distanceToQueryMeters(point, from)
      if (
        distance > farthestDistance ||
        (distance === farthestDistance &&
          point.mediaId.localeCompare(farthest.mediaId) < 0)
      ) {
        farthest = point
        farthestDistance = distance
      }
    }
    return farthest
  }

  private nodeForPoints(points: GeoIndexPoint[]): SegmentedBallTreeNode {
    let latMin = Infinity
    let latMax = -Infinity
    let lonMin = Infinity
    let lonMax = -Infinity
    let latSum = 0
    let lonSum = 0
    let minTimestamp: number | undefined
    let maxTimestamp: number | undefined
    let nodeKindMask = 0

    for (const point of points) {
      latMin = Math.min(latMin, point.lat)
      latMax = Math.max(latMax, point.lat)
      lonMin = Math.min(lonMin, point.lon)
      lonMax = Math.max(lonMax, point.lon)
      latSum += point.lat
      lonSum += point.lon
      nodeKindMask |= kindMask(point.kind)
      if (typeof point.timestamp === 'number') {
        minTimestamp =
          typeof minTimestamp === 'number'
            ? Math.min(minTimestamp, point.timestamp)
            : point.timestamp
        maxTimestamp =
          typeof maxTimestamp === 'number'
            ? Math.max(maxTimestamp, point.timestamp)
            : point.timestamp
      }
    }

    const centerLat = latSum / points.length
    const centerLon = normalizeLon(lonSum / points.length)
    const center = { lat: centerLat, lon: centerLon }
    let radiusMeters = 0
    for (const point of points) {
      radiusMeters = Math.max(
        radiusMeters,
        distanceToQueryMeters(point, center),
      )
    }

    return {
      pointStart: 0,
      pointEnd: 0,
      centerLat,
      centerLon,
      radiusMeters,
      latMin,
      latMax,
      lonMin,
      lonMax,
      minTimestamp,
      maxTimestamp,
      kindMask: nodeKindMask,
    }
  }

  private normalizePoint(point: GeoIndexPoint): GeoIndexPoint | undefined {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return undefined
    }
    return {
      ...point,
      lon: normalizeLon(point.lon),
    }
  }

  private worstDistance(results: GeoSearchResult[], limit: number): number {
    if (limit <= 0 || results.length !== limit) return Infinity
    return results[results.length - 1]?.distanceMeters ?? Infinity
  }

  private pointCount(): number {
    return (
      this.segments.reduce((total, segment) => total + segment.pointCount, 0) +
      this.pendingPoints.size
    )
  }

  private deltaSegmentCount(): number {
    return this.segments.filter((segment) => segment.isDelta).length
  }

  private maxLeafSize(): number {
    return this.segments.reduce(
      (max, segment) => Math.max(max, segment.maxLeafSize),
      0,
    )
  }

  private estimateSizeBytes(): number {
    const nodeCount = this.segments.reduce(
      (total, segment) => total + segment.nodes.length,
      0,
    )
    return this.pointCount() * 48 + nodeCount * 120
  }

  private needsOptimization(): boolean {
    return this.deltaSegmentCount() >= 8 || this.maxLeafSize() > this.leafSize
  }

  private emptyStats(): GeoIndexStats {
    return {
      engineId: this.id,
      pointCount: this.pointCount(),
      indexSizeBytes: this.estimateSizeBytes(),
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
      segmentCount: this.segments.length,
      deltaSegmentCount: this.deltaSegmentCount(),
      loadedSegments: this.segments.length,
      maxLeafSize: this.maxLeafSize(),
      pendingPointCount: this.pendingPoints.size,
      needsOptimization: this.needsOptimization(),
    }
  }
}
