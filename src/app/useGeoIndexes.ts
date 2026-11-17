import { useEffect, useRef, useState } from 'react'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import type { SearchIndexStats } from '../types'

export const CATALOG_INDEX_ID = 'file-time-geo'
export const DISTANCE_INDEX_ID = 'segmented-ball-tree'
const BRUTE_FORCE_INDEX_ID = 'brute-force'
const maintainedIndexes = [CATALOG_INDEX_ID, DISTANCE_INDEX_ID]

type IndexUpdate =
  | { phase: 'updating' }
  | { phase: 'ready' }
  | { phase: 'failed'; message: string }

type IndexSnapshot = {
  catalogInfo: CatalogInfo
  revision: number
  stats: SearchIndexStats[]
  bruteForceReady: boolean
}

type UseGeoIndexesOptions = {
  catalog: CatalogBackend
  catalogInfo: CatalogInfo | undefined
  catalogRevision: number
  catalogBusy: boolean
  selectedIndexId: string
}

export function useGeoIndexes({
  catalog,
  catalogInfo,
  catalogRevision,
  catalogBusy,
  selectedIndexId,
}: UseGeoIndexesOptions) {
  const [snapshot, setSnapshot] = useState<IndexSnapshot>()
  const [update, setUpdate] = useState<IndexUpdate>()
  const [retry, setRetry] = useState(0)
  const runningUpdate = useRef(Promise.resolve())
  const bruteForceBuild = useRef<Pick<IndexSnapshot, 'catalogInfo' | 'revision'>>(
    undefined,
  )
  const needsBruteForce = selectedIndexId === BRUTE_FORCE_INDEX_ID

  useEffect(() => {
    if (!catalogInfo || catalogBusy) return

    const currentCatalog = { catalogInfo, revision: catalogRevision }
    let cancelled = false

    async function updateIndexes() {
      if (cancelled) return

      let stats: SearchIndexStats[] = []
      let bruteForceReady =
        bruteForceBuild.current?.catalogInfo === catalogInfo &&
        bruteForceBuild.current?.revision === catalogRevision
      const publish = () => {
        setSnapshot({ ...currentCatalog, stats, bruteForceReady })
      }

      try {
        stats = await catalog.getSearchIndexStats()
        if (cancelled) return
        const pending = maintainedIndexes.filter((id) =>
          stats.find((entry) => entry.engineId === id)?.indexStatus !== 'current',
        )
        const buildBruteForce = needsBruteForce && !bruteForceReady
        if (pending.length === 0 && !buildBruteForce) {
          publish()
          setUpdate(undefined)
          return
        }

        setUpdate({ phase: 'updating' })
        publish()
        for (const indexId of pending) {
          const status = stats.find((entry) => entry.engineId === indexId)?.indexStatus
          if (status === 'current') continue
          if (status === 'failed') {
            await catalog.rebuildSearchIndex(indexId)
          } else {
            await catalog.buildSearchIndexes(indexId)
          }
          if (cancelled) return
          stats = await catalog.getSearchIndexStats()
          if (cancelled) return
          if (stats.find((entry) => entry.engineId === indexId)?.indexStatus !== 'current') {
            throw new Error(`Index ${indexId} is still out of date.`)
          }
          publish()
        }

        if (buildBruteForce) {
          await catalog.buildSearchIndexes(BRUTE_FORCE_INDEX_ID)
          bruteForceBuild.current = currentCatalog
          if (cancelled) return
          bruteForceReady = true
          stats = await catalog.getSearchIndexStats()
          if (cancelled) return
          publish()
        }
        setUpdate({ phase: 'ready' })
      } catch (error) {
        if (cancelled) return
        publish()
        setUpdate({
          phase: 'failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const timer = window.setTimeout(() => {
      runningUpdate.current = runningUpdate.current.then(updateIndexes)
    }, 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [catalog, catalogBusy, catalogInfo, catalogRevision, needsBruteForce, retry])

  useEffect(() => {
    if (update?.phase !== 'ready') return
    const timer = window.setTimeout(() => setUpdate(undefined), 2_500)
    return () => window.clearTimeout(timer)
  }, [update])

  const currentSnapshot =
    snapshot?.catalogInfo === catalogInfo && snapshot?.revision === catalogRevision
      ? snapshot
      : undefined
  const catalogIndex = currentSnapshot?.stats.find((entry) => entry.engineId === CATALOG_INDEX_ID)
  const distanceIndex = currentSnapshot?.stats.find((entry) => entry.engineId === selectedIndexId)
  const catalogIndexReady = !catalogBusy && catalogIndex?.indexStatus === 'current'
  const distanceIndexReady = !catalogBusy && (
    needsBruteForce
      ? currentSnapshot?.bruteForceReady === true
      : distanceIndex?.indexStatus === 'current'
  )

  return {
    catalogIndex,
    catalogIndexReady,
    distanceIndex,
    distanceIndexReady,
    update,
    updating: Boolean(catalogInfo) && (!currentSnapshot || update?.phase === 'updating'),
    retryUpdate: () => setRetry((value) => value + 1),
  }
}
