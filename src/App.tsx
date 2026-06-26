import {
  Activity,
  BoxSelect,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  FileText,
  FolderOpen,
  Images,
  Image as ImageIcon,
  Languages,
  List,
  MapPin,
  RefreshCw,
  Route,
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
  memo,
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
  formatTimelineGroupId,
  importedMediaFacts,
  itemGroupId,
} from './lib/mediaMetadata'
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
  ThumbnailBackend,
} from './platform/types'
import { traceStartup } from './lib/startupTrace'
import type {
  EnrichedSearchResult,
  GeoBounds,
  KindFilter,
  MapDisplayMode,
  MapPolylineCleanupSource,
  MediaItem,
  SearchIndexStats,
  SearchSpec,
} from './types'

type ActivePage = 'app' | 'imprint' | 'privacy'
type ResultDisplayMode = 'images' | 'cards' | 'list'
type ResultThumbnailSize = 'small' | 'medium' | 'large'
type MapViewport = {
  bounds: GeoBounds
  zoom: number
  widthPx: number
  heightPx: number
}
type ActivityLogEntry = {
  id: number
  key: TranslationKey
  values?: TranslationValues
  createdAt: number
}
type TimelineGroupSummary = {
  id: string
  label: string
  count: number
  startTime?: number
  endTime?: number
  sourceTypes: string[]
}
type LineCleanupState = {
  allowedSources: MapPolylineCleanupSource[]
  maxAccuracyMeters?: number
  breakSpeedKmh?: number
  maxSegmentDistanceKm?: number
  removeIsolatedJumps: boolean
}

