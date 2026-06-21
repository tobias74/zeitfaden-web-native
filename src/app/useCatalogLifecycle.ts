import { useCallback, useEffect, useState } from 'react'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import type { MediaSource } from '../types'

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
  sources: MediaSource[]
  markCatalogChanged(): void
  resetCatalogState(): void
} {
  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [sources, setSources] = useState<MediaSource[]>([])

  const markCatalogChanged = useCallback(() => {
    setCatalogRevision((revision) => revision + 1)
  }, [])

  const resetCatalogState = useCallback(() => {
    setCatalogInfo(undefined)
    setSources([])
    setCatalogRevision(0)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function boot() {
      try {
        const info = await catalog.init()
        if (cancelled) return
        setCatalogInfo(info)
      } catch (caught) {
        if (!cancelled) {
          onError(caught instanceof Error ? caught.message : String(caught))
          onInitFailed()
        }
      }
    }

    boot()

    return () => {
      cancelled = true
    }
  }, [catalog, onError, onInitFailed])

  useEffect(() => {
    if (!catalogInfo) return

    let cancelled = false
    catalog.listSources().then(
      (nextSources) => {
        if (!cancelled) setSources(nextSources)
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
  }, [catalog, catalogInfo, catalogRevision, onError])

  return {
    catalogInfo,
    catalogReady: Boolean(catalogInfo),
    catalogRevision,
    sources,
    markCatalogChanged,
    resetCatalogState,
  }
}
