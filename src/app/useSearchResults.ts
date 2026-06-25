import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogBackend } from '../platform/types'
import type {
  EnrichedSearchResult,
  MapPoint,
  SearchIndexStats,
  SearchSpec,
  ValidationReport,
} from '../types'

export type UseSearchResultsOptions = {
  catalog: CatalogBackend
  ready: boolean
  pageSpec: SearchSpec
  mapSpec?: SearchSpec
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
  queryPurpose: 'results',
  storageMode: 'file',
  queryTimeMs: 0,
  rowsReturned: 0,
  limit: 0,
  offset: 0,
  limitReached: false,
}

const defaultMapMetrics: SearchIndexStats = {
  ...defaultResultMetrics,
  queryPurpose: 'map',
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'AbortError'
  )
}

function clientTimedMetrics(
  metrics: SearchIndexStats,
  requestedAt: number,
  responseAt: number,
  paintAt = responseAt,
): SearchIndexStats {
  const workerMs = metrics.queryTimeMs ?? metrics.lastQueryTimeMs ?? 0
  return {
    ...metrics,
    queryRoundTripMs: responseAt - requestedAt,
    queryTransferMs: Math.max(0, responseAt - requestedAt - workerMs),
    queryPaintMs: paintAt - requestedAt,
    queryRenderMs: Math.max(0, paintAt - responseAt),
  }
}

