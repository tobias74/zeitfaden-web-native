import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogBackend } from '../platform/types'
import type { CatalogQuery, MediaItem } from '../types'

export type UseCatalogPageOptions = {
  catalog: CatalogBackend
  ready: boolean
  enabled: boolean
  query: CatalogQuery
  revision: number
  onError(message: string): void
}

export function useCatalogPage({
  catalog,
  ready,
  enabled,
  query,
  revision,
  onError,
}: UseCatalogPageOptions): {
  items: MediaItem[]
  loading: boolean
  setItems(items: MediaItem[]): void
  refresh(): Promise<void>
} {
  const [items, setItems] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    const nextItems = await catalog.listMedia(query)
    if (requestId === requestIdRef.current) {
      setItems(nextItems)
      setLoading(false)
    }
  }, [catalog, query])

  useEffect(() => {
    if (!ready || !enabled) {
      const timer = window.setTimeout(() => setLoading(false), 0)
      return () => window.clearTimeout(timer)
    }

    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      if (requestId === requestIdRef.current) setLoading(true)
      catalog.listMedia(query).then(
        (nextItems) => {
          if (requestId !== requestIdRef.current) return
          setItems(nextItems)
          setLoading(false)
        },
        (caught) => {
          if (requestId === requestIdRef.current) {
            setLoading(false)
            onError(caught instanceof Error ? caught.message : String(caught))
          }
        },
      )
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [catalog, enabled, onError, query, ready, revision])

  return { items, loading, setItems, refresh }
}

export type UseCatalogMapItemsOptions = {
  catalog: CatalogBackend
  ready: boolean
  enabled: boolean
  query: CatalogQuery
  revision: number
  limit: number
  onError(message: string): void
}

export function useCatalogMapItems({
  catalog,
  ready,
  enabled,
  query,
  revision,
  limit,
  onError,
}: UseCatalogMapItemsOptions): {
  items: MediaItem[]
  limitReached: boolean
  clear(): void
} {
  const [items, setItems] = useState<MediaItem[]>([])
  const [limitReached, setLimitReached] = useState(false)
  const requestIdRef = useRef(0)

  const clear = useCallback(() => {
    ++requestIdRef.current
    setItems([])
    setLimitReached(false)
  }, [])

  useEffect(() => {
    if (!ready || !enabled) return

    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      catalog.listMedia(query).then(
        (nextItems) => {
          if (requestId !== requestIdRef.current) return
          setItems(nextItems.slice(0, limit))
          setLimitReached(nextItems.length > limit)
        },
        (caught) => {
          if (requestId === requestIdRef.current) {
            onError(caught instanceof Error ? caught.message : String(caught))
          }
        },
      )
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [catalog, enabled, limit, onError, query, ready, revision])

  return { items, limitReached, clear }
}
