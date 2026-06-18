import {
  Activity,
  Calendar,
  Database,
  FolderOpen,
  FlaskConical,
  Image as ImageIcon,
  MapPin,
  RefreshCcw,
  Search,
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
import { CatalogClient } from './catalog/catalogClient'
import { MapView } from './components/MapView'
import { Thumbnail } from './components/Thumbnail'
import { sampleMedia, sampleSource } from './demo/sampleData'
import { formatDistance } from './lib/distance'
import {
  dateInputEndToMillis,
  dateInputToMillis,
  formatDateTime,
} from './lib/time'
import { GeoIndexRegistry } from './geo/registry'
import { ScannerClient } from './scanner/scannerClient'
import { putDirectoryHandle } from './storage/handleStore'
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

type CatalogInfo = {
  storageMode: 'opfs' | 'transient'
  sqliteVersion: string
  filename: string
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

function filterValueToKind(value: string): MediaKind | 'all' {
  return value === 'image' || value === 'video' ? value : 'all'
}

function filterValueToHasGeo(value: string): boolean | undefined {
  if (value === 'yes') return true
  if (value === 'no') return false
  return undefined
}

function statsNumber(value: number | undefined): string {
  return typeof value === 'number' ? value.toLocaleString() : '0'
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
  const catalog = useMemo(() => new CatalogClient(), [])
  const scanner = useMemo(() => new ScannerClient(), [])
  const registry = useMemo(() => new GeoIndexRegistry(), [])

  const [catalogInfo, setCatalogInfo] = useState<CatalogInfo>()
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([])
  const [sources, setSources] = useState<MediaSource[]>([])
  const [geoPointCount, setGeoPointCount] = useState(0)
  const [selectedIndexId, setSelectedIndexId] = useState('brute-force')
  const [queryPoint, setQueryPoint] = useState<QueryPoint>({
    lat: 47.3769,
    lon: 8.5417,
  })
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [sort, setSort] = useState<CatalogSort>('captured_at_desc')
  const [kindFilter, setKindFilter] = useState<MediaKind | 'all'>('all')
  const [hasGeoFilter, setHasGeoFilter] = useState<boolean | undefined>()
  const [k, setK] = useState(24)
  const [searchResults, setSearchResults] = useState<EnrichedSearchResult[]>([])
  const [indexStats, setIndexStats] = useState<GeoIndexStats>(defaultStats)
  const [validation, setValidation] = useState<ValidationReport>()
  const [status, setStatus] = useState('Initializing catalog')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [leftWidth, setLeftWidth] = useState(() =>
    clamp(storedNumber(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH), MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
  )
  const [mapHeight, setMapHeight] = useState(() =>
    Math.max(MIN_MAP_HEIGHT, storedNumber(MAP_HEIGHT_KEY, DEFAULT_MAP_HEIGHT)),
  )
  const workspaceRef = useRef<HTMLElement | null>(null)
  const leftStackRef = useRef<HTMLElement | null>(null)

  const selectedIndex = registry.get(selectedIndexId)
  const timeRange = useMemo(
    () => timeRangeFromInputs(startDate, endDate),
    [endDate, startDate],
  )

  const catalogQuery = useMemo<CatalogQuery>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      hasGeo: hasGeoFilter,
      sort,
      limit: 500,
      offset: 0,
    }),
    [hasGeoFilter, kindFilter, sort, timeRange],
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

    if (!window.showDirectoryPicker) {
      setError('This browser does not expose the File System Access API.')
      return
    }

    setBusy(true)
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      const sourceId = crypto.randomUUID()
      const sourceLabel = handle.name
      await putDirectoryHandle({
        id: sourceId,
        label: sourceLabel,
        addedAt: Date.now(),
        handle,
      })

      setStatus(`Scanning ${sourceLabel}`)
      const result = await scanner.scanDirectory(
        sourceId,
        sourceLabel,
        handle,
        (progress) => {
          setStatus(
            `Scanned ${progress.scannedFiles.toLocaleString()} files, accepted ${progress.acceptedMedia.toLocaleString()}`,
          )
        },
      )

      await catalog.upsertSource(result.source)
      await catalog.upsertMedia(result.items)
      await registry.insertMany(mediaItemsToGeoIndexPoints(result.items))
      setGeoPointCount((await catalog.getGeoPoints()).length)
      setIndexStats(await registry.get(selectedIndexId).stats())
      await refreshMedia()
      setStatus(
        `Imported ${result.stats.acceptedMedia.toLocaleString()} media files from ${sourceLabel}`,
      )
      if (result.errors.length > 0) {
        setError(`${result.errors.length} files could not be read.`)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setStatus('Import stopped')
    } finally {
      setBusy(false)
    }
  }, [catalog, refreshMedia, registry, scanner, selectedIndexId])

  const loadSampleData = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      await catalog.upsertSource(sampleSource)
      await catalog.upsertMedia(sampleMedia)
      await registry.insertMany(mediaItemsToGeoIndexPoints(sampleMedia))
      setGeoPointCount((await catalog.getGeoPoints()).length)
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

  const runGeoSearch = useCallback(async () => {
    setBusy(true)
    setError(undefined)
    try {
      const query = {
        ...timeRange,
        lat: queryPoint.lat,
        lon: queryPoint.lon,
        k,
      }
      const results = await selectedIndex.search(query)
      const items = await catalog.getMediaByIds(
        results.map((result) => result.mediaId),
      )
      const byId = new Map(items.map((item) => [item.id, item]))
      const enriched = results.flatMap((result) => {
        const item = byId.get(result.mediaId)
        return item ? [{ ...result, item }] : []
      })
      setSearchResults(enriched)
      setValidation(await registry.validateSelected(selectedIndex.id, query))
      setIndexStats(await selectedIndex.stats())
      setStatus(
        `Found ${enriched.length.toLocaleString()} nearest matches with ${selectedIndex.label}`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [catalog, k, queryPoint, registry, selectedIndex, timeRange])

  const visibleResults = searchResults.length > 0
  const resultItems = visibleResults
    ? searchResults
    : mediaItems.map((item) => ({ item, mediaId: item.id, distanceMeters: NaN }))

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
        <div>
          <h1>Geo Media Index Lab</h1>
          <p className="subtle">
            {catalogInfo
              ? `SQLite ${catalogInfo.sqliteVersion} · ${catalogInfo.storageMode.toUpperCase()} · ${catalogInfo.filename}`
              : 'Starting local catalog'}
          </p>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={importFolder} disabled={busy}>
            <FolderOpen size={17} />
            Import folder
          </button>
          <button type="button" onClick={loadSampleData} disabled={busy}>
            <Database size={17} />
            Sample data
          </button>
          <button
            type="button"
            className="danger"
            onClick={clearCatalog}
            disabled={busy}
          >
            <Trash2 size={17} />
            Clear
          </button>
        </div>
      </header>

      <section ref={workspaceRef} className="workspace">
        <section ref={leftStackRef} className="left-stack">
          <div className="map-pane">
            <MapView
              queryPoint={queryPoint}
              geoItems={mediaItems}
              results={searchResults}
              onQueryPointChange={setQueryPoint}
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
              <label>
                From
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </label>
              <div className="control-row">
                <label>
                  Kind
                  <select
                    value={kindFilter}
                    onChange={(event) =>
                      setKindFilter(filterValueToKind(event.target.value))
                    }
                  >
                    <option value="all">All</option>
                    <option value="image">Images</option>
                    <option value="video">Videos</option>
                  </select>
                </label>
                <label>
                  GPS
                  <select
                    value={
                      hasGeoFilter === true
                        ? 'yes'
                        : hasGeoFilter === false
                          ? 'no'
                          : 'all'
                    }
                    onChange={(event) =>
                      setHasGeoFilter(filterValueToHasGeo(event.target.value))
                    }
                  >
                    <option value="all">All</option>
                    <option value="yes">With GPS</option>
                    <option value="no">Missing GPS</option>
                  </select>
                </label>
              </div>
              <label>
                Sort
                <select
                  value={sort}
                  onChange={(event) => setSort(event.target.value as CatalogSort)}
                >
                  <option value="captured_at_desc">Newest first</option>
                  <option value="captured_at_asc">Oldest first</option>
                </select>
              </label>
            </section>

            <section className="panel accent-panel">
              <div className="panel-title">
                <FlaskConical size={17} />
                <h2>Geo Search</h2>
              </div>
              <label>
                Engine
                <select
                  value={selectedIndexId}
                  onChange={(event) => setSelectedIndexId(event.target.value)}
                >
                  {registry.indexes.map((index) => (
                    <option key={index.id} value={index.id}>
                      {index.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Result count
                <input
                  type="number"
                  min={1}
                  max={500}
                  value={k}
                  onChange={(event) => setK(Number(event.target.value))}
                />
              </label>
              <button type="button" onClick={runGeoSearch} disabled={busy}>
                <Search size={17} />
                Search nearest
              </button>
              <div className="capabilities">
                <span>{selectedIndex.capabilities.exact ? 'exact' : 'approx'}</span>
                <span>
                  {selectedIndex.capabilities.supportsTimePruning
                    ? 'time-pruning'
                    : 'time-filter'}
                </span>
                <span>
                  {selectedIndex.capabilities.incrementalInsert
                    ? 'incremental'
                    : 'rebuild'}
                </span>
              </div>
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
              {mediaItems.length.toLocaleString()} visible ·{' '}
              {sources.length.toLocaleString()} sources · {status}
            </p>
          </div>
          <button type="button" onClick={refreshAll} disabled={busy}>
            <RefreshCcw size={17} />
            Refresh
          </button>
        </div>
        {error && <p className="error-banner">{error}</p>}
        <div className="media-grid">
          {resultItems.map((result) => (
            <article key={result.item.id} className="media-card">
              <Thumbnail
                thumbnailKey={result.item.thumbnailKey}
                label={result.item.displayName}
                kind={result.item.kind}
              />
              <div className="media-card-body">
                <div className="media-title-row">
                  {result.item.kind === 'video' ? (
                    <Video size={15} />
                  ) : (
                    <ImageIcon size={15} />
                  )}
                  <h3>{result.item.displayName}</h3>
                </div>
                <p>{formatDateTime(result.item.capturedAt)}</p>
                <p>{result.item.relativePath}</p>
                {Number.isFinite(result.distanceMeters) && (
                  <strong>{formatDistance(result.distanceMeters)}</strong>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
      </section>
    </main>
  )
}

export default App
