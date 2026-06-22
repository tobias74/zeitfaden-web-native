import { distanceToQueryMeters } from '../lib/distance'
import { matchesTimeRange, overlapsTimeRange } from '../lib/time'
import type {
  GeoIndexBuildOptions,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  GeoTemporalIndex,
  ValidationReport,
} from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'

type Cell = {
  key: string
  z: number
  x: number
  y: number
  latMin: number
  latMax: number
  lonMin: number
  lonMax: number
  minTimestamp?: number
  maxTimestamp?: number
  points: Map<string, GeoIndexPoint>
}

export type DynamicZOrderSnapshotCell = Omit<Cell, 'points'> & {
  points: GeoIndexPoint[]
}

export type DynamicZOrderGeoIndexSnapshot = {
  engineId: 'dynamic-z-order-cells'
  version: 1
  resolution: number
  pointCount: number
  cellCount: number
  cells: DynamicZOrderSnapshotCell[]
}

type CellCandidate = {
  cell: Cell
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

const EARTH_RADIUS_METERS = 6_371_008.8
const DEFAULT_RESOLUTION = 10
const DISTANCE_TIE_EPSILON_METERS = 1e-6

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

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180
}

function normalizeLon(lon: number): number {
  const normalized = ((((lon + 180) % 360) + 360) % 360) - 180
  return normalized === -180 ? 180 : normalized
}

