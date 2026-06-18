import { distanceToQueryMeters } from '../lib/distance'
import { matchesTimeRange, overlapsTimeRange } from '../lib/time'
import type {
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
  minCapturedAt?: number
  maxCapturedAt?: number
  points: Map<string, GeoIndexPoint>
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

export class DynamicZOrderGeoIndex implements GeoTemporalIndex {
  readonly id = 'dynamic-z-order-cells'
  readonly label = 'Dynamic Z-order cells'
  readonly capabilities = {
    exact: true,
    persistent: false,
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

  async build(points: GeoIndexPoint[]): Promise<void> {
    const start = performance.now()
    this.pointsById.clear()
    this.pointCellKey.clear()
    this.cells.clear()

    for (const point of points) {
      this.insertInternal(point)
    }

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

    if (query.k <= 0 || this.cells.size === 0) {
      this.lastStats = {
        ...this.emptyStats(),
        lastQueryTimeMs: performance.now() - start,
      }
      return []
    }

    const candidates: CellCandidate[] = []
    for (const cell of this.cells.values()) {
      if (!overlapsTimeRange(cell.minCapturedAt, cell.maxCapturedAt, query)) {
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
        topK.length === query.k ? topK[topK.length - 1].distanceMeters : Infinity

      if (topK.length === query.k && candidate.lowerBound > worst) {
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
        if (!matchesTimeRange(point.capturedAt, query)) continue

        metrics.distanceComputations += 1
        topK.push({
          mediaId: point.mediaId,
          distanceMeters: distanceToQueryMeters(point, query),
        })
        topK.splice(0, topK.length, ...sortResults(topK).slice(0, query.k))
      }
    }

    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.pointsById.size,
      indexSizeBytes: this.estimateSizeBytes(),
      lastQueryTimeMs: performance.now() - start,
      ...metrics,
    }

    return sortResults(topK)
  }

  async stats(): Promise<GeoIndexStats> {
    return this.lastStats
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
    this.recomputeCellTimeRange(cell)
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
    const times = [...cell.points.values()]
      .map((point) => point.capturedAt)
      .filter((time): time is number => typeof time === 'number')

    cell.minCapturedAt = times.length > 0 ? Math.min(...times) : undefined
    cell.maxCapturedAt = times.length > 0 ? Math.max(...times) : undefined
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
