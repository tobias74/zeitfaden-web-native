import { distanceToQueryMeters } from '../lib/distance'
import { matchesTimeRange } from '../lib/time'
import type {
  GeoIndexBuildOptions,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  GeoTemporalIndex,
  ValidationReport,
} from '../types'

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

function compareSearchResults(
  a: GeoSearchResult,
  b: GeoSearchResult,
): number {
  const distanceDelta = a.distanceMeters - b.distanceMeters
  if (Math.abs(distanceDelta) > DISTANCE_TIE_EPSILON_METERS) {
    return distanceDelta
  }
  return a.mediaId.localeCompare(b.mediaId)
}

export class BruteForceGeoIndex implements GeoTemporalIndex {
  readonly id = 'brute-force'
  readonly label = 'Brute force oracle'
  readonly capabilities = {
    exact: true,
    persistent: false,
    incrementalInsert: true,
    incrementalDelete: true,
    supportsTimePruning: false,
  }

  private points: GeoIndexPoint[] = []
  private lastStats: GeoIndexStats = this.emptyStats()

  async build(
    points: GeoIndexPoint[],
    options?: GeoIndexBuildOptions,
  ): Promise<void> {
    const start = performance.now()
    options?.onProgress?.({
      indexId: this.id,
      indexLabel: this.label,
      processedPoints: 0,
      totalPoints: points.length,
    })
    this.points = [...points].sort((a, b) => a.mediaId.localeCompare(b.mediaId))
    options?.onProgress?.({
      indexId: this.id,
      indexLabel: this.label,
      processedPoints: points.length,
      totalPoints: points.length,
    })
    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.points.length,
      buildTimeMs: performance.now() - start,
    }
  }

  async insert(point: GeoIndexPoint): Promise<void> {
    const start = performance.now()
    this.points = [
      ...this.points.filter((candidate) => candidate.mediaId !== point.mediaId),
      point,
    ].sort((a, b) => a.mediaId.localeCompare(b.mediaId))
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.points.length,
      insertTimeMs: performance.now() - start,
    }
  }

  async insertMany(points: GeoIndexPoint[]): Promise<void> {
    const start = performance.now()
    const incomingIds = new Set(points.map((point) => point.mediaId))
    this.points = [
      ...this.points.filter((point) => !incomingIds.has(point.mediaId)),
      ...points,
    ].sort((a, b) => a.mediaId.localeCompare(b.mediaId))
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.points.length,
      insertTimeMs: performance.now() - start,
    }
  }

  async flushPending(_catalogEpoch = 0): Promise<void> {
    void _catalogEpoch
    // Brute force keeps all points in memory immediately.
  }

  async remove(mediaId: string): Promise<void> {
    const start = performance.now()
    this.points = this.points.filter((point) => point.mediaId !== mediaId)
    this.lastStats = {
      ...this.lastStats,
      pointCount: this.points.length,
      deleteTimeMs: performance.now() - start,
    }
  }

  async search(query: GeoSearchQuery): Promise<GeoSearchResult[]> {
    const start = performance.now()
    const offset = Math.max(0, Math.trunc(query.offset ?? 0))
    const limit = Math.max(0, Math.trunc(query.k))
    let distanceComputations = 0
    let candidatesInspected = 0

    const results = this.points
      .filter((point) => {
        candidatesInspected += 1
        return matchesSearchQuery(point, query)
      })
      .map((point) => {
        distanceComputations += 1
        return {
          mediaId: point.mediaId,
          distanceMeters: distanceToQueryMeters(point, query),
        }
      })
      .sort(compareSearchResults)
      .slice(offset, offset + limit)

    this.lastStats = {
      ...this.emptyStats(),
      pointCount: this.points.length,
      lastQueryTimeMs: performance.now() - start,
      distanceComputations,
      candidatesInspected,
    }

    return results
  }

  async stats(): Promise<GeoIndexStats> {
    return this.lastStats
  }

  async validateAgainstBruteForce(): Promise<ValidationReport> {
    return {
      checked: true,
      equal: true,
      comparedWith: this.id,
      message: 'Brute force is the comparison baseline.',
    }
  }

  protected emptyStats(): GeoIndexStats {
    return {
      engineId: this.id,
      pointCount: this.points.length,
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    }
  }
}