function interleaveMorton(x: number, y: number): number {
  let z = 0
  for (let bit = 0; bit < 16; bit += 1) {
    z |= ((x >> bit) & 1) << (2 * bit)
    z |= ((y >> bit) & 1) << (2 * bit + 1)
  }
  return z
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

function replaceResultsInPlace(
  target: GeoSearchResult[],
  source: GeoSearchResult[],
): void {
  target.length = source.length
  for (let index = 0; index < source.length; index += 1) {
    target[index] = source[index]
  }
}

function trimResultsInPlace(results: GeoSearchResult[], limit: number): void {
  replaceResultsInPlace(results, sortResults(results).slice(0, limit))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

export class DynamicZOrderGeoIndex implements GeoTemporalIndex {
  readonly id = 'dynamic-z-order-cells'
  readonly label = 'Dynamic Z-order cells'
  readonly capabilities = {
    exact: true,
    persistent: true,
    incrementalInsert: true,
    incrementalDelete: true,
    supportsTimePruning: true,
  }

  private readonly resolution: number
  private readonly axisSize: number
  private readonly pointsById = new Map<string, GeoIndexPoint>()
  private readonly pointCellKey = new Map<string, string>()
  private readonly cells = new Map<string, Cell>()
  private lastStats: GeoIndexStats = this.emptyStats()

  constructor(resolution = DEFAULT_RESOLUTION) {
    this.resolution = resolution
    this.axisSize = 2 ** resolution
  }

  async build(
    points: GeoIndexPoint[],
    options?: GeoIndexBuildOptions,
  ): Promise<void> {
    const start = performance.now()
    this.pointsById.clear()
    this.pointCellKey.clear()
    this.cells.clear()

    const yieldEvery = Math.max(1, options?.yieldEvery ?? 2_000)
    const reportProgress = (processedPoints: number) => {
      options?.onProgress?.({
        indexId: this.id,
        indexLabel: this.label,
        processedPoints,
        totalPoints: points.length,
      })
    }

    reportProgress(0)
    let processedPoints = 0
    for (const point of points) {
      this.insertInternal(point)
      processedPoints += 1
      if (processedPoints % yieldEvery === 0) {
        reportProgress(processedPoints)
        await yieldToEventLoop()
      }
    }
    reportProgress(points.length)

    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      buildTimeMs: performance.now() - start,
    }
  }

  async insert(point: GeoIndexPoint): Promise<void> {
    const start = performance.now()
    this.insertInternal(point)
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      insertTimeMs: performance.now() - start,
    }
  }

  async insertMany(points: GeoIndexPoint[]): Promise<void> {
    const start = performance.now()
    for (const point of points) {
      this.insertInternal(point)
    }
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      insertTimeMs: performance.now() - start,
    }
  }

  async flushPending(_catalogEpoch = 0): Promise<void> {
    void _catalogEpoch
    // Dynamic Z-order inserts directly into its active cells.
  }

  async remove(mediaId: string): Promise<void> {
    const start = performance.now()
    this.removeInternal(mediaId)
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      deleteTimeMs: performance.now() - start,
    }
  }

  async search(query: GeoSearchQuery): Promise<GeoSearchResult[]> {
    const start = performance.now()
    const metrics: QueryMetrics = {
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    }

    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.max(0, Math.trunc(query.k))
    const retainedLimit = offset + limit
    if (limit <= 0 || this.cells.size === 0) {
      this.lastStats = {
        ...this.emptyStats(),
        lastQueryTimeMs: performance.now() - start,
      }
      return []
    }

    const candidates: CellCandidate[] = []
    for (const cell of this.cells.values()) {
      if (!overlapsTimeRange(cell.minTimestamp, cell.maxTimestamp, query)) {
        metrics.prunedByTime += 1
        continue
      }

      candidates.push({
        cell,
        lowerBound: this.cellLowerBoundMeters(cell, query),
      })
    }

    candidates.sort(
      (a, b) => a.lowerBound - b.lowerBound || a.cell.z - b.cell.z,
    )

    const topK: GeoSearchResult[] = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const worst =
        topK.length === retainedLimit
          ? topK[topK.length - 1].distanceMeters
          : Infinity

      if (topK.length === retainedLimit && candidate.lowerBound > worst) {
        metrics.prunedByGeo += candidates.length - index
        break
      }

      metrics.nodesVisited += 1
      metrics.pagesRead += 1

      const points = [...candidate.cell.points.values()].sort((a, b) =>
        a.mediaId.localeCompare(b.mediaId),
      )
      for (const point of points) {
        metrics.candidatesInspected += 1
        if (!matchesSearchQuery(point, query)) continue

        metrics.distanceComputations += 1
        topK.push({
          mediaId: point.mediaId,
          distanceMeters: distanceToQueryMeters(point, query),
        })
        if (topK.length >= retainedLimit) {
          trimResultsInPlace(topK, retainedLimit)
        }
      }
    }

    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      lastQueryTimeMs: performance.now() - start,
      ...metrics,
    }

    return sortResults(topK).slice(offset, offset + limit)
  }

  async stats(): Promise<GeoIndexStats> {
    return this.lastStats
  }

  snapshot(): DynamicZOrderGeoIndexSnapshot {
    const cells = [...this.cells.values()]
      .sort((a, b) => a.z - b.z || a.key.localeCompare(b.key))
      .map((cell) => ({
        key: cell.key,
        z: cell.z,
        x: cell.x,
        y: cell.y,
        latMin: cell.latMin,
        latMax: cell.latMax,
        lonMin: cell.lonMin,
        lonMax: cell.lonMax,
        minTimestamp: cell.minTimestamp,
        maxTimestamp: cell.maxTimestamp,
        points: [...cell.points.values()].sort((a, b) =>
          a.mediaId.localeCompare(b.mediaId),
        ),
      }))

    return {
      engineId: this.id,
      version: 1,
      resolution: this.resolution,
      pointCount: this.pointsById.size,
      cellCount: cells.length,
      cells,
    }
  }

  restore(snapshot: DynamicZOrderGeoIndexSnapshot): void {
    if (
      snapshot.engineId !== this.id ||
      snapshot.version !== 1 ||
      snapshot.resolution !== this.resolution
    ) {
      throw new Error('Dynamic Z-order index snapshot is incompatible.')
    }

    this.pointsById.clear()
    this.pointCellKey.clear()
    this.cells.clear()

    for (const snapshotCell of snapshot.cells) {
      const cell: Cell = {
        key: snapshotCell.key,
        z: snapshotCell.z,
        x: snapshotCell.x,
        y: snapshotCell.y,
        latMin: snapshotCell.latMin,
        latMax: snapshotCell.latMax,
        lonMin: snapshotCell.lonMin,
        lonMax: snapshotCell.lonMax,
        minTimestamp: snapshotCell.minTimestamp,
        maxTimestamp: snapshotCell.maxTimestamp,
        points: new Map(),
      }

      for (const point of snapshotCell.points) {
        const normalizedPoint = {
          ...point,
          lon: normalizeLon(point.lon),
        }
        cell.points.set(normalizedPoint.mediaId, normalizedPoint)
        this.pointsById.set(normalizedPoint.mediaId, normalizedPoint)
        this.pointCellKey.set(normalizedPoint.mediaId, cell.key)
      }

      this.cells.set(cell.key, cell)
    }

    if (
      snapshot.pointCount !== this.pointsById.size ||
      snapshot.cellCount !== this.cells.size
    ) {
      this.pointsById.clear()
      this.pointCellKey.clear()
      this.cells.clear()
      throw new Error('Dynamic Z-order index snapshot is incomplete.')
    }

    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      buildTimeMs: 0,
    }
  }

  async validateAgainstBruteForce(
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    const oracle = new BruteForceGeoIndex()
    await oracle.build([...this.pointsById.values()])
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

  private insertInternal(point: GeoIndexPoint): void {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return

    this.removeInternal(point.mediaId)
    const normalizedPoint = {
      ...point,
      lon: normalizeLon(point.lon),
    }
    const cell = this.getOrCreateCell(normalizedPoint)
    cell.points.set(normalizedPoint.mediaId, normalizedPoint)
    this.pointsById.set(normalizedPoint.mediaId, normalizedPoint)
    this.pointCellKey.set(normalizedPoint.mediaId, cell.key)
    this.updateCellTimeRangeWithPoint(cell, normalizedPoint)
  }

  private removeInternal(mediaId: string): void {
    const oldCellKey = this.pointCellKey.get(mediaId)
    if (!oldCellKey) return

    const cell = this.cells.get(oldCellKey)
    cell?.points.delete(mediaId)
    this.pointsById.delete(mediaId)
    this.pointCellKey.delete(mediaId)

    if (!cell) return
    if (cell.points.size === 0) {
      this.cells.delete(cell.key)
    } else {
      this.recomputeCellTimeRange(cell)
    }
  }

  private getOrCreateCell(point: GeoIndexPoint): Cell {
    const { x, y, z, key } = this.cellAddress(point)
    const existing = this.cells.get(key)
    if (existing) return existing

    const latStep = 180 / this.axisSize
    const lonStep = 360 / this.axisSize
    const cell: Cell = {
      key,
      z,
      x,
      y,
      latMin: y * latStep - 90,
      latMax: (y + 1) * latStep - 90,
      lonMin: x * lonStep - 180,
      lonMax: (x + 1) * lonStep - 180,
      points: new Map(),
    }
    this.cells.set(key, cell)
    return cell
  }

  private cellAddress(point: GeoIndexPoint): {
    x: number
    y: number
    z: number
    key: string
  } {
    const x = clampIndex(
      Math.floor(((normalizeLon(point.lon) + 180) / 360) * this.axisSize),
      this.axisSize,
    )
    const y = clampIndex(
      Math.floor(((point.lat + 90) / 180) * this.axisSize),
      this.axisSize,
    )
    const z = interleaveMorton(x, y)
    return { x, y, z, key: `${this.resolution}:${z}` }
  }

  private recomputeCellTimeRange(cell: Cell): void {
    cell.minTimestamp = undefined
    cell.maxTimestamp = undefined
    for (const point of cell.points.values()) {
      this.updateCellTimeRangeWithPoint(cell, point)
    }
  }

  private updateCellTimeRangeWithPoint(cell: Cell, point: GeoIndexPoint): void {
    if (typeof point.timestamp !== 'number') return
    if (
      typeof cell.minTimestamp !== 'number' ||
      point.timestamp < cell.minTimestamp
    ) {
      cell.minTimestamp = point.timestamp
    }
    if (
      typeof cell.maxTimestamp !== 'number' ||
      point.timestamp > cell.maxTimestamp
    ) {
      cell.maxTimestamp = point.timestamp
    }
  }

  private cellLowerBoundMeters(
    cell: Pick<Cell, 'latMin' | 'latMax'>,
    query: Pick<GeoSearchQuery, 'lat'>,
  ): number {
    if (query.lat < cell.latMin) {
      return EARTH_RADIUS_METERS * toRadians(cell.latMin - query.lat)
    }
    if (query.lat > cell.latMax) {
      return EARTH_RADIUS_METERS * toRadians(query.lat - cell.latMax)
    }
    return 0
  }

  private estimateSizeBytes(): number {
    return this.pointsById.size * 48 + this.cells.size * 96
  }

  private emptyStats(): GeoIndexStats {
    return {
      engineId: this.id,
      pointCount: this.pointsById.size,
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    }
  }
}

function clampIndex(value: number, axisSize: number): number {
  return Math.min(Math.max(value, 0), axisSize - 1)
}