function mapFallbackMetrics(
  spec: SearchSpec,
  points: MapPoint[],
  limitReached: boolean,
): SearchIndexStats {
  return {
    ...defaultMapMetrics,
    engineId: spec.order.engineId ?? 'file-time-geo',
    engineLabel: 'Time-first packed index',
    queryPurpose: 'map',
    rowsReturned: points.length,
    limit: spec.limit ?? 0,
    offset: spec.offset ?? 0,
    limitReached,
  }
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
  mapItems: MapPoint[]
  mapLoading: boolean
  resultMetrics: SearchIndexStats
  mapMetrics: SearchIndexStats
  validation: ValidationReport | undefined
  setValidation(validation: ValidationReport | undefined): void
  loadWindow(offset: number, signal?: AbortSignal): Promise<SearchWindow>
  clearMap(): void
} {
  const [results, setResultsState] = useState<EnrichedSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [pageLimitReached, setPageLimitReached] = useState(false)
  const [mapItems, setMapItems] = useState<MapPoint[]>([])
  const [mapLoading, setMapLoading] = useState(false)
  const [resultMetrics, setResultMetrics] =
    useState<SearchIndexStats>(defaultResultMetrics)
  const [mapMetrics, setMapMetrics] =
    useState<SearchIndexStats>(defaultMapMetrics)
  const [validation, setValidation] = useState<ValidationReport>()
  const pageRequestIdRef = useRef(0)
  const pageAbortControllerRef = useRef<AbortController | undefined>(undefined)
  const mapRequestIdRef = useRef(0)
  const mapAbortControllerRef = useRef<AbortController | undefined>(undefined)

  const clearMap = useCallback(() => {
    ++mapRequestIdRef.current
    mapAbortControllerRef.current?.abort()
    mapAbortControllerRef.current = undefined
    setMapItems([])
    setMapLoading(false)
    setMapMetrics(defaultMapMetrics)
  }, [])

  const setResults = useCallback(
    (nextResults: EnrichedSearchResult[]) => {
      ++pageRequestIdRef.current
      pageAbortControllerRef.current?.abort()
      pageAbortControllerRef.current = undefined
      setResultsState(nextResults)
      setPageLimitReached(
        nextResults.length > 0 &&
          nextResults.length >= Math.max(1, pageSpec.limit ?? 1),
      )
    },
    [pageSpec.limit],
  )

  const loadWindow = useCallback(
    async (offset: number, signal?: AbortSignal): Promise<SearchWindow> => {
      const page = await catalog.searchMedia({
        ...pageSpec,
        offset,
        purpose: 'viewer',
      }, { signal })
      return { items: page.items }
    },
    [catalog, pageSpec],
  )

  useEffect(() => {
    if (!ready) {
      ++pageRequestIdRef.current
      pageAbortControllerRef.current?.abort()
      pageAbortControllerRef.current = undefined
      const timer = window.setTimeout(() => {
        setLoading(false)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    const requestId = ++pageRequestIdRef.current
    const abortController = new AbortController()
    pageAbortControllerRef.current = abortController

    async function loadResultPage() {
      try {
        setLoading(true)
        const requestedAt = performance.now()
        const page = await catalog.searchMedia(pageSpec, {
          signal: abortController.signal,
        })
        const responseAt = performance.now()

        if (requestId !== pageRequestIdRef.current) return

        const responseMetrics = clientTimedMetrics(
          page.resultMetrics,
          requestedAt,
          responseAt,
        )
        setResultsState(page.items)
        setPageLimitReached(Boolean(page.limitReached))
        setResultMetrics(responseMetrics)
        onStats(responseMetrics)
        setValidation(undefined)
        onError('')
        setLoading(false)
        window.requestAnimationFrame(() => {
          if (requestId !== pageRequestIdRef.current) return
          const paintMetrics = clientTimedMetrics(
            page.resultMetrics,
            requestedAt,
            responseAt,
            performance.now(),
          )
          setResultMetrics(paintMetrics)
          onStats(paintMetrics)
        })
      } catch (caught) {
        if (isAbortError(caught)) return
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
      if (pageAbortControllerRef.current === abortController) {
        pageAbortControllerRef.current = undefined
      }
      abortController.abort()
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
    if (!ready || !mapSpec) {
      ++mapRequestIdRef.current
      mapAbortControllerRef.current?.abort()
      mapAbortControllerRef.current = undefined
      const timer = window.setTimeout(() => {
        setMapLoading(false)
      }, 0)
      return () => window.clearTimeout(timer)
    }

    const requestId = ++mapRequestIdRef.current
    const activeMapSpec = mapSpec
    const abortController = new AbortController()
    mapAbortControllerRef.current = abortController

    async function loadMapPage() {
      try {
        setMapLoading(true)
        const requestedAt = performance.now()
        const page = await catalog.searchMapPoints(activeMapSpec, {
          signal: abortController.signal,
        })
        const responseAt = performance.now()
        if (requestId !== mapRequestIdRef.current) return

        const baseMetrics =
          page.resultMetrics ??
          mapFallbackMetrics(
            activeMapSpec,
            page.points,
            Boolean(page.limitReached),
          )
        const responseMetrics = clientTimedMetrics(
          baseMetrics,
          requestedAt,
          responseAt,
        )
        setMapItems(page.points)
        setMapMetrics(responseMetrics)
        onError('')
        setMapLoading(false)
        window.requestAnimationFrame(() => {
          if (requestId !== mapRequestIdRef.current) return
          setMapMetrics(
            clientTimedMetrics(
              baseMetrics,
              requestedAt,
              responseAt,
              performance.now(),
            ),
          )
        })
      } catch (caught) {
        if (isAbortError(caught)) return
        if (requestId === mapRequestIdRef.current) {
          setMapLoading(false)
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    const timer = window.setTimeout(() => {
      void loadMapPage()
    }, 0)

    return () => {
      window.clearTimeout(timer)
      if (mapAbortControllerRef.current === abortController) {
        mapAbortControllerRef.current = undefined
      }
      abortController.abort()
    }
  }, [catalog, indexVersion, mapSpec, onError, ready, revision])

  return {
    results,
    loading,
    setResults,
    pageLimitReached,
    mapItems,
    mapLoading,
    resultMetrics,
    mapMetrics,
    validation,
    setValidation,
    loadWindow,
    clearMap,
  }
}
