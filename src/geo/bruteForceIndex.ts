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
    let distanceComputations = 0
    let candidatesInspected = 0

    const results = this.points
      .filter((point) => {
        candidatesInspected += 1
        return matchesTimeRange(point.capturedAt, query)
      })
      .map((point) => {
        distanceComputations += 1
        return {
          mediaId: point.mediaId,
          distanceMeters: distanceToQueryMeters(point, query),
        }
      })
      .sort(compareSearchResults)
      .slice(0, Math.max(0, query.k))

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
