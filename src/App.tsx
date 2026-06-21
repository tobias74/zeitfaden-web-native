import {
  Activity,
  BoxSelect,
  Calendar,
  ChevronLeft,
  ChevronRight,
  FileText,
  FolderOpen,
  Images,
  Image as ImageIcon,
  Languages,
  List,
  MapPin,
  Settings2,
  ShieldCheck,
  Trash2,
  Video,
} from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import './App.css'
import { MapView } from './components/MapView'
import { MediaViewer } from './components/MediaViewer'
import { Thumbnail } from './components/Thumbnail'
import privacyDeHtml from './legal/privacy.de.html?raw'
import privacyEnHtml from './legal/privacy.en.html?raw'
import { formatDistance } from './lib/distance'
import {
  LANGUAGES,
  LANGUAGE_STORAGE_KEY,
  type Language,
  type TranslationKey,
  type TranslationValues,
  isLanguage,
  languageLocale,
  translate,
} from './i18n'
import {
  buildSearchUrlParams,
  parseSearchUrlState,
} from './lib/searchUrl'
import type {
  SearchUrlDefaults,
  SearchUrlState,
} from './lib/searchUrl'
import {
  dateInputEndToMillis,
  dateInputToMillis,
  formatDateTime,
} from './lib/time'
import { GeoIndexRegistry } from './geo/registry'
import { createPlatformBackend } from './platform'
import type { CatalogInfo, ImportProgress } from './platform/types'
import type {
  CatalogQuery,
  CatalogSort,
  EnrichedSearchResult,
  GeoBounds,
  GeoIndexStats,
  MediaItem,
  MediaKind,
  MediaSource,
  TimeRange,
  ValidationReport,
} from './types'

type QueryPoint = {
  lat: number
  lon: number
}

type SortMode = CatalogSort | 'distance'
type ActivePage = 'app' | 'imprint' | 'privacy'
type ResultDisplayMode = 'images' | 'cards' | 'list'
type ResultThumbnailSize = 'small' | 'medium' | 'large'
type ActivityLogEntry = {
  id: number
  key: TranslationKey
  values?: TranslationValues
  createdAt: number
}
type ViewerSession = {
  absoluteIndex: number
  windowOffset: number
  items: EnrichedSearchResult[]
  canNavigateNext: boolean
  totalItems?: number
}

const defaultStats: GeoIndexStats = {
  engineId: 'none',
  pointCount: 0,
  distanceComputations: 0,
  nodesVisited: 0,
  pagesRead: 0,
  candidatesInspected: 0,
  prunedByGeo: 0,
  prunedByTime: 0,
}

const LEFT_WIDTH_KEY = 'geo-media-index-lab:left-width'
const MAP_HEIGHT_KEY = 'geo-media-index-lab:map-height'
const RESULT_DISPLAY_MODE_KEY = 'geo-media-index-lab:result-display-mode'
const RESULT_THUMBNAIL_SIZE_KEY = 'geo-media-index-lab:result-thumbnail-size'
const RESULT_METADATA_KEY = 'geo-media-index-lab:result-metadata'
const RESULT_PAGE_SIZE_KEY = 'geo-media-index-lab:result-page-size'
const RESULT_PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const
const DEFAULT_RESULT_PAGE_SIZE = 100
const MAP_POINT_LIMIT = 5_000
const DEFAULT_QUERY_POINT = {
  lat: 47.3769,
  lon: 8.5417,
} as const
const DEFAULT_LEFT_WIDTH = 440
const DEFAULT_MAP_HEIGHT = 430
const MIN_LEFT_WIDTH = 340
const MAX_LEFT_WIDTH = 760
const MIN_RESULTS_WIDTH = 480
const MIN_MAP_HEIGHT = 240
const MIN_CONTROL_HEIGHT = 260

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function storedNumber(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key)
  if (stored === null || stored.trim() === '') return fallback

  const value = Number(stored)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function storedString<T extends string>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const stored = window.localStorage.getItem(key)
  return allowed.includes(stored as T) ? (stored as T) : fallback
}

function storedBoolean(key: string, fallback: boolean): boolean {
  const stored = window.localStorage.getItem(key)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return fallback
}

function storedLanguage(): Language {
  const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY)
  return isLanguage(stored) ? stored : 'en'
}

function storedPageSize(): number {
  const stored = storedNumber(RESULT_PAGE_SIZE_KEY, DEFAULT_RESULT_PAGE_SIZE)
  return RESULT_PAGE_SIZE_OPTIONS.includes(
    stored as (typeof RESULT_PAGE_SIZE_OPTIONS)[number],
  )
    ? stored
    : DEFAULT_RESULT_PAGE_SIZE
}

function filterValueToKind(value: string): MediaKind | 'all' {
  return value === 'image' || value === 'video' ? value : 'all'
}

function statsNumber(value: number | undefined, locale: string): string {
  return typeof value === 'number' ? value.toLocaleString(locale) : '0'
}

function importProgressPercent(progress: ImportProgress): number | undefined {
  if (progress.phase === 'counting' || progress.totalFiles === 0) {
    return undefined
  }
  return Math.min(100, (progress.scannedFiles / progress.totalFiles) * 100)
}

function importProgressLabel(
  progress: ImportProgress,
  t: (key: TranslationKey, values?: TranslationValues) => string,
  locale: string,
): string {
  if (progress.phase === 'counting') {
    return t('countingFilesIn', { sourceLabel: progress.sourceLabel })
  }
  if (progress.phase === 'storing') {
    return t('savingMediaFiles', {
      count: progress.acceptedMedia.toLocaleString(locale),
    })
  }
  return t('scanningSource', { sourceLabel: progress.sourceLabel })
}

function importProgressDetail(
  progress: ImportProgress,
  t: (key: TranslationKey, values?: TranslationValues) => string,
  locale: string,
): string {
  if (progress.phase === 'counting') {
    return t('filesFound', {
      count: progress.totalFiles.toLocaleString(locale),
    })
  }

  return `${progress.scannedFiles.toLocaleString(locale)} / ${progress.totalFiles.toLocaleString(locale)}`
}

