import { useCallback, useEffect, useState } from 'react'
import type {
  CatalogBackend,
  CatalogInfo,
  GeoIndexBuildProgress,
} from '../platform/types'
import { traceStartup } from '../lib/startupTrace'
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
  allIndexStats: SearchIndexStats[]
  updateCatalogIndexes(): Promise<void>
  updateIndex(): Promise<void>
  optimizeIndex(): Promise<void>
  resetIndexState(): void
} {
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [geoIndexProgress, setGeoIndexProgress] =
    useState<GeoIndexBuildProgress>()
  const [indexStats, setIndexStats] = useState<SearchIndexStats>(defaultStats)
  const [allIndexStats, setAllIndexStats] = useState<SearchIndexStats[]>([])

  const resetIndexState = useCallback(() => {
    setGeoPointCount(0)
    setGeoIndexVersion(0)
    setGeoIndexProgress(undefined)
    setIndexStats(defaultStats)
    setAllIndexStats([])
  }, [])

  const refreshIndexStats = useCallback(async () => {
    const stats = await catalog.getSearchIndexStats()
    setAllIndexStats(stats)
    const selectedStats =
      stats.find((entry) => entry.engineId === selectedIndexId) ??
      stats.find((entry) => entry.engineId === 'segmented-ball-tree') ??
      defaultStats
    setIndexStats(selectedStats)
    setGeoPointCount(selectedStats.pointCount)
  }, [catalog, selectedIndexId])

  const runIndexBuild = useCallback(
    async (
      forceRebuild: boolean,
      isCancelled: () => boolean = () => false,
      indexId = selectedIndexId,
    ) => {
      if (isCancelled()) return
      const startedAt = performance.now()
      traceStartup('[startup:index-hook]', 'runIndexBuild start', {
        indexId,
        forceRebuild,
      })
      console.log('[geo-index:ui] runIndexBuild start', {
        indexId,
        forceRebuild,
      })
      setGeoIndexProgress({
        phase: 'loading',
        pointCount: 0,
        builtIndexes: 0,
        totalIndexes: 1,
        currentIndexId: indexId,
      })
      try {
        const summary = await (forceRebuild
          ? catalog.rebuildSearchIndex
          : catalog.buildSearchIndexes
        ).call(catalog, indexId, (progress) => {
          traceStartup('[startup:index-hook]', 'runIndexBuild progress', {
            indexId,
            forceRebuild,
            progress,
          })
          if (!isCancelled()) setGeoIndexProgress(progress)
        })
        if (isCancelled()) return
        traceStartup('[startup:index-hook]', 'runIndexBuild complete', {
          indexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          summary,
        })
        console.log('[geo-index:ui] runIndexBuild complete', {
          indexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          summary,
        })
        setGeoPointCount(summary.pointCount)
        setGeoIndexVersion((version) => version + 1)
        await refreshIndexStats()
      } catch (error) {
        traceStartup('[startup:index-hook]', 'runIndexBuild failed', {
          indexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
        console.error('[geo-index:ui] runIndexBuild failed', {
          indexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          error,
        })
        throw error
      } finally {
        traceStartup('[startup:index-hook]', 'runIndexBuild cleanup', {
          indexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          cancelled: isCancelled(),
        })
        if (!isCancelled()) setGeoIndexProgress(undefined)
      }
    },
    [catalog, refreshIndexStats, selectedIndexId],
  )

  const updateIndex = useCallback(async () => {
    await runIndexBuild(false)
  }, [runIndexBuild])

  const updateCatalogIndexes = useCallback(async () => {
    console.log('[geo-index:ui] updateCatalogIndexes clicked', {
      indexId: 'file-time-geo',
      selectedIndexId,
    })
    await runIndexBuild(true, () => false, 'file-time-geo')
  }, [runIndexBuild, selectedIndexId])

  const optimizeIndex = useCallback(async () => {
    await runIndexBuild(true)
  }, [runIndexBuild])

  useEffect(() => {
    const unsubscribe = catalog.onIndexProgress?.((progress) => {
      setGeoIndexProgress(progress)
      if (progress.phase === 'ready') {
        setGeoPointCount(progress.pointCount)
        setGeoIndexVersion((version) => version + 1)
        refreshIndexStats().catch((caught) => {
          onError(caught instanceof Error ? caught.message : String(caught))
        })
        window.setTimeout(() => {
          setGeoIndexProgress((current) => (current === progress ? undefined : current))
        }, 1200)
      }
    })
    return unsubscribe
  }, [catalog, onError, refreshIndexStats])

  useEffect(() => {
    if (!catalogInfo) {
      traceStartup('[startup:index-hook]', 'catalogInfo missing; scheduling index reset', {
        selectedIndexId,
        catalogRevision,
      })
      const resetTimer = window.setTimeout(resetIndexState, 0)
      return () => window.clearTimeout(resetTimer)
    }

    let cancelled = false
    traceStartup('[startup:index-hook]', 'catalogInfo ready; refreshing index status', {
      selectedIndexId,
      catalogRevision,
      catalogInfo,
    })
    const timer = window.setTimeout(() => {
      refreshIndexStats().catch((caught) => {
        if (!cancelled) {
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    }, 0)

    return () => {
      cancelled = true
      traceStartup('[startup:index-hook]', 'index status effect cleanup', {
        selectedIndexId,
        catalogRevision,
      })
      window.clearTimeout(timer)
    }
  }, [
    catalog,
    catalogInfo,
    catalogRevision,
    onError,
    refreshIndexStats,
    resetIndexState,
    selectedIndexId,
  ])

  return {
    geoPointCount,
    geoIndexVersion,
    geoIndexProgress,
    indexStats,
    allIndexStats,
    updateCatalogIndexes,
    updateIndex,
    optimizeIndex,
    resetIndexState,
  }
}
