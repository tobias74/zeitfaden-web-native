import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogBackend } from '../platform/types'
import type {
  EnrichedSearchResult,
  MediaItem,
  SearchIndexStats,
  SearchSpec,
  ValidationReport,
} from '../types'

export type UseSearchResultsOptions = {
  catalog: CatalogBackend
  ready: boolean
  pageSpec: SearchSpec
  mapSpec: SearchSpec
  revision: number
  indexVersion: number
  onError(message: string): void
  onStats(stats: SearchIndexStats): void
}

export type SearchWindow = {
  items: EnrichedSearchResult[]
}

const defaultResultMetrics: SearchIndexStats = {
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

function searchPageItemsToMediaItems(items: EnrichedSearchResult[]): MediaItem[] {
  return items.map((result) => result.item)
}

export function useSearchResults({
  catalog,
  ready,
  pageSpec,
  mapSpec,
  revision,
  indexVersion,
  onError,
  onStats,
}: UseSearchResultsOptions): {
  results: EnrichedSearchResult[]
  loading: boolean
  setResults(results: EnrichedSearchResult[]): void
  pageLimitReached: boolean
  mapItems: MediaItem[]
  mapLimitReached: boolean
  resultMetrics: SearchIndexStats
  validation: ValidationReport | undefined
  setValidation(validation: ValidationReport | undefined): void
  loadWindow(offset: number): Promise<SearchWindow>
  clearMap(): void
} {
  const [results, setResultsState] = useState<EnrichedSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [pageLimitReached, setPageLimitReached] = useState(false)
  const [mapItems, setMapItems] = useState<MediaItem[]>([])
  const [mapLimitReached, setMapLimitReached] = useState(false)
  const [resultMetrics, setResultMetrics] =
    useState<SearchIndexStats>(defaultResultMetrics)
  const [validation, setValidation] = useState<ValidationReport>()
  const pageRequestIdRef = useRef(0)
  const mapRequestIdRef = useRef(0)

  const clearMap = useCallback(() => {
    ++mapRequestIdRef.current
    setMapItems([])
    setMapLimitReached(false)
  }, [])

  const setResults = useCallback(
    (nextResults: EnrichedSearchResult[]) => {
      ++pageRequestIdRef.current
      setResultsState(nextResults)
      setPageLimitReached(
        nextResults.length > 0 &&
          nextResults.length >= Math.max(1, pageSpec.limit ?? 1),
      )
    },
    [pageSpec.limit],
  )

  const loadWindow = useCallback(
    async (offset: number): Promise<SearchWindow> => {
      const page = await catalog.searchMedia({
        ...pageSpec,
        offset,
        purpose: 'viewer',
      })
      return { items: page.items }
    },
    [catalog, pageSpec],
  )

  useEffect(() => {
    if (!ready) {
      const timer = window.setTimeout(() => {
        setLoading(false)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    const requestId = ++pageRequestIdRef.current

    async function loadResultPage() {
      try {
        setLoading(true)
        const page = await catalog.searchMedia(pageSpec)

        if (requestId !== pageRequestIdRef.current) return

        setResultsState(page.items)
        setPageLimitReached(Boolean(page.limitReached))
        setResultMetrics(page.resultMetrics)
        onStats(page.resultMetrics)
        setValidation(undefined)
        setLoading(false)
      } catch (caught) {
        if (requestId === pageRequestIdRef.current) {
          setLoading(false)
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadResultPage()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    catalog,
    indexVersion,
    onError,
    onStats,
    pageSpec,
    ready,
    revision,
  ])

  useEffect(() => {
    if (!ready) return

    const requestId = ++mapRequestIdRef.current

    async function loadMapPage() {
      try {
        const page = await catalog.searchMedia(mapSpec)
        if (requestId !== mapRequestIdRef.current) return

        setMapItems(searchPageItemsToMediaItems(page.items))
        setMapLimitReached(Boolean(page.limitReached))
      } catch (caught) {
        if (requestId === mapRequestIdRef.current) {
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadMapPage()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [catalog, indexVersion, mapSpec, onError, ready, revision])

  return {
    results,
    loading,
    setResults,
    pageLimitReached,
    mapItems,
    mapLimitReached,
    resultMetrics,
    validation,
    setValidation,
    loadWindow,
    clearMap,
  }
}
