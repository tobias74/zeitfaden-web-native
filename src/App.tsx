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
  Save,
  Settings2,
  Trash2,
  Video,
  X,
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
import { useCatalogLifecycle } from './app/useCatalogLifecycle'
import { useGeoIndexes } from './app/useGeoIndexes'
import { useImports } from './app/useImports'
import { useMediaViewer } from './app/useMediaViewer'
import { useSearchResults } from './app/useSearchResults'
import {
  type QueryPoint,
  type SearchSortMode,
  useSearchState,
} from './app/useSearchState'
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
import { formatDateTime } from './lib/time'
import { createPlatformBackend } from './platform'
import type {
  GeoIndexBuildProgress,
  ImportProgress,
} from './platform/types'
import {
  WEB_CATALOG_STORAGE_MODE_KEY,
  isWebCatalogStorageMode,
  storedWebCatalogStorageMode,
  type WebCatalogStorageMode,
} from './platform/web/storageMode'
import type {
  EnrichedSearchResult,
  GeoBounds,
  KindFilter,
  MediaItem,
  SearchIndexStats,
  SearchSpec,
} from './types'

type ActivePage = 'app' | 'imprint' | 'privacy'
type ResultDisplayMode = 'images' | 'cards' | 'list'
type ResultThumbnailSize = 'small' | 'medium' | 'large'
type ActivityLogEntry = {
  id: number
  key: TranslationKey
  values?: TranslationValues
  createdAt: number
}

const LEFT_WIDTH_KEY = 'geo-media-index-lab:left-width'
const MAP_HEIGHT_KEY = 'geo-media-index-lab:map-height'
const RESULT_DISPLAY_MODE_KEY = 'geo-media-index-lab:result-display-mode'
const RESULT_THUMBNAIL_SIZE_KEY = 'geo-media-index-lab:result-thumbnail-size'
const RESULT_METADATA_KEY = 'geo-media-index-lab:result-metadata'
const EXPLAIN_SQL_KEY = 'geo-media-index-lab:explain-sql'
const RESULT_PAGE_SIZE_KEY = 'geo-media-index-lab:result-page-size'
const RESULT_PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const
const DEFAULT_RESULT_PAGE_SIZE = 100
const MAP_POINT_LIMIT = 500
const DEFAULT_DISTANCE_ENGINE_ID = 'dynamic-z-order-cells'
const DISTANCE_ENGINE_IDS = [
  'brute-force',
  's2-cell-btree',
  'dynamic-z-order-cells',
  'segmented-kd-tree',
  'segmented-ball-tree',
] as const
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

function filterValueToKind(value: string): KindFilter {
  return value === 'image' ||
    value === 'video' ||
    value === 'geo_point' ||
    value === 'media'
    ? value
    : 'all'
}

function statsNumber(value: number | undefined, locale: string): string {
  return typeof value === 'number' ? value.toLocaleString(locale) : '0'
}

