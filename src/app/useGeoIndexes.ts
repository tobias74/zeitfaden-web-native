import { useCallback, useEffect, useState } from 'react'
import type {
  CatalogBackend,
  CatalogInfo,
  GeoIndexBuildProgress,
} from '../platform/types'
import type { GeoIndexStats } from '../types'

const defaultStats: GeoIndexStats = {
  engineId: 'none',
  pointCount: 0,
  distanceComputations: 0,
  nodesVisited: 0,
  pagesRead: 0,
  candidatesInspected: 0,
  prunedByGeo: 0,
  prunedByTime: 0,
}

export type UseGeoIndexesOptions = {
  catalog: CatalogBackend
  catalogInfo: CatalogInfo | undefined
  catalogRevision: number
  selectedIndexId: string
  indexCount: number
  onError(message: string): void
}

export function useGeoIndexes({
  catalog,
  catalogInfo,
  catalogRevision,
  selectedIndexId,
  indexCount,
  onError,
}: UseGeoIndexesOptions): {
  geoPointCount: number
  geoIndexVersion: number
  geoIndexProgress: GeoIndexBuildProgress | undefined
  indexStats: GeoIndexStats
  resetIndexState(): void
} {
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [geoIndexProgress, setGeoIndexProgress] =
    useState<GeoIndexBuildProgress>()
  const [indexStats, setIndexStats] = useState<GeoIndexStats>(defaultStats)

  const resetIndexState = useCallback(() => {
    setGeoPointCount(0)
    setGeoIndexVersion(0)
    setGeoIndexProgress(undefined)
    setIndexStats(defaultStats)
  }, [])

  useEffect(() => {
    if (!catalogInfo) {
      const resetTimer = window.setTimeout(resetIndexState, 0)
      return () => window.clearTimeout(resetTimer)
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      setGeoIndexProgress({
        phase: 'loading',
        pointCount: 0,
        builtIndexes: 0,
        totalIndexes: indexCount,
      })

      catalog
        .buildGeoIndexes((progress) => {
          if (!cancelled) setGeoIndexProgress(progress)
        })
        .then(
          (summary) => {
            if (cancelled) return
            setGeoPointCount(summary.pointCount)
            setGeoIndexVersion((version) => version + 1)
          },
          (caught) => {
            if (!cancelled) {
              onError(caught instanceof Error ? caught.message : String(caught))
            }
          },
        )
        .finally(() => {
          if (!cancelled) setGeoIndexProgress(undefined)
        })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [catalog, catalogInfo, catalogRevision, indexCount, onError, resetIndexState])

  useEffect(() => {
    if (!catalogInfo) return

    let cancelled = false
    catalog.getGeoIndexStats(selectedIndexId).then(
      (nextStats) => {
        if (!cancelled) setIndexStats(nextStats)
      },
      (caught) => {
        if (!cancelled) {
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [catalog, catalogInfo, geoIndexVersion, onError, selectedIndexId])

  return {
    geoPointCount,
    geoIndexVersion,
    geoIndexProgress,
    indexStats,
    resetIndexState,
  }
}