const LEFT_WIDTH_KEY = 'geo-media-index-lab:left-width'
const MAP_HEIGHT_KEY = 'geo-media-index-lab:map-height'
const RESULT_DISPLAY_MODE_KEY = 'geo-media-index-lab:result-display-mode'
const RESULT_THUMBNAIL_SIZE_KEY = 'geo-media-index-lab:result-thumbnail-size'
const RESULT_METADATA_KEY = 'geo-media-index-lab:result-metadata'
const DEBUG_DATA_KEY = 'geo-media-index-lab:debug-data'
const RESULT_PAGE_SIZE_KEY = 'geo-media-index-lab:result-page-size'
const MAP_DISPLAY_MODE_KEY = 'geo-media-index-lab:map-display-mode'
const MAP_BUBBLE_CELL_SIZE_KEY = 'geo-media-index-lab:map-bubble-cell-size'
const MAP_RENDER_BATCH_SIZE_KEY = 'geo-media-index-lab:map-render-batch-size'
const MAP_BUBBLE_SCALE_KEY = 'geo-media-index-lab:map-bubble-scale'
const MAP_MAX_BUBBLES_KEY = 'geo-media-index-lab:map-max-bubbles'
const RESULT_PAGE_SIZE_OPTIONS = [50, 100, 250, 500] as const
const MAP_BUBBLE_CELL_SIZE_OPTIONS = [48, 64, 80] as const
const MAP_RENDER_BATCH_SIZE_OPTIONS = [100, 250, 500, 1_000, 2_500] as const
const MAP_BUBBLE_SCALE_OPTIONS = [0.75, 1, 1.35] as const
const MAP_MAX_BUBBLES_OPTIONS = [2_000, 5_000, 10_000] as const
const LINE_CLEANUP_SOURCE_OPTIONS: MapPolylineCleanupSource[] = [
  'GPS',
  'WIFI',
  'CELL',
  'UNKNOWN',
]
const LINE_MAX_ACCURACY_OPTIONS = [0, 25, 50, 100, 250, 500, 1_000] as const
const LINE_BREAK_SPEED_MIN = 0
const LINE_BREAK_SPEED_MAX = 1_000
const LINE_BREAK_SPEED_STEP = 10
const LINE_MAX_SEGMENT_DISTANCE_OPTIONS = [
  0,
  0.05,
  0.1,
  0.15,
  0.2,
  0.25,
  0.3,
  0.4,
  0.5,
  0.75,
  1,
  1.5,
  2,
  2.5,
  3,
  4,
  5,
  7.5,
  10,
  15,
  20,
  25,
  30,
  40,
  50,
  75,
  100,
  150,
  250,
  500,
  750,
  1_000,
] as const
const DEFAULT_RESULT_PAGE_SIZE = 100
const DEFAULT_MAP_BUBBLE_CELL_SIZE = 64
const DEFAULT_MAP_RENDER_BATCH_SIZE = 500
const DEFAULT_MAP_BUBBLE_SCALE = 1
const DEFAULT_MAP_MAX_BUBBLES = 5_000
const MAP_POLYLINE_MAX_POINTS = 10_000
const DEFAULT_LINE_CLEANUP: LineCleanupState = {
  allowedSources: LINE_CLEANUP_SOURCE_OPTIONS,
  removeIsolatedJumps: false,
}
const DEFAULT_DISTANCE_ENGINE_ID = 'segmented-ball-tree'
const CATALOG_QUERY_INDEX_ID = 'file-time-geo'
const DISTANCE_ENGINE_IDS = [
  'brute-force',
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

function geoBoundsEqual(
  left: GeoBounds | undefined,
  right: GeoBounds | undefined,
): boolean {
  if (!left || !right) return left === right

  return (
    Math.abs(left.minLat - right.minLat) < 0.000001 &&
    Math.abs(left.maxLat - right.maxLat) < 0.000001 &&
    Math.abs(left.minLon - right.minLon) < 0.000001 &&
    Math.abs(left.maxLon - right.maxLon) < 0.000001
  )
}

function mapViewportEqual(
  left: MapViewport | undefined,
  right: MapViewport | undefined,
): boolean {
  if (!left || !right) return left === right

  return (
    geoBoundsEqual(left.bounds, right.bounds) &&
    Math.abs(left.zoom - right.zoom) < 0.001 &&
    left.widthPx === right.widthPx &&
    left.heightPx === right.heightPx
  )
}

function lineCleanupEnabled(cleanup: LineCleanupState): boolean {
  return (
    cleanup.removeIsolatedJumps ||
    cleanup.maxAccuracyMeters !== undefined ||
    cleanup.breakSpeedKmh !== undefined ||
    cleanup.maxSegmentDistanceKm !== undefined ||
    cleanup.allowedSources.length !== LINE_CLEANUP_SOURCE_OPTIONS.length
  )
}

function formatDistanceThresholdKm(value: number, locale: string): string {
  if (value < 1) {
    return `${Math.round(value * 1000).toLocaleString(locale)} m`
  }
  return `${value.toLocaleString(locale, {
    maximumFractionDigits: 1,
  })} km`
}

function lineMaxSegmentDistanceOptionIndex(value: number | undefined): number {
  const normalizedValue = value ?? 0
  const exactIndex = LINE_MAX_SEGMENT_DISTANCE_OPTIONS.indexOf(
    normalizedValue as (typeof LINE_MAX_SEGMENT_DISTANCE_OPTIONS)[number],
  )
  if (exactIndex >= 0) return exactIndex

  let nearestIndex = 0
  let nearestDistance = Math.abs(
    LINE_MAX_SEGMENT_DISTANCE_OPTIONS[0] - normalizedValue,
  )
  LINE_MAX_SEGMENT_DISTANCE_OPTIONS.forEach((option, index) => {
    const distance = Math.abs(option - normalizedValue)
    if (distance < nearestDistance) {
      nearestIndex = index
      nearestDistance = distance
    }
  })
  return nearestIndex
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

function storedNumberOption<T extends number>(
  key: string,
  fallback: T,
  allowed: readonly T[],
): T {
  const stored = storedNumber(key, fallback)
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
    value === 'timeline_visit' ||
    value === 'timeline_activity' ||
    value === 'activity_sample' ||
    value === 'frequent_place' ||
    value === 'media'
    ? value
    : 'all'
}

function statsNumber(value: number | undefined, locale: string): string {
  return typeof value === 'number' ? value.toLocaleString(locale) : '0'
}

function errorToMessage(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
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

function formatMilliseconds(value: number | undefined): string {
  return `${(value ?? 0).toFixed(2)} ms`
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
    )} Â· ${t('importItemsAcceptedSkipped', {
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

function indexStatusLabel(
  status: SearchIndexStats['indexStatus'] | undefined,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): string {
  if (status === 'current') return t('indexStatusCurrent')
  if (status === 'stale') return t('indexStatusStale')
  if (status === 'missing') return t('indexStatusMissing')
  if (status === 'building') return t('indexStatusBuilding')
  if (status === 'pending') return t('indexStatusPending')
  if (status === 'indexing') return t('indexStatusIndexing')
  if (status === 'failed') return t('indexStatusFailed')
  return t('indexStatusUnknown')
}

function catalogIndexStatus(
  stats: SearchIndexStats | undefined,
  progress: GeoIndexBuildProgress | undefined,
): SearchIndexStats['indexStatus'] {
  if (progress?.currentIndexId?.startsWith('file-')) return 'building'
  return stats?.indexStatus ?? 'missing'
}

function combinedIndexStatus(
  statuses: Array<SearchIndexStats['indexStatus'] | undefined>,
): SearchIndexStats['indexStatus'] {
  if (statuses.some((status) => status === 'failed')) return 'failed'
  if (statuses.some((status) => status === 'building')) return 'building'
  if (statuses.some((status) => status === 'indexing')) return 'indexing'
  if (statuses.some((status) => status === 'pending')) return 'pending'
  if (statuses.some((status) => status === 'stale')) return 'stale'
  if (statuses.some((status) => status === 'missing' || !status)) return 'missing'
  return 'current'
}

function combinedIndexButtonLabel(
  status: SearchIndexStats['indexStatus'] | undefined,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): string {
  if (status === 'current') return t('rebuildCatalogIndexes')
  if (status === 'building' || status === 'indexing' || status === 'pending') return t('updatingCatalogIndexes')
  return t('updateCatalogIndexes')
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

function mediaKindIcon(kind: MediaItem['kind']) {
  if (
    kind === 'geo_point' ||
    kind === 'timeline_visit' ||
    kind === 'frequent_place'
  ) return <MapPin size={15} />
  if (kind === 'video') return <Video size={15} />
  if (kind === 'timeline_activity') return <Route size={15} />
  if (kind === 'activity_sample') return <Activity size={15} />
  return <ImageIcon size={15} />
}

function summarizeTimelineGroups(
  results: EnrichedSearchResult[],
  locale: string,
  t: (key: TranslationKey, values?: TranslationValues) => string,
): TimelineGroupSummary[] {
  const groups = new Map<string, TimelineGroupSummary & { sourceTypeSet: Set<string> }>()
  for (const result of results) {
    const { item } = result
    const groupId = itemGroupId(item)
    if (!groupId) continue
    const existing = groups.get(groupId) ?? {
      id: groupId,
      label: formatTimelineGroupId(groupId, t),
      count: 0,
      startTime: undefined,
      endTime: undefined,
      sourceTypes: [],
      sourceTypeSet: new Set<string>(),
    }
    existing.count += 1
    if (typeof item.timestamp === 'number') {
      existing.startTime = Math.min(existing.startTime ?? item.timestamp, item.timestamp)
      existing.endTime = Math.max(existing.endTime ?? item.timestamp, item.timestamp)
    }
    if (typeof item.endTimestamp === 'number') {
      existing.endTime = Math.max(existing.endTime ?? item.endTimestamp, item.endTimestamp)
    }
    if (item.sourceType) existing.sourceTypeSet.add(item.sourceType)
    groups.set(groupId, existing)
  }

  return Array.from(groups.values())
    .map((group) => ({
      id: group.id,
      label: group.label,
      count: group.count,
      startTime: group.startTime,
      endTime: group.endTime,
      sourceTypes: Array.from(group.sourceTypeSet).sort((a, b) =>
        a.localeCompare(b, locale),
      ),
    }))
    .sort((a, b) => {
      const left = a.startTime ?? Number.MAX_SAFE_INTEGER
      const right = b.startTime ?? Number.MAX_SAFE_INTEGER
      return left - right || a.id.localeCompare(b.id, locale)
    })
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

type ResultCardProps = {
  result: EnrichedSearchResult
  index: number
  displayMode: ResultDisplayMode
  showMetadata: boolean
  thumbnails: ThumbnailBackend
  locale: string
  t: (key: TranslationKey, values?: TranslationValues) => string
  onOpen(index: number): void
  onHoverResultChange(resultId: string | undefined): void
}

const ResultCard = memo(function ResultCard({
  result,
  index,
  displayMode,
  showMetadata,
  thumbnails,
  locale,
  t,
  onOpen,
  onHoverResultChange,
}: ResultCardProps) {
  const { item } = result
  const metadataFacts = importedMediaFacts(item, locale, t)
  const metadataSummary = metadataFacts
    .slice(0, 4)
    .map((fact) => `${fact.label}: ${fact.value}`)
    .join(' - ')

  return (
    <article
      className="media-card"
      role="button"
      tabIndex={0}
      onPointerEnter={() => onHoverResultChange(item.id)}
      onPointerLeave={() => onHoverResultChange(undefined)}
      onClick={() => onOpen(index)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        onOpen(index)
      }}
    >
      <Thumbnail
        thumbnails={thumbnails}
        thumbnailKey={item.thumbnailKey}
        label={item.displayName}
        kind={item.kind}
      />
      {displayMode !== 'images' && (
        <div className="media-card-body">
          <div className="media-title-row">
            {mediaKindIcon(item.kind)}
            <h3>{item.displayName}</h3>
          </div>
          {showMetadata && (
            <>
              <p>
                {formatDateTime(
                  item.timestamp,
                  locale,
                  t('noTimestamp'),
                )}
              </p>
              <p>{item.relativePath}</p>
              <p className="metadata-extra">
                {[
                  item.mimeType,
                  formatDimensions(item),
                  formatGeo(item),
                  metadataSummary,
                ]
                  .filter(Boolean)
                  .join(' - ')}
              </p>
            </>
          )}
          {typeof result.distanceMeters === 'number' &&
            Number.isFinite(result.distanceMeters) && (
            <strong>{formatDistance(result.distanceMeters)}</strong>
          )}
        </div>
      )}
      {displayMode === 'images' && showMetadata && (
        <div className="media-overlay">
          <span>{item.displayName}</span>
          {typeof result.distanceMeters === 'number' &&
            Number.isFinite(result.distanceMeters) && (
            <strong>{formatDistance(result.distanceMeters)}</strong>
          )}
        </div>
      )}
      {displayMode === 'list' && (
        <div className="media-list-columns">
          <span>{t(item.kind)}</span>
          <span>
            {formatDateTime(
              item.timestamp,
              locale,
              t('noTimestamp'),
            )}
          </span>
          <span>{formatDimensions(item) ?? 'n/a'}</span>
          <span>{formatGeo(item) ?? t('metadataNoGps')}</span>
          {typeof result.distanceMeters === 'number' &&
          Number.isFinite(result.distanceMeters) ? (
            <strong>{formatDistance(result.distanceMeters)}</strong>
          ) : metadataSummary ? (
            <span>{metadataSummary}</span>
          ) : (
            <span>{t('metadataCatalog')}</span>
          )}
        </div>
      )}
    </article>
  )
})

function App() {
  traceStartup('[startup]', 'App render start')
  const platform = useMemo(() => {
    traceStartup('[startup]', 'creating platform backend')
    const created = createPlatformBackend()
    traceStartup('[startup]', 'platform backend created', {
      platformKind: created.kind,
    })
    return created
  }, [])
  const catalog = platform.catalog
  const [language, setLanguage] = useState<Language>(() => storedLanguage())
  const [activePage, setActivePage] = useState<ActivePage>('app')
  const locale = languageLocale(language)
  const t = useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(language, key, values),
    [language],
  )
  const [mapBubbleCellSize, setMapBubbleCellSizeState] = useState<
    (typeof MAP_BUBBLE_CELL_SIZE_OPTIONS)[number]
  >(() =>
    storedNumberOption(
      MAP_BUBBLE_CELL_SIZE_KEY,
      DEFAULT_MAP_BUBBLE_CELL_SIZE,
      MAP_BUBBLE_CELL_SIZE_OPTIONS,
    ),
  )
  const [mapRenderBatchSize, setMapRenderBatchSizeState] = useState<
    (typeof MAP_RENDER_BATCH_SIZE_OPTIONS)[number]
  >(() =>
    storedNumberOption(
      MAP_RENDER_BATCH_SIZE_KEY,
      DEFAULT_MAP_RENDER_BATCH_SIZE,
      MAP_RENDER_BATCH_SIZE_OPTIONS,
    ),
  )
  const [mapBubbleScale, setMapBubbleScaleState] = useState<
    (typeof MAP_BUBBLE_SCALE_OPTIONS)[number]
  >(() =>
    storedNumberOption(
      MAP_BUBBLE_SCALE_KEY,
      DEFAULT_MAP_BUBBLE_SCALE,
      MAP_BUBBLE_SCALE_OPTIONS,
    ),
  )
  const [mapMaxBubbles, setMapMaxBubblesState] = useState<
    (typeof MAP_MAX_BUBBLES_OPTIONS)[number]
  >(() =>
    storedNumberOption(
      MAP_MAX_BUBBLES_KEY,
      DEFAULT_MAP_MAX_BUBBLES,
      MAP_MAX_BUBBLES_OPTIONS,
    ),
  )
  const search = useSearchState({
    allowedIndexIds: DISTANCE_ENGINE_IDS,
    defaultSelectedIndexId: DEFAULT_DISTANCE_ENGINE_ID,
    defaultQueryPoint: DEFAULT_QUERY_POINT,
    defaultResultPageSize: DEFAULT_RESULT_PAGE_SIZE,
    allowedPageSizes: RESULT_PAGE_SIZE_OPTIONS,
    pageSizeStorageKey: RESULT_PAGE_SIZE_KEY,
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
  const [showDebugData, setShowDebugData] = useState(() =>
    storedBoolean(DEBUG_DATA_KEY, false),
  )
  const [leftWidth, setLeftWidth] = useState(() =>
    clamp(storedNumber(LEFT_WIDTH_KEY, DEFAULT_LEFT_WIDTH), MIN_LEFT_WIDTH, MAX_LEFT_WIDTH),
  )
  const [mapHeight, setMapHeight] = useState(() =>
    Math.max(MIN_MAP_HEIGHT, storedNumber(MAP_HEIGHT_KEY, DEFAULT_MAP_HEIGHT)),
  )
  const [mapDisplayMode, setMapDisplayModeState] = useState<MapDisplayMode>(() =>
    storedString(MAP_DISPLAY_MODE_KEY, 'bubbles', ['bubbles', 'polyline']),
  )
  const [lineCleanup, setLineCleanup] =
    useState<LineCleanupState>(DEFAULT_LINE_CLEANUP)
  const [visibleMapViewport, setVisibleMapViewport] = useState<MapViewport>()
  const [hoveredResultId, setHoveredResultId] = useState<string>()
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
  const reportError = useCallback((message: unknown) => {
    setError(errorToMessage(message) || undefined)
  }, [])
  const recordCatalogInitFailure = useCallback(() => {
    recordActivity('activityCatalogFailedToInitialize')
  }, [recordActivity])

  const {
    catalogInfo,
    catalogReady,
    catalogRevision,
    markCatalogChanged,
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
    allIndexStats,
    updateCatalogIndexes,
    updateIndex,
    optimizeIndex,
  } = useGeoIndexes({
    catalog,
    catalogInfo,
    catalogRevision,
    selectedIndexId,
    onError: reportError,
  })
  const [indexStatsOverride, setIndexStatsOverride] =
    useState<SearchIndexStats>()
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
      engineId: CATALOG_QUERY_INDEX_ID,
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
    }),
    [
      geoBounds,
      kindFilter,
      resultOffset,
      resultPageSize,
      searchOrder,
      timeRange,
    ],
  )
  const mapSearchSpec = useMemo<SearchSpec | undefined>(
    () => {
      if (!visibleMapViewport) return undefined

      const mapAggregation = {
        zoom: visibleMapViewport.zoom,
        viewportWidthPx: visibleMapViewport.widthPx,
        viewportHeightPx: visibleMapViewport.heightPx,
        bubbleCellSizePx: mapBubbleCellSize,
        bubbleScale: mapBubbleScale,
      }

      if (mapDisplayMode === 'polyline') {
        return {
          ...timeRange,
          kind: 'geo_point',
          hasGeo: true,
          geoBounds: visibleMapViewport.bounds,
          mapAggregation,
          mapMode: 'polyline',
          mapPolyline: {
            tolerancePx: 0,
            maxPoints: MAP_POLYLINE_MAX_POINTS,
            cleanup: {
              enabled: lineCleanupEnabled(lineCleanup),
              groupLinesOnly: true,
              allowedSources: lineCleanup.allowedSources,
              maxAccuracyMeters: lineCleanup.maxAccuracyMeters,
              breakSpeedKmh: lineCleanup.breakSpeedKmh,
              maxSegmentDistanceKm: lineCleanup.maxSegmentDistanceKm,
              removeIsolatedJumps: lineCleanup.removeIsolatedJumps,
              showDots: false,
            },
          },
          order: {
            kind: 'timestamp',
            sort: 'timestamp_asc',
            engineId: CATALOG_QUERY_INDEX_ID,
          },
          limit: MAP_POLYLINE_MAX_POINTS,
          offset: 0,
          purpose: 'map',
        }
      }

      return {
        ...timeRange,
        kind: kindFilter,
        hasGeo: true,
        geoBounds: visibleMapViewport.bounds,
        mapAggregation,
        mapMode: 'bubbles',
        order: {
          kind: 'timestamp',
          sort: catalogSort,
          engineId: CATALOG_QUERY_INDEX_ID,
        },
        limit: mapMaxBubbles,
        offset: 0,
        purpose: 'map',
      }
    },
    [
      catalogSort,
      kindFilter,
      lineCleanup,
      mapBubbleCellSize,
      mapBubbleScale,
      mapDisplayMode,
      mapMaxBubbles,
      timeRange,
      visibleMapViewport,
    ],
  )
  const {
    results: resultItems,
    loading: resultItemsLoading,
    setResults: setSearchResults,
    pageLimitReached,
    mapItems,
    mapPolyline,
    mapLoading,
    resultMetrics,
    mapMetrics,
    validation,
    setValidation: setSearchValidation,
    loadWindow,
    clearMap,
  } = useSearchResults({
    catalog,
    ready: catalogReady,
    pageSpec: resultSearchSpec,
    mapSpec: mapSearchSpec,
    revision: catalogRevision,
    indexVersion: geoIndexVersion,
    onError: reportError,
    onStats: setIndexStatsOverride,
  })
  const effectiveIndexStats =
    indexStatsOverride ?? resultMetrics ?? indexStats
  const hoveredResultPoint = useMemo<QueryPoint | undefined>(() => {
    if (!hoveredResultId) return undefined
    const hoveredItem = resultItems.find(
      (result) => result.item.id === hoveredResultId,
    )?.item
    if (
      typeof hoveredItem?.latitude !== 'number' ||
      typeof hoveredItem?.longitude !== 'number'
    ) {
      return undefined
    }
    return { lat: hoveredItem.latitude, lon: hoveredItem.longitude }
  }, [hoveredResultId, resultItems])
  const distanceIndexBuilding =
    geoIndexProgress?.currentIndexId === selectedIndexId ||
    geoIndexProgress?.currentIndexId === 'segmented-ball-tree'
  const selectedIndexStatus = distanceIndexBuilding
    ? 'building'
    : (indexStats.indexStatus ?? 'missing')
  const timeGeoIndexStats = allIndexStats.find(
    (entry) => entry.engineId === 'file-time-geo',
  )
  const regularIndexStatus = catalogIndexStatus(
    timeGeoIndexStats,
    geoIndexProgress,
  )
  const combinedIndexesStatus = combinedIndexStatus([
    regularIndexStatus,
    selectedIndexStatus,
  ])
  const handleUpdateIndexes = async () => {
    if (combinedIndexesStatus === 'current') {
      await updateCatalogIndexes()
      await optimizeIndex()
      return
    }

    if (regularIndexStatus !== 'current') {
      await updateCatalogIndexes()
    }
    if (selectedIndexStatus !== 'current') {
      await updateIndex()
    }
  }
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
    rescanFolders,
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
    activeImportKind === 'geo'
  const visibleResults = distanceSortActive
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
  const timelineGroups = summarizeTimelineGroups(resultItems, locale, t).slice(0, 8)
  const canPageBackward = resultPage > 0
  const canPageForward = pageLimitReached
  const loadViewerWindow = useCallback(
    async (windowOffset: number, signal?: AbortSignal) => {
      return (await loadWindow(windowOffset, signal)).items
    },
    [loadWindow],
  )
  const handleViewerWindowLoaded = useCallback(
    (windowOffset: number, windowItems: EnrichedSearchResult[]) => {
      setResultPage(windowOffset / resultPageSize)
      setSearchResults(windowItems)
    },
    [resultPageSize, setResultPage, setSearchResults],
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

  useEffect(() => {
    traceStartup('[startup]', 'App mounted', {
      platformKind: platform.kind,
    })
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
      setSearchResults([])
      clearMap()
      setSearchValidation(undefined)
      setIndexStatsOverride(undefined)
      closeViewer()
      markCatalogChanged()
      recordActivity('activityCatalogCleared')
    } catch (caught) {
      reportError(caught)
    } finally {
      setCatalogBusy(false)
    }
  }, [
    catalog,
    clearGeoBounds,
    closeViewer,
    markCatalogChanged,
    recordActivity,
    reportError,
    clearMap,
    setSearchResults,
    setSearchValidation,
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
      setSearchResults([])
      setSearchValidation(undefined)
      setIndexStatsOverride(undefined)
    }
  }, [setSearchResults, setSearchValidation, setSort])

  const setMapQueryPoint = useCallback((point: QueryPoint) => {
    setQueryPoint(point)
  }, [setQueryPoint])

  const setMapGeoBounds = useCallback((bounds: GeoBounds) => {
    setGeoBounds(bounds)
  }, [setGeoBounds])

  const setVisibleMapViewportState = useCallback((viewport: MapViewport) => {
    setVisibleMapViewport((currentViewport) =>
      mapViewportEqual(currentViewport, viewport) ? currentViewport : viewport,
    )
  }, [])

  const clearMapGeoBounds = useCallback(() => {
    clearGeoBounds()
  }, [clearGeoBounds])

  const clearSearch = useCallback(() => {
    clearSearchState()
    setSearchResults([])
    setSearchValidation(undefined)
    setIndexStatsOverride(undefined)
    closeViewer()
  }, [clearSearchState, closeViewer, setSearchResults, setSearchValidation])

  const setDisplayMode = useCallback((mode: ResultDisplayMode) => {
    setResultDisplayMode(mode)
    window.localStorage.setItem(RESULT_DISPLAY_MODE_KEY, mode)
  }, [])

  const setThumbnailSize = useCallback((size: ResultThumbnailSize) => {
    setResultThumbnailSize(size)
    window.localStorage.setItem(RESULT_THUMBNAIL_SIZE_KEY, size)
  }, [])

  const setMapDisplayMode = useCallback((mode: MapDisplayMode) => {
    setMapDisplayModeState(mode)
    window.localStorage.setItem(MAP_DISPLAY_MODE_KEY, mode)
  }, [])

  const setMapBubbleCellSize = useCallback((cellSize: number) => {
    const nextCellSize = MAP_BUBBLE_CELL_SIZE_OPTIONS.includes(
      cellSize as (typeof MAP_BUBBLE_CELL_SIZE_OPTIONS)[number],
    )
      ? (cellSize as (typeof MAP_BUBBLE_CELL_SIZE_OPTIONS)[number])
      : DEFAULT_MAP_BUBBLE_CELL_SIZE
    setMapBubbleCellSizeState(nextCellSize)
    window.localStorage.setItem(MAP_BUBBLE_CELL_SIZE_KEY, String(nextCellSize))
  }, [])

  const setMapRenderBatchSize = useCallback((batchSize: number) => {
    const nextBatchSize = MAP_RENDER_BATCH_SIZE_OPTIONS.includes(
      batchSize as (typeof MAP_RENDER_BATCH_SIZE_OPTIONS)[number],
    )
      ? (batchSize as (typeof MAP_RENDER_BATCH_SIZE_OPTIONS)[number])
      : DEFAULT_MAP_RENDER_BATCH_SIZE
    setMapRenderBatchSizeState(nextBatchSize)
    window.localStorage.setItem(
      MAP_RENDER_BATCH_SIZE_KEY,
      String(nextBatchSize),
    )
  }, [])

  const setMapBubbleScale = useCallback((scale: number) => {
    const nextScale = MAP_BUBBLE_SCALE_OPTIONS.includes(
      scale as (typeof MAP_BUBBLE_SCALE_OPTIONS)[number],
    )
      ? (scale as (typeof MAP_BUBBLE_SCALE_OPTIONS)[number])
      : DEFAULT_MAP_BUBBLE_SCALE
    setMapBubbleScaleState(nextScale)
    window.localStorage.setItem(MAP_BUBBLE_SCALE_KEY, String(nextScale))
  }, [])

  const setMapMaxBubbles = useCallback((value: number) => {
    const nextValue = MAP_MAX_BUBBLES_OPTIONS.includes(
      value as (typeof MAP_MAX_BUBBLES_OPTIONS)[number],
    )
      ? (value as (typeof MAP_MAX_BUBBLES_OPTIONS)[number])
      : DEFAULT_MAP_MAX_BUBBLES
    setMapMaxBubblesState(nextValue)
    window.localStorage.setItem(MAP_MAX_BUBBLES_KEY, String(nextValue))
  }, [])

  const toggleLineCleanupSource = useCallback((
    source: MapPolylineCleanupSource,
    enabled: boolean,
  ) => {
    setLineCleanup((current) => {
      const sources = new Set(current.allowedSources)
      if (enabled) sources.add(source)
      else sources.delete(source)
      return {
        ...current,
        allowedSources: LINE_CLEANUP_SOURCE_OPTIONS.filter((option) =>
          sources.has(option),
        ),
      }
    })
  }, [])

  const setLineMaxAccuracy = useCallback((value: number) => {
    setLineCleanup((current) => ({
      ...current,
      maxAccuracyMeters:
        value > 0 &&
        LINE_MAX_ACCURACY_OPTIONS.includes(
          value as (typeof LINE_MAX_ACCURACY_OPTIONS)[number],
        )
          ? value
          : undefined,
    }))
  }, [])

  const setLineBreakSpeed = useCallback((value: number) => {
    const nextValue = Number.isFinite(value)
      ? Math.round(
          clamp(value, LINE_BREAK_SPEED_MIN, LINE_BREAK_SPEED_MAX) /
            LINE_BREAK_SPEED_STEP,
        ) * LINE_BREAK_SPEED_STEP
      : LINE_BREAK_SPEED_MIN
    setLineCleanup((current) => ({
      ...current,
      breakSpeedKmh: nextValue > 0 ? nextValue : undefined,
    }))
  }, [])

  const setLineMaxSegmentDistance = useCallback((optionIndex: number) => {
    const nextOptionIndex = Number.isFinite(optionIndex)
      ? Math.trunc(
          clamp(
            optionIndex,
            0,
            LINE_MAX_SEGMENT_DISTANCE_OPTIONS.length - 1,
          ),
        )
      : 0
    const nextValue = LINE_MAX_SEGMENT_DISTANCE_OPTIONS[nextOptionIndex]
    setLineCleanup((current) => ({
      ...current,
      maxSegmentDistanceKm: nextValue > 0 ? nextValue : undefined,
    }))
  }, [])

  const setLineCleanupFlag = useCallback((
    key: 'removeIsolatedJumps',
    enabled: boolean,
  ) => {
    setLineCleanup((current) => ({ ...current, [key]: enabled }))
  }, [])

  const resetLineCleanup = useCallback(() => {
    setLineCleanup(DEFAULT_LINE_CLEANUP)
  }, [])

  const toggleMetadata = useCallback((enabled: boolean) => {
    setShowResultMetadata(enabled)
    window.localStorage.setItem(RESULT_METADATA_KEY, String(enabled))
  }, [])

  const toggleDebugData = useCallback((enabled: boolean) => {
    setShowDebugData(enabled)
    window.localStorage.setItem(DEBUG_DATA_KEY, String(enabled))
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
                <strong>tobiga UG (haftungsbeschrÃ¤nkt)</strong>
                <span>Tobias Gassmann</span>
                <span>Bodenseestr. 4a</span>
                <span>81241 MÃ¼nchen</span>
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
            <button
              type="button"
              onClick={rescanFolders}
              disabled={busy || !catalogReady}
            >
              <RefreshCw size={17} />
              {t('rescanFolders')}
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
                <div className="display-section">
                  <label className="settings-select-row">
                    {t('mapBubbleDensity')}
                    <select
                      value={mapBubbleCellSize}
                      onChange={(event) =>
                        setMapBubbleCellSize(Number(event.target.value))
                      }
                    >
                      {MAP_BUBBLE_CELL_SIZE_OPTIONS.map((cellSize) => (
                        <option key={cellSize} value={cellSize}>
                          {cellSize === 48
                            ? t('mapBubbleDensityCompact')
                            : cellSize === 64
                              ? t('mapBubbleDensityBalanced')
                              : t('mapBubbleDensitySpacious')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-hint">{t('mapBubbleDensityHint')}</p>
                </div>
                <div className="display-section">
                  <label className="settings-select-row">
                    {t('mapBubbleSize')}
                    <select
                      value={mapBubbleScale}
                      onChange={(event) =>
                        setMapBubbleScale(Number(event.target.value))
                      }
                    >
                      {MAP_BUBBLE_SCALE_OPTIONS.map((scale) => (
                        <option key={scale} value={scale}>
                          {scale === 0.75
                            ? t('small')
                            : scale === 1
                              ? t('medium')
                              : t('large')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-hint">{t('mapBubbleSizeHint')}</p>
                </div>
                <div className="display-section">
                  <label className="settings-select-row">
                    {t('mapMaxBubbles')}
                    <select
                      value={mapMaxBubbles}
                      onChange={(event) =>
                        setMapMaxBubbles(Number(event.target.value))
                      }
                    >
                      {MAP_MAX_BUBBLES_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value.toLocaleString(locale)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-hint">{t('mapMaxBubblesHint')}</p>
                </div>
                <div className="display-section">
                  <label className="settings-select-row">
                    {t('mapRenderBatchSize')}
                    <select
                      value={mapRenderBatchSize}
                      onChange={(event) =>
                        setMapRenderBatchSize(Number(event.target.value))
                      }
                    >
                      {MAP_RENDER_BATCH_SIZE_OPTIONS.map((batchSize) => (
                        <option key={batchSize} value={batchSize}>
                          {batchSize.toLocaleString(locale)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-hint">
                    {t('mapRenderBatchSizeHint')}
                  </p>
                </div>
                <div className="display-section">
                  <span>{t('lineCleanup')}</span>
                  <div className="settings-checkbox-grid" aria-label={t('lineAllowedSources')}>
                    {LINE_CLEANUP_SOURCE_OPTIONS.map((source) => (
                      <label key={source} className="settings-checkbox-row">
                        <input
                          type="checkbox"
                          checked={lineCleanup.allowedSources.includes(source)}
                          onChange={(event) =>
                            toggleLineCleanupSource(source, event.target.checked)
                          }
                        />
                        {source}
                      </label>
                    ))}
                  </div>
                  <label className="settings-select-row">
                    {t('lineMaxAccuracy')}
                    <select
                      value={lineCleanup.maxAccuracyMeters ?? 0}
                      onChange={(event) =>
                        setLineMaxAccuracy(Number(event.target.value))
                      }
                    >
                      {LINE_MAX_ACCURACY_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value === 0 ? t('off') : `${value.toLocaleString(locale)} m`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="settings-slider-row">
                    <span>
                      {t('lineBreakSpeed')}
                      <strong>
                        {lineCleanup.breakSpeedKmh === undefined
                          ? t('off')
                          : `${lineCleanup.breakSpeedKmh.toLocaleString(locale)} km/h`}
                      </strong>
                    </span>
                    <input
                      aria-label={t('lineBreakSpeed')}
                      type="range"
                      min={LINE_BREAK_SPEED_MIN}
                      max={LINE_BREAK_SPEED_MAX}
                      step={LINE_BREAK_SPEED_STEP}
                      value={lineCleanup.breakSpeedKmh ?? 0}
                      onChange={(event) =>
                        setLineBreakSpeed(Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="settings-slider-row">
                    <span>
                      {t('lineMaxSegmentDistance')}
                      <strong>
                        {lineCleanup.maxSegmentDistanceKm === undefined
                          ? t('off')
                          : formatDistanceThresholdKm(
                              lineCleanup.maxSegmentDistanceKm,
                              locale,
                            )}
                      </strong>
                    </span>
                    <input
                      aria-label={t('lineMaxSegmentDistance')}
                      aria-valuetext={
                        lineCleanup.maxSegmentDistanceKm === undefined
                          ? t('off')
                          : formatDistanceThresholdKm(
                              lineCleanup.maxSegmentDistanceKm,
                              locale,
                            )
                      }
                      type="range"
                      min={0}
                      max={LINE_MAX_SEGMENT_DISTANCE_OPTIONS.length - 1}
                      step={1}
                      value={lineMaxSegmentDistanceOptionIndex(
                        lineCleanup.maxSegmentDistanceKm,
                      )}
                      onChange={(event) =>
                        setLineMaxSegmentDistance(Number(event.target.value))
                      }
                    />
                  </label>
                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={lineCleanup.removeIsolatedJumps}
                      onChange={(event) =>
                        setLineCleanupFlag(
                          'removeIsolatedJumps',
                          event.target.checked,
                        )
                      }
                    />
                    {t('lineRemoveIsolatedJumps')}
                  </label>
                  <button type="button" onClick={resetLineCleanup}>
                    {t('lineResetFilters')}
                  </button>
                  <p className="settings-hint">{t('lineCleanupHint')}</p>
                </div>
                <div className="display-section">
                  <label className="toggle-row">
                    <input
                      type="checkbox"
                      checked={showDebugData}
                      onChange={(event) =>
                        toggleDebugData(event.target.checked)
                      }
                    />
                    {t('showDebugData')}
                  </label>
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
      </header>

      <section ref={workspaceRef} className="workspace">
        <section ref={leftStackRef} className="left-stack">
          <div
            className={`map-pane ${boundsDrawing ? 'area-drawing' : ''}`}
          >
            <MapView
              queryPoint={distanceSortActive ? queryPoint : undefined}
              hoverPoint={hoveredResultPoint}
              geoItems={mapItems}
              mapMode={mapDisplayMode}
              polyline={mapPolyline}
              renderBatchSize={mapRenderBatchSize}
              bubbleScale={mapBubbleScale}
              geoBounds={geoBounds}
              boundsDrawing={boundsDrawing}
              label={t('searchMap')}
              onQueryPointChange={setMapQueryPoint}
              onGeoBoundsChange={setMapGeoBounds}
              onVisibleViewportChange={setVisibleMapViewportState}
            />
            {mapLoading && (
              <div className="map-loading-strip" aria-hidden="true">
                <div className="map-loading-strip-fill" />
              </div>
            )}
            <div className="map-area-tools">
              <div
                className="map-mode-control"
                role="group"
                aria-label={t('mapDisplayMode')}
              >
                <button
                  type="button"
                  className={mapDisplayMode === 'bubbles' ? 'active' : undefined}
                  aria-pressed={mapDisplayMode === 'bubbles'}
                  onClick={() => setMapDisplayMode('bubbles')}
                  title={t('mapDisplayBubbles')}
                >
                  <CircleDot size={16} />
                  {t('mapDisplayBubbles')}
                </button>
                <button
                  type="button"
                  className={mapDisplayMode === 'polyline' ? 'active' : undefined}
                  aria-pressed={mapDisplayMode === 'polyline'}
                  onClick={() => setMapDisplayMode('polyline')}
                  title={t('mapDisplayLine')}
                >
                  <Route size={16} />
                  {t('mapDisplayLine')}
                </button>
              </div>
              {geoBounds ? (
                <button
                  type="button"
                  onClick={clearMapGeoBounds}
                  title={t('clearAreaFilter')}
                >
                  <Trash2 size={16} />
                  {t('clear')}
                </button>
              ) : (
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
              )}
            </div>
            {distanceSortActive && (
              <div className="map-status-stack">
                <div className="map-readout">
                  <MapPin size={16} />
                  <span>{queryPoint.lat.toFixed(5)}</span>
                  <span>{queryPoint.lon.toFixed(5)}</span>
                </div>
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
                <h2>{t('query')}</h2>
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
              <div className="control-row query-select-row">
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
                    <option value="timeline_visit">{t('timelineVisits')}</option>
                    <option value="timeline_activity">{t('timelineActivities')}</option>
                    <option value="activity_sample">{t('activitySamples')}</option>
                    <option value="frequent_place">{t('frequentPlaces')}</option>
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
              </div>
              {distanceSortActive && (
                <label>
                  {t('distanceEngine')}
                  <select
                    value={selectedIndexId}
                    onChange={(event) => setSelectedIndexId(event.target.value)}
                  >
                    <option value="segmented-ball-tree">
                      {t('segmentedBallTree')}
                    </option>
                    <option value="brute-force">{t('bruteForceOracle')}</option>
                  </select>
                </label>
              )}
            </section>

            <section className="panel index-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t('indexes')}</h2>
              </div>
              <div className="index-status-row">
                <span className={`index-status-badge ${combinedIndexesStatus}`}>
                  {indexStatusLabel(combinedIndexesStatus, t)}
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={!catalogInfo || Boolean(geoIndexProgress)}
                  onClick={() => {
                    void handleUpdateIndexes().catch(reportError)
                  }}
                >
                  {combinedIndexButtonLabel(combinedIndexesStatus, t)}
                </button>
              </div>
              {geoIndexProgress && (
                <div className="index-progress">
                  <div className="index-progress-copy">
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
                    aria-label={geoIndexProgressLabel(geoIndexProgress, t)}
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
              )}
              <dl className="index-status-grid">
                <div data-index-id="file-time-geo">
                  <dt>{t('timeFirstIndex')}</dt>
                  <dd>
                    <span className={`index-status-badge ${regularIndexStatus}`}>
                      {indexStatusLabel(regularIndexStatus, t)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t('assets')}</dt>
                  <dd>
                    {statsNumber(
                      timeGeoIndexStats?.pointCount ?? 0,
                      locale,
                    )}
                  </dd>
                </div>
                {typeof timeGeoIndexStats?.indexSizeBytes === 'number' && (
                  <div>
                    <dt>{t('indexSize')}</dt>
                    <dd>
                      {formatBytes(
                        timeGeoIndexStats.indexSizeBytes,
                        locale,
                      )}
                    </dd>
                  </div>
                )}
                {typeof timeGeoIndexStats?.catalogVersion === 'number' && (
                  <div>
                    <dt>{t('catalogVersion')}</dt>
                    <dd>
                      {statsNumber(timeGeoIndexStats.catalogVersion, locale)}
                    </dd>
                  </div>
                )}
                {typeof timeGeoIndexStats?.indexCatalogVersion ===
                  'number' && (
                  <div>
                    <dt>{t('indexVersion')}</dt>
                    <dd>
                      {statsNumber(
                        timeGeoIndexStats.indexCatalogVersion,
                        locale,
                      )}
                    </dd>
                  </div>
                )}
                <div data-index-id={selectedIndexId}>
                  <dt>{t('engine')}</dt>
                  <dd>
                    <span className={`index-status-badge ${selectedIndexStatus}`}>
                      {indexStatusLabel(selectedIndexStatus, t)}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{t('distanceEngine')}</dt>
                  <dd>{indexStats.engineLabel ?? indexStats.engineId}</dd>
                </div>
                <div>
                  <dt>{t('geoPoints')}</dt>
                  <dd>{statsNumber(indexStats.pointCount, locale)}</dd>
                </div>
                {typeof indexStats.catalogVersion === 'number' && (
                  <div>
                    <dt>{t('catalogVersion')}</dt>
                    <dd>{statsNumber(indexStats.catalogVersion, locale)}</dd>
                  </div>
                )}
                {typeof indexStats.indexCatalogVersion === 'number' && (
                  <div>
                    <dt>{t('indexVersion')}</dt>
                    <dd>
                      {statsNumber(indexStats.indexCatalogVersion, locale)}
                    </dd>
                  </div>
                )}
                {typeof indexStats.indexSizeBytes === 'number' && (
                  <div>
                    <dt>{t('indexSize')}</dt>
                    <dd>{formatBytes(indexStats.indexSizeBytes, locale)}</dd>
                  </div>
                )}
                {typeof indexStats.segmentCount === 'number' && (
                  <div>
                    <dt>{t('segments')}</dt>
                    <dd>{statsNumber(indexStats.segmentCount, locale)}</dd>
                  </div>
                )}
              </dl>
            </section>

            {showDebugData && (
            <section className="panel metrics-panel">
              <div className="panel-title">
                <Activity size={17} />
                <h2>{t('metrics')}</h2>
              </div>
              <div className="metrics-section">
                <div className="metrics-section-title">{t('resultsQuery')}</div>
                <dl className="metrics-grid">
                  <div>
                    <dt>{t('worker')}</dt>
                    <dd>{formatMilliseconds(resultMetrics.queryTimeMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('roundTrip')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryRoundTripMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('paint')}</dt>
                    <dd>{formatMilliseconds(resultMetrics.queryPaintMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('clientWait')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryTransferMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('render')}</dt>
                    <dd>{formatMilliseconds(resultMetrics.queryRenderMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('indexReady')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryIndexReadyMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('indexScan')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryIndexScanMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('assetRead')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryAssetReadMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('filter')}</dt>
                    <dd>
                      {formatMilliseconds(
                        resultMetrics.queryAssetFilterMs,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('rows')}</dt>
                    <dd>
                      {statsNumber(
                        resultMetrics.rowsReturned ?? resultItems.length,
                        locale,
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
              <div className="metrics-section">
                <div className="metrics-section-title">{t('mapQuery')}</div>
                <dl className="metrics-grid">
                  <div>
                    <dt>{t('worker')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryTimeMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('roundTrip')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryRoundTripMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('paint')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryPaintMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('clientWait')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryTransferMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('indexReady')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryIndexReadyMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('indexScan')}</dt>
                    <dd>{formatMilliseconds(mapMetrics.queryIndexScanMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('renderedBubbles')}</dt>
                    <dd>
                      {statsNumber(
                        mapMetrics.renderedBubbles ??
                          mapMetrics.rowsReturned ??
                          mapItems.length,
                        locale,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('matchedRecords')}</dt>
                    <dd>{statsNumber(mapMetrics.matchedRecords, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('sourceLinePoints')}</dt>
                    <dd>{statsNumber(mapMetrics.sourceLinePoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('acceptedLinePoints')}</dt>
                    <dd>{statsNumber(mapMetrics.acceptedLinePoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('filteredLinePoints')}</dt>
                    <dd>{statsNumber(mapMetrics.filteredLinePoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('filteredQualityPoints')}</dt>
                    <dd>{statsNumber(mapMetrics.filteredQualityPoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('filteredJumpPoints')}</dt>
                    <dd>{statsNumber(mapMetrics.filteredJumpPoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('lineSpeedBreaks')}</dt>
                    <dd>{statsNumber(mapMetrics.lineSpeedBreaks, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('lineDistanceBreaks')}</dt>
                    <dd>{statsNumber(mapMetrics.lineDistanceBreaks, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('lineSegments')}</dt>
                    <dd>{statsNumber(mapMetrics.lineSegments, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('renderedLinePoints')}</dt>
                    <dd>{statsNumber(mapMetrics.renderedLinePoints, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('renderedLineDots')}</dt>
                    <dd>{statsNumber(mapMetrics.renderedLineDots, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('largestBubble')}</dt>
                    <dd>{statsNumber(mapMetrics.largestBubbleCount, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('aggregationZoom')}</dt>
                    <dd>{statsNumber(mapMetrics.aggregationZoom, locale)}</dd>
                  </div>
                  <div>
                    <dt>{t('cellSize')}</dt>
                    <dd>
                      {`${statsNumber(
                        typeof mapMetrics.aggregationCellSizePx === 'number'
                          ? Math.round(mapMetrics.aggregationCellSizePx)
                          : undefined,
                        locale,
                      )} px`}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('visited')}</dt>
                    <dd>{statsNumber(mapMetrics.candidatesInspected, locale)}</dd>
                  </div>
                </dl>
              </div>
              <div className="metrics-section-title">{t('indexDetails')}</div>
              <dl className="metrics-grid">
                <div>
                  <dt>{t('engine')}</dt>
                  <dd className="metric-text">
                    {effectiveIndexStats.engineLabel ??
                      effectiveIndexStats.engineId}
                  </dd>
                </div>
                <div>
                  <dt>{t('geoPoints')}</dt>
                  <dd>{geoPointCount.toLocaleString(locale)}</dd>
                </div>
                <div>
                  <dt>{t('worker')}</dt>
                  <dd>
                    {formatMilliseconds(
                      effectiveIndexStats.queryTimeMs ??
                        effectiveIndexStats.lastQueryTimeMs,
                    )}
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
            )}
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
                {visibleRange} {t('visible')}
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
          {timelineGroups.length > 0 && (
            <section className="timeline-group-overview" aria-label={t('timelineGroups')}>
              <div className="timeline-group-overview-header">
                <h3>{t('timelineGroups')}</h3>
                <span>
                  {t('timelineGroupsOnPage', {
                    count: timelineGroups.length.toLocaleString(locale),
                  })}
                </span>
              </div>
              <div className="timeline-group-list">
                {timelineGroups.map((group) => (
                  <article key={group.id} className="timeline-group-card">
                    <strong>{group.label}</strong>
                    <span>
                      {group.count.toLocaleString(locale)} {t('visible')}
                      {group.sourceTypes.length > 0
                        ? ` · ${group.sourceTypes.join(', ')}`
                        : ''}
                    </span>
                    <span>
                      {formatDateTime(group.startTime, locale, t('noTimestamp'))}
                      {group.endTime !== undefined &&
                      group.endTime !== group.startTime
                        ? ` - ${formatDateTime(group.endTime, locale, t('noTimestamp'))}`
                        : ''}
                    </span>
                  </article>
                ))}
              </div>
            </section>
          )}
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
            <ResultCard
              key={result.item.id}
              result={result}
              index={index}
              displayMode={resultDisplayMode}
              showMetadata={showResultMetadata}
              thumbnails={platform.thumbnails}
              locale={locale}
              t={t}
              onOpen={openViewer}
              onHoverResultChange={setHoveredResultId}
            />
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