function formatBytes(value: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
  }).format(size)} ${units[unitIndex]}`
}

function importProgressCurrent(progress: ImportProgress): number | undefined {
  if (
    typeof progress.scannedBytes === 'number' &&
    typeof progress.totalBytes === 'number'
  ) {
    return progress.scannedBytes
  }
  if (progress.phase === 'counting') return undefined
  return progress.scannedFiles
}

function importProgressMax(progress: ImportProgress): number | undefined {
  if (
    typeof progress.scannedBytes === 'number' &&
    typeof progress.totalBytes === 'number'
  ) {
    return progress.totalBytes
  }
  return progress.totalFiles || undefined
}

function importProgressPercent(progress: ImportProgress): number | undefined {
  const current = importProgressCurrent(progress)
  const max = importProgressMax(progress)
  if (current === undefined || max === undefined || max === 0) {
    return undefined
  }
  return Math.min(100, (current / max) * 100)
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

  if (
    typeof progress.scannedBytes === 'number' &&
    typeof progress.totalBytes === 'number'
  ) {
    return `${formatBytes(progress.scannedBytes, locale)} / ${formatBytes(
      progress.totalBytes,
      locale,
    )} · ${t('importItemsAcceptedSkipped', {
      accepted: progress.acceptedMedia.toLocaleString(locale),
      skipped: progress.skippedFiles.toLocaleString(locale),
    })}`
  }

  return `${progress.scannedFiles.toLocaleString(locale)} / ${progress.totalFiles.toLocaleString(locale)}`
}

function geoIndexProgressPercent(
  progress: GeoIndexBuildProgress,
): number | undefined {
  if (progress.phase === 'loading' || progress.totalIndexes === 0) {
    return undefined
  }
  const currentIndexProgress =
    typeof progress.currentIndexProcessedPoints === 'number' &&
    typeof progress.currentIndexTotalPoints === 'number' &&
    progress.currentIndexTotalPoints > 0
      ? Math.min(
          1,
          progress.currentIndexProcessedPoints / progress.currentIndexTotalPoints,
        )
      : 0
  return Math.min(
    100,
    ((progress.builtIndexes + currentIndexProgress) / progress.totalIndexes) *
      100,
  )
}

function geoIndexProgressLabel(
  progress: GeoIndexBuildProgress,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): string {
  if (progress.phase === 'loading') {
    return t('loadingDistanceIndex', {
      indexLabel: progress.currentIndexLabel ?? '',
    })
  }
  if (progress.phase === 'ready') return t('geoIndexesReady')
  return t('buildingGeoIndex', {
    indexLabel: progress.currentIndexLabel ?? '',
  })
}

function geoIndexProgressDetail(
  progress: GeoIndexBuildProgress,
  t: (key: TranslationKey, values?: TranslationValues) => string,
  locale: string,
): string {
  if (
    typeof progress.currentIndexProcessedPoints === 'number' &&
    typeof progress.currentIndexTotalPoints === 'number' &&
    progress.currentIndexTotalPoints > 0
  ) {
    return t('geoIndexProgressDetailWithCurrent', {
      points: progress.pointCount.toLocaleString(locale),
      built: progress.builtIndexes.toLocaleString(locale),
      total: progress.totalIndexes.toLocaleString(locale),
      processed: progress.currentIndexProcessedPoints.toLocaleString(locale),
      currentTotal: progress.currentIndexTotalPoints.toLocaleString(locale),
    })
  }

  return t('geoIndexProgressDetail', {
    points: progress.pointCount.toLocaleString(locale),
    built: progress.builtIndexes.toLocaleString(locale),
    total: progress.totalIndexes.toLocaleString(locale),
  })
}

function formatDimensions(item: MediaItem): string | undefined {
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

function resultSkeletonCount(
  displayMode: ResultDisplayMode,
  pageSize: number,
): number {
  const modeMaximum = displayMode === 'images' ? 24 : 12
  return Math.max(1, Math.min(pageSize, modeMaximum))
}

function ResultSkeletons({
  count,
  displayMode,
}: {
  count: number
  displayMode: ResultDisplayMode
}) {
  return Array.from({ length: count }, (_, index) => (
    <article
      key={`result-skeleton-${index}`}
      className="media-card media-card-skeleton"
      aria-hidden="true"
    >
      <div className="thumb-placeholder skeleton-thumb">
        <span className="skeleton-block skeleton-icon" />
      </div>
      {displayMode !== 'images' && (
        <div className="media-card-body">
          <div className="media-title-row">
            <span className="skeleton-block skeleton-glyph" />
            <span className="skeleton-block skeleton-title" />
          </div>
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line short" />
          <span className="skeleton-block skeleton-line medium" />
        </div>
      )}
      {displayMode === 'images' && (
        <div className="media-overlay media-overlay-skeleton">
          <span className="skeleton-block skeleton-line" />
          <strong className="skeleton-block skeleton-distance" />
        </div>
      )}
      {displayMode === 'list' && (
        <div className="media-list-columns media-list-columns-skeleton">
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line" />
          <span className="skeleton-block skeleton-line" />
          <strong className="skeleton-block skeleton-line" />
        </div>
      )}
    </article>
  ))
}

function App() {
  const [webCatalogStorageMode, setWebCatalogStorageMode] =
    useState<WebCatalogStorageMode>(() => storedWebCatalogStorageMode())
  const platform = useMemo(
    () => createPlatformBackend(webCatalogStorageMode),
    [webCatalogStorageMode],
  )
  const catalog = platform.catalog
  const [language, setLanguage] = useState<Language>(() => storedLanguage())
  const [activePage, setActivePage] = useState<ActivePage>('app')
  const locale = languageLocale(language)
  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(language, key, values),
    [language],
  )
  const search = useSearchState({
    allowedIndexIds: DISTANCE_ENGINE_IDS,
    defaultSelectedIndexId: DEFAULT_DISTANCE_ENGINE_ID,
    defaultQueryPoint: DEFAULT_QUERY_POINT,
    defaultResultPageSize: DEFAULT_RESULT_PAGE_SIZE,
    allowedPageSizes: RESULT_PAGE_SIZE_OPTIONS,
    pageSizeStorageKey: RESULT_PAGE_SIZE_KEY,
    mapPointLimit: MAP_POINT_LIMIT,
  })
  const {
    selectedIndexId,
    queryPoint,
    startDate,
    endDate,
    sort,
    kindFilter,
    geoBounds,
    boundsDrawing,
    resultPage,
    resultPageSize,
    distanceSortActive,
    catalogSort,
    resultOffset,
    timeRange,
    appHref,
  } = search.values
  const {
    setQueryPoint,
    setStartDate,
    setEndDate,
    setSort,
    setSelectedIndexId,
    setKindFilter,
    setGeoBounds,
    clearGeoBounds,
    toggleBoundsDrawing,
    setPage: setResultPage,
    setPageSize,
    clearSearch: clearSearchState,
  } = search.actions

  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>(() => [
    {
      id: 0,
      key: 'activityInitializingCatalog',
      createdAt: Date.now(),
    },
  ])
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [error, setError] = useState<string>()
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
  const [explainSqlQueries, setExplainSqlQueries] = useState(() =>
    storedBoolean(EXPLAIN_SQL_KEY, false),
  )
  const [leftWidth, setLeftWidth] = useState(() =>
    clamp(storedNumber(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH), MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
  )
  const [mapHeight, setMapHeight] = useState(() =>
    Math.max(MIN_MAP_HEIGHT, storedNumber(MAP_HEIGHT_KEY, DEFAULT_MAP_HEIGHT)),
  )
  const workspaceRef = useRef<HTMLElement | null>(null)
  const leftStackRef = useRef<HTMLElement | null>(null)
  const settingsMenuRef = useRef<HTMLDetailsElement | null>(null)
  const displayMenuRef = useRef<HTMLDetailsElement | null>(null)
  const activityLogIdRef = useRef(1)

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
  const reportError = useCallback((message: string) => {
    setError(message || undefined)
  }, [])
  const recordCatalogInitFailure = useCallback(() => {
    recordActivity('activityCatalogFailedToInitialize')
  }, [recordActivity])

  const {
    catalogInfo,
    catalogReady,
    catalogRevision,
    sources,
    markCatalogChanged,
    resetCatalogState,
  } = useCatalogLifecycle({
    catalog,
    onError: reportError,
    onInitFailed: recordCatalogInitFailure,
  })
  const {
    geoPointCount,
    geoIndexVersion,
    geoIndexProgress,
    indexStats,
    optimizeIndex,
    resetIndexState,
  } = useGeoIndexes({
    catalog,
    catalogInfo,
    catalogRevision,
    selectedIndexId,
    onError: reportError,
  })
  const [indexStatsOverride, setIndexStatsOverride] =
    useState<SearchIndexStats>()
  const s2CellBtreeAvailable =
    catalogInfo?.storageMode === 'native' ||
    catalogInfo?.storageMode === 'opfs' ||
    (!catalogInfo && webCatalogStorageMode === 'sqlite')
  useEffect(() => {
    if (selectedIndexId === 's2-cell-btree' && !s2CellBtreeAvailable) {
      setSelectedIndexId(DEFAULT_DISTANCE_ENGINE_ID)
    }
  }, [s2CellBtreeAvailable, selectedIndexId, setSelectedIndexId])
  const searchDiagnostics = useMemo(
    () => ({
      explainSql: explainSqlQueries,
    }),
    [explainSqlQueries],
  )
  const searchOrder = useMemo<SearchSpec['order']>(() => {
    if (distanceSortActive) {
      return {
        kind: 'distance',
        point: queryPoint,
        engineId: selectedIndexId,
      }
    }

    return {
      kind: 'timestamp',
      sort: catalogSort,
    }
  }, [
    catalogSort,
    distanceSortActive,
    queryPoint,
    selectedIndexId,
  ])
  const resultSearchSpec = useMemo<SearchSpec>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      geoBounds,
      order: searchOrder,
      limit: resultPageSize,
      offset: resultOffset,
      purpose: 'results',
      diagnostics: searchDiagnostics,
    }),
    [
      geoBounds,
      kindFilter,
      resultOffset,
      resultPageSize,
      searchDiagnostics,
      searchOrder,
      timeRange,
    ],
  )
  const mapSearchSpec = useMemo<SearchSpec>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      hasGeo: true,
      order: searchOrder,
      limit: MAP_POINT_LIMIT,
      offset: 0,
      purpose: 'map',
      diagnostics: searchDiagnostics,
    }),
    [kindFilter, searchDiagnostics, searchOrder, timeRange],
  )
  const searchWindows = useSearchResults({
    catalog,
    ready: catalogReady,
    pageSpec: resultSearchSpec,
    mapSpec: mapSearchSpec,
    revision: catalogRevision,
    indexVersion: geoIndexVersion,
    onError: reportError,
    onStats: setIndexStatsOverride,
  })
  const mapItems = searchWindows.mapItems
  const mapPointLimitReached = searchWindows.mapLimitReached
  const validation = searchWindows.validation
  const effectiveIndexStats =
    indexStatsOverride ?? searchWindows.resultMetrics ?? indexStats
  const handleImported = useCallback(() => {
    setResultPage(0)
    markCatalogChanged()
  }, [markCatalogChanged, setResultPage])
  const {
    busy: importBusy,
    importProgress,
    activeImportKind,
    cancelling: cancellingImport,
    importFolder,
    importGeoFile,
    cancelImport,
    commitImport,
  } = useImports({
    platform,
    locale,
    t,
    recordActivity,
    onError: reportError,
    onImported: handleImported,
  })
  const busy = importBusy || catalogBusy
  const canCommitImport =
    Boolean(importProgress) &&
    activeImportKind === 'geo' &&
    (platform.kind === 'tauri' || webCatalogStorageMode === 'sqlite')
  const visibleResults = distanceSortActive
  const resultItems = searchWindows.results
  const resultItemsLoading = searchWindows.loading
  const skeletonCount = resultSkeletonCount(resultDisplayMode, resultPageSize)
  const visibleStart = resultItems.length === 0 ? 0 : resultOffset + 1
  const visibleEnd = resultOffset + resultItems.length
  const visibleRange = distanceSortActive
    ? t('resultRangeOf', {
        start: visibleStart.toLocaleString(locale),
        end: visibleEnd.toLocaleString(locale),
        total: geoPointCount.toLocaleString(locale),
      })
    : resultItems.length === 0
      ? '0'
      : `${visibleStart.toLocaleString(locale)}-${visibleEnd.toLocaleString(locale)}`
  const canPageBackward = resultPage > 0
  const canPageForward = searchWindows.pageLimitReached
  const loadViewerWindow = useCallback(
    async (windowOffset: number) => {
      return (await searchWindows.loadWindow(windowOffset)).items
    },
    [searchWindows],
  )
  const handleViewerWindowLoaded = useCallback(
    (windowOffset: number, windowItems: EnrichedSearchResult[]) => {
      setResultPage(windowOffset / resultPageSize)
      searchWindows.setResults(windowItems)
    },
    [resultPageSize, searchWindows, setResultPage],
  )
  const {
    viewerSession,
    viewerLocalIndex,
    viewerNavigationPending,
    openViewer,
    openViewerAtIndex,
    closeViewer,
  } = useMediaViewer({
    resultOffset,
    resultPageSize,
    currentItems: resultItems,
    totalItems: undefined,
    loadWindow: loadViewerWindow,
    onWindowLoaded: handleViewerWindowLoaded,
    onError: reportError,
  })

  const changeLanguage = useCallback((value: string) => {
    if (!isLanguage(value)) return
    setLanguage(value)
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value)
  }, [])

  const changeWebCatalogStorageMode = useCallback(
    (value: string) => {
      if (
        busy ||
        !isWebCatalogStorageMode(value) ||
        value === webCatalogStorageMode
      ) {
        return
      }

      window.localStorage.setItem(WEB_CATALOG_STORAGE_MODE_KEY, value)
      resetCatalogState()
      resetIndexState()
      searchWindows.setResults([])
      searchWindows.clearMap()
      searchWindows.setValidation(undefined)
      setIndexStatsOverride(undefined)
      closeViewer()
      setError(undefined)
      setWebCatalogStorageMode(value)
    },
    [
      busy,
      closeViewer,
      resetCatalogState,
      resetIndexState,
      searchWindows,
      webCatalogStorageMode,
    ],
  )

  const changeExplainSqlQueries = useCallback((checked: boolean) => {
    setExplainSqlQueries(checked)
    window.localStorage.setItem(EXPLAIN_SQL_KEY, checked ? 'true' : 'false')
  }, [])

  useEffect(() => {
    return () => platform.dispose()
  }, [platform])

  useEffect(() => {
    function closeMenusOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return
      const openMenus = [settingsMenuRef.current, displayMenuRef.current]
        .filter((menu): menu is HTMLDetailsElement => Boolean(menu?.open))
      if (openMenus.length === 0) return

      for (const menu of openMenus) {
        menu.open = false
      }
      event.preventDefault()
    }

    window.addEventListener('keydown', closeMenusOnEscape)
    return () => window.removeEventListener('keydown', closeMenusOnEscape)
  }, [])

  useEffect(() => {
    function closeMenusOnOutsidePointer(event: globalThis.PointerEvent) {
      const path = event.composedPath()
      const menus = [settingsMenuRef.current, displayMenuRef.current].filter(
        (menu): menu is HTMLDetailsElement => Boolean(menu?.open),
      )

      for (const menu of menus) {
        if (!path.includes(menu)) {
          menu.open = false
        }
      }
    }

    window.addEventListener('pointerdown', closeMenusOnOutsidePointer)
    return () =>
      window.removeEventListener('pointerdown', closeMenusOnOutsidePointer)
  }, [])

  const clearCatalog = useCallback(async () => {
    setCatalogBusy(true)
    setError(undefined)
    try {
      await catalog.clear()
      setResultPage(0)
      clearGeoBounds()
      searchWindows.setResults([])
      searchWindows.clearMap()
      searchWindows.setValidation(undefined)
      setIndexStatsOverride(undefined)
      closeViewer()
      markCatalogChanged()
      recordActivity('activityCatalogCleared')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCatalogBusy(false)
    }
  }, [
    catalog,
    clearGeoBounds,
    closeViewer,
    markCatalogChanged,
    recordActivity,
    searchWindows,
    setResultPage,
  ])

  const confirmClearCatalog = useCallback(() => {
    if (busy || !catalogReady) return
    const confirmed = window.confirm(t('clearCatalogConfirm'))
    if (!confirmed) return
    void clearCatalog()
  }, [busy, catalogReady, clearCatalog, t])

  const setFilterKind = useCallback((kind: KindFilter) => {
    setKindFilter(kind)
  }, [setKindFilter])

  const setSortMode = useCallback((nextSort: SearchSortMode) => {
    setSort(nextSort)
    if (nextSort !== 'distance') {
      searchWindows.setResults([])
      searchWindows.setValidation(undefined)
      setIndexStatsOverride(undefined)
    }
  }, [searchWindows, setSort])

  const setMapQueryPoint = useCallback((point: QueryPoint) => {
    setQueryPoint(point)
  }, [setQueryPoint])

  const setMapGeoBounds = useCallback((bounds: GeoBounds) => {
    setGeoBounds(bounds)
  }, [setGeoBounds])

  const clearMapGeoBounds = useCallback(() => {
    clearGeoBounds()
  }, [clearGeoBounds])

  const clearSearch = useCallback(() => {
    clearSearchState()
    searchWindows.setResults([])
    searchWindows.setValidation(undefined)
    setIndexStatsOverride(undefined)
    closeViewer()
  }, [clearSearchState, closeViewer, searchWindows])

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

  const privacyHtml = language === 'de' ? privacyDeHtml : privacyEnHtml

  if (activePage !== 'app') {
    return (
      <main className="legal-shell">
        <header className="topbar legal-topbar">
          <div className="topbar-copy">
            <h1>
              <a
                className="app-title-link"
                href={appHref}
                onClick={(event) => {
                  event.preventDefault()
                  setActivePage('app')
                }}
              >
                zeitfaden
              </a>
            </h1>
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
            <article
              className="privacy-page"
              dangerouslySetInnerHTML={{ __html: privacyHtml }}
            />
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
              href={appHref}
              onClick={(event) => {
                event.preventDefault()
                setActivePage('app')
              }}
            >
              zeitfaden
            </a>
          </h1>
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
            <button
              type="button"
              onClick={importGeoFile}
              disabled={busy || !catalogReady}
            >
              <MapPin size={17} />
              {t('importGeoFile')}
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
            <details ref={settingsMenuRef} className="display-menu settings-menu">
              <summary>
                <Settings2 size={17} />
                {t('settings')}
              </summary>
              <div className="display-popover settings-popover">
                {platform.kind === 'web' && (
                  <div className="display-section">
                    <label className="settings-select-row">
                      <span>{t('catalogDatabase')}</span>
                      <select
                        value={webCatalogStorageMode}
                        onChange={(event) =>
                          changeWebCatalogStorageMode(event.target.value)
                        }
                        disabled={busy}
                      >
                        <option value="sqlite">{t('sqliteOpfs')}</option>
                        <option value="indexeddb">{t('indexedDb')}</option>
                      </select>
                    </label>
                    <p className="settings-hint">
                      {t('catalogDatabaseDescription')}
                    </p>
                  </div>
                )}
                <div className="display-section">
                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={explainSqlQueries}
                      onChange={(event) =>
                        changeExplainSqlQueries(event.currentTarget.checked)
                      }
                    />
                    <span>{t('explainSqlQueries')}</span>
                  </label>
                  <p className="settings-hint">
                    {t('explainSqlQueriesDescription')}
                  </p>
                </div>
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
            className={`topbar-progress-slot ${
              importProgress || geoIndexProgress || error ? 'active' : 'idle'
            }`}
            aria-live="polite"
          >
            {importProgress ? (
              <div className="import-progress-strip">
                <div className="import-progress-header">
                  <span>{importProgressLabel(importProgress, t, locale)}</span>
                  <div className="import-progress-actions">
                    <strong>{importProgressDetail(importProgress, t, locale)}</strong>
                    {canCommitImport && (
                      <button
                        type="button"
                        className="import-cancel-button"
                        onClick={commitImport}
                      >
                        <Save size={13} />
                        {t('commitImport')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="import-cancel-button"
                      onClick={cancelImport}
                      disabled={cancellingImport}
                    >
                      <X size={13} />
                      {t('cancelImport')}
                    </button>
                  </div>
                </div>
                <div
                  className={`progress-track ${
                    importProgress.phase === 'counting' ? 'indeterminate' : ''
                  }`}
                  role="progressbar"
                  aria-label={t('importProgress')}
                  aria-valuemax={importProgressMax(importProgress)}
                  aria-valuemin={0}
                  aria-valuenow={importProgressCurrent(importProgress)}
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
            ) : geoIndexProgress ? (
              <div className="import-progress-strip">
                <div className="import-progress-header">
                  <span>{geoIndexProgressLabel(geoIndexProgress, t)}</span>
                  <strong>
                    {geoIndexProgressDetail(geoIndexProgress, t, locale)}
                  </strong>
                </div>
                <div
                  className={`progress-track ${
                    geoIndexProgress.phase === 'loading' ? 'indeterminate' : ''
                  }`}
                  role="progressbar"
                  aria-label={t('buildingGeoIndex', { indexLabel: '' })}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={
                    geoIndexProgress.phase === 'loading'
                      ? undefined
                      : geoIndexProgressPercent(geoIndexProgress)
                  }
                  aria-valuetext={geoIndexProgressDetail(
                    geoIndexProgress,
                    t,
                    locale,
                  )}
                >
                  <div
                    className="progress-fill"
                    style={{
                      width:
                        geoIndexProgressPercent(geoIndexProgress) === undefined
                          ? undefined
                          : `${geoIndexProgressPercent(geoIndexProgress)}%`,
                    }}
                  />
                </div>
              </div>
            ) : error ? (
              <div className="topbar-error-strip" role="alert" title={error}>
                {error}
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
              results={resultItems}
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
                    onChange={(event) => setStartDate(event.target.value)}
                  />
                </label>
                <label>
                  {t('to')}
                  <input
                    type="datetime-local"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
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
                  <option value="media">{t('allMedia')}</option>
                  <option value="image">{t('images')}</option>
                  <option value="video">{t('videos')}</option>
                  <option value="geo_point">{t('geoPoints')}</option>
                </select>
              </label>
              <label>
                {t('sort')}
                <select
                  value={sort}
                  onChange={(event) =>
                    setSortMode(event.target.value as SearchSortMode)
                  }
                >
                  <option value="timestamp_desc">{t('newestFirst')}</option>
                  <option value="timestamp_asc">{t('oldestFirst')}</option>
                  <option value="distance">
                    {t('distanceFromMapPoint')}
                  </option>
                </select>
              </label>
              {distanceSortActive && (
                <label>
                  {t('distanceEngine')}
                  <select
                    value={selectedIndexId}
                    onChange={(event) => setSelectedIndexId(event.target.value)}
                  >
                    {s2CellBtreeAvailable && (
                      <option value="s2-cell-btree">{t('s2CellBtree')}</option>
                    )}
                    <option value="dynamic-z-order-cells">
                      {t('dynamicZOrderCells')}
                    </option>
                    <option value="segmented-kd-tree">
                      {t('segmentedKdTree')}
                    </option>
                    <option value="segmented-ball-tree">
                      {t('segmentedBallTree')}
                    </option>
                    <option value="brute-force">{t('bruteForceOracle')}</option>
                  </select>
                </label>
              )}
            </section>

            <section className="panel metrics-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t('metrics')}</h2>
              </div>
              <dl className="metrics-grid">
                <div>
                  <dt>{t('engine')}</dt>
                  <dd className="metric-text">
                    {effectiveIndexStats.engineLabel ??
                      effectiveIndexStats.engineId}
                  </dd>
                </div>
                <div>
                  <dt>{t('storage')}</dt>
                  <dd className="metric-text">
                    {effectiveIndexStats.storageMode ?? '-'}
                  </dd>
                </div>
                <div>
                  <dt>{t('geoPoints')}</dt>
                  <dd>{geoPointCount.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{t('query')}</dt>
                  <dd>
                    {(
                      effectiveIndexStats.queryTimeMs ??
                      effectiveIndexStats.lastQueryTimeMs ??
                      0
                    ).toFixed(2)}{' '}
                    ms
                  </dd>
                </div>
                <div>
                  <dt>{t('rows')}</dt>
                  <dd>
                    {statsNumber(
                      effectiveIndexStats.rowsReturned ?? resultItems.length,
                      locale,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t('offset')}</dt>
                  <dd>
                    {statsNumber(effectiveIndexStats.offset ?? resultOffset, locale)}
                  </dd>
                </div>
                <div>
                  <dt>{t('distances')}</dt>
                  <dd>
                    {statsNumber(effectiveIndexStats.distanceComputations, locale)}
                  </dd>
                </div>
                <div>
                  <dt>{t('nodes')}</dt>
                  <dd>{statsNumber(effectiveIndexStats.nodesVisited, locale)}</dd>
                </div>
                <div>
                  <dt>{t('visited')}</dt>
                  <dd>
                    {statsNumber(effectiveIndexStats.candidatesInspected, locale)}
                  </dd>
                </div>
                <div>
                  <dt>{t('pruned')}</dt>
                  <dd>
                    {statsNumber(
                      effectiveIndexStats.prunedByGeo +
                        effectiveIndexStats.prunedByTime,
                      locale,
                    )}
                  </dd>
                </div>
                {typeof effectiveIndexStats.segmentCount === 'number' && (
                  <div>
                    <dt>{t('segments')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.segmentCount, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.deltaSegmentCount === 'number' && (
                  <div>
                    <dt>{t('deltas')}</dt>
                    <dd>
                      {statsNumber(
                        effectiveIndexStats.deltaSegmentCount,
                        locale,
                      )}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.pendingPointCount === 'number' && (
                  <div>
                    <dt>{t('pending')}</dt>
                    <dd>
                      {statsNumber(
                        effectiveIndexStats.pendingPointCount,
                        locale,
                      )}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.cellCount === 'number' && (
                  <div>
                    <dt>{t('cells')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.cellCount, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.sqliteQueryCount === 'number' && (
                  <div>
                    <dt>{t('sqlQueries')}</dt>
                    <dd>
                      {statsNumber(
                        effectiveIndexStats.sqliteQueryCount,
                        locale,
                      )}
                    </dd>
                  </div>
                )}
                {effectiveIndexStats.indexStorage && (
                  <div>
                    <dt>{t('indexStorage')}</dt>
                    <dd>{effectiveIndexStats.indexStorage}</dd>
                  </div>
                )}
                {typeof effectiveIndexStats.residentBytes === 'number' && (
                  <div>
                    <dt>{t('resident')}</dt>
                    <dd>
                      {formatBytes(effectiveIndexStats.residentBytes, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.diskReadBytes === 'number' && (
                  <div>
                    <dt>{t('diskRead')}</dt>
                    <dd>
                      {formatBytes(effectiveIndexStats.diskReadBytes, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.diskReadCount === 'number' && (
                  <div>
                    <dt>{t('diskReads')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.diskReadCount, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.pageCacheHits === 'number' && (
                  <div>
                    <dt>{t('cacheHits')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.pageCacheHits, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.pageCacheMisses === 'number' && (
                  <div>
                    <dt>{t('cacheMisses')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.pageCacheMisses, locale)}
                    </dd>
                  </div>
                )}
                {typeof effectiveIndexStats.loadedPages === 'number' && (
                  <div>
                    <dt>{t('loadedPages')}</dt>
                    <dd>
                      {statsNumber(effectiveIndexStats.loadedPages, locale)}
                    </dd>
                  </div>
                )}
              </dl>
              {(selectedIndexId === 'segmented-kd-tree' ||
                selectedIndexId === 'segmented-ball-tree') && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    void optimizeIndex().catch(reportError)
                  }}
                >
                  {t('optimizeDistanceIndex')}
                </button>
              )}
              {explainSqlQueries && effectiveIndexStats.sqlPlan && (
                <div className="sql-plan-panel">
                  <div>
                    <span>{t('usedIndexes')}</span>
                    <strong>
                      {effectiveIndexStats.sqlPlan.usedIndexes.length > 0
                        ? effectiveIndexStats.sqlPlan.usedIndexes.join(', ')
                        : t('none')}
                    </strong>
                  </div>
                  <ol className="sql-plan-list">
                    {effectiveIndexStats.sqlPlan.rows.map((row) => (
                      <li key={`${row.id}-${row.parent}-${row.detail}`}>
                        {row.detail}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
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
              <details ref={displayMenuRef} className="display-menu">
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
        <div
          className={`media-grid media-grid-${resultDisplayMode} media-thumb-${resultThumbnailSize}`}
          aria-busy={resultItemsLoading}
        >
          {resultItemsLoading ? (
            <ResultSkeletons
              count={skeletonCount}
              displayMode={resultDisplayMode}
            />
          ) : resultItems.map((result, index) => (
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
                    {result.item.kind === 'geo_point' ? (
                      <MapPin size={15} />
                    ) : result.item.kind === 'video' ? (
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
                          result.item.timestamp,
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
                  {typeof result.distanceMeters === 'number' &&
                    Number.isFinite(result.distanceMeters) && (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  )}
                </div>
              )}
              {resultDisplayMode === 'images' && showResultMetadata && (
                <div className="media-overlay">
                  <span>{result.item.displayName}</span>
                  {typeof result.distanceMeters === 'number' &&
                    Number.isFinite(result.distanceMeters) && (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  )}
                </div>
              )}
              {resultDisplayMode === 'list' && (
                <div className="media-list-columns">
                  <span>{t(result.item.kind)}</span>
                  <span>
                    {formatDateTime(
                      result.item.timestamp,
                      locale,
                      t('noTimestamp'),
                    )}
                  </span>
                  <span>{formatDimensions(result.item) ?? 'n/a'}</span>
                  <span>{formatGeo(result.item) ?? t('metadataNoGps')}</span>
                  {typeof result.distanceMeters === 'number' &&
                  Number.isFinite(result.distanceMeters) ? (
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