function formatDimensions(item: MediaItem): string | undefined {
  if (typeof item.width === 'number' && typeof item.height === 'number') {
    return `${item.width} x ${item.height}`
  }
  if (typeof item.durationMs === 'number') {
    return `${Math.round(item.durationMs / 1_000)} s`
  }
  return undefined
}

function formatGeo(item: MediaItem): string | undefined {
  if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
    return undefined
  }
  return `${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}`
}

function itemWithinGeoBounds(item: MediaItem, bounds?: GeoBounds): boolean {
  if (!bounds) return true
  if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
    return false
  }

  return (
    item.latitude >= bounds.minLat &&
    item.latitude <= bounds.maxLat &&
    item.longitude >= bounds.minLon &&
    item.longitude <= bounds.maxLon
  )
}

function timeRangeFromInputs(startDate: string, endDate: string): TimeRange {
  return {
    startTime: dateInputToMillis(startDate),
    endTime: dateInputEndToMillis(endDate),
  }
}

function mediaItemsToResults(items: MediaItem[]): EnrichedSearchResult[] {
  return items.map((item) => ({
    item,
    mediaId: item.id,
    distanceMeters: NaN,
  }))
}

function pathWithSearchParams(params: URLSearchParams): string {
  const search = params.toString()
  return `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
}

function App() {
  const platform = useMemo(() => createPlatformBackend(), [])
  const catalog = platform.catalog
  const registry = useMemo(() => new GeoIndexRegistry(), [])
  const [language, setLanguage] = useState<Language>(() => storedLanguage())
  const [activePage, setActivePage] = useState<ActivePage>('app')
  const locale = languageLocale(language)
  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(language, key, values),
    [language],
  )
  const allowedIndexIds = useMemo(
    () => registry.indexes.map((index) => index.id),
    [registry],
  )
  const searchUrlDefaults = useMemo<SearchUrlDefaults>(
    () => ({
      resultPageSize: DEFAULT_RESULT_PAGE_SIZE,
      selectedIndexId: registry.indexes[0]?.id ?? 'brute-force',
      queryPoint: DEFAULT_QUERY_POINT,
    }),
    [registry],
  )
  const initialSearchUrlDefaults = useMemo<SearchUrlDefaults>(
    () => ({
      ...searchUrlDefaults,
      resultPageSize: storedPageSize(),
    }),
    [searchUrlDefaults],
  )
  const initialSearchState = useMemo(
    () =>
      parseSearchUrlState(
        window.location.search,
        initialSearchUrlDefaults,
        allowedIndexIds,
        RESULT_PAGE_SIZE_OPTIONS,
      ),
    [allowedIndexIds, initialSearchUrlDefaults],
  )

  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [mapItems, setMapItems] = useState<MediaItem[]>([])
  const [mapPointLimitReached, setMapPointLimitReached] = useState(false)
  const [sources, setSources] = useState<MediaSource[]>([])
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [selectedIndexId, setSelectedIndexId] = useState(
    initialSearchState.selectedIndexId,
  )
  const [queryPoint, setQueryPoint] = useState<QueryPoint>(
    initialSearchState.queryPoint,
  )
  const [startDate, setStartDate] = useState(initialSearchState.startDate)
  const [endDate, setEndDate] = useState(initialSearchState.endDate)
  const [sort, setSort] = useState<SortMode>(initialSearchState.sort)
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>(
    initialSearchState.kindFilter,
  )
  const [geoBounds, setGeoBounds] = useState<GeoBounds | undefined>(
    initialSearchState.geoBounds,
  )
  const [boundsDrawing, setBoundsDrawing] = useState(false)
  const [resultPage, setResultPage] = useState(initialSearchState.resultPage)
  const [resultPageSize, setResultPageSize] = useState(
    initialSearchState.resultPageSize,
  )
  const [searchResults, setSearchResults] = useState<EnrichedSearchResult[]>([])
  const [viewerSession, setViewerSession] = useState<ViewerSession>()
  const [viewerNavigationPending, setViewerNavigationPending] = useState(false)
  const [indexStats, setIndexStats] = useState<GeoIndexStats>(defaultStats)
  const [validation, setValidation] = useState<ValidationReport>()
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>(() => [
    {
      id: 0,
      key: 'activityInitializingCatalog',
      createdAt: Date.now(),
    },
  ])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [importProgress, setImportProgress] = useState<ImportProgress>()
  const [resultDisplayMode, setResultDisplayMode] =
    useState<ResultDisplayMode>(() =>
      storedString(RESULT_DISPLAY_MODE_KEY, 'cards', [
        'images',
        'cards',
        'list',
      ]),
    )
  const [resultThumbnailSize, setResultThumbnailSize] =
    useState<ResultThumbnailSize>(() =>
      storedString(RESULT_THUMBNAIL_SIZE_KEY, 'medium', [
        'small',
        'medium',
        'large',
      ]),
    )
  const [showResultMetadata, setShowResultMetadata] = useState(() =>
    storedBoolean(RESULT_METADATA_KEY, true),
  )
  const [leftWidth, setLeftWidth] = useState(() =>
    clamp(storedNumber(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH), MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
  )
  const [mapHeight, setMapHeight] = useState(() =>
    Math.max(MIN_MAP_HEIGHT, storedNumber(MAP_HEIGHT_KEY, DEFAULT_MAP_HEIGHT)),
  )
  const workspaceRef = useRef<HTMLElement | null>(null)
  const leftStackRef = useRef<HTMLElement | null>(null)
  const activityLogIdRef = useRef(1)

  const selectedIndex = registry.get(selectedIndexId)
  const catalogReady = Boolean(catalogInfo)
  const distanceSortActive = sort === 'distance'
  const catalogSort: CatalogSort =
    sort === 'distance' ? 'captured_at_desc' : sort
  const resultOffset = resultPage * resultPageSize
  const timeRange = useMemo(
    () => timeRangeFromInputs(startDate, endDate),
    [endDate, startDate],
  )

  const catalogQuery = useMemo<CatalogQuery>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      geoBounds,
      sort: catalogSort,
      limit: resultPageSize,
      offset: resultOffset,
    }),
    [
      catalogSort,
      geoBounds,
      kindFilter,
      resultOffset,
      resultPageSize,
      timeRange,
    ],
  )
  const mapCatalogQuery = useMemo<CatalogQuery>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      hasGeo: true,
      sort: catalogSort,
      limit: MAP_POINT_LIMIT + 1,
      offset: 0,
    }),
    [catalogSort, kindFilter, timeRange],
  )
  const searchUrlState = useMemo<SearchUrlState>(
    () => ({
      startDate,
      endDate,
      sort,
      kindFilter,
      geoBounds,
      resultPage,
      resultPageSize,
      selectedIndexId,
      queryPoint,
    }),
    [
      endDate,
      geoBounds,
      kindFilter,
      queryPoint,
      resultPage,
      resultPageSize,
      selectedIndexId,
      sort,
      startDate,
    ],
  )
  const hasSyncedSearchUrlRef = useRef(false)

  const recordActivity = useCallback((
    key: TranslationKey,
    values?: TranslationValues,
  ) => {
    setActivityLog((entries) =>
      [
        {
          id: activityLogIdRef.current++,
          key,
          values,
          createdAt: Date.now(),
        },
        ...entries,
      ].slice(0, 30),
    )
  }, [])

  const changeLanguage = useCallback((value: string) => {
    if (!isLanguage(value)) return
    setLanguage(value)
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value)
  }, [])

  const applySearchUrlState = useCallback((nextState: SearchUrlState) => {
    setSelectedIndexId(nextState.selectedIndexId)
    setQueryPoint(nextState.queryPoint)
    setStartDate(nextState.startDate)
    setEndDate(nextState.endDate)
    setSort(nextState.sort)
    setKindFilter(nextState.kindFilter)
    setGeoBounds(nextState.geoBounds)
    setBoundsDrawing(false)
    setResultPage(nextState.resultPage)
    setResultPageSize(nextState.resultPageSize)
    setSearchResults([])
    setMapPointLimitReached(false)
    setValidation(undefined)
    setViewerSession(undefined)
    setViewerNavigationPending(false)
  }, [])

  const refreshMedia = useCallback(async () => {
    const [items, nextSources] = await Promise.all([
      catalog.listMedia(catalogQuery),
      catalog.listSources(),
    ])
    setMediaItems(items)
    setSources(nextSources)
  }, [catalog, catalogQuery])

  const refreshMapMedia = useCallback(async () => {
    const items = await catalog.listMedia(mapCatalogQuery)
    setMapItems(items.slice(0, MAP_POINT_LIMIT))
    setMapPointLimitReached(items.length > MAP_POINT_LIMIT)
  }, [catalog, mapCatalogQuery])

  const rebuildGeoIndexes = useCallback(async () => {
    const points = await catalog.getGeoPoints()
    setGeoPointCount(points.length)
    await registry.buildAll(points)
    setGeoIndexVersion((version) => version + 1)
    setIndexStats(await registry.get(selectedIndexId).stats())
  }, [catalog, registry, selectedIndexId])

  const refreshAll = useCallback(async () => {
    await Promise.all([
      refreshMedia(),
      distanceSortActive ? Promise.resolve() : refreshMapMedia(),
      rebuildGeoIndexes(),
    ])
  }, [distanceSortActive, rebuildGeoIndexes, refreshMapMedia, refreshMedia])

  useEffect(() => {
    let cancelled = false

    async function boot() {
      try {
        const info = await catalog.init()
        if (cancelled) return
        setCatalogInfo(info)
        await refreshAll()
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
          recordActivity('activityCatalogFailedToInitialize')
        }
      }
    }

    boot()

    return () => {
      cancelled = true
    }
  }, [catalog, recordActivity, refreshAll])

  useEffect(() => {
    return () => platform.dispose()
  }, [platform])

  useEffect(() => {
    const params = buildSearchUrlParams(searchUrlState, searchUrlDefaults)
    const nextUrl = pathWithSearchParams(params)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`

    if (nextUrl === currentUrl) {
      hasSyncedSearchUrlRef.current = true
      return
    }

    const method = hasSyncedSearchUrlRef.current ? 'pushState' : 'replaceState'
    window.history[method](null, '', nextUrl)
    hasSyncedSearchUrlRef.current = true
  }, [searchUrlDefaults, searchUrlState])

  useEffect(() => {
    function onPopState() {
      applySearchUrlState(
        parseSearchUrlState(
          window.location.search,
          initialSearchUrlDefaults,
          allowedIndexIds,
          RESULT_PAGE_SIZE_OPTIONS,
        ),
      )
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [allowedIndexIds, applySearchUrlState, initialSearchUrlDefaults])

  useEffect(() => {
    if (!catalogInfo) return
    const timer = window.setTimeout(() => {
      refreshMedia().catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [catalogInfo, refreshMedia])

  useEffect(() => {
    if (!catalogInfo || distanceSortActive) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      refreshMapMedia().catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [catalogInfo, distanceSortActive, refreshMapMedia])

  const importFolder = useCallback(async () => {
    setError(undefined)
    setImportProgress(undefined)

    setBusy(true)
    try {
      const summary = await platform.importer.importFolder((progress) => {
        setImportProgress(progress)
      })
      setResultPage(0)
      await refreshAll()
      recordActivity('activityImportedMediaFilesFrom', {
        count: summary.acceptedMedia.toLocaleString(locale),
        sourceLabel: summary.sourceLabel,
      })
      if (summary.errors.length > 0) {
        setError(
          t('filesCouldNotBeRead', {
            count: summary.errors.length.toLocaleString(locale),
          }),
        )
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      recordActivity('activityImportStopped')
    } finally {
      setImportProgress(undefined)
      setBusy(false)
    }
  }, [locale, platform, recordActivity, refreshAll, t])

  const clearCatalog = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      await catalog.clear()
      setResultPage(0)
      setGeoBounds(undefined)
      setBoundsDrawing(false)
      setSearchResults([])
      setMapItems([])
      setMapPointLimitReached(false)
      setValidation(undefined)
      setViewerSession(undefined)
      setViewerNavigationPending(false)
      await refreshAll()
      recordActivity('activityCatalogCleared')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [catalog, recordActivity, refreshAll])

  const confirmClearCatalog = useCallback(() => {
    if (busy || !catalogReady) return
    const confirmed = window.confirm(t('clearCatalogConfirm'))
    if (!confirmed) return
    void clearCatalog()
  }, [busy, catalogReady, clearCatalog, t])

  useEffect(() => {
    if (!catalogInfo || !distanceSortActive) return

    let cancelled = false

    async function sortByDistance() {
      setError(undefined)

      try {
        const query = {
          ...timeRange,
          lat: queryPoint.lat,
          lon: queryPoint.lon,
          k: geoPointCount,
        }
        const results = await selectedIndex.search(query)
        const resultIds = results.map((result) => result.mediaId)
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
        const unboundedEnriched = results
          .flatMap((result) => {
            const item = byId.get(result.mediaId)
            if (!item) return []
            if (kindFilter !== 'all' && item.kind !== kindFilter) return []
            return [{ ...result, item }]
          })
        const enriched = geoBounds
          ? unboundedEnriched.filter((result) =>
              itemWithinGeoBounds(result.item, geoBounds),
            )
          : unboundedEnriched
        const [nextValidation, nextStats] = await Promise.all([
          kindFilter === 'all'
            ? registry.validateSelected(selectedIndex.id, query)
            : Promise.resolve(undefined),
          selectedIndex.stats(),
        ])

        if (cancelled) return

        setSearchResults(enriched)
        setMapItems(
          unboundedEnriched
            .slice(0, MAP_POINT_LIMIT)
            .map((result) => result.item),
        )
        setMapPointLimitReached(unboundedEnriched.length > MAP_POINT_LIMIT)
        setValidation(nextValidation)
        setIndexStats(nextStats)
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }

    sortByDistance()

    return () => {
      cancelled = true
    }
  }, [
    catalog,
    catalogInfo,
    distanceSortActive,
    geoIndexVersion,
    geoPointCount,
    geoBounds,
    kindFilter,
    queryPoint.lat,
    queryPoint.lon,
    registry,
    selectedIndex,
    timeRange,
  ])

  const visibleResults = distanceSortActive
  const catalogPageResultItems = useMemo(
    () => mediaItemsToResults(mediaItems),
    [mediaItems],
  )
  const allResultItems = distanceSortActive
    ? searchResults
    : catalogPageResultItems
  const resultItems = distanceSortActive
    ? allResultItems.slice(resultOffset, resultOffset + resultPageSize)
    : allResultItems
  const visibleStart = resultItems.length === 0 ? 0 : resultOffset + 1
  const visibleEnd = resultOffset + resultItems.length
  const visibleRange = distanceSortActive
    ? t('resultRangeOf', {
        start: visibleStart.toLocaleString(locale),
        end: visibleEnd.toLocaleString(locale),
        total: allResultItems.length.toLocaleString(locale),
      })
    : resultItems.length === 0
      ? '0'
      : `${visibleStart.toLocaleString(locale)}-${visibleEnd.toLocaleString(locale)}`
  const canPageBackward = resultPage > 0
  const canPageForward = distanceSortActive
    ? visibleEnd < allResultItems.length
    : resultItems.length === resultPageSize

  const setFilterKind = useCallback((kind: MediaKind | 'all') => {
    setKindFilter(kind)
    setResultPage(0)
  }, [])

  const setSortMode = useCallback((nextSort: SortMode) => {
    setSort(nextSort)
    setResultPage(0)
    if (nextSort === 'distance') {
      setBoundsDrawing(false)
    }
    if (nextSort !== 'distance') {
      setSearchResults([])
      setMapPointLimitReached(false)
      setValidation(undefined)
    }
  }, [])

  const setMapQueryPoint = useCallback((point: QueryPoint) => {
    setQueryPoint(point)
    setResultPage(0)
  }, [])

  const setMapGeoBounds = useCallback((bounds: GeoBounds) => {
    setGeoBounds(bounds)
    setBoundsDrawing(false)
    setResultPage(0)
  }, [])

  const clearMapGeoBounds = useCallback(() => {
    setGeoBounds(undefined)
    setBoundsDrawing(false)
    setResultPage(0)
  }, [])

  const toggleBoundsDrawing = useCallback(() => {
    setBoundsDrawing((active) => !active)
  }, [])

  const setPageSize = useCallback((size: number) => {
    setResultPageSize(size)
    setResultPage(0)
    window.localStorage.setItem(RESULT_PAGE_SIZE_KEY, String(size))
  }, [])

  const clearSearch = useCallback(() => {
    setStartDate('')
    setEndDate('')
    setSort('captured_at_desc')
    setKindFilter('all')
    setGeoBounds(undefined)
    setBoundsDrawing(false)
    setResultPage(0)
    setSearchResults([])
    setMapPointLimitReached(false)
    setValidation(undefined)
    setViewerSession(undefined)
    setViewerNavigationPending(false)
  }, [])

  const openViewerAtIndex = useCallback(
    async (absoluteIndex: number) => {
      if (absoluteIndex < 0) return

      setViewerNavigationPending(true)
      try {
        if (distanceSortActive) {
          if (absoluteIndex >= searchResults.length) return

          setViewerSession({
            absoluteIndex,
            windowOffset: 0,
            items: searchResults,
            canNavigateNext: absoluteIndex < searchResults.length - 1,
            totalItems: searchResults.length,
          })
          return
        }

        const windowOffset =
          Math.floor(absoluteIndex / resultPageSize) * resultPageSize
        const localIndex = absoluteIndex - windowOffset
        let windowItems = catalogPageResultItems

        if (windowOffset !== resultOffset) {
          const pageItems = await catalog.listMedia({
            ...timeRange,
            kind: kindFilter,
            geoBounds,
            sort: catalogSort,
            limit: resultPageSize,
            offset: windowOffset,
          })
          windowItems = mediaItemsToResults(pageItems)
          setResultPage(windowOffset / resultPageSize)
          setMediaItems(pageItems)
        }

        if (!windowItems[localIndex]) {
          setViewerSession((session) =>
            session ? { ...session, canNavigateNext: false } : session,
          )
          return
        }

        setViewerSession({
          absoluteIndex,
          windowOffset,
          items: windowItems,
          canNavigateNext:
            localIndex < windowItems.length - 1 ||
            windowItems.length === resultPageSize,
          totalItems:
            windowItems.length < resultPageSize
              ? windowOffset + windowItems.length
              : undefined,
        })
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setViewerNavigationPending(false)
      }
    },
    [
      catalog,
      catalogPageResultItems,
      catalogSort,
      distanceSortActive,
      geoBounds,
      kindFilter,
      resultOffset,
      resultPageSize,
      searchResults,
      timeRange,
    ],
  )

  const openViewer = useCallback(
    (index: number) => {
      void openViewerAtIndex(resultOffset + index)
    },
    [openViewerAtIndex, resultOffset],
  )

  const closeViewer = useCallback(() => {
    setViewerSession(undefined)
    setViewerNavigationPending(false)
  }, [])

  const setDisplayMode = useCallback((mode: ResultDisplayMode) => {
    setResultDisplayMode(mode)
    window.localStorage.setItem(RESULT_DISPLAY_MODE_KEY, mode)
  }, [])

  const setThumbnailSize = useCallback((size: ResultThumbnailSize) => {
    setResultThumbnailSize(size)
    window.localStorage.setItem(RESULT_THUMBNAIL_SIZE_KEY, size)
  }, [])

  const toggleMetadata = useCallback((enabled: boolean) => {
    setShowResultMetadata(enabled)
    window.localStorage.setItem(RESULT_METADATA_KEY, String(enabled))
  }, [])

  const resizeStyle = {
    '--left-width': `${leftWidth}px`,
    '--map-height': `${mapHeight}px`,
  } as CSSProperties

  const resizeControls = useMemo(
    () => ({
      left: {
        min: MIN_LEFT_WIDTH,
        max: MAX_LEFT_WIDTH,
        now: Math.round(leftWidth),
      },
      map: {
        min: MIN_MAP_HEIGHT,
        max: Math.max(MIN_MAP_HEIGHT, window.innerHeight - MIN_CONTROL_HEIGHT),
        now: Math.round(mapHeight),
      },
    }),
    [leftWidth, mapHeight],
  )

  const resizeLeftPane = useCallback((clientX: number) => {
    const workspace = workspaceRef.current
    if (!workspace) return

    const rect = workspace.getBoundingClientRect()
    const maxWidth = Math.min(MAX_LEFT_WIDTH, rect.width - MIN_RESULTS_WIDTH)
    const nextWidth = clamp(clientX - rect.left, MIN_LEFT_WIDTH, maxWidth)
    setLeftWidth(nextWidth)
    window.localStorage.setItem(LEFT_WIDTH_KEY, String(Math.round(nextWidth)))
  }, [])

  const resizeMapPane = useCallback((clientY: number) => {
    const leftStack = leftStackRef.current
    if (!leftStack) return

    const rect = leftStack.getBoundingClientRect()
    const nextHeight = clamp(
      clientY - rect.top,
      MIN_MAP_HEIGHT,
      rect.height - MIN_CONTROL_HEIGHT,
    )
    setMapHeight(nextHeight)
    window.localStorage.setItem(MAP_HEIGHT_KEY, String(Math.round(nextHeight)))
  }, [])

  const startVerticalResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      resizeLeftPane(event.clientX)
    },
    [resizeLeftPane],
  )

  const startHorizontalResize = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId)
      resizeMapPane(event.clientY)
    },
    [resizeMapPane],
  )

  const handleVerticalResizeMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.buttons !== 1) return
      resizeLeftPane(event.clientX)
    },
    [resizeLeftPane],
  )

  const handleHorizontalResizeMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.buttons !== 1) return
      resizeMapPane(event.clientY)
    },
    [resizeMapPane],
  )

  const nudgeLeftPane = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 16
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

      event.preventDefault()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const workspace = workspaceRef.current
      const maxWidth = workspace
        ? Math.min(
            MAX_LEFT_WIDTH,
            workspace.getBoundingClientRect().width - MIN_RESULTS_WIDTH,
          )
        : MAX_LEFT_WIDTH
      const nextWidth = clamp(
        leftWidth + direction * step,
        MIN_LEFT_WIDTH,
        maxWidth,
      )
      setLeftWidth(nextWidth)
      window.localStorage.setItem(LEFT_WIDTH_KEY, String(Math.round(nextWidth)))
    },
    [leftWidth],
  )

  const nudgeMapPane = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 40 : 16
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return

      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const leftStack = leftStackRef.current
      const maxHeight = leftStack
        ? leftStack.getBoundingClientRect().height - MIN_CONTROL_HEIGHT
        : window.innerHeight - MIN_CONTROL_HEIGHT
      const nextHeight = clamp(
        mapHeight + direction * step,
        MIN_MAP_HEIGHT,
        maxHeight,
      )
      setMapHeight(nextHeight)
      window.localStorage.setItem(MAP_HEIGHT_KEY, String(Math.round(nextHeight)))
    },
    [mapHeight],
  )

  const viewerLocalIndex = viewerSession
    ? viewerSession.absoluteIndex - viewerSession.windowOffset
    : -1
  const mapResultItems = useMemo(() => mediaItemsToResults(mapItems), [mapItems])
  const legalPageTitle =
    activePage === 'privacy' ? t('privacy') : t('imprint')
  const privacyHtml = language === 'de' ? privacyDeHtml : privacyEnHtml

  if (activePage !== 'app') {
    return (
      <main className="legal-shell">
        <header className="topbar legal-topbar">
          <div className="topbar-copy">
            <h1>
              <a
                className="app-title-link"
                href={pathWithSearchParams(
                  buildSearchUrlParams(searchUrlState, searchUrlDefaults),
                )}
                onClick={(event) => {
                  event.preventDefault()
                  setActivePage('app')
                }}
              >
                zeitfaden
              </a>
            </h1>
            <p className="subtle">{legalPageTitle}</p>
          </div>
          <div className="topbar-tools">
            <nav className="topbar-nav" aria-label="Legal">
              <button
                type="button"
                className="topbar-link"
                aria-current={activePage === 'imprint' ? 'page' : undefined}
                onClick={() => setActivePage('imprint')}
              >
                {t('imprint')}
              </button>
              <button
                type="button"
                className="topbar-link"
                aria-current={activePage === 'privacy' ? 'page' : undefined}
                onClick={() => setActivePage('privacy')}
              >
                {t('privacy')}
              </button>
            </nav>
            <div className="topbar-actions">
              <label className="language-control" title={t('language')}>
                <span aria-hidden="true">
                  <Languages size={16} />
                </span>
                <select
                  aria-label={t('language')}
                  value={language}
                  onChange={(event) => changeLanguage(event.target.value)}
                >
                  {LANGUAGES.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        </header>
        <section className="legal-content">
          {activePage === 'imprint' ? (
            <article className="legal-panel">
              <div className="legal-panel-title">
                <FileText size={20} />
                <h2>{t('imprint')}</h2>
              </div>
              <address className="imprint-address">
                <strong>tobiga UG (haftungsbeschränkt)</strong>
                <span>Tobias Gassmann</span>
                <span>Bodenseestr. 4a</span>
                <span>81241 München</span>
                <span>HRB 219431</span>
                <span>USt-IdNr. DE 301206623</span>
              </address>
            </article>
          ) : (
            <article className="legal-panel privacy-panel">
              <div className="legal-panel-title">
                <ShieldCheck size={20} />
                <h2>{t('privacy')}</h2>
              </div>
              <iframe
                className="privacy-frame"
                title={t('privacy')}
                sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                srcDoc={privacyHtml}
              />
            </article>
          )}
        </section>
      </main>
    )
  }

  return (
    <main className="app-shell" style={resizeStyle}>
      <header className="topbar">
        <div className="topbar-copy">
          <h1>
            <a
              className="app-title-link"
              href={pathWithSearchParams(
                buildSearchUrlParams(searchUrlState, searchUrlDefaults),
              )}
              onClick={(event) => {
                event.preventDefault()
                setActivePage('app')
              }}
            >
              zeitfaden
            </a>
          </h1>
          <p className="subtle">
            {catalogInfo
              ? `SQLite ${catalogInfo.sqliteVersion} · ${catalogInfo.storageMode.toUpperCase()} · ${catalogInfo.filename}`
              : t('catalogStatusStarting')}
          </p>
        </div>
        <div className="topbar-tools">
          <nav className="topbar-nav" aria-label="Legal">
            <button
              type="button"
              className="topbar-link"
              onClick={() => setActivePage('imprint')}
            >
              {t('imprint')}
            </button>
            <button
              type="button"
              className="topbar-link"
              onClick={() => setActivePage('privacy')}
            >
              {t('privacy')}
            </button>
          </nav>
          <div className="topbar-actions">
            <button
              type="button"
              onClick={importFolder}
              disabled={busy || !catalogReady}
            >
              <FolderOpen size={17} />
              {t('importFolder')}
            </button>
            <label className="language-control" title={t('language')}>
              <span aria-hidden="true">
                <Languages size={16} />
              </span>
              <select
                aria-label={t('language')}
                value={language}
                onChange={(event) => changeLanguage(event.target.value)}
              >
                {LANGUAGES.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <details className="display-menu settings-menu">
              <summary>
                <Settings2 size={17} />
                {t('settings')}
              </summary>
              <div className="display-popover settings-popover">
                <div className="display-section">
                  <span>{t('activityLog')}</span>
                  <div className="activity-log" aria-label={t('activityLog')}>
                    {activityLog.map((entry) => (
                      <div key={entry.id} className="activity-log-entry">
                        <time dateTime={new Date(entry.createdAt).toISOString()}>
                          {formatDateTime(entry.createdAt, locale)}
                        </time>
                        <p>{t(entry.key, entry.values)}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="display-section">
                  <span>{t('catalogData')}</span>
                  <button
                    type="button"
                    className="danger settings-clear-button"
                    onClick={confirmClearCatalog}
                    disabled={busy || !catalogReady}
                  >
                    <Trash2 size={16} />
                    {t('clearCatalog')}
                  </button>
                </div>
              </div>
            </details>
          </div>
          <div
            className={`topbar-progress-slot ${importProgress ? 'active' : 'idle'}`}
            aria-live="polite"
          >
            {importProgress ? (
              <div className="import-progress-strip">
                <div className="import-progress-header">
                  <span>{importProgressLabel(importProgress, t, locale)}</span>
                  <strong>{importProgressDetail(importProgress, t, locale)}</strong>
                </div>
                <div
                  className={`progress-track ${
                    importProgress.phase === 'counting' ? 'indeterminate' : ''
                  }`}
                  role="progressbar"
                  aria-label={t('importProgress')}
                  aria-valuemax={importProgress.totalFiles || undefined}
                  aria-valuemin={0}
                  aria-valuenow={
                    importProgress.phase === 'counting'
                      ? undefined
                      : importProgress.scannedFiles
                  }
                >
                  <div
                    className="progress-fill"
                    style={{
                      width:
                        importProgressPercent(importProgress) === undefined
                          ? undefined
                          : `${importProgressPercent(importProgress)}%`,
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="import-progress-idle" aria-hidden="true" />
            )}
          </div>
        </div>
      </header>

      <section ref={workspaceRef} className="workspace">
        <section ref={leftStackRef} className="left-stack">
          <div
            className={`map-pane ${boundsDrawing ? 'area-drawing' : ''}`}
          >
            <MapView
              queryPoint={distanceSortActive ? queryPoint : undefined}
              geoItems={mapItems}
              results={mapResultItems}
              geoBounds={geoBounds}
              boundsDrawing={boundsDrawing}
              label={t('searchMap')}
              onQueryPointChange={setMapQueryPoint}
              onGeoBoundsChange={setMapGeoBounds}
            />
            <div className="map-area-tools">
              <button
                type="button"
                className={boundsDrawing ? 'active' : undefined}
                aria-pressed={boundsDrawing}
                onClick={toggleBoundsDrawing}
                title={t('areaFilter')}
              >
                <BoxSelect size={16} />
                {t('area')}
              </button>
              {geoBounds && (
                <button
                  type="button"
                  onClick={clearMapGeoBounds}
                  title={t('clearAreaFilter')}
                >
                  <Trash2 size={16} />
                  {t('clear')}
                </button>
              )}
            </div>
            {(mapPointLimitReached || distanceSortActive) && (
              <div className="map-status-stack">
                {mapPointLimitReached && (
                  <div className="map-limit-notice">
                    {t('mapPointLimitNotice', {
                      shown: MAP_POINT_LIMIT.toLocaleString(locale),
                    })}
                  </div>
                )}
                {distanceSortActive && (
                  <div className="map-readout">
                    <MapPin size={16} />
                    <span>{queryPoint.lat.toFixed(5)}</span>
                    <span>{queryPoint.lon.toFixed(5)}</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div
            aria-label={t('resizeMapAndQueryPanels')}
            aria-orientation="horizontal"
            aria-valuemax={resizeControls.map.max}
            aria-valuemin={resizeControls.map.min}
            aria-valuenow={resizeControls.map.now}
            className="resize-handle resize-handle-horizontal"
            role="separator"
            tabIndex={0}
            title={t('resizeMapAndQueryPanels')}
            onKeyDown={nudgeMapPane}
            onPointerDown={startHorizontalResize}
            onPointerMove={handleHorizontalResizeMove}
          />

          <aside className="control-pane">
            <section className="panel">
              <div className="panel-title">
                <Calendar size={17} />
                <h2>{t('catalog')}</h2>
              </div>
              <div className="time-range-row">
                <label>
                  {t('from')}
                  <input
                    type="datetime-local"
                    value={startDate}
                    onChange={(event) => {
                      setStartDate(event.target.value)
                      setResultPage(0)
                    }}
                  />
                </label>
                <label>
                  {t('to')}
                  <input
                    type="datetime-local"
                    value={endDate}
                    onChange={(event) => {
                      setEndDate(event.target.value)
                      setResultPage(0)
                    }}
                  />
                </label>
              </div>
              <label>
                {t('kind')}
                <select
                  value={kindFilter}
                  onChange={(event) =>
                    setFilterKind(filterValueToKind(event.target.value))
                  }
                >
                  <option value="all">{t('all')}</option>
                  <option value="image">{t('images')}</option>
                  <option value="video">{t('videos')}</option>
                </select>
              </label>
              <label>
                {t('sort')}
                <select
                  value={sort}
                  onChange={(event) =>
                    setSortMode(event.target.value as SortMode)
                  }
                >
                  <option value="captured_at_desc">{t('newestFirst')}</option>
                  <option value="captured_at_asc">{t('oldestFirst')}</option>
                  <option value="distance">
                    {t('distanceFromMapPoint')}
                  </option>
                </select>
              </label>
              {distanceSortActive && (
                <div className="distance-sort-controls">
                  <label>
                    {t('engine')}
                    <select
                      value={selectedIndexId}
                      onChange={(event) => {
                        setSelectedIndexId(event.target.value)
                        setResultPage(0)
                      }}
                    >
                      {registry.indexes.map((index) => (
                        <option key={index.id} value={index.id}>
                          {index.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
            </section>

            <section className="panel metrics-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t('metrics')}</h2>
              </div>
              <dl className="metrics-grid">
                <div>
                  <dt>{t('geoPoints')}</dt>
                  <dd>{geoPointCount.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{t('query')}</dt>
                  <dd>{indexStats.lastQueryTimeMs?.toFixed(2) ?? '0'} ms</dd>
                </div>
                <div>
                  <dt>{t('distances')}</dt>
                  <dd>{statsNumber(indexStats.distanceComputations, locale)}</dd>
                </div>
                <div>
                  <dt>{t('nodes')}</dt>
                  <dd>{statsNumber(indexStats.nodesVisited, locale)}</dd>
                </div>
                <div>
                  <dt>{t('visited')}</dt>
                  <dd>{statsNumber(indexStats.candidatesInspected, locale)}</dd>
                </div>
                <div>
                  <dt>{t('pruned')}</dt>
                  <dd>
                    {statsNumber(
                      indexStats.prunedByGeo + indexStats.prunedByTime,
                      locale,
                    )}
                  </dd>
                </div>
              </dl>
              {validation && (
                <p
                  className={
                    validation.equal ? 'validation good' : 'validation bad'
                  }
                >
                  {validation.message}
                </p>
              )}
            </section>
          </aside>
        </section>

        <div
          aria-label={t('resizeLeftToolsAndResults')}
          aria-orientation="vertical"
          aria-valuemax={resizeControls.left.max}
          aria-valuemin={resizeControls.left.min}
          aria-valuenow={resizeControls.left.now}
          className="resize-handle resize-handle-vertical"
          role="separator"
          tabIndex={0}
          title={t('resizeLeftToolsAndResults')}
          onKeyDown={nudgeLeftPane}
          onPointerDown={startVerticalResize}
          onPointerMove={handleVerticalResizeMove}
        />

        <section className="library-strip">
          <div className="library-header">
            <div>
              <h2>
                {visibleResults ? t('nearestResults') : t('catalogResults')}
              </h2>
              <p className="subtle">
                {visibleRange} {t('visible')} ·{' '}
                {sources.length.toLocaleString(locale)} {t('sources')}
              </p>
            </div>
            <div className="library-actions">
              <label className="pagination-size">
                {t('page')}
                <select
                  value={resultPageSize}
                  onChange={(event) => setPageSize(Number(event.target.value))}
                >
                  {RESULT_PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </label>
              <div className="pagination-buttons" aria-label={t('resultPages')}>
                <button
                  type="button"
                  onClick={() => setResultPage((page) => Math.max(0, page - 1))}
                  disabled={!canPageBackward}
                  title={t('previousPage')}
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  type="button"
                  onClick={() => setResultPage((page) => page + 1)}
                  disabled={!canPageForward}
                  title={t('nextPage')}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <details className="display-menu">
                <summary>
                  <Settings2 size={17} />
                  {t('display')}
                </summary>
                <div className="display-popover">
                  <div className="display-section">
                    <span>{t('mode')}</span>
                    <div className="segmented-control" role="group" aria-label={t('resultDisplayMode')}>
                      <button
                        type="button"
                        className={resultDisplayMode === 'images' ? 'active' : ''}
                        onClick={() => setDisplayMode('images')}
                      >
                        <Images size={16} />
                        {t('images')}
                      </button>
                      <button
                        type="button"
                        className={resultDisplayMode === 'cards' ? 'active' : ''}
                        onClick={() => setDisplayMode('cards')}
                      >
                        <ImageIcon size={16} />
                        {t('cards')}
                      </button>
                      <button
                        type="button"
                        className={resultDisplayMode === 'list' ? 'active' : ''}
                        onClick={() => setDisplayMode('list')}
                      >
                        <List size={16} />
                        {t('list')}
                      </button>
                    </div>
                  </div>
                  <div className="display-section">
                    <span>{t('thumbnailSize')}</span>
                    <div className="segmented-control compact" role="group" aria-label={t('thumbnailSize')}>
                      {(['small', 'medium', 'large'] as const).map((size) => (
                        <button
                          key={size}
                          type="button"
                          className={resultThumbnailSize === size ? 'active' : ''}
                          onClick={() => setThumbnailSize(size)}
                        >
                          {t(size)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={showResultMetadata}
                      onChange={(event) => toggleMetadata(event.target.checked)}
                    />
                    {t('showMetadata')}
                  </label>
                </div>
              </details>
              <button type="button" onClick={clearSearch} disabled={busy}>
                <Trash2 size={17} />
                {t('clearSearch')}
              </button>
            </div>
          </div>
          <div className="library-notices">
            {error && <p className="error-banner">{error}</p>}
          </div>
        <div
          className={`media-grid media-grid-${resultDisplayMode} media-thumb-${resultThumbnailSize}`}
        >
          {resultItems.map((result, index) => (
            <article
              key={result.item.id}
              className="media-card"
              role="button"
              tabIndex={0}
              onClick={() => openViewer(index)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openViewer(index)
              }}
            >
              <Thumbnail
                thumbnails={platform.thumbnails}
                thumbnailKey={result.item.thumbnailKey}
                label={result.item.displayName}
                kind={result.item.kind}
              />
              {resultDisplayMode !== 'images' && (
                <div className="media-card-body">
                  <div className="media-title-row">
                    {result.item.kind === 'video' ? (
                      <Video size={15} />
                    ) : (
                      <ImageIcon size={15} />
                    )}
                    <h3>{result.item.displayName}</h3>
                  </div>
                  {showResultMetadata && (
                    <>
                      <p>
                        {formatDateTime(
                          result.item.capturedAt,
                          locale,
                          t('noTimestamp'),
                        )}
                      </p>
                      <p>{result.item.relativePath}</p>
                      <p className="metadata-extra">
                        {[
                          result.item.mimeType,
                          formatDimensions(result.item),
                          formatGeo(result.item),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </>
                  )}
                  {Number.isFinite(result.distanceMeters) && (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  )}
                </div>
              )}
              {resultDisplayMode === 'images' && showResultMetadata && (
                <div className="media-overlay">
                  <span>{result.item.displayName}</span>
                  {Number.isFinite(result.distanceMeters) && (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  )}
                </div>
              )}
              {resultDisplayMode === 'list' && (
                <div className="media-list-columns">
                  <span>{t(result.item.kind)}</span>
                  <span>
                    {formatDateTime(
                      result.item.capturedAt,
                      locale,
                      t('noTimestamp'),
                    )}
                  </span>
                  <span>{formatDimensions(result.item) ?? 'n/a'}</span>
                  <span>{formatGeo(result.item) ?? t('metadataNoGps')}</span>
                  {Number.isFinite(result.distanceMeters) ? (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  ) : (
                    <span>{t('metadataCatalog')}</span>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {viewerSession &&
        viewerLocalIndex >= 0 &&
        viewerLocalIndex < viewerSession.items.length && (
        <MediaViewer
          platform={platform}
          items={viewerSession.items}
          index={viewerLocalIndex}
          absoluteIndex={viewerSession.absoluteIndex}
          totalItems={viewerSession.totalItems}
          canNavigatePrevious={viewerSession.absoluteIndex > 0}
          canNavigateNext={viewerSession.canNavigateNext}
          navigationPending={viewerNavigationPending}
          locale={locale}
          t={t}
          onClose={closeViewer}
          onNavigate={(index) => {
            void openViewerAtIndex(index)
          }}
        />
      )}
      </section>
    </main>
  )
}

export default App
