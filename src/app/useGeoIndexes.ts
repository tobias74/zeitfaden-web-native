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
  optimizeIndex(): Promise<void>
  resetIndexState(): void
} {
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [geoIndexProgress, setGeoIndexProgress] =
    useState<GeoIndexBuildProgress>()

  const resetIndexState = useCallback(() => {
    setGeoPointCount(0)
    setGeoIndexVersion(0)
    setGeoIndexProgress(undefined)
  }, [])

  const runIndexBuild = useCallback(
    async (forceRebuild: boolean, isCancelled: () => boolean = () => false) => {
      if (isCancelled()) return
      const startedAt = performance.now()
      traceStartup('[startup:index-hook]', 'runIndexBuild start', {
        selectedIndexId,
        forceRebuild,
      })
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
          traceStartup('[startup:index-hook]', 'runIndexBuild progress', {
            selectedIndexId,
            forceRebuild,
            progress,
          })
          if (!isCancelled()) setGeoIndexProgress(progress)
        })
        if (isCancelled()) return
        traceStartup('[startup:index-hook]', 'runIndexBuild complete', {
          selectedIndexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          summary,
        })
        setGeoPointCount(summary.pointCount)
        setGeoIndexVersion((version) => version + 1)
      } catch (error) {
        traceStartup('[startup:index-hook]', 'runIndexBuild failed', {
          selectedIndexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      } finally {
        traceStartup('[startup:index-hook]', 'runIndexBuild cleanup', {
          selectedIndexId,
          forceRebuild,
          elapsedMs: performance.now() - startedAt,
          cancelled: isCancelled(),
        })
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
      traceStartup('[startup:index-hook]', 'catalogInfo missing; scheduling index reset', {
        selectedIndexId,
        catalogRevision,
      })
      const resetTimer = window.setTimeout(resetIndexState, 0)
      return () => window.clearTimeout(resetTimer)
    }

    let cancelled = false
    traceStartup('[startup:index-hook]', 'catalogInfo ready; scheduling index build', {
      selectedIndexId,
      catalogRevision,
      catalogInfo,
    })
    const timer = window.setTimeout(() => {
      traceStartup('[startup:index-hook]', 'scheduled index build timer fired', {
        selectedIndexId,
        catalogRevision,
      })
      runIndexBuild(false, () => cancelled).catch((caught) => {
        if (!cancelled) {
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    }, 0)

    return () => {
      cancelled = true
      traceStartup('[startup:index-hook]', 'index build effect cleanup', {
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
    resetIndexState,
    runIndexBuild,
    selectedIndexId,
  ])

  return {
    geoPointCount,
    geoIndexVersion,
    geoIndexProgress,
    indexStats: defaultStats,
    optimizeIndex,
    resetIndexState,
  }
}
