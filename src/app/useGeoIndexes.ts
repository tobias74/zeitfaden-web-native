import { useCallback, useEffect, useState } from 'react'
import type {
  CatalogBackend,
  CatalogInfo,
  GeoIndexBuildProgress,
} from '../platform/types'
import type { SearchIndexStats } from '../types'

const defaultStats: SearchIndexStats = {
  engineId: 'none',
  engineLabel: 'None',
  exact: true,
  persistent: true,
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
  onError(message: string): void
}

export function useGeoIndexes({
  catalog,
  catalogInfo,
  catalogRevision,
  selectedIndexId,
  onError,
}: UseGeoIndexesOptions): {
  geoPointCount: number
  geoIndexVersion: number
  geoIndexProgress: GeoIndexBuildProgress | undefined
  indexStats: SearchIndexStats
  optimizeIndex(): Promise<void>
  resetIndexState(): void
} {
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [geoIndexProgress, setGeoIndexProgress] =
    useState<GeoIndexBuildProgress>()
  const [indexStats, setIndexStats] = useState<SearchIndexStats>(defaultStats)

  const resetIndexState = useCallback(() => {
    setGeoPointCount(0)
    setGeoIndexVersion(0)
    setGeoIndexProgress(undefined)
    setIndexStats(defaultStats)
  }, [])

  const runIndexBuild = useCallback(
    async (forceRebuild: boolean, isCancelled: () => boolean = () => false) => {
      if (isCancelled()) return
      setGeoIndexProgress({
        phase: 'loading',
        pointCount: 0,
        builtIndexes: 0,
        totalIndexes: 1,
        currentIndexId: selectedIndexId,
      })
      try {
        const summary = await (forceRebuild
          ? catalog.rebuildSearchIndex
          : catalog.buildSearchIndexes
        ).call(catalog, selectedIndexId, (progress) => {
          if (!isCancelled()) setGeoIndexProgress(progress)
        })
        if (isCancelled()) return
        setGeoPointCount(summary.pointCount)
        setGeoIndexVersion((version) => version + 1)
      } finally {
        if (!isCancelled()) setGeoIndexProgress(undefined)
      }
    },
    [catalog, selectedIndexId],
  )

  const optimizeIndex = useCallback(async () => {
    await runIndexBuild(true)
  }, [runIndexBuild])

  useEffect(() => {
    if (!catalogInfo) {
      const resetTimer = window.setTimeout(resetIndexState, 0)
      return () => window.clearTimeout(resetTimer)
    }

    let cancelled = false
    const timer = window.setTimeout(() => {
      runIndexBuild(false, () => cancelled).catch((caught) => {
        if (!cancelled) {
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [
    catalog,
    catalogInfo,
    catalogRevision,
    onError,
    resetIndexState,
    runIndexBuild,
    selectedIndexId,
  ])

  useEffect(() => {
    if (!catalogInfo) return

    let cancelled = false
    catalog.getSearchIndexStats().then(
      (nextStats) => {
        if (!cancelled) {
          setIndexStats(
            nextStats.find((stats) => stats.engineId === selectedIndexId) ??
              nextStats[0] ??
              defaultStats,
          )
        }
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
    optimizeIndex,
    resetIndexState,
  }
}
