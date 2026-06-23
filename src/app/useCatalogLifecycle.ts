import { useCallback, useEffect, useState } from 'react'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import { traceStartup } from '../lib/startupTrace'

export type UseCatalogLifecycleOptions = {
  catalog: CatalogBackend
  onError(message: string): void
  onInitFailed(): void
}

export function useCatalogLifecycle({
  catalog,
  onError,
  onInitFailed,
}: UseCatalogLifecycleOptions): {
  catalogInfo: CatalogInfo | undefined
  catalogReady: boolean
  catalogRevision: number
  markCatalogChanged(): void
  resetCatalogState(): void
} {
  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [catalogRevision, setCatalogRevision] = useState(0)

  const markCatalogChanged = useCallback(() => {
    setCatalogRevision((revision) => revision + 1)
  }, [])

  const resetCatalogState = useCallback(() => {
    setCatalogInfo(undefined)
    setCatalogRevision(0)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function boot() {
      const startedAt = performance.now()
      traceStartup('[startup:catalog]', 'catalog init start')
      try {
        const info = await catalog.init()
        if (cancelled) return
        traceStartup('[startup:catalog]', 'catalog init complete', {
          elapsedMs: performance.now() - startedAt,
          info,
        })
        setCatalogInfo(info)
      } catch (caught) {
        if (!cancelled) {
          traceStartup('[startup:catalog]', 'catalog init failed', {
            elapsedMs: performance.now() - startedAt,
            error: caught instanceof Error ? caught.message : String(caught),
          })
          onError(caught instanceof Error ? caught.message : String(caught))
          onInitFailed()
        }
      }
    }

    boot()

    return () => {
      cancelled = true
      traceStartup('[startup:catalog]', 'catalog init effect cleanup')
    }
  }, [catalog, onError, onInitFailed])

  return {
    catalogInfo,
    catalogReady: Boolean(catalogInfo),
    catalogRevision,
    markCatalogChanged,
    resetCatalogState,
  }
}
