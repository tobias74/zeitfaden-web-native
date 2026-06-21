import { useCallback, useEffect, useRef, useState } from 'react'
import type { CatalogBackend } from '../platform/types'
import type {
  EnrichedSearchResult,
  GeoBounds,
  GeoIndexStats,
  KindFilter,
  MediaItem,
  TimeRange,
  ValidationReport,
} from '../types'
import type { QueryPoint } from './useSearchState'

export type UseDistanceResultsOptions = {
  catalog: CatalogBackend
  ready: boolean
  enabled: boolean
  indexId: string
  timeRange: TimeRange
  queryPoint: QueryPoint
  kindFilter: KindFilter
  geoBounds?: GeoBounds
  resultOffset: number
  resultPageSize: number
  geoPointCount: number
  geoIndexVersion: number
  mapPointLimit: number
  onError(message: string): void
  onStats(stats: GeoIndexStats): void
}

type DistanceWindow = {
  items: EnrichedSearchResult[]
}

async function getEnrichedResults(
  catalog: CatalogBackend,
  results: { mediaId: string; distanceMeters: number }[],
): Promise<EnrichedSearchResult[]> {
  const resultIds = Array.from(new Set(results.map((result) => result.mediaId)))
  const mediaLookupBatchSize = 500
  const itemChunks = await Promise.all(
    Array.from(
      { length: Math.ceil(resultIds.length / mediaLookupBatchSize) },
      (_, index) =>
        catalog.getMediaByIds(
          resultIds.slice(
            index * mediaLookupBatchSize,
            (index + 1) * mediaLookupBatchSize,
          ),
        ),
    ),
  )
  const items = itemChunks.flat()
  const byId = new Map(items.map((item) => [item.id, item]))
  return results.flatMap((result) => {
    const item = byId.get(result.mediaId)
    if (!item) return []
    return [{ ...result, item }]
  })
}

export function useDistanceResults({
  catalog,
  ready,
  enabled,
  indexId,
  timeRange,
  queryPoint,
  kindFilter,
  geoBounds,
  resultOffset,
  resultPageSize,
  geoPointCount,
  geoIndexVersion,
  mapPointLimit,
  onError,
  onStats,
}: UseDistanceResultsOptions): {
  results: EnrichedSearchResult[]
  loading: boolean
  setResults(results: EnrichedSearchResult[]): void
  mapItems: MediaItem[]
  mapLimitReached: boolean
  validation: ValidationReport | undefined
  setValidation(validation: ValidationReport | undefined): void
  loadWindow(offset: number): Promise<DistanceWindow>
} {
  const [results, setResults] = useState<EnrichedSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [mapItems, setMapItems] = useState<MediaItem[]>([])
  const [mapLimitReached, setMapLimitReached] = useState(false)
  const [validation, setValidation] = useState<ValidationReport>()
  const requestIdRef = useRef(0)

  const loadWindow = useCallback(
    async (offset: number): Promise<DistanceWindow> => {
      const pageResults = await catalog.searchGeoIndex(indexId, {
        ...timeRange,
        lat: queryPoint.lat,
        lon: queryPoint.lon,
        k: resultPageSize,
        offset,
        kind: kindFilter,
        geoBounds,
      })
      return { items: await getEnrichedResults(catalog, pageResults) }
    },
    [
      catalog,
      geoBounds,
      indexId,
      kindFilter,
      queryPoint.lat,
      queryPoint.lon,
      resultPageSize,
      timeRange,
    ],
  )

  useEffect(() => {
    if (!ready || !enabled) {
      const timer = window.setTimeout(() => setLoading(false), 0)
      return () => window.clearTimeout(timer)
    }

    const requestId = ++requestIdRef.current

    async function loadDistancePage() {
      try {
        setLoading(true)
        const baseQuery = {
          ...timeRange,
          lat: queryPoint.lat,
          lon: queryPoint.lon,
        }
        const pageQuery = {
          ...baseQuery,
          k: resultPageSize,
          offset: resultOffset,
          kind: kindFilter,
          geoBounds,
        }
        const mapQuery = {
          ...baseQuery,
          k: mapPointLimit,
          offset: 0,
          kind: kindFilter,
        }
        const [pageResults, mapResults] = await Promise.all([
          catalog.searchGeoIndex(indexId, pageQuery),
          catalog.searchGeoIndex(indexId, mapQuery),
        ])
        const [pageEnriched, mapEnriched] = await Promise.all([
          getEnrichedResults(catalog, pageResults),
          getEnrichedResults(catalog, mapResults),
        ])
        const [nextValidation, nextStats] = await Promise.all([
          kindFilter === 'all'
            ? catalog.validateGeoIndex(indexId, pageQuery)
            : Promise.resolve(undefined),
          catalog.getGeoIndexStats(indexId),
        ])

        if (requestId !== requestIdRef.current) return

        setResults(pageEnriched)
        setMapItems(mapEnriched.map((result) => result.item))
        setMapLimitReached(
          mapResults.length >= mapPointLimit && geoPointCount > mapPointLimit,
        )
        setValidation(nextValidation)
        onStats(nextStats)
        setLoading(false)
      } catch (caught) {
        if (requestId === requestIdRef.current) {
          setLoading(false)
          onError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    const timer = window.setTimeout(() => {
      loadDistancePage()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [
    catalog,
    enabled,
    geoBounds,
    geoIndexVersion,
    geoPointCount,
    indexId,
    kindFilter,
    mapPointLimit,
    onError,
    onStats,
    queryPoint.lat,
    queryPoint.lon,
    ready,
    resultOffset,
    resultPageSize,
    timeRange,
  ])

  return {
    results,
    loading,
    setResults,
    mapItems,
    mapLimitReached,
    validation,
    setValidation,
    loadWindow,
  }
}
