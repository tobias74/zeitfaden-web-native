import {
  Activity,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Database,
  FolderOpen,
  Images,
  Image as ImageIcon,
  List,
  MapPin,
  RefreshCcw,
  Settings2,
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
import { sampleMedia, sampleSource } from './demo/sampleData'
import { formatDistance } from './lib/distance'
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
  GeoIndexPoint,
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
type ResultDisplayMode = 'images' | 'cards' | 'list'
type ResultThumbnailSize = 'small' | 'medium' | 'large'

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

function statsNumber(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '0'
}

function importProgressPercent(progress: ImportProgress): number | undefined {
  if (progress.phase === 'counting' || progress.totalFiles === 0) {
    return undefined
  }
  return Math.min(100, (progress.scannedFiles / progress.totalFiles) * 100)
}

function importProgressLabel(progress: ImportProgress): string {
  if (progress.phase === 'counting') {
    return `Counting files in ${progress.sourceLabel}`
  }
  if (progress.phase === 'storing') {
    return `Saving ${progress.acceptedMedia.toLocaleString()} media files`
  }
  return `Scanning ${progress.sourceLabel}`
}

function importProgressDetail(progress: ImportProgress): string {
  if (progress.phase === 'counting') {
    return `${progress.totalFiles.toLocaleString()} files found`
  }

  return `${progress.scannedFiles.toLocaleString()} / ${progress.totalFiles.toLocaleString()} files`
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

function timeRangeFromInputs(startDate: string, endDate: string): TimeRange {
  return {
    startTime: dateInputToMillis(startDate),
    endTime: dateInputEndToMillis(endDate),
  }
}

function mediaItemsToGeoIndexPoints(items: MediaItem[]): GeoIndexPoint[] {
  return items.flatMap((item) => {
    if (
      typeof item.latitude !== 'number' ||
      typeof item.longitude !== 'number'
    ) {
      return []
    }

    return [
      {
        mediaId: item.id,
        lat: item.latitude,
        lon: item.longitude,
        capturedAt: item.capturedAt,
      },
    ]
  })
}

function App() {
  const platform = useMemo(() => createPlatformBackend(), [])
  const catalog = platform.catalog
  const registry = useMemo(() => new GeoIndexRegistry(), [])

  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [sources, setSources] = useState<MediaSource[]>([])
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [geoIndexVersion, setGeoIndexVersion] = useState(0)
  const [selectedIndexId, setSelectedIndexId] = useState('brute-force')
  const [queryPoint, setQueryPoint] = useState<QueryPoint>({
    lat: 47.3769,
    lon: 8.5417,
  })
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [sort, setSort] = useState<SortMode>('captured_at_desc')
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>('all')
  const [resultPage, setResultPage] = useState(0)
  const [resultPageSize, setResultPageSize] = useState(storedPageSize)
  const [searchResults, setSearchResults] = useState<EnrichedSearchResult[]>([])
  const [viewerIndex, setViewerIndex] = useState<number>()
  const [indexStats, setIndexStats] = useState<GeoIndexStats>(defaultStats)
  const [validation, setValidation] = useState<ValidationReport>()
  const [status, setStatus] = useState('Initializing catalog')
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
      sort: catalogSort,
      limit: resultPageSize,
      offset: resultOffset,
    }),
    [catalogSort, kindFilter, resultOffset, resultPageSize, timeRange],
  )

  const refreshMedia = useCallback(async () => {
    const [items, nextSources] = await Promise.all([
      catalog.listMedia(catalogQuery),
      catalog.listSources(),
    ])
    setMediaItems(items)
    setSources(nextSources)
  }, [catalog, catalogQuery])

  const rebuildGeoIndexes = useCallback(async () => {
    const points = await catalog.getGeoPoints()
    setGeoPointCount(points.length)
    setStatus('Building geo index engines')
    await registry.buildAll(points)
    setGeoIndexVersion((version) => version + 1)
    setIndexStats(await registry.get(selectedIndexId).stats())
    setStatus(`Indexed ${points.length.toLocaleString()} geotagged items`)
  }, [catalog, registry, selectedIndexId])

  const refreshAll = useCallback(async () => {
    await refreshMedia()
    await rebuildGeoIndexes()
  }, [rebuildGeoIndexes, refreshMedia])

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
          setStatus('Catalog failed to initialize')
        }
      }
    }

    boot()

    return () => {
      cancelled = true
    }
  }, [catalog, refreshAll])

  useEffect(() => {
    return () => platform.dispose()
  }, [platform])

  useEffect(() => {
    if (!catalogInfo) return
    const timer = window.setTimeout(() => {
      refreshMedia().catch((caught) => {
        setError(caught instanceof Error ? caught.message : String(caught))
      })
    }, 0)

    return () => window.clearTimeout(timer)
  }, [catalogInfo, refreshMedia])

  const importFolder = useCallback(async () => {
    setError(undefined)
    setImportProgress(undefined)

    setBusy(true)
    try {
      const summary = await platform.importer.importFolder((progress) => {
        setImportProgress(progress)
        setStatus(importProgressDetail(progress))
      })
      setResultPage(0)
      await refreshAll()
      setStatus(
        `Imported ${summary.acceptedMedia.toLocaleString()} media files from ${summary.sourceLabel}`,
      )
      if (summary.errors.length > 0) {
        setError(`${summary.errors.length} files could not be read.`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('Import stopped')
    } finally {
      setImportProgress(undefined)
      setBusy(false)
    }
  }, [platform, refreshAll])

  const loadSampleData = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      await catalog.upsertSource(sampleSource)
      await catalog.upsertMedia(sampleMedia)
      await registry.insertMany(mediaItemsToGeoIndexPoints(sampleMedia))
      setResultPage(0)
      setGeoPointCount((await catalog.getGeoPoints()).length)
      setGeoIndexVersion((version) => version + 1)
      setIndexStats(await registry.get(selectedIndexId).stats())
      await refreshMedia()
      setStatus('Loaded sample geotagged library')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [catalog, refreshMedia, registry, selectedIndexId])

  const clearCatalog = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      await catalog.clear()
      setResultPage(0)
      setSearchResults([])
      setValidation(undefined)
      await refreshAll()
      setStatus('Catalog cleared')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [catalog, refreshAll])

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
        const enriched = results
          .flatMap((result) => {
            const item = byId.get(result.mediaId)
            if (!item) return []
            if (kindFilter !== 'all' && item.kind !== kindFilter) return []
            return [{ ...result, item }]
          })
        const [nextValidation, nextStats] = await Promise.all([
          kindFilter === 'all'
            ? registry.validateSelected(selectedIndex.id, query)
            : Promise.resolve(undefined),
          selectedIndex.stats(),
        ])

        if (cancelled) return

        setSearchResults(enriched)
        setValidation(nextValidation)
        setIndexStats(nextStats)
        setStatus(
          `Sorted ${enriched.length.toLocaleString()} items by distance with ${selectedIndex.label}`,
        )
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught))
          setStatus('Distance sort failed')
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
    kindFilter,
    queryPoint.lat,
    queryPoint.lon,
    registry,
    selectedIndex,
    timeRange,
  ])

  const visibleResults = distanceSortActive
  const allResultItems = distanceSortActive
    ? searchResults
    : mediaItems.map((item) => ({ item, mediaId: item.id, distanceMeters: NaN }))
  const resultItems = distanceSortActive
    ? allResultItems.slice(resultOffset, resultOffset + resultPageSize)
    : allResultItems
  const visibleStart = resultItems.length === 0 ? 0 : resultOffset + 1
  const visibleEnd = resultOffset + resultItems.length
  const visibleRange = distanceSortActive
    ? `${visibleStart.toLocaleString()}-${visibleEnd.toLocaleString()} of ${allResultItems.length.toLocaleString()}`
    : resultItems.length === 0
      ? '0'
      : `${visibleStart.toLocaleString()}-${visibleEnd.toLocaleString()}`
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
    if (nextSort !== 'distance') {
      setSearchResults([])
      setValidation(undefined)
    }
  }, [])

  const setPageSize = useCallback((size: number) => {
    setResultPageSize(size)
    setResultPage(0)
    window.localStorage.setItem(RESULT_PAGE_SIZE_KEY, String(size))
  }, [])

  const openViewer = useCallback((index: number) => {
    setViewerIndex(index)
  }, [])

  const closeViewer = useCallback(() => {
    setViewerIndex(undefined)
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

  return (
    <main className="app-shell" style={resizeStyle}>
      <header className="topbar">
        <div className="topbar-copy">
          <h1>Geo Media Index Lab</h1>
          <p className="subtle">
            {catalogInfo
              ? `SQLite ${catalogInfo.sqliteVersion} · ${catalogInfo.storageMode.toUpperCase()} · ${catalogInfo.filename}`
              : 'Starting local catalog'}
          </p>
        </div>
        <div className="topbar-tools">
          <div className="topbar-actions">
            <button
              type="button"
              onClick={importFolder}
              disabled={busy || !catalogReady}
            >
              <FolderOpen size={17} />
              Import folder
            </button>
            <button
              type="button"
              onClick={loadSampleData}
              disabled={busy || !catalogReady}
            >
              <Database size={17} />
              Sample data
            </button>
            <button
              type="button"
              className="danger"
              onClick={clearCatalog}
              disabled={busy || !catalogReady}
            >
              <Trash2 size={17} />
              Clear
            </button>
          </div>
          <div
            className={`topbar-progress-slot ${importProgress ? 'active' : 'idle'}`}
            aria-live="polite"
          >
            {importProgress ? (
              <div className="import-progress-strip">
                <div className="import-progress-header">
                  <span>{importProgressLabel(importProgress)}</span>
                  <strong>{importProgressDetail(importProgress)}</strong>
                </div>
                <div
                  className={`progress-track ${
                    importProgress.phase === 'counting' ? 'indeterminate' : ''
                  }`}
                  role="progressbar"
                  aria-label="Import progress"
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
          <div className="map-pane">
            <MapView
              queryPoint={queryPoint}
              geoItems={mediaItems}
              results={searchResults}
              onQueryPointChange={(point) => {
                setQueryPoint(point)
                setResultPage(0)
              }}
            />
            <div className="map-readout">
              <MapPin size={16} />
              <span>{queryPoint.lat.toFixed(5)}</span>
              <span>{queryPoint.lon.toFixed(5)}</span>
            </div>
          </div>

          <div
            aria-label="Resize map and query panels"
            aria-orientation="horizontal"
            aria-valuemax={resizeControls.map.max}
            aria-valuemin={resizeControls.map.min}
            aria-valuenow={resizeControls.map.now}
            className="resize-handle resize-handle-horizontal"
            role="separator"
            tabIndex={0}
            title="Resize map and query panels"
            onKeyDown={nudgeMapPane}
            onPointerDown={startHorizontalResize}
            onPointerMove={handleHorizontalResizeMove}
          />

          <aside className="control-pane">
            <section className="panel">
              <div className="panel-title">
                <Calendar size={17} />
                <h2>Catalog</h2>
              </div>
              <div className="time-range-row">
                <label>
                  From
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
                  To
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
                Kind
                <select
                  value={kindFilter}
                  onChange={(event) =>
                    setFilterKind(filterValueToKind(event.target.value))
                  }
                >
                  <option value="all">All</option>
                  <option value="image">Images</option>
                  <option value="video">Videos</option>
                </select>
              </label>
              <label>
                Sort
                <select
                  value={sort}
                  onChange={(event) =>
                    setSortMode(event.target.value as SortMode)
                  }
                >
                  <option value="captured_at_desc">Newest first</option>
                  <option value="captured_at_asc">Oldest first</option>
                  <option value="distance">Distance from map point</option>
                </select>
              </label>
              {distanceSortActive && (
                <div className="distance-sort-controls">
                  <label>
                    Engine
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
                <h2>Metrics</h2>
              </div>
              <dl className="metrics-grid">
                <div>
                  <dt>Geo points</dt>
                  <dd>{geoPointCount.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Query</dt>
                  <dd>{indexStats.lastQueryTimeMs?.toFixed(2) ?? '0'} ms</dd>
                </div>
                <div>
                  <dt>Distances</dt>
                  <dd>{statsNumber(indexStats.distanceComputations)}</dd>
                </div>
                <div>
                  <dt>Nodes</dt>
                  <dd>{statsNumber(indexStats.nodesVisited)}</dd>
                </div>
                <div>
                  <dt>Visited</dt>
                  <dd>{statsNumber(indexStats.candidatesInspected)}</dd>
                </div>
                <div>
                  <dt>Pruned</dt>
                  <dd>
                    {statsNumber(
                      indexStats.prunedByGeo + indexStats.prunedByTime,
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
          aria-label="Resize left tools and results"
          aria-orientation="vertical"
          aria-valuemax={resizeControls.left.max}
          aria-valuemin={resizeControls.left.min}
          aria-valuenow={resizeControls.left.now}
          className="resize-handle resize-handle-vertical"
          role="separator"
          tabIndex={0}
          title="Resize left tools and results"
          onKeyDown={nudgeLeftPane}
          onPointerDown={startVerticalResize}
          onPointerMove={handleVerticalResizeMove}
        />

        <section className="library-strip">
          <div className="library-header">
            <div>
              <h2>{visibleResults ? 'Nearest results' : 'Catalog results'}</h2>
              <p className="subtle">
                {visibleRange} visible ·{' '}
                {sources.length.toLocaleString()} sources · {status}
              </p>
            </div>
            <div className="library-actions">
              <label className="pagination-size">
                Page
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
              <div className="pagination-buttons" aria-label="Result pages">
                <button
                  type="button"
                  onClick={() => setResultPage((page) => Math.max(0, page - 1))}
                  disabled={!canPageBackward}
                  title="Previous page"
                >
                  <ChevronLeft size={17} />
                </button>
                <button
                  type="button"
                  onClick={() => setResultPage((page) => page + 1)}
                  disabled={!canPageForward}
                  title="Next page"
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <details className="display-menu">
                <summary>
                  <Settings2 size={17} />
                  Display
                </summary>
                <div className="display-popover">
                  <div className="display-section">
                    <span>Mode</span>
                    <div className="segmented-control" role="group" aria-label="Result display mode">
                      <button
                        type="button"
                        className={resultDisplayMode === 'images' ? 'active' : ''}
                        onClick={() => setDisplayMode('images')}
                      >
                        <Images size={16} />
                        Images
                      </button>
                      <button
                        type="button"
                        className={resultDisplayMode === 'cards' ? 'active' : ''}
                        onClick={() => setDisplayMode('cards')}
                      >
                        <ImageIcon size={16} />
                        Cards
                      </button>
                      <button
                        type="button"
                        className={resultDisplayMode === 'list' ? 'active' : ''}
                        onClick={() => setDisplayMode('list')}
                      >
                        <List size={16} />
                        List
                      </button>
                    </div>
                  </div>
                  <div className="display-section">
                    <span>Thumbnail size</span>
                    <div className="segmented-control compact" role="group" aria-label="Thumbnail size">
                      {(['small', 'medium', 'large'] as const).map((size) => (
                        <button
                          key={size}
                          type="button"
                          className={resultThumbnailSize === size ? 'active' : ''}
                          onClick={() => setThumbnailSize(size)}
                        >
                          {size}
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
                    Show metadata
                  </label>
                </div>
              </details>
              <button type="button" onClick={refreshAll} disabled={busy}>
                <RefreshCcw size={17} />
                Refresh
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
                      <p>{formatDateTime(result.item.capturedAt)}</p>
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
                  <span>{result.item.kind}</span>
                  <span>{formatDateTime(result.item.capturedAt)}</span>
                  <span>{formatDimensions(result.item) ?? 'n/a'}</span>
                  <span>{formatGeo(result.item) ?? 'no GPS'}</span>
                  {Number.isFinite(result.distanceMeters) ? (
                    <strong>{formatDistance(result.distanceMeters)}</strong>
                  ) : (
                    <span>catalog</span>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      {viewerIndex !== undefined && viewerIndex < resultItems.length && (
        <MediaViewer
          platform={platform}
          items={resultItems}
          index={viewerIndex}
          onClose={closeViewer}
          onNavigate={setViewerIndex}
        />
      )}
      </section>
    </main>
  )
}

export default App
