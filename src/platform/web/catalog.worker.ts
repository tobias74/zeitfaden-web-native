import * as exifr from 'exifr'
import {
  ResidentPackedDistanceIndex,
  type ResidentDistanceBuildPoint,
  type ResidentDistanceSearchResult,
  type ResidentPackedDistanceEngineId,
  type ResidentPackedDistanceManifest,
  type ResidentPackedDistanceStore,
} from '../../geo/residentPackedDistanceIndex'
import { GeoIndexRegistry } from '../../geo/registry'
import {
  geoPointContentHash,
  parseGeoFilePoints,
  semanticContentHash,
  type ParsedGeoItem,
  type ParsedGeoPoint,
} from '../../lib/geoPoint'
import { GoogleTakeoutLocationStreamParser } from '../../lib/googleTakeoutStream'
import { haversineMeters } from '../../lib/distance'
import { detectMediaKind, pathDisplayName } from '../../lib/media'
import { sha256Hex } from '../../lib/sha256'
import { traceStartup } from '../../lib/startupTrace'
import { SearchIndexRegistry as SearchIndexEngineRegistry } from '../../search/registry'
import type {
  CatalogQuery,
  GeoBounds,
  GeoIndexPoint,
  GeoSearchQuery,
  GeoSearchResult,
  MapPoint,
  MapPointPage,
  MapPolyline,
  MediaKind,
  MediaItem,
  MediaLocation,
  MediaSource,
  SearchIndexEngine,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
  TimeRange,
} from '../../types'
import type {
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  ImportProgress,
  ImportSummary,
} from '../types'

traceStartup('[startup:worker]', 'catalog worker module evaluated')

type WorkerRequest = {
  id: number
  type: string
  payload?: unknown
}

type InitResult = {
  storageMode: 'file'
  filename: string
}

type ImportFolderPayload = {
  source: MediaSource
  duplicateSourceIds: string[]
  handle: FileSystemDirectoryHandle
}

type ImportGeoFilePayload = {
  source: MediaSource
  duplicateSourceIds: string[]
  file: File
}

type CancellationSignal = () => boolean

type CatalogManifest = {
  schemaVersion: 2
  catalogVersion: number
  nextAssetId: number
  assetStoreVersion: number
  indexAppliedVersion: number
  indexJob?: FileCatalogIndexJob
  nextChunkId: number
  occurrenceCount: number
  assetCount: number
  locationCount: number
  materializedVersion: number
  sources: Record<string, FileCatalogSource>
  chunks: FileCatalogChunk[]
}

type FileCatalogIndexJob = {
  status: 'pending' | 'indexing' | 'current' | 'failed'
  pendingSince?: number
  startedAt?: number
  finishedAt?: number
  failedMessage?: string
}

type FileCatalogSource = MediaSource & {
  generation: number
  active: boolean
  importedAt: number
}

type FileCatalogChunk = {
  id: string
  sourceId: string
  generation: number
  count: number
  createdAt: number
  active: boolean
}

type FileOccurrence = {
  item: MediaItem
  sourceId: string
  generation: number
}

type MaterializedCatalog = {
  version: number
  assets: MediaItem[]
  byId: Map<string, MediaItem>
  geoPoints: GeoIndexPoint[]
}

type MediaSearchRows = {
  items: MediaItem[]
  metrics?: Partial<SearchIndexStats>
}

type AssetMediaResult = {
  assetId: number
  item: MediaItem
}

type MediaSearchRowsFn = (
  query: CatalogQuery,
  indexId: FileCatalogIndexId,
  isCancelled: CancellationSignal,
) => Promise<MediaSearchRows>
type EnsureSearchIndexReadyFn = (indexId: string) => Promise<SearchIndexStats>

type MediaBatchWriteResult = {
  written: number
}

type CatalogStore = {
  storageMode: 'file'
  geoImportWriteBatchSize: number
  init(): Promise<InitResult>
  upsertSource(source: MediaSource): Promise<void>
  upsertMedia(items: MediaItem[]): Promise<number>
  prepareImportSource(source: MediaSource, duplicateSourceIds: string[]): Promise<void>
  writeMediaBatch(items: MediaItem[]): Promise<MediaBatchWriteResult>
  commitImport(): Promise<void>
  withImportTransaction<T>(run: () => Promise<T>): Promise<T>
  listMedia(query: CatalogQuery): Promise<MediaItem[]>
  searchMedia(
    spec: SearchSpec,
    isCancelled?: CancellationSignal,
  ): Promise<SearchPage>
  searchMapPoints(
    spec: SearchSpec,
    isCancelled?: CancellationSignal,
  ): Promise<MapPointPage>
  getMediaByIds(ids: string[]): Promise<MediaItem[]>
  getMediaByAssetIds(assetIds: number[]): Promise<AssetMediaResult[]>
  getGeoPoints(range: TimeRange): Promise<GeoIndexPoint[]>
  forEachGeoPointBatch(
    batchSize: number,
    onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
  ): Promise<number>
  forEachGeoAssetBatch(
    batchSize: number,
    onBatch: (batch: ResidentDistanceBuildPoint[], processedPoints: number) => Promise<void>,
  ): Promise<number>
  residentDistanceIndexStore(): ResidentPackedDistanceStore
  catalogEpoch(): Promise<number>
  buildSearchIndexes(
    indexId: string,
    forceRebuild: boolean,
    postProgress: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary & { engineCount: number }>
  getSearchIndexStats(): Promise<SearchIndexStats[]>
  countMedia(): Promise<number>
  clear(): Promise<void>
}

const IMPORT_BATCH_SIZE = 40
const GEO_IMPORT_PREFIX_BYTES = 512 * 1024
const GEO_IMPORT_PARSE_SLICE_MS = 250
const GEO_IMPORT_WRITE_BATCH_SIZE = 10_000
const GEO_POINT_ITEM_BUILD_CHUNK_SIZE = 10_000
const PROGRESS_HEARTBEAT_MS = 200
const CATALOG_DIR = 'catalog-file-v1'
const MANIFEST_FILE = 'manifest.json'
const ASSETS_FILE = 'assets.bin'
const ASSET_RECORD_INDEX_FILE = 'records.idx'
const ASSET_ID_MAP_FILE = 'ids.idx'
const ASSET_CHUNK_PREFIX = 'chunk-'
const ASSET_CHUNK_EXTENSION = '.jsonl'
const ASSET_BINARY_CHUNK_EXTENSION = '.bin'
const ASSET_CHUNK_SIZE = 10_000
const TIME_GEO_INDEX_FILE = 'time-geo.idx'
const ASSET_TABLE_MAGIC = 0x41535431
const ASSET_ID_MAP_MAGIC = 0x41494431
const PACKED_INDEX_MAGIC = 0x50495831
const BINARY_SCHEMA_VERSION = 3
const ASSET_TABLE_HEADER_SIZE = 32
const ASSET_RECORD_INDEX_ENTRY_SIZE = 16
const ASSET_ID_MAP_HEADER_SIZE = 32
const ASSET_ID_MAP_ENTRY_SIZE = 72
const PACKED_INDEX_HEADER_SIZE = 96
const TIME_GEO_RECORD_SIZE = 44
const PACKED_SCAN_RECORDS = 8192
const PACKED_MAP_SCAN_RECORDS = 131_072
const MAX_RENDERED_MAP_BUBBLES = 5_000
const INDEX_KIND_TIME_GEO = 1
const KIND_CODE_IMAGE = 0
const KIND_CODE_VIDEO = 1
const KIND_CODE_GEO_POINT = 2
const KIND_CODE_TIMELINE_VISIT = 3
const KIND_CODE_TIMELINE_ACTIVITY = 4
const KIND_CODE_ACTIVITY_SAMPLE = 5
const KIND_CODE_FREQUENT_PLACE = 6
const KIND_CODE_MASK = 0x7f
const KIND_FLAG_HAS_GEO = 1 << 7
const LINE_SOURCE_UNKNOWN = 0
const LINE_SOURCE_GPS = 1
const LINE_SOURCE_WIFI = 2
const LINE_SOURCE_CELL = 3
const LINE_QUALITY_HAS_ACCURACY = 1 << 0
const LINE_QUALITY_HAS_VELOCITY = 1 << 1
const LINE_QUALITY_HAS_HEADING = 1 << 2
const LINE_QUALITY_HAS_GROUP = 1 << 3
const LINE_QUALITY_HAS_SEQUENCE = 1 << 4
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

const geoIndexRegistry = new GeoIndexRegistry()
const residentDistanceIndexInstances = new Map<string, ResidentPackedDistanceIndex>()
const cancelledRequests = new Set<number>()

function neverCancelled(): boolean {
  return false
}

function abortError(): Error {
  const error = new Error('Catalog request aborted')
  error.name = 'AbortError'
  return error
}

function throwIfCancelled(isCancelled: CancellationSignal): void {
  if (isCancelled()) throw abortError()
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function dateMillis(value: unknown): number | undefined {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isFinite(time) ? time : undefined
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = Date.parse(String(value))
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

async function rootDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(CATALOG_DIR, { create: true })
}

async function childDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true })
}

async function readFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<File | undefined> {
  try {
    return await (await directory.getFileHandle(name)).getFile()
  } catch {
    return undefined
  }
}

async function readTextFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<string | undefined> {
  return (await readFile(directory, name))?.text()
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: BlobPart,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable?.()
  if (!writable) throw new Error('File catalog writes are unavailable.')
  await writable.write(data)
  await writable.close()
}

async function writeFileParts(
  directory: FileSystemDirectoryHandle,
  name: string,
  parts: Iterable<BlobPart>,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable?.()
  if (!writable) throw new Error('File catalog writes are unavailable.')
  try {
    for (const part of parts) await writable.write(part)
  } finally {
    await writable.close()
  }
}

async function clearDirectory(directory: FileSystemDirectoryHandle): Promise<void> {
  const iterable = directory as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterable<[string, FileSystemHandle]>
  }
  if (!iterable.entries) return
  for await (const [name] of iterable.entries()) {
    await directory.removeEntry(name, { recursive: true })
  }
}

async function directoryEntries(
  directory: FileSystemDirectoryHandle,
): Promise<[string, FileSystemHandle][]> {
  const iterable = directory as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterable<[string, FileSystemHandle]>
  }
  if (!iterable.entries) return []
  const entries: [string, FileSystemHandle][] = []
  for await (const entry of iterable.entries()) entries.push(entry)
  return entries
}

async function readFileRange(file: File, offset: number, length: number): Promise<ArrayBuffer> {
  return file.slice(offset, offset + length).arrayBuffer()
}

function setUint64(view: DataView, offset: number, value: number): void {
  view.setBigUint64(offset, BigInt(value), true)
}

function getUint64(view: DataView, offset: number): number {
  return Number(view.getBigUint64(offset, true))
}

function encodeHeader(
  magic: number,
  catalogVersion: number,
  count: number,
  entrySize: number,
): Uint8Array {
  const bytes = new Uint8Array(ASSET_TABLE_HEADER_SIZE)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, magic, true)
  view.setUint32(4, BINARY_SCHEMA_VERSION, true)
  view.setFloat64(8, catalogVersion, true)
  view.setFloat64(16, count, true)
  view.setUint32(24, entrySize, true)
  return bytes
}

function bytesAsBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

function readBinaryHeader(
  bytes: ArrayBuffer,
  expectedMagic: number,
): { catalogVersion: number; count: number; entrySize: number } | undefined {
  if (bytes.byteLength < ASSET_TABLE_HEADER_SIZE) return undefined
  const view = new DataView(bytes)
  if (view.getUint32(0, true) !== expectedMagic) return undefined
  if (view.getUint32(4, true) !== BINARY_SCHEMA_VERSION) return undefined
  return {
    catalogVersion: view.getFloat64(8, true),
    count: view.getFloat64(16, true),
    entrySize: view.getUint32(24, true),
  }
}

function encodeHashKey(hash: string): Uint8Array {
  const bytes = new Uint8Array(64)
  const encoded = textEncoder.encode(hash.toLowerCase())
  bytes.set(encoded.slice(0, bytes.length))
  return bytes
}

function compareHashBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index]
    if (delta !== 0) return delta
  }
  return 0
}

function timestampSeconds(value: number): number {
  return Math.max(0, Math.min(0xffffffff, Math.floor(value / 1000)))
}

function latE7(value: number): number {
  return Math.round(Math.max(-90, Math.min(90, value)) * 10_000_000)
}

function lonE7(value: number): number {
  return Math.round(Math.max(-180, Math.min(180, value)) * 10_000_000)
}

function minLatBoundE7(value: number): number {
  return Math.ceil(Math.max(-90, Math.min(90, value)) * 10_000_000 - 0.5)
}

function maxLatBoundE7(value: number): number {
  return Math.floor(Math.max(-90, Math.min(90, value)) * 10_000_000 + 0.5)
}

function minLonBoundE7(value: number): number {
  return Math.ceil(Math.max(-180, Math.min(180, value)) * 10_000_000 - 0.5)
}

function maxLonBoundE7(value: number): number {
  return Math.floor(Math.max(-180, Math.min(180, value)) * 10_000_000 + 0.5)
}

function coordinateFromE7(value: number): number {
  return value / 10_000_000
}

function mediaKindFromUnknown(value: unknown): MediaKind {
  switch (value) {
    case 'video':
    case 'geo_point':
    case 'timeline_visit':
    case 'timeline_activity':
    case 'activity_sample':
    case 'frequent_place':
      return value
    default:
      return 'image'
  }
}

function kindCode(kind: MediaKind): number {
  switch (kind) {
    case 'video':
      return KIND_CODE_VIDEO
    case 'geo_point':
      return KIND_CODE_GEO_POINT
    case 'timeline_visit':
      return KIND_CODE_TIMELINE_VISIT
    case 'timeline_activity':
      return KIND_CODE_TIMELINE_ACTIVITY
    case 'activity_sample':
      return KIND_CODE_ACTIVITY_SAMPLE
    case 'frequent_place':
      return KIND_CODE_FREQUENT_PLACE
    case 'image':
      return KIND_CODE_IMAGE
  }
}

function kindFlags(item: MediaItem): number {
  const kind = kindCode(item.kind)
  return kind |
    (item.latitude !== undefined && item.longitude !== undefined
      ? KIND_FLAG_HAS_GEO
      : 0)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sourceCodeFromValue(value: unknown): number {
  if (typeof value !== 'string') return LINE_SOURCE_UNKNOWN
  const normalized = value.trim().toUpperCase()
  if (normalized === 'GPS') return LINE_SOURCE_GPS
  if (normalized === 'WIFI' || normalized === 'WI_FI') return LINE_SOURCE_WIFI
  if (normalized === 'CELL' || normalized === 'CELLULAR') return LINE_SOURCE_CELL
  return LINE_SOURCE_UNKNOWN
}

function sourceCodeFromItem(item: MediaItem): number {
  const metadataSource = item.metadata && typeof item.metadata === 'object'
    ? (item.metadata as Record<string, unknown>).source
    : undefined
  return sourceCodeFromValue(item.sourceType) || sourceCodeFromValue(metadataSource)
}

function lineSourceFromCode(code: number): 'GPS' | 'WIFI' | 'CELL' | 'UNKNOWN' {
  if (code === LINE_SOURCE_GPS) return 'GPS'
  if (code === LINE_SOURCE_WIFI) return 'WIFI'
  if (code === LINE_SOURCE_CELL) return 'CELL'
  return 'UNKNOWN'
}

function hashString64(value: string | undefined): { lo: number; hi: number } {
  if (!value) return { lo: 0, hi: 0 }
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return {
    lo: Number(hash & 0xffff_ffffn),
    hi: Number((hash >> 32n) & 0xffff_ffffn),
  }
}

function linePayloadFromItem(item: MediaItem): Pick<
  PackedIndexRecord,
  | 'sourceCode'
  | 'qualityFlags'
  | 'accuracyMeters'
  | 'velocityMetersPerSecond'
  | 'headingDegrees'
  | 'groupHashLo'
  | 'groupHashHi'
  | 'sequence'
> {
  const groupHash = hashString64(item.groupId)
  const sequence = finiteNumber(item.sequence)
  let qualityFlags = 0
  const accuracyMeters = finiteNumber(item.accuracyMeters)
  const velocityMetersPerSecond = finiteNumber(item.velocityMetersPerSecond)
  const headingDegrees = finiteNumber(item.headingDegrees)
  if (accuracyMeters !== undefined) qualityFlags |= LINE_QUALITY_HAS_ACCURACY
  if (velocityMetersPerSecond !== undefined) qualityFlags |= LINE_QUALITY_HAS_VELOCITY
  if (headingDegrees !== undefined) qualityFlags |= LINE_QUALITY_HAS_HEADING
  if (groupHash.lo !== 0 || groupHash.hi !== 0) qualityFlags |= LINE_QUALITY_HAS_GROUP
  if (sequence !== undefined) qualityFlags |= LINE_QUALITY_HAS_SEQUENCE
  return {
    sourceCode: sourceCodeFromItem(item),
    qualityFlags,
    accuracyMeters,
    velocityMetersPerSecond,
    headingDegrees,
    groupHashLo: groupHash.lo,
    groupHashHi: groupHash.hi,
    sequence,
  }
}

function kindFromFlags(flags: number): MapPoint['kind'] {
  const encoded = flags & KIND_CODE_MASK
  if (encoded === KIND_CODE_VIDEO) return 'video'
  if (encoded === KIND_CODE_GEO_POINT) return 'geo_point'
  if (encoded === KIND_CODE_TIMELINE_VISIT) return 'timeline_visit'
  if (encoded === KIND_CODE_TIMELINE_ACTIVITY) return 'timeline_activity'
  if (encoded === KIND_CODE_ACTIVITY_SAMPLE) return 'activity_sample'
  if (encoded === KIND_CODE_FREQUENT_PLACE) return 'frequent_place'
  return 'image'
}

function acceptedKindMask(kind: CatalogQuery['kind']): number {
  if (!kind || kind === 'all') return 0xffffffff
  if (kind === 'media') return (1 << KIND_CODE_IMAGE) | (1 << KIND_CODE_VIDEO)
  return 1 << kindCode(kind)
}

function queryMayMatchIntervalKinds(kind: CatalogQuery['kind']): boolean {
  return (
    !kind ||
    kind === 'all' ||
    kind === 'timeline_visit' ||
    kind === 'timeline_activity'
  )
}

function scanMinTimestampSec(query: CatalogQuery): number {
  if (query.startTime === undefined) return 0
  return queryMayMatchIntervalKinds(query.kind) ? 0 : timestampSeconds(query.startTime)
}

function emptyManifest(): CatalogManifest {
  return {
    schemaVersion: 2,
    catalogVersion: 0,
    nextAssetId: 0,
    assetStoreVersion: -1,
    indexAppliedVersion: -1,
    indexJob: { status: 'current' },
    nextChunkId: 0,
    occurrenceCount: 0,
    assetCount: 0,
    locationCount: 0,
    materializedVersion: -1,
    sources: {},
    chunks: [],
  }
}

function normalizeManifest(value: unknown): CatalogManifest {
  if (!isRecord(value) || value.schemaVersion !== 2) return emptyManifest()
  const base = emptyManifest()
  const catalogVersion = numeric(value.catalogVersion) ?? base.catalogVersion
  return {
    ...base,
    ...value,
    catalogVersion,
    nextAssetId: numeric(value.nextAssetId) ?? numeric(value.assetCount) ?? 0,
    assetStoreVersion: numeric(value.assetStoreVersion) ?? numeric(value.materializedVersion) ?? -1,
    indexAppliedVersion: numeric(value.indexAppliedVersion) ?? -1,
    indexJob: isRecord(value.indexJob)
      ? {
          status:
            value.indexJob.status === 'pending' ||
            value.indexJob.status === 'indexing' ||
            value.indexJob.status === 'failed' ||
            value.indexJob.status === 'current'
              ? value.indexJob.status
              : 'pending',
          pendingSince: numeric(value.indexJob.pendingSince),
          startedAt: numeric(value.indexJob.startedAt),
          finishedAt: numeric(value.indexJob.finishedAt),
          failedMessage:
            typeof value.indexJob.failedMessage === 'string'
              ? value.indexJob.failedMessage
              : undefined,
        }
      : { status: catalogVersion === (numeric(value.indexAppliedVersion) ?? -1) ? 'current' : 'pending' },
    sources: isRecord(value.sources)
      ? (value.sources as Record<string, FileCatalogSource>)
      : {},
    chunks: Array.isArray(value.chunks) ? (value.chunks as FileCatalogChunk[]) : [],
  }
}

function locationFromUnknown(value: unknown): MediaLocation | undefined {
  if (!isRecord(value)) return undefined
  return {
    id: String(value.id ?? ''),
    sourceId: String(value.sourceId ?? ''),
    sourceLabel: String(value.sourceLabel ?? ''),
    rootPath: typeof value.rootPath === 'string' ? value.rootPath : undefined,
    relativePath:
      typeof value.relativePath === 'string' ? value.relativePath : undefined,
    absolutePath:
      typeof value.absolutePath === 'string' ? value.absolutePath : undefined,
    pointIndex: numeric(value.pointIndex),
    sourceDataset:
      typeof value.sourceDataset === 'string' ? value.sourceDataset : undefined,
    sourceType: typeof value.sourceType === 'string' ? value.sourceType : undefined,
    groupId: typeof value.groupId === 'string' ? value.groupId : undefined,
    sequence: numeric(value.sequence),
    timestamp: numeric(value.timestamp),
    endTimestamp: numeric(value.endTimestamp),
  }
}

function mediaFromUnknown(value: unknown): MediaItem | undefined {
  if (!isRecord(value)) return undefined
  const contentHash = String(value.contentHash ?? value.id ?? '')
  const locations = Array.isArray(value.locations)
    ? value.locations.flatMap((location) => {
        const parsed = locationFromUnknown(location)
        return parsed ? [parsed] : []
      })
    : []
  if (!contentHash || locations.length === 0) return undefined
  const kind = mediaKindFromUnknown(value.kind)
  const metadata = isRecord(value.metadata)
    ? (value.metadata as Record<string, unknown>)
    : undefined
  return {
    id: contentHash,
    contentHash,
    sourceId: String(value.sourceId ?? locations[0]?.sourceId ?? ''),
    relativePath: String(value.relativePath ?? locations[0]?.relativePath ?? ''),
    displayName: String(value.displayName ?? contentHash),
    kind,
    mimeType: String(value.mimeType ?? ''),
    sizeBytes: numeric(value.sizeBytes) ?? 0,
    durationMs: numeric(value.durationMs),
    timestamp: numeric(value.timestamp),
    endTimestamp: numeric(value.endTimestamp),
    latitude: numeric(value.latitude),
    longitude: numeric(value.longitude),
    sourceDataset:
      typeof value.sourceDataset === 'string' ? value.sourceDataset : undefined,
    sourceType: typeof value.sourceType === 'string' ? value.sourceType : undefined,
    accuracyMeters: numeric(value.accuracyMeters),
    altitudeMeters: numeric(value.altitudeMeters),
    verticalAccuracyMeters: numeric(value.verticalAccuracyMeters),
    velocityMetersPerSecond: numeric(value.velocityMetersPerSecond),
    headingDegrees: numeric(value.headingDegrees),
    groupId: typeof value.groupId === 'string' ? value.groupId : undefined,
    sequence: numeric(value.sequence),
    metadata,
    thumbnailKey:
      typeof value.thumbnailKey === 'string' ? value.thumbnailKey : undefined,
    locations,
  }
}

function occurrenceFromLine(line: string): FileOccurrence | undefined {
  if (!line.trim()) return undefined
  try {
    const parsed = JSON.parse(line) as unknown
    if (!isRecord(parsed)) return undefined
    const item = mediaFromUnknown(parsed.item)
    if (!item) return undefined
    return {
      item,
      sourceId: String(parsed.sourceId ?? item.sourceId),
      generation: numeric(parsed.generation) ?? 0,
    }
  } catch {
    return undefined
  }
}

function itemLocations(item: MediaItem): MediaLocation[] {
  if (item.locations.length > 0) return item.locations
  return [
    {
      id: `${item.sourceId}:${item.relativePath}`,
      sourceId: item.sourceId,
      sourceLabel: item.sourceId,
      relativePath: item.relativePath,
      sourceDataset: item.sourceDataset,
      sourceType: item.sourceType,
      groupId: item.groupId,
      sequence: item.sequence,
      timestamp: item.timestamp,
      endTimestamp: item.endTimestamp,
    },
  ]
}

function displayNameForLocation(
  kind: MediaItem['kind'],
  contentHash: string,
  location: MediaLocation | undefined,
): string {
  if (kind !== 'image' && kind !== 'video') {
    const base = location?.sourceLabel ?? location?.relativePath ?? contentHash
    return typeof location?.pointIndex === 'number'
      ? `${base} #${location.pointIndex}`
      : base
  }
  return pathDisplayName(location?.relativePath ?? contentHash)
}

function relativePathForLocation(location: MediaLocation | undefined): string {
  return location?.relativePath ?? location?.sourceLabel ?? ''
}

function normalizeMediaItem(item: MediaItem, locations: MediaLocation[]): MediaItem {
  const sortedLocations = [...locations].sort(
    (a, b) =>
      (a.relativePath ?? '').localeCompare(b.relativePath ?? '') ||
      a.id.localeCompare(b.id),
  )
  const primaryLocation = sortedLocations[0] ?? {
    id: item.contentHash,
    sourceId: item.sourceId,
    sourceLabel: item.sourceId,
    relativePath: item.relativePath,
  }
  return {
    ...item,
    id: item.contentHash,
    sourceId: primaryLocation.sourceId,
    relativePath: relativePathForLocation(primaryLocation),
    displayName: displayNameForLocation(item.kind, item.contentHash, primaryLocation),
    locations: sortedLocations,
  }
}

function mergeMediaItems(existing: MediaItem, incoming: MediaItem): MediaItem {
  const mergedMetadata =
    existing.metadata || incoming.metadata
      ? {
          ...(incoming.metadata ?? {}),
          ...(existing.metadata ?? {}),
        }
      : undefined
  return {
    ...incoming,
    ...existing,
    timestamp: existing.timestamp ?? incoming.timestamp,
    endTimestamp: existing.endTimestamp ?? incoming.endTimestamp,
    latitude: existing.latitude ?? incoming.latitude,
    longitude: existing.longitude ?? incoming.longitude,
    sourceDataset: existing.sourceDataset ?? incoming.sourceDataset,
    sourceType: existing.sourceType ?? incoming.sourceType,
    accuracyMeters: existing.accuracyMeters ?? incoming.accuracyMeters,
    altitudeMeters: existing.altitudeMeters ?? incoming.altitudeMeters,
    verticalAccuracyMeters:
      existing.verticalAccuracyMeters ?? incoming.verticalAccuracyMeters,
    velocityMetersPerSecond:
      existing.velocityMetersPerSecond ?? incoming.velocityMetersPerSecond,
    headingDegrees: existing.headingDegrees ?? incoming.headingDegrees,
    groupId: existing.groupId ?? incoming.groupId,
    sequence: existing.sequence ?? incoming.sequence,
    metadata: mergedMetadata,
    locations: [...existing.locations, ...incoming.locations],
  }
}

function itemMatchesQuery(item: MediaItem, query: CatalogQuery): boolean {
  if (query.kind === 'media') {
    if (item.kind !== 'image' && item.kind !== 'video') return false
  } else if (query.kind && query.kind !== 'all' && item.kind !== query.kind) {
    return false
  }
  if (query.hasGeo === true && (item.latitude === undefined || item.longitude === undefined)) {
    return false
  }
  if (query.hasGeo === false && item.latitude !== undefined && item.longitude !== undefined) {
    return false
  }
  if (query.geoBounds) {
    if (item.latitude === undefined || item.longitude === undefined) return false
    if (
      item.latitude < query.geoBounds.minLat ||
      item.latitude > query.geoBounds.maxLat ||
      item.longitude < query.geoBounds.minLon ||
      item.longitude > query.geoBounds.maxLon
    ) {
      return false
    }
  }
  if (item.timestamp === undefined) {
    return query.startTime === undefined && query.endTime === undefined
  }
  const itemEndTime = item.endTimestamp ?? item.timestamp
  if (query.startTime !== undefined && itemEndTime < query.startTime) return false
  if (query.endTime !== undefined && item.timestamp > query.endTime) return false
  return true
}

function defaultSearchStats(engineId: string, engineLabel: string): SearchIndexStats {
  return {
    engineId,
    engineLabel,
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
}

type FileCatalogIndexId = 'file-time-geo'

function isFileCatalogIndexId(indexId: string): indexId is FileCatalogIndexId {
  return indexId === 'file-time-geo'
}

function fileCatalogIndexSpec(): {
  fileName: string
  kind: number
  label: string
} {
  return {
    fileName: TIME_GEO_INDEX_FILE,
    kind: INDEX_KIND_TIME_GEO,
    label: 'Time-first packed index',
  }
}

async function residentDistanceStatusStats(
  store: CatalogStore,
  indexId: ResidentPackedDistanceEngineId,
): Promise<SearchIndexStats> {
  const catalogVersion = await store.catalogEpoch()
  const distanceIndex = residentDistanceIndex(store, indexId)
  const stats = await distanceIndex.status(catalogVersion)
  if (stats.indexStatus === 'current' && stats.indexStorage !== 'memory') {
    distanceIndex.preload(catalogVersion)
  }
  return {
    ...stats,
    engineLabel: distanceIndex.label,
    exact: distanceIndex.capabilities.exact,
    persistent: distanceIndex.capabilities.persistent,
    catalogVersion,
  }
}

function withQueryMetrics(
  base: SearchIndexStats,
  spec: SearchSpec,
  queryTimeMs: number,
  rowsReturned: number,
  limit: number,
  offset: number,
  limitReached: boolean,
  timings: Partial<SearchIndexStats> = {},
): SearchIndexStats {
  return {
    ...base,
    ...timings,
    queryPurpose: spec.purpose,
    storageMode: 'file',
    queryTimeMs,
    lastQueryTimeMs: base.lastQueryTimeMs ?? queryTimeMs,
    rowsReturned,
    limit,
    offset,
    limitReached,
  }
}

function searchSpecToCatalogQuery(spec: SearchSpec, limit: number): CatalogQuery {
  return {
    startTime: spec.startTime,
    endTime: spec.endTime,
    kind: spec.kind,
    hasGeo: spec.hasGeo,
    geoBounds: spec.geoBounds,
    sort: spec.order.kind === 'timestamp' ? spec.order.sort : 'timestamp_desc',
    limit,
    offset: spec.offset,
  }
}

function mediaItemsToSearchResults(items: MediaItem[]): SearchPage['items'] {
  return items.map((item) => ({
    item,
    mediaId: item.id,
  }))
}

async function enrichDistanceAssetResults(
  getMediaByAssetIdsFn: (assetIds: number[]) => Promise<AssetMediaResult[]>,
  results: ResidentDistanceSearchResult[],
): Promise<SearchPage['items']> {
  const resultAssetIds = Array.from(new Set(results.map((result) => result.assetId)))
  const items = await getMediaByAssetIdsFn(resultAssetIds)
  const itemsByAssetId = new Map(
    items.map((result) => [result.assetId, result.item]),
  )
  return results.flatMap((result) => {
    const item = itemsByAssetId.get(result.assetId)
    return item
      ? [{ mediaId: item.id, distanceMeters: result.distanceMeters, item }]
      : []
  })
}

async function enrichDistanceResults(
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  results: GeoSearchResult[],
): Promise<SearchPage['items']> {
  const resultIds = Array.from(new Set(results.map((result) => result.mediaId)))
  const items = await getMediaByIdsFn(resultIds)
  const itemsById = new Map(items.map((item) => [item.id, item]))
  return results.flatMap((result) => {
    const item = itemsById.get(result.mediaId)
    return item ? [{ ...result, item }] : []
  })
}

function createFileSearchEngine(
  engineId: FileCatalogIndexId,
  engineLabel: string,
  searchRowsFn: MediaSearchRowsFn,
  ensureIndexReadyFn: EnsureSearchIndexReadyFn,
  isCancelled: CancellationSignal,
): SearchIndexEngine {
  return {
    id: engineId,
    label: engineLabel,
    capabilities: {
      exact: true,
      persistent: true,
      requiresBuild: false,
      supportsTimestampOrder: true,
      supportsDistanceOrder: false,
      supportsGeoBounds: true,
      supportsTimeRange: true,
      supportsKind: true,
    },
    canHandle(spec) {
      if (spec.order.kind !== 'timestamp') return false
      if (spec.order.engineId && spec.order.engineId !== engineId) return false
      return true
    },
    async search(spec) {
      throwIfCancelled(isCancelled)
      const startedAt = performance.now()
      const readyStartedAt = performance.now()
      await ensureIndexReadyFn(engineId)
      const queryIndexReadyMs = performance.now() - readyStartedAt
      throwIfCancelled(isCancelled)
      const limit = Math.max(1, Math.min(spec.limit ?? 500, 10_000))
      const offset = Math.max(0, spec.offset ?? 0)
      const rows = await searchRowsFn(
        searchSpecToCatalogQuery(spec, limit + 1),
        engineId,
        isCancelled,
      )
      throwIfCancelled(isCancelled)
      const limitedRows = rows.items.slice(0, limit)
      const limitReached = rows.items.length > limit
      return {
        items: mediaItemsToSearchResults(limitedRows),
        resultMetrics: withQueryMetrics(
          {
            ...defaultSearchStats(engineId, engineLabel),
            ...rows.metrics,
          },
          spec,
          performance.now() - startedAt,
          limitedRows.length,
          limit,
          offset,
          limitReached,
          {
            ...rows.metrics,
            queryIndexReadyMs,
          },
        ),
        engineId,
        engineLabel,
        limitReached,
      }
    },
    async stats() {
      return defaultSearchStats(engineId, engineLabel)
    },
  }
}

function isResidentDistanceEngineId(indexId: string): indexId is ResidentPackedDistanceEngineId {
  return indexId === 'segmented-ball-tree'
}

function residentDistanceRuntimeKey(indexId: ResidentPackedDistanceEngineId): string {
  return `file:${indexId}`
}

function residentDistanceIndex(
  store: CatalogStore,
  indexId: ResidentPackedDistanceEngineId,
): ResidentPackedDistanceIndex {
  const key = residentDistanceRuntimeKey(indexId)
  const existing = residentDistanceIndexInstances.get(key)
  if (existing) return existing
  const index = new ResidentPackedDistanceIndex(store.residentDistanceIndexStore())
  residentDistanceIndexInstances.set(key, index)
  return index
}

function activeResidentDistanceIndex(indexId: string): ResidentPackedDistanceIndex | undefined {
  if (!isResidentDistanceEngineId(indexId)) return undefined
  return residentDistanceIndexInstances.get(residentDistanceRuntimeKey(indexId))
}

function clearResidentDistanceRuntimeCaches(): void {
  residentDistanceIndexInstances.delete(residentDistanceRuntimeKey('segmented-ball-tree'))
}

function createDistanceSearchEngine(
  geoIndex: (typeof geoIndexRegistry.indexes)[number],
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  getMediaByAssetIdsFn: (assetIds: number[]) => Promise<AssetMediaResult[]>,
  ensureIndexReadyFn: EnsureSearchIndexReadyFn,
  isCancelled: CancellationSignal,
): SearchIndexEngine {
  return {
    id: geoIndex.id,
    label: geoIndex.label,
    capabilities: {
      exact: geoIndex.capabilities.exact,
      persistent: geoIndex.capabilities.persistent,
      requiresBuild: true,
      supportsTimestampOrder: false,
      supportsDistanceOrder: true,
      supportsGeoBounds: true,
      supportsTimeRange: true,
      supportsKind: true,
    },
    canHandle(spec) {
      return spec.order.kind === 'distance'
    },
    async search(spec) {
      if (spec.order.kind !== 'distance') {
        throw new Error(`${geoIndex.label} cannot serve timestamp queries.`)
      }
      throwIfCancelled(isCancelled)
      const limit = Math.max(1, Math.min(spec.limit ?? 500, 10_000))
      const offset = Math.max(0, spec.offset ?? 0)
      const startedAt = performance.now()
      const query = {
        startTime: spec.startTime,
        endTime: spec.endTime,
        lat: spec.order.point.lat,
        lon: spec.order.point.lon,
        k: limit,
        offset: spec.offset,
        kind: spec.kind,
        geoBounds: spec.geoBounds,
      }
      const readyStartedAt = performance.now()
      const activeIndex = isResidentDistanceEngineId(geoIndex.id)
        ? await ensureIndexReadyFn(geoIndex.id).then(() =>
            activeResidentDistanceIndex(geoIndex.id),
          )
        : activeResidentDistanceIndex(geoIndex.id)
      const queryIndexReadyMs = performance.now() - readyStartedAt
      throwIfCancelled(isCancelled)
      if (isResidentDistanceEngineId(geoIndex.id) && !activeIndex) {
        throw new Error(`${geoIndex.label} index is not ready. Update the index before querying.`)
      }
      if (activeIndex) {
        const searchStartedAt = performance.now()
        const results = await activeIndex.search(query)
        const queryIndexScanMs = performance.now() - searchStartedAt
        throwIfCancelled(isCancelled)
        const stats = await activeIndex.stats()
        const assetStartedAt = performance.now()
        const items = await enrichDistanceAssetResults(getMediaByAssetIdsFn, results)
        const queryAssetReadMs = performance.now() - assetStartedAt
        throwIfCancelled(isCancelled)
        const resultMetrics = {
          ...stats,
          engineLabel: activeIndex.label,
          exact: activeIndex.capabilities.exact,
          persistent: activeIndex.capabilities.persistent,
        }
        const limitReached =
          results.length >= limit && resultMetrics.pointCount > offset + limit
        return {
          items,
          resultMetrics: withQueryMetrics(
            resultMetrics,
            spec,
            performance.now() - startedAt,
            items.length,
            limit,
            offset,
            limitReached,
            {
              queryIndexReadyMs,
              queryIndexScanMs,
              queryAssetReadMs,
            },
          ),
          engineId: geoIndex.id,
          engineLabel: geoIndex.label,
          limitReached,
        }
      }
      const searchStartedAt = performance.now()
      const results = await geoIndex.search(query)
      const queryIndexScanMs = performance.now() - searchStartedAt
      throwIfCancelled(isCancelled)
      const stats = await geoIndex.stats()
      const assetStartedAt = performance.now()
      const items = await enrichDistanceResults(getMediaByIdsFn, results)
      const queryAssetReadMs = performance.now() - assetStartedAt
      throwIfCancelled(isCancelled)
      const resultMetrics = {
        ...stats,
        engineLabel: geoIndex.label,
        exact: geoIndex.capabilities.exact,
        persistent: geoIndex.capabilities.persistent,
      }
      const limitReached =
        results.length >= limit && resultMetrics.pointCount > offset + limit
      return {
        items,
        resultMetrics: withQueryMetrics(
          resultMetrics,
          spec,
          performance.now() - startedAt,
          items.length,
          limit,
          offset,
          limitReached,
          {
            queryIndexReadyMs,
            queryIndexScanMs,
            queryAssetReadMs,
          },
        ),
        engineId: geoIndex.id,
        engineLabel: geoIndex.label,
        limitReached,
      }
    },
    async stats() {
      return {
        ...(await geoIndex.stats()),
        engineLabel: geoIndex.label,
        exact: geoIndex.capabilities.exact,
        persistent: geoIndex.capabilities.persistent,
      }
    },
  }
}

function createSearchRegistry(
  searchRowsFn: MediaSearchRowsFn,
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  getMediaByAssetIdsFn: (assetIds: number[]) => Promise<AssetMediaResult[]>,
  ensureIndexReadyFn: EnsureSearchIndexReadyFn,
  isCancelled: CancellationSignal = neverCancelled,
): SearchIndexEngineRegistry {
  return new SearchIndexEngineRegistry([
    createFileSearchEngine(
      'file-time-geo',
      'Time-first packed index',
      searchRowsFn,
      ensureIndexReadyFn,
      isCancelled,
    ),
    ...geoIndexRegistry.indexes.map((index) =>
      createDistanceSearchEngine(
        index,
        getMediaByIdsFn,
        getMediaByAssetIdsFn,
        ensureIndexReadyFn,
        isCancelled,
      ),
    ),
  ])
}

type IndexedAsset = {
  assetId: number
  item: MediaItem
}

export type PackedIndexRecord = {
  timestampSec: number
  latE7: number
  lonE7: number
  assetId: number
  kindFlags: number
  sourceCode?: number
  qualityFlags?: number
  accuracyMeters?: number
  velocityMetersPerSecond?: number
  headingDegrees?: number
  groupHashLo?: number
  groupHashHi?: number
  sequence?: number
}

type PackedIndexMetrics = {
  pagesRead: number
  diskReadBytes: number
  candidatesInspected: number
}

type PackedAssetIdScanPage = {
  assetIds: number[]
  limitReached: boolean
  metrics: PackedIndexMetrics
}

type PackedMapPointScanPage = MapPointPage & {
  metrics: PackedIndexMetrics
  matchedRecords: number
  renderedBubbles: number
  largestBubbleCount: number
  aggregationZoom: number
  aggregationCellSizePx: number
}

type PackedMapPolylineScanPage = MapPointPage & {
  metrics: PackedIndexMetrics
  matchedRecords: number
  sourceLinePoints: number
  acceptedLinePoints: number
  filteredLinePoints: number
  filteredQualityPoints: number
  filteredJumpPoints: number
  lineSpeedBreaks: number
  lineDistanceBreaks: number
  lineSegments: number
  renderedLinePoints: number
  renderedLineDots: number
  simplificationTolerancePx: number
}

type PolylineCandidate = {
  assetId: number
  kind: MapPoint['kind']
  lat: number
  lon: number
  timestampSec: number
  source: 'GPS' | 'WIFI' | 'CELL' | 'UNKNOWN'
  accuracyMeters?: number
  groupKey?: string
  sequence?: number
}

type PolylineCleanup = {
  enabled: boolean
  groupLinesOnly: boolean
  allowedSources: Set<'GPS' | 'WIFI' | 'CELL' | 'UNKNOWN'>
  maxAccuracyMeters?: number
  breakSpeedKmh?: number
  maxSegmentDistanceKm?: number
  removeIsolatedJumps: boolean
  showDots: boolean
}

type PackedMapPointBucket = {
  cellId: string
  count: number
  sumLat: number
  sumLon: number
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
  firstPoint?: MapPoint
}

type PackedMapPointAggregation = {
  zoom: number
  worldSize: number
  cellSizePx: number
  bubbleScale: number
  buckets: Map<string, PackedMapPointBucket>
}

type PackedMapAggregationOptions = NonNullable<SearchSpec['mapAggregation']>

type PackedWorldPixel = {
  x: number
  y: number
}

const WEB_MERCATOR_MAX_LAT = 85.0511287798066
const WEB_MERCATOR_TILE_SIZE = 256

function createMapPointAggregation(
  options: PackedMapAggregationOptions | undefined,
  limit: number,
): PackedMapPointAggregation {
  const zoom = Math.max(0, Math.min(24, Math.floor(options?.zoom ?? 0)))
  const viewportWidthPx = Math.max(1, options?.viewportWidthPx ?? 1024)
  const viewportHeightPx = Math.max(1, options?.viewportHeightPx ?? 768)
  const requestedCellSizePx = Math.max(1, options?.bubbleCellSizePx ?? 64)
  const budgetCellSizePx = Math.sqrt(
    (viewportWidthPx * viewportHeightPx) / Math.max(1, limit),
  )
  const cellSizePx = Math.max(requestedCellSizePx, budgetCellSizePx)
  const bubbleScale = Math.max(0.1, options?.bubbleScale ?? 1)
  return {
    zoom,
    worldSize: WEB_MERCATOR_TILE_SIZE * 2 ** zoom,
    cellSizePx,
    bubbleScale,
    buckets: new Map(),
  }
}

function lonLatToWorldPixel(
  lon: number,
  lat: number,
  worldSize: number,
): PackedWorldPixel {
  const clampedLat = Math.max(
    -WEB_MERCATOR_MAX_LAT,
    Math.min(WEB_MERCATOR_MAX_LAT, lat),
  )
  const clampedLon = Math.max(-180, Math.min(180, lon))
  const sinLat = Math.sin((clampedLat * Math.PI) / 180)
  return {
    x: ((clampedLon + 180) / 360) * worldSize,
    y:
      (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) *
      worldSize,
  }
}

type PolylineAccumulator = {
  lat: Float64Array
  lon: Float64Array
  x: Float64Array
  y: Float64Array
  count: number
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

function createPolylineAccumulator(capacity = 1024): PolylineAccumulator {
  return {
    lat: new Float64Array(capacity),
    lon: new Float64Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    count: 0,
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLon: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
  }
}

function ensurePolylineCapacity(
  accumulator: PolylineAccumulator,
  nextCount: number,
): void {
  if (nextCount <= accumulator.lat.length) return

  let nextCapacity = accumulator.lat.length
  while (nextCapacity < nextCount) nextCapacity *= 2
  const grow = (current: Float64Array) => {
    const next = new Float64Array(nextCapacity)
    next.set(current)
    return next
  }
  accumulator.lat = grow(accumulator.lat)
  accumulator.lon = grow(accumulator.lon)
  accumulator.x = grow(accumulator.x)
  accumulator.y = grow(accumulator.y)
}

function addPolylinePoint(
  accumulator: PolylineAccumulator,
  lat: number,
  lon: number,
  worldSize: number,
): void {
  ensurePolylineCapacity(accumulator, accumulator.count + 1)
  const pixel = lonLatToWorldPixel(lon, lat, worldSize)
  const index = accumulator.count
  accumulator.lat[index] = lat
  accumulator.lon[index] = lon
  accumulator.x[index] = pixel.x
  accumulator.y[index] = pixel.y
  accumulator.count += 1
  accumulator.minLat = Math.min(accumulator.minLat, lat)
  accumulator.maxLat = Math.max(accumulator.maxLat, lat)
  accumulator.minLon = Math.min(accumulator.minLon, lon)
  accumulator.maxLon = Math.max(accumulator.maxLon, lon)
}

function simplifyPolyline(
  accumulator: PolylineAccumulator,
  requestedTolerancePx: number,
  _maxPoints: number,
  isCancelled: CancellationSignal,
): { indices: number[]; tolerancePx: number } {
  throwIfCancelled(isCancelled)
  return {
    indices: Array.from({ length: accumulator.count }, (_, index) => index),
    tolerancePx: Math.max(0, requestedTolerancePx),
  }
}

function normalizePolylineCleanup(
  mapPolyline: SearchSpec['mapPolyline'] | undefined,
): PolylineCleanup {
  const cleanup = mapPolyline?.cleanup
  return {
    enabled: cleanup?.enabled === true,
    groupLinesOnly: true,
    allowedSources: new Set(
      cleanup?.allowedSources?.length
        ? cleanup.allowedSources
        : ['GPS', 'WIFI', 'CELL', 'UNKNOWN'],
    ),
    maxAccuracyMeters:
      typeof cleanup?.maxAccuracyMeters === 'number' &&
      Number.isFinite(cleanup.maxAccuracyMeters)
        ? cleanup.maxAccuracyMeters
        : undefined,
    breakSpeedKmh:
      typeof cleanup?.breakSpeedKmh === 'number' &&
      Number.isFinite(cleanup.breakSpeedKmh)
        ? cleanup.breakSpeedKmh
        : undefined,
    maxSegmentDistanceKm:
      typeof cleanup?.maxSegmentDistanceKm === 'number' &&
      Number.isFinite(cleanup.maxSegmentDistanceKm) &&
      cleanup.maxSegmentDistanceKm > 0
        ? cleanup.maxSegmentDistanceKm
        : undefined,
    removeIsolatedJumps: cleanup?.removeIsolatedJumps === true,
    showDots: cleanup?.showDots !== false,
  }
}

function groupKeyFromRecord(record: PackedIndexRecord): string | undefined {
  if ((record.qualityFlags ?? 0) & LINE_QUALITY_HAS_GROUP) {
    return `${record.groupHashHi ?? 0}:${record.groupHashLo ?? 0}`
  }
  return undefined
}

function recordAccuracy(record: PackedIndexRecord): number | undefined {
  return (record.qualityFlags ?? 0) & LINE_QUALITY_HAS_ACCURACY &&
    typeof record.accuracyMeters === 'number' &&
    Number.isFinite(record.accuracyMeters)
    ? record.accuracyMeters
    : undefined
}

function recordSequence(record: PackedIndexRecord): number | undefined {
  const sequence = record.sequence
  return (record.qualityFlags ?? 0) & LINE_QUALITY_HAS_SEQUENCE &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
    ? sequence
    : undefined
}

function lineCandidateFromRecord(record: PackedIndexRecord): PolylineCandidate {
  return {
    assetId: record.assetId,
    kind: kindFromFlags(record.kindFlags),
    lat: coordinateFromE7(record.latE7),
    lon: coordinateFromE7(record.lonE7),
    timestampSec: record.timestampSec,
    source: lineSourceFromCode(record.sourceCode ?? LINE_SOURCE_UNKNOWN),
    accuracyMeters: recordAccuracy(record),
    groupKey: groupKeyFromRecord(record),
    sequence: recordSequence(record),
  }
}

function candidatePassesQualityFilter(
  candidate: PolylineCandidate,
  cleanup: PolylineCleanup,
): boolean {
  if (!cleanup.enabled) return true
  if (!cleanup.allowedSources.has(candidate.source)) return false
  if (
    cleanup.maxAccuracyMeters !== undefined &&
    candidate.accuracyMeters !== undefined &&
    candidate.accuracyMeters > cleanup.maxAccuracyMeters
  ) {
    return false
  }
  return true
}

function mapPointFromCandidate(candidate: PolylineCandidate): MapPoint {
  return {
    assetId: candidate.assetId,
    kind: candidate.kind,
    lat: candidate.lat,
    lon: candidate.lon,
    timestamp: candidate.timestampSec * 1000,
    count: 1,
  }
}

function speedKmh(left: PolylineCandidate, right: PolylineCandidate): number {
  const seconds = right.timestampSec - left.timestampSec
  if (seconds <= 0) return 0
  return (haversineMeters(left.lat, left.lon, right.lat, right.lon) / seconds) * 3.6
}

function removeIsolatedJumps(
  candidates: PolylineCandidate[],
  breakSpeedKmh: number | undefined,
): { candidates: PolylineCandidate[]; removed: number } {
  if (breakSpeedKmh === undefined || candidates.length < 3) {
    return { candidates, removed: 0 }
  }
  const kept: PolylineCandidate[] = [candidates[0]]
  let removed = 0
  for (let index = 1; index < candidates.length - 1; index += 1) {
    const previous = candidates[index - 1]
    const current = candidates[index]
    const next = candidates[index + 1]
    if (
      speedKmh(previous, current) > breakSpeedKmh &&
      speedKmh(current, next) > breakSpeedKmh &&
      speedKmh(previous, next) <= breakSpeedKmh
    ) {
      removed += 1
      continue
    }
    kept.push(current)
  }
  kept.push(candidates[candidates.length - 1])
  return { candidates: kept, removed }
}

function splitBySpeed(
  candidates: PolylineCandidate[],
  breakSpeedKmh: number | undefined,
): { segments: PolylineCandidate[][]; breaks: number } {
  if (candidates.length === 0) return { segments: [], breaks: 0 }
  if (breakSpeedKmh === undefined || candidates.length < 2) {
    return { segments: [candidates], breaks: 0 }
  }
  const segments: PolylineCandidate[][] = []
  let current: PolylineCandidate[] = [candidates[0]]
  let breaks = 0
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    if (speedKmh(candidates[index - 1], candidate) > breakSpeedKmh) {
      if (current.length > 0) segments.push(current)
      current = [candidate]
      breaks += 1
    } else {
      current.push(candidate)
    }
  }
  if (current.length > 0) segments.push(current)
  return { segments, breaks }
}

function splitByMaxSegmentDistance(
  candidates: PolylineCandidate[],
  maxSegmentDistanceKm: number | undefined,
): { segments: PolylineCandidate[][]; breaks: number } {
  if (candidates.length === 0) return { segments: [], breaks: 0 }
  if (maxSegmentDistanceKm === undefined || candidates.length < 2) {
    return { segments: [candidates], breaks: 0 }
  }
  const maxSegmentDistanceMeters = maxSegmentDistanceKm * 1000
  const segments: PolylineCandidate[][] = []
  let current: PolylineCandidate[] = [candidates[0]]
  let breaks = 0
  for (let index = 1; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const previous = candidates[index - 1]
    if (
      haversineMeters(previous.lat, previous.lon, candidate.lat, candidate.lon) >
      maxSegmentDistanceMeters
    ) {
      if (current.length > 0) segments.push(current)
      current = [candidate]
      breaks += 1
    } else {
      current.push(candidate)
    }
  }
  if (current.length > 0) segments.push(current)
  return { segments, breaks }
}

function flushSequenceRun(
  groupKey: string,
  run: PolylineCandidate[],
  lineSegments: Array<{ groupKey: string; candidates: PolylineCandidate[] }>,
  dotPoints: MapPoint[],
): void {
  if (run.length >= 2) {
    lineSegments.push({ groupKey, candidates: run })
    return
  }
  if (run.length === 1) dotPoints.push(mapPointFromCandidate(run[0]))
}

function splitGroupByConsecutiveSequence(
  groupKey: string,
  candidates: PolylineCandidate[],
): {
  lineSegments: Array<{ groupKey: string; candidates: PolylineCandidate[] }>
  dotPoints: MapPoint[]
} {
  const lineSegments: Array<{ groupKey: string; candidates: PolylineCandidate[] }> = []
  const dotPoints: MapPoint[] = []
  const sorted = [...candidates].sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) -
        (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.timestampSec - right.timestampSec ||
      left.assetId - right.assetId,
  )
  let currentRun: PolylineCandidate[] = []

  for (const candidate of sorted) {
    if (candidate.sequence === undefined) {
      flushSequenceRun(groupKey, currentRun, lineSegments, dotPoints)
      currentRun = []
      dotPoints.push(mapPointFromCandidate(candidate))
      continue
    }

    const previous = currentRun[currentRun.length - 1]
    if (
      previous &&
      previous.sequence !== undefined &&
      candidate.sequence !== previous.sequence + 1
    ) {
      flushSequenceRun(groupKey, currentRun, lineSegments, dotPoints)
      currentRun = []
    }
    currentRun.push(candidate)
  }

  flushSequenceRun(groupKey, currentRun, lineSegments, dotPoints)
  return { lineSegments, dotPoints }
}

function accumulatorFromCandidates(
  candidates: PolylineCandidate[],
  worldSize: number,
): PolylineAccumulator {
  const accumulator = createPolylineAccumulator(Math.max(2, candidates.length))
  for (const candidate of candidates) {
    addPolylinePoint(accumulator, candidate.lat, candidate.lon, worldSize)
  }
  return accumulator
}

function polylineFromCandidateSegments(
  candidateSegments: Array<{ groupKey?: string; candidates: PolylineCandidate[] }>,
  requestedTolerancePx: number,
  _maxPoints: number,
  worldSize: number,
  isCancelled: CancellationSignal,
): MapPolyline {
  const nonEmptySegments = candidateSegments.filter((segment) => segment.candidates.length >= 2)
  if (nonEmptySegments.length === 0) {
    return {
      points: [],
      segments: [],
      sourcePointCount: candidateSegments.reduce(
        (total, segment) => total + segment.candidates.length,
        0,
      ),
      simplifiedPointCount: 0,
      tolerancePx: requestedTolerancePx,
    }
  }

  const tolerancePx = Math.max(0, requestedTolerancePx)
  const renderedSegments: NonNullable<MapPolyline['segments']> = []
  const flattened: MapPolyline['points'] = []
  for (const segment of nonEmptySegments) {
    throwIfCancelled(isCancelled)
    const accumulator = accumulatorFromCandidates(segment.candidates, worldSize)
    const { indices } = simplifyPolyline(
      accumulator,
      tolerancePx,
      Number.MAX_SAFE_INTEGER,
      isCancelled,
    )
    const points = indices.map((index) => ({
      lat: accumulator.lat[index],
      lon: accumulator.lon[index],
    }))
    if (points.length >= 2) {
      renderedSegments.push({ points, groupKey: segment.groupKey })
      flattened.push(...points)
    }
  }

  const sourcePointCount = nonEmptySegments.reduce(
    (total, segment) => total + segment.candidates.length,
    0,
  )
  const bounds =
    flattened.length > 0
      ? flattened.reduce<GeoBounds>(
          (current, point) => ({
            minLat: Math.min(current.minLat, point.lat),
            maxLat: Math.max(current.maxLat, point.lat),
            minLon: Math.min(current.minLon, point.lon),
            maxLon: Math.max(current.maxLon, point.lon),
          }),
          {
            minLat: Number.POSITIVE_INFINITY,
            maxLat: Number.NEGATIVE_INFINITY,
            minLon: Number.POSITIVE_INFINITY,
            maxLon: Number.NEGATIVE_INFINITY,
          },
        )
      : undefined

  return {
    points: flattened,
    segments: renderedSegments,
    bounds,
    sourcePointCount,
    simplifiedPointCount: flattened.length,
    tolerancePx,
  }
}

// Cluster bubble radii in CSS pixels, mirroring mapPointStyle() in
// components/MapView.tsx (circle radius + stroke). Used to detect when two
// rendered bubbles overlap so they can be merged.
const BUBBLE_STROKE_PX = 2
const SINGLE_POINT_RADIUS_PX = 8

function bubbleRadiusForCount(count: number, scale: number): number {
  if (count <= 1) return SINGLE_POINT_RADIUS_PX * scale + BUBBLE_STROKE_PX
  const radius = count >= 1_000 ? 18 : count >= 100 ? 15 : count >= 10 ? 12 : 10
  return radius * scale + BUBBLE_STROKE_PX
}

// Upper bound on any bubble radius, used to size the collision spatial hash.
function maxBubbleRadius(scale: number): number {
  return bubbleRadiusForCount(Number.MAX_SAFE_INTEGER, scale)
}

function mapPointBucket(
  aggregation: PackedMapPointAggregation,
  point: MapPoint,
): string {
  const pixel = lonLatToWorldPixel(point.lon, point.lat, aggregation.worldSize)
  const cellsPerRow = Math.max(
    1,
    Math.ceil(aggregation.worldSize / aggregation.cellSizePx),
  )
  const cellX = Math.max(
    0,
    Math.min(cellsPerRow - 1, Math.floor(pixel.x / aggregation.cellSizePx)),
  )
  const cellY = Math.max(
    0,
    Math.min(cellsPerRow - 1, Math.floor(pixel.y / aggregation.cellSizePx)),
  )
  return `${aggregation.zoom}/${cellX}/${cellY}`
}

function addMapPointToAggregation(
  aggregation: PackedMapPointAggregation,
  point: MapPoint,
): number {
  const cellId = mapPointBucket(aggregation, point)
  const bucket = aggregation.buckets.get(cellId)
  if (bucket) {
    bucket.count += 1
    bucket.sumLat += point.lat
    bucket.sumLon += point.lon
    bucket.minLat = Math.min(bucket.minLat, point.lat)
    bucket.maxLat = Math.max(bucket.maxLat, point.lat)
    bucket.minLon = Math.min(bucket.minLon, point.lon)
    bucket.maxLon = Math.max(bucket.maxLon, point.lon)
    return bucket.count
  }

  aggregation.buckets.set(cellId, {
    cellId,
    count: 1,
    sumLat: point.lat,
    sumLon: point.lon,
    minLat: point.lat,
    maxLat: point.lat,
    minLon: point.lon,
    maxLon: point.lon,
    firstPoint: point,
  })
  return 1
}

function mergeBuckets(
  target: PackedMapPointBucket,
  source: PackedMapPointBucket,
): void {
  target.count += source.count
  target.sumLat += source.sumLat
  target.sumLon += source.sumLon
  target.minLat = Math.min(target.minLat, source.minLat)
  target.maxLat = Math.max(target.maxLat, source.maxLat)
  target.minLon = Math.min(target.minLon, source.minLon)
  target.maxLon = Math.max(target.maxLon, source.maxLon)
  // A merged cluster no longer represents a single openable media item.
  target.firstPoint = undefined
}

// Grid binning splits points along hard cell boundaries, so two clusters either
// side of a boundary can render on top of each other. Repeatedly merge any
// clusters whose rendered circles overlap, re-placing the result at the
// count-weighted centroid of its members. Merging grows a cluster's radius and
// can create new overlaps, so iterate until a pass merges nothing.
function mergeOverlappingClusters(
  clusters: PackedMapPointBucket[],
  worldSize: number,
  bubbleScale: number,
): PackedMapPointBucket[] {
  let current = clusters
  while (current.length > 1) {
    const n = current.length
    const px = new Float64Array(n)
    const py = new Float64Array(n)
    const radius = new Float64Array(n)
    for (let i = 0; i < n; i += 1) {
      const cluster = current[i]
      const pixel = lonLatToWorldPixel(
        cluster.sumLon / cluster.count,
        cluster.sumLat / cluster.count,
        worldSize,
      )
      px[i] = pixel.x
      py[i] = pixel.y
      radius[i] = bubbleRadiusForCount(cluster.count, bubbleScale)
    }

    const parent = new Int32Array(n)
    for (let i = 0; i < n; i += 1) parent[i] = i
    const find = (value: number): number => {
      let root = value
      while (parent[root] !== root) root = parent[root]
      while (parent[value] !== root) {
        const next = parent[value]
        parent[value] = root
        value = next
      }
      return root
    }

    // Any overlapping pair is closer than 2*MAX_BUBBLE_RADIUS_PX, so a spatial
    // hash with that cell size only needs to compare each bubble with its 3x3
    // neighbourhood. Each bubble is inserted after it is queried, so every
    // unordered pair is considered exactly once.
    const gridSize = 2 * maxBubbleRadius(bubbleScale)
    const grid = new Map<string, number[]>()
    let merged = false
    for (let i = 0; i < n; i += 1) {
      const gx = Math.floor(px[i] / gridSize)
      const gy = Math.floor(py[i] / gridSize)
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const neighbours = grid.get(`${gx + dx}/${gy + dy}`)
          if (!neighbours) continue
          for (const j of neighbours) {
            if (find(i) === find(j)) continue
            const dist = Math.hypot(px[i] - px[j], py[i] - py[j])
            if (dist < radius[i] + radius[j]) {
              parent[find(i)] = find(j)
              merged = true
            }
          }
        }
      }
      const key = `${gx}/${gy}`
      const own = grid.get(key)
      if (own) own.push(i)
      else grid.set(key, [i])
    }

    if (!merged) break

    const groups = new Map<number, PackedMapPointBucket>()
    for (let i = 0; i < n; i += 1) {
      const root = find(i)
      const existing = groups.get(root)
      if (existing) mergeBuckets(existing, current[i])
      else groups.set(root, { ...current[i] })
    }
    current = [...groups.values()]
  }
  return current
}

function aggregatedMapPoints(aggregation: PackedMapPointAggregation): MapPoint[] {
  const clusters = mergeOverlappingClusters(
    [...aggregation.buckets.values()],
    aggregation.worldSize,
    aggregation.bubbleScale,
  )
  return clusters.map((cluster) => {
    if (cluster.count === 1 && cluster.firstPoint) {
      return {
        ...cluster.firstPoint,
        cellId: cluster.cellId,
        count: 1,
        bounds: {
          minLat: cluster.minLat,
          maxLat: cluster.maxLat,
          minLon: cluster.minLon,
          maxLon: cluster.maxLon,
        },
      }
    }

    // Natural placement at the count-weighted centroid of the cluster's members.
    // Overlaps have already been resolved by mergeOverlappingClusters.
    return {
      cellId: cluster.cellId,
      lat: cluster.sumLat / cluster.count,
      lon: cluster.sumLon / cluster.count,
      count: cluster.count,
      bounds: {
        minLat: cluster.minLat,
        maxLat: cluster.maxLat,
        minLon: cluster.minLon,
        maxLon: cluster.maxLon,
      },
    }
  })
}

type PackedIndexHeader = {
  catalogVersion: number
  assetCount: number
  entryCount: number
  indexSizeBytes: number
  kind: number
  recordSize: number
}

type AssetTableMetrics = {
  diskReadBytes: number
  diskReadCount: number
}

type AssetRecordEntry = {
  assetId: number
  chunkId: number
  recordOffset: number
  recordLength: number
}

export class AssetTable {
  private readonly assetsDir: FileSystemDirectoryHandle
  private readonly header: { catalogVersion: number; count: number; entrySize: number }
  private readonly recordIndexFile: File

  constructor(
    assetsDir: FileSystemDirectoryHandle,
    header: { catalogVersion: number; count: number; entrySize: number },
    recordIndexFile: File,
  ) {
    this.assetsDir = assetsDir
    this.header = header
    this.recordIndexFile = recordIndexFile
  }

  static async open(
    assetsDir: FileSystemDirectoryHandle,
  ): Promise<AssetTable | undefined> {
    const recordIndexFile = await readFile(assetsDir, ASSET_RECORD_INDEX_FILE)
    if (!recordIndexFile) return undefined
    const header = readBinaryHeader(
      await readFileRange(recordIndexFile, 0, ASSET_TABLE_HEADER_SIZE),
      ASSET_TABLE_MAGIC,
    )
    if (!header || header.entrySize !== ASSET_RECORD_INDEX_ENTRY_SIZE) return undefined
    return new AssetTable(assetsDir, header, recordIndexFile)
  }

  get count(): number {
    return this.header.count
  }

  get catalogVersion(): number {
    return this.header.catalogVersion
  }

  async read(assetId: number): Promise<{ item?: MediaItem; metrics: AssetTableMetrics }> {
    if (assetId < 0 || assetId >= this.header.count) {
      return { metrics: { diskReadBytes: 0, diskReadCount: 0 } }
    }
    const indexOffset =
      ASSET_TABLE_HEADER_SIZE + assetId * ASSET_RECORD_INDEX_ENTRY_SIZE
    const entryBuffer = await readFileRange(
      this.recordIndexFile,
      indexOffset,
      ASSET_RECORD_INDEX_ENTRY_SIZE,
    )
    const entry = new DataView(entryBuffer)
    const chunkId = entry.getUint32(0, true)
    const recordOffset = entry.getUint32(4, true)
    const recordLength = entry.getUint32(8, true)
    if (recordLength === 0) {
      return {
        metrics: {
          diskReadBytes: ASSET_RECORD_INDEX_ENTRY_SIZE,
          diskReadCount: 1,
        },
      }
    }
    const chunkName = `${ASSET_CHUNK_PREFIX}${String(chunkId).padStart(6, '0')}${ASSET_BINARY_CHUNK_EXTENSION}`
    const chunkFile = await readFile(this.assetsDir, chunkName)
    if (!chunkFile) {
      return {
        metrics: {
          diskReadBytes: ASSET_RECORD_INDEX_ENTRY_SIZE,
          diskReadCount: 1,
        },
      }
    }
    const payload = await readFileRange(chunkFile, recordOffset + 4, recordLength)
    const item = mediaFromUnknown(
      JSON.parse(textDecoder.decode(new Uint8Array(payload))) as unknown,
    )
    return {
      item,
      metrics: {
        diskReadBytes: ASSET_RECORD_INDEX_ENTRY_SIZE + recordLength,
        diskReadCount: 2,
      },
    }
  }

  async readMany(assetIds: Iterable<number>): Promise<{
    items: MediaItem[]
    metrics: AssetTableMetrics
  }> {
    const result = await this.readByAssetIds([...assetIds])
    return {
      items: result.items.map(({ item }) => item),
      metrics: result.metrics,
    }
  }

  async readByAssetIds(assetIds: readonly number[]): Promise<{
    items: AssetMediaResult[]
    metrics: AssetTableMetrics
  }> {
    const metrics = { diskReadBytes: 0, diskReadCount: 0 }
    const validIds = Array.from(
      new Set(
        assetIds.filter((assetId) =>
          Number.isSafeInteger(assetId) &&
          assetId >= 0 &&
          assetId < this.header.count,
        ),
      ),
    ).sort((left, right) => left - right)
    if (validIds.length === 0) return { items: [], metrics }

    const entries: AssetRecordEntry[] = []
    for (let rangeStartIndex = 0; rangeStartIndex < validIds.length;) {
      const firstAssetId = validIds[rangeStartIndex]
      let rangeEndIndex = rangeStartIndex + 1
      while (
        rangeEndIndex < validIds.length &&
        validIds[rangeEndIndex] === validIds[rangeEndIndex - 1] + 1
      ) {
        rangeEndIndex += 1
      }

      const count = rangeEndIndex - rangeStartIndex
      const indexOffset =
        ASSET_TABLE_HEADER_SIZE + firstAssetId * ASSET_RECORD_INDEX_ENTRY_SIZE
      const entryBuffer = await readFileRange(
        this.recordIndexFile,
        indexOffset,
        count * ASSET_RECORD_INDEX_ENTRY_SIZE,
      )
      metrics.diskReadBytes += entryBuffer.byteLength
      metrics.diskReadCount += 1
      const entryView = new DataView(entryBuffer)
      for (let offset = 0; offset < count; offset += 1) {
        const recordOffset = offset * ASSET_RECORD_INDEX_ENTRY_SIZE
        const recordLength = entryView.getUint32(recordOffset + 8, true)
        if (recordLength === 0) continue
        entries.push({
          assetId: firstAssetId + offset,
          chunkId: entryView.getUint32(recordOffset, true),
          recordOffset: entryView.getUint32(recordOffset + 4, true),
          recordLength,
        })
      }
      rangeStartIndex = rangeEndIndex
    }

    const entriesByChunk = new Map<number, AssetRecordEntry[]>()
    for (const entry of entries) {
      const chunkEntries = entriesByChunk.get(entry.chunkId) ?? []
      chunkEntries.push(entry)
      entriesByChunk.set(entry.chunkId, chunkEntries)
    }

    const itemByAssetId = new Map<number, MediaItem>()
    for (const [chunkId, chunkEntries] of entriesByChunk) {
      const chunkName = `${ASSET_CHUNK_PREFIX}${String(chunkId).padStart(6, '0')}${ASSET_BINARY_CHUNK_EXTENSION}`
      const chunkFile = await readFile(this.assetsDir, chunkName)
      if (!chunkFile) continue
      const bytes = new Uint8Array(await chunkFile.arrayBuffer())
      metrics.diskReadBytes += bytes.byteLength
      metrics.diskReadCount += 1
      for (const entry of chunkEntries) {
        const payloadOffset = entry.recordOffset + 4
        const payloadEnd = payloadOffset + entry.recordLength
        if (payloadOffset < 0 || payloadEnd > bytes.byteLength) continue
        const item = mediaFromUnknown(
          JSON.parse(textDecoder.decode(bytes.slice(payloadOffset, payloadEnd))) as unknown,
        )
        if (item) itemByAssetId.set(entry.assetId, item)
      }
    }

    return {
      items: assetIds.flatMap((assetId) => {
        const item = itemByAssetId.get(assetId)
        return item ? [{ assetId, item }] : []
      }),
      metrics,
    }
  }

  async *scan(): AsyncGenerator<IndexedAsset> {
    let assetId = 0
    for (let chunkId = 0; assetId < this.header.count; chunkId += 1) {
      const chunkName = `${ASSET_CHUNK_PREFIX}${String(chunkId).padStart(6, '0')}${ASSET_BINARY_CHUNK_EXTENSION}`
      const chunkFile = await readFile(this.assetsDir, chunkName)
      if (!chunkFile) break
      const bytes = new Uint8Array(await chunkFile.arrayBuffer())
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let offset = 0
      while (offset + 4 <= bytes.byteLength && assetId < this.header.count) {
        const length = view.getUint32(offset, true)
        offset += 4
        if (length === 0 || offset + length > bytes.byteLength) break
        const item = mediaFromUnknown(
          JSON.parse(textDecoder.decode(bytes.slice(offset, offset + length))) as unknown,
        )
        if (item) yield { assetId, item }
        assetId += 1
        offset += length
      }
      await yieldToEventLoop()
    }
  }
}

class AssetIdMap {
  private readonly header: { catalogVersion: number; count: number; entrySize: number }
  private readonly file: File

  constructor(
    header: { catalogVersion: number; count: number; entrySize: number },
    file: File,
  ) {
    this.header = header
    this.file = file
  }

  static async open(assetsDir: FileSystemDirectoryHandle): Promise<AssetIdMap | undefined> {
    const file = await readFile(assetsDir, ASSET_ID_MAP_FILE)
    if (!file) return undefined
    const header = readBinaryHeader(
      await readFileRange(file, 0, ASSET_ID_MAP_HEADER_SIZE),
      ASSET_ID_MAP_MAGIC,
    )
    if (!header || header.entrySize !== ASSET_ID_MAP_ENTRY_SIZE) return undefined
    return new AssetIdMap(header, file)
  }

  async findAssetId(contentHash: string): Promise<number | undefined> {
    const target = encodeHashKey(contentHash)
    let low = 0
    let high = this.header.count - 1
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const offset = ASSET_ID_MAP_HEADER_SIZE + middle * ASSET_ID_MAP_ENTRY_SIZE
      const bytes = new Uint8Array(await readFileRange(this.file, offset, ASSET_ID_MAP_ENTRY_SIZE))
      const key = bytes.slice(0, 64)
      const comparison = compareHashBytes(key, target)
      if (comparison === 0) {
        return getUint64(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 64)
      }
      if (comparison < 0) low = middle + 1
      else high = middle - 1
    }
    return undefined
  }
}

function expectedPackedRecordSize(kind: number): number {
  return kind === INDEX_KIND_TIME_GEO ? TIME_GEO_RECORD_SIZE : 0
}

export function encodeTimeGeoIndexForTests(
  records: PackedIndexRecord[],
  options: { catalogVersion?: number; assetCount?: number; indexAppliedVersion?: number } = {},
): ArrayBuffer {
  const sortedRecords = [...records].sort((a, b) =>
    a.timestampSec - b.timestampSec || a.assetId - b.assetId,
  )
  const bytes = new Uint8Array(
    PACKED_INDEX_HEADER_SIZE + sortedRecords.length * TIME_GEO_RECORD_SIZE,
  )
  const view = new DataView(bytes.buffer)
  view.setUint32(0, PACKED_INDEX_MAGIC, true)
  view.setUint32(4, BINARY_SCHEMA_VERSION, true)
  view.setFloat64(8, options.catalogVersion ?? 1, true)
  view.setFloat64(16, options.assetCount ?? sortedRecords.length, true)
  view.setFloat64(24, sortedRecords.length, true)
  view.setUint32(32, 0, true)
  view.setUint32(36, TIME_GEO_RECORD_SIZE, true)
  view.setUint32(40, INDEX_KIND_TIME_GEO, true)
  view.setUint32(44, 0, true)
  view.setUint32(48, 0, true)
  view.setFloat64(56, PACKED_INDEX_HEADER_SIZE, true)
  view.setFloat64(80, options.indexAppliedVersion ?? options.catalogVersion ?? 1, true)
  for (let index = 0; index < sortedRecords.length; index += 1) {
    const record = sortedRecords[index]
    const offset = PACKED_INDEX_HEADER_SIZE + index * TIME_GEO_RECORD_SIZE
    view.setUint32(offset, record.timestampSec, true)
    view.setInt32(offset + 4, record.latE7, true)
    view.setInt32(offset + 8, record.lonE7, true)
    view.setUint32(offset + 12, record.assetId, true)
    view.setUint8(offset + 16, record.kindFlags)
    view.setUint8(offset + 17, record.sourceCode ?? LINE_SOURCE_UNKNOWN)
    view.setUint16(offset + 18, record.qualityFlags ?? 0, true)
    view.setFloat32(offset + 20, record.accuracyMeters ?? Number.NaN, true)
    view.setFloat32(offset + 24, record.velocityMetersPerSecond ?? Number.NaN, true)
    view.setFloat32(offset + 28, record.headingDegrees ?? Number.NaN, true)
    view.setUint32(offset + 32, record.groupHashLo ?? 0, true)
    view.setUint32(offset + 36, record.groupHashHi ?? 0, true)
    view.setInt32(offset + 40, record.sequence ?? -1, true)
  }
  return bytes.buffer
}

export const catalogWorkerTestConstants = {
  ASSET_BINARY_CHUNK_EXTENSION,
  ASSET_CHUNK_PREFIX,
  ASSET_CHUNK_SIZE,
  ASSET_ID_MAP_ENTRY_SIZE,
  ASSET_ID_MAP_FILE,
  ASSET_ID_MAP_HEADER_SIZE,
  ASSET_ID_MAP_MAGIC,
  ASSET_RECORD_INDEX_ENTRY_SIZE,
  ASSET_RECORD_INDEX_FILE,
  ASSET_TABLE_HEADER_SIZE,
  ASSET_TABLE_MAGIC,
  BINARY_SCHEMA_VERSION,
  INDEX_KIND_TIME_GEO,
  KIND_CODE_GEO_POINT,
  KIND_CODE_TIMELINE_VISIT,
  KIND_CODE_TIMELINE_ACTIVITY,
  KIND_CODE_ACTIVITY_SAMPLE,
  KIND_CODE_FREQUENT_PLACE,
  KIND_FLAG_HAS_GEO,
  KIND_CODE_IMAGE,
  KIND_CODE_VIDEO,
  LINE_SOURCE_UNKNOWN,
  LINE_SOURCE_GPS,
  LINE_SOURCE_WIFI,
  LINE_SOURCE_CELL,
  LINE_QUALITY_HAS_ACCURACY,
  LINE_QUALITY_HAS_GROUP,
  LINE_QUALITY_HAS_SEQUENCE,
  PACKED_INDEX_HEADER_SIZE,
  PACKED_INDEX_MAGIC,
  TIME_GEO_RECORD_SIZE,
} as const

function parsePackedIndexHeader(
  bytes: ArrayBuffer,
  expectedKind: number,
  indexSizeBytes: number,
): PackedIndexHeader | undefined {
  if (bytes.byteLength < PACKED_INDEX_HEADER_SIZE) return undefined
  const header = new DataView(bytes)
  if (header.getUint32(0, true) !== PACKED_INDEX_MAGIC) return undefined
  if (header.getUint32(4, true) !== BINARY_SCHEMA_VERSION) return undefined
  const kind = header.getUint32(40, true)
  if (kind !== expectedKind) return undefined
  const recordSize = header.getUint32(36, true)
  if (recordSize !== expectedPackedRecordSize(expectedKind)) return undefined
  const catalogVersion = header.getFloat64(8, true)
  const assetCount = header.getFloat64(16, true)
  const entryCount = header.getFloat64(24, true)
  if (
    !Number.isSafeInteger(catalogVersion) ||
    !Number.isSafeInteger(assetCount) ||
    !Number.isSafeInteger(entryCount) ||
    catalogVersion < 0 ||
    assetCount < 0 ||
    entryCount < 0
  ) {
    return undefined
  }
  const expectedByteLength = PACKED_INDEX_HEADER_SIZE + entryCount * recordSize
  if (indexSizeBytes !== expectedByteLength) return undefined
  return {
    catalogVersion,
    assetCount,
    entryCount,
    indexSizeBytes,
    kind,
    recordSize,
  }
}

export class ResidentPackedGeoIndex {
  readonly catalogVersion: number
  readonly assetCount: number
  readonly entryCount: number
  readonly indexSizeBytes: number
  readonly kind: number
  readonly recordSize: number
  readonly bytes: ArrayBuffer
  private readonly view: DataView

  constructor(header: PackedIndexHeader, bytes: ArrayBuffer) {
    this.catalogVersion = header.catalogVersion
    this.assetCount = header.assetCount
    this.entryCount = header.entryCount
    this.indexSizeBytes = header.indexSizeBytes
    this.kind = header.kind
    this.recordSize = header.recordSize
    this.bytes = bytes
    this.view = new DataView(bytes)
  }

  static fromArrayBuffer(
    bytes: ArrayBuffer,
    expectedKind: number,
  ): ResidentPackedGeoIndex | undefined {
    const header = parsePackedIndexHeader(bytes, expectedKind, bytes.byteLength)
    return header ? new ResidentPackedGeoIndex(header, bytes) : undefined
  }

  private recordOffset(index: number): number {
    return PACKED_INDEX_HEADER_SIZE + index * this.recordSize
  }

  private readRecord(offset: number): PackedIndexRecord {
    return {
      timestampSec: this.view.getUint32(offset, true),
      latE7: this.view.getInt32(offset + 4, true),
      lonE7: this.view.getInt32(offset + 8, true),
      assetId: this.view.getUint32(offset + 12, true),
      kindFlags: this.view.getUint8(offset + 16),
      sourceCode: this.view.getUint8(offset + 17),
      qualityFlags: this.view.getUint16(offset + 18, true),
      accuracyMeters: this.view.getFloat32(offset + 20, true),
      velocityMetersPerSecond: this.view.getFloat32(offset + 24, true),
      headingDegrees: this.view.getFloat32(offset + 28, true),
      groupHashLo: this.view.getUint32(offset + 32, true),
      groupHashHi: this.view.getUint32(offset + 36, true),
      sequence: this.view.getInt32(offset + 40, true),
    }
  }

  private readRecordAt(index: number): PackedIndexRecord {
    return this.readRecord(this.recordOffset(index))
  }

  private lowerBound(isBeforeTarget: (record: PackedIndexRecord) => boolean): number {
    let low = 0
    let high = this.entryCount
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      const record = this.readRecordAt(middle)
      if (isBeforeTarget(record)) low = middle + 1
      else high = middle
    }
    return low
  }

  async scanTimeRange(
    minTimestampSec: number,
    maxTimestampSec: number,
    direction: 'asc' | 'desc',
    onRecord: (record: PackedIndexRecord) => Promise<boolean>,
  ): Promise<PackedIndexMetrics> {
    const start = this.lowerBound((record) => record.timestampSec < minTimestampSec)
    const end = this.lowerBound((record) => record.timestampSec <= maxTimestampSec)
    return this.scanRecordRange(start, end, direction, onRecord)
  }

  async scanMapPoints(
    minTimestampSec: number,
    maxTimestampSec: number,
    direction: 'asc' | 'desc',
    query: CatalogQuery,
    mapAggregation: SearchSpec['mapAggregation'] | undefined,
    limit: number,
    _offset: number,
    isCancelled: CancellationSignal,
  ): Promise<PackedMapPointScanPage> {
    const start = this.lowerBound((record) => record.timestampSec < minTimestampSec)
    const end = this.lowerBound((record) => record.timestampSec <= maxTimestampSec)
    const metrics = { pagesRead: 0, diskReadBytes: 0, candidatesInspected: 0 }
    const aggregation = createMapPointAggregation(mapAggregation, limit)
    let matchedRecords = 0
    const page = (): PackedMapPointScanPage => {
      const aggregatedPoints = aggregatedMapPoints(aggregation)
      const largestBubbleCount = aggregatedPoints.reduce(
        (largest, point) => Math.max(largest, point.count ?? 1),
        0,
      )
      const limitedPoints =
        aggregatedPoints.length > limit
          ? [...aggregatedPoints]
              .sort((left, right) => (right.count ?? 1) - (left.count ?? 1))
              .slice(0, limit)
          : aggregatedPoints
      return {
        points: limitedPoints,
        limitReached: aggregatedPoints.length > limit,
        metrics,
        matchedRecords,
        renderedBubbles: limitedPoints.length,
        largestBubbleCount,
        aggregationZoom: aggregation.zoom,
        aggregationCellSizePx: aggregation.cellSizePx,
      }
    }

    if (end <= start) {
      return page()
    }

    const acceptedKinds = acceptedKindMask(query.kind)
    const bounds = query.geoBounds
    const minLatE7 = bounds
      ? minLatBoundE7(bounds.minLat)
      : 0
    const maxLatE7 = bounds
      ? maxLatBoundE7(bounds.maxLat)
      : 0
    const minLonE7 = bounds
      ? minLonBoundE7(bounds.minLon)
      : 0
    const maxLonE7 = bounds
      ? maxLonBoundE7(bounds.maxLon)
      : 0
    const requiresGeo = query.hasGeo === true || bounds !== undefined
    const rejectsGeo = query.hasGeo === false
    const view = this.view
    const recordSize = this.recordSize

    const addMatchedPoint = (
      recordOffset: number,
      kindFlags: number,
      recordLatE7: number,
      recordLonE7: number,
    ) => {
      const point: MapPoint = {
        assetId: view.getUint32(recordOffset + 12, true),
        kind: kindFromFlags(kindFlags),
        lat: coordinateFromE7(recordLatE7),
        lon: coordinateFromE7(recordLonE7),
        timestamp: view.getUint32(recordOffset, true) * 1000,
      }

      addMapPointToAggregation(aggregation, point)
      matchedRecords += 1
    }

    if (direction === 'desc') {
      for (let chunkEnd = end; chunkEnd > start;) {
        throwIfCancelled(isCancelled)
        const count = Math.min(PACKED_MAP_SCAN_RECORDS, chunkEnd - start)
        const chunkStart = chunkEnd - count
        metrics.pagesRead += 1
        for (let recordIndex = chunkEnd - 1; recordIndex >= chunkStart; recordIndex -= 1) {
          metrics.candidatesInspected += 1
          const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
          const kindFlags = view.getUint8(recordOffset + 16)
          if ((acceptedKinds & (1 << (kindFlags & KIND_CODE_MASK))) === 0) continue
          const hasGeo = (kindFlags & KIND_FLAG_HAS_GEO) !== 0
          if (requiresGeo && !hasGeo) continue
          if (rejectsGeo && hasGeo) continue

          let recordLatE7 = 0
          let recordLonE7 = 0
          if (bounds) {
            recordLatE7 = view.getInt32(recordOffset + 4, true)
            if (recordLatE7 < minLatE7 || recordLatE7 > maxLatE7) continue
            recordLonE7 = view.getInt32(recordOffset + 8, true)
            if (recordLonE7 < minLonE7 || recordLonE7 > maxLonE7) continue
          }

          if (!bounds) {
            recordLatE7 = view.getInt32(recordOffset + 4, true)
            recordLonE7 = view.getInt32(recordOffset + 8, true)
          }
          addMatchedPoint(recordOffset, kindFlags, recordLatE7, recordLonE7)
        }
        chunkEnd = chunkStart
        if (chunkEnd > start) await yieldToEventLoop()
      }
      return page()
    }

    for (let chunkStart = start; chunkStart < end;) {
      throwIfCancelled(isCancelled)
      const chunkEnd = Math.min(chunkStart + PACKED_MAP_SCAN_RECORDS, end)
      metrics.pagesRead += 1
      for (let recordIndex = chunkStart; recordIndex < chunkEnd; recordIndex += 1) {
        metrics.candidatesInspected += 1
        const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
        const kindFlags = view.getUint8(recordOffset + 16)
        if ((acceptedKinds & (1 << (kindFlags & KIND_CODE_MASK))) === 0) continue
        const hasGeo = (kindFlags & KIND_FLAG_HAS_GEO) !== 0
        if (requiresGeo && !hasGeo) continue
        if (rejectsGeo && hasGeo) continue

        let recordLatE7 = 0
        let recordLonE7 = 0
        if (bounds) {
          recordLatE7 = view.getInt32(recordOffset + 4, true)
          if (recordLatE7 < minLatE7 || recordLatE7 > maxLatE7) continue
          recordLonE7 = view.getInt32(recordOffset + 8, true)
          if (recordLonE7 < minLonE7 || recordLonE7 > maxLonE7) continue
        }

        if (!bounds) {
          recordLatE7 = view.getInt32(recordOffset + 4, true)
          recordLonE7 = view.getInt32(recordOffset + 8, true)
        }
        addMatchedPoint(recordOffset, kindFlags, recordLatE7, recordLonE7)
      }
      chunkStart = chunkEnd
      if (chunkStart < end) await yieldToEventLoop()
    }
    return page()
  }

  async scanMapPolyline(
    minTimestampSec: number,
    maxTimestampSec: number,
    direction: 'asc' | 'desc',
    query: CatalogQuery,
    mapAggregation: SearchSpec['mapAggregation'] | undefined,
    mapPolyline: SearchSpec['mapPolyline'] | undefined,
    isCancelled: CancellationSignal,
  ): Promise<PackedMapPolylineScanPage> {
    const start = this.lowerBound((record) => record.timestampSec < minTimestampSec)
    const end = this.lowerBound((record) => record.timestampSec <= maxTimestampSec)
    const metrics = { pagesRead: 0, diskReadBytes: 0, candidatesInspected: 0 }
    const zoom = Math.max(0, Math.min(24, Math.floor(mapAggregation?.zoom ?? 0)))
    const worldSize = WEB_MERCATOR_TILE_SIZE * 2 ** zoom
    const cleanup = normalizePolylineCleanup(mapPolyline)
    const groupedLineCandidates = new Map<string, PolylineCandidate[]>()
    const dotPoints: MapPoint[] = []
    let matchedRecords = 0
    let filteredQualityPoints = 0
    const requestedTolerancePx = Math.max(0, mapPolyline?.tolerancePx ?? 2)
    const maxPoints = Math.max(2, Math.min(100_000, mapPolyline?.maxPoints ?? 10_000))

    const page = (): PackedMapPolylineScanPage => {
      const candidateSegments: Array<{ groupKey: string; candidates: PolylineCandidate[] }> = []
      const sequenceDotPoints: MapPoint[] = []
      for (const [groupKey, candidates] of groupedLineCandidates) {
        const groupedSegments = splitGroupByConsecutiveSequence(groupKey, candidates)
        candidateSegments.push(...groupedSegments.lineSegments)
        if (cleanup.showDots) sequenceDotPoints.push(...groupedSegments.dotPoints)
      }

      let filteredJumpPoints = 0
      let lineSpeedBreaks = 0
      let lineDistanceBreaks = 0
      const processedSegments: Array<{ groupKey: string; candidates: PolylineCandidate[] }> = []
      const segmentDotPoints: MapPoint[] = []
      for (const segment of candidateSegments) {
        const jumpFiltered = cleanup.enabled && cleanup.removeIsolatedJumps
          ? removeIsolatedJumps(segment.candidates, cleanup.breakSpeedKmh)
          : { candidates: segment.candidates, removed: 0 }
        filteredJumpPoints += jumpFiltered.removed
        const distanceSplit = splitByMaxSegmentDistance(
          jumpFiltered.candidates,
          cleanup.maxSegmentDistanceKm,
        )
        lineDistanceBreaks += distanceSplit.breaks
        for (const distanceSegment of distanceSplit.segments) {
          const speedSplit = splitBySpeed(distanceSegment, cleanup.breakSpeedKmh)
          lineSpeedBreaks += speedSplit.breaks
          for (const candidates of speedSplit.segments) {
            if (candidates.length >= 2) {
              processedSegments.push({ groupKey: segment.groupKey, candidates })
            } else if (cleanup.showDots && candidates.length === 1) {
              segmentDotPoints.push(mapPointFromCandidate(candidates[0]))
            }
          }
        }
      }

      const polyline = polylineFromCandidateSegments(
        processedSegments,
        requestedTolerancePx,
        maxPoints,
        worldSize,
        isCancelled,
      )
      const allDotPoints = cleanup.showDots
        ? [...dotPoints, ...sequenceDotPoints, ...segmentDotPoints]
        : []
      const renderedDots = allDotPoints.slice(0, maxPoints)
      const acceptedLinePoints = candidateSegments.reduce(
        (total, segment) => total + segment.candidates.length,
        0,
      )
      const filteredLinePoints = filteredQualityPoints + filteredJumpPoints
      return {
        points: renderedDots,
        polyline,
        limitReached: renderedDots.length < allDotPoints.length,
        metrics,
        matchedRecords,
        sourceLinePoints: matchedRecords,
        acceptedLinePoints,
        filteredLinePoints,
        filteredQualityPoints,
        filteredJumpPoints,
        lineSpeedBreaks,
        lineDistanceBreaks,
        lineSegments: polyline.segments?.length ?? 0,
        renderedLinePoints: polyline.simplifiedPointCount,
        renderedLineDots: renderedDots.length,
        simplificationTolerancePx: polyline.tolerancePx,
      }
    }

    if (end <= start) return page()

    const acceptedKinds = acceptedKindMask(query.kind)
    const bounds = query.geoBounds
    const minLatE7 = bounds ? minLatBoundE7(bounds.minLat) : 0
    const maxLatE7 = bounds ? maxLatBoundE7(bounds.maxLat) : 0
    const minLonE7 = bounds ? minLonBoundE7(bounds.minLon) : 0
    const maxLonE7 = bounds ? maxLonBoundE7(bounds.maxLon) : 0
    const requiresGeo = query.hasGeo === true || bounds !== undefined
    const rejectsGeo = query.hasGeo === false
    const recordSize = this.recordSize

    const addMatchedRecord = (record: PackedIndexRecord) => {
      matchedRecords += 1
      const candidate = lineCandidateFromRecord(record)
      if (!candidatePassesQualityFilter(candidate, cleanup)) {
        filteredQualityPoints += 1
        return
      }

      if (!candidate.groupKey) {
        if (cleanup.showDots) {
          dotPoints.push(mapPointFromCandidate(candidate))
        }
        return
      }

      const group = groupedLineCandidates.get(candidate.groupKey) ?? []
      group.push(candidate)
      groupedLineCandidates.set(candidate.groupKey, group)
    }

    if (direction === 'desc') {
      for (let chunkEnd = end; chunkEnd > start;) {
        throwIfCancelled(isCancelled)
        const count = Math.min(PACKED_MAP_SCAN_RECORDS, chunkEnd - start)
        const chunkStart = chunkEnd - count
        metrics.pagesRead += 1
        for (let recordIndex = chunkEnd - 1; recordIndex >= chunkStart; recordIndex -= 1) {
          metrics.candidatesInspected += 1
          const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
          const record = this.readRecord(recordOffset)
          if ((acceptedKinds & (1 << (record.kindFlags & KIND_CODE_MASK))) === 0) continue
          const hasGeo = (record.kindFlags & KIND_FLAG_HAS_GEO) !== 0
          if (requiresGeo && !hasGeo) continue
          if (rejectsGeo && hasGeo) continue

          const latE7 = record.latE7
          if (bounds && (latE7 < minLatE7 || latE7 > maxLatE7)) continue
          const lonE7 = record.lonE7
          if (bounds && (lonE7 < minLonE7 || lonE7 > maxLonE7)) continue
          addMatchedRecord(record)
        }
        chunkEnd = chunkStart
        if (chunkEnd > start) await yieldToEventLoop()
      }
      return page()
    }

    for (let chunkStart = start; chunkStart < end;) {
      throwIfCancelled(isCancelled)
      const chunkEnd = Math.min(chunkStart + PACKED_MAP_SCAN_RECORDS, end)
      metrics.pagesRead += 1
      for (let recordIndex = chunkStart; recordIndex < chunkEnd; recordIndex += 1) {
        metrics.candidatesInspected += 1
        const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
        const record = this.readRecord(recordOffset)
        if ((acceptedKinds & (1 << (record.kindFlags & KIND_CODE_MASK))) === 0) continue
        const hasGeo = (record.kindFlags & KIND_FLAG_HAS_GEO) !== 0
        if (requiresGeo && !hasGeo) continue
        if (rejectsGeo && hasGeo) continue

        const latE7 = record.latE7
        if (bounds && (latE7 < minLatE7 || latE7 > maxLatE7)) continue
        const lonE7 = record.lonE7
        if (bounds && (lonE7 < minLonE7 || lonE7 > maxLonE7)) continue
        addMatchedRecord(record)
      }
      chunkStart = chunkEnd
      if (chunkStart < end) await yieldToEventLoop()
    }
    return page()
  }

  async scanAssetIds(
    minTimestampSec: number,
    maxTimestampSec: number,
    direction: 'asc' | 'desc',
    query: CatalogQuery,
    limit: number,
    isCancelled: CancellationSignal,
  ): Promise<PackedAssetIdScanPage> {
    const start = this.lowerBound((record) => record.timestampSec < minTimestampSec)
    const end = this.lowerBound((record) => record.timestampSec <= maxTimestampSec)
    const metrics = { pagesRead: 0, diskReadBytes: 0, candidatesInspected: 0 }
    const assetIds: number[] = []
    if (end <= start || limit <= 0) {
      return { assetIds, limitReached: false, metrics }
    }

    const acceptedKinds = acceptedKindMask(query.kind)
    const bounds = query.geoBounds
    const minLatE7 = bounds
      ? minLatBoundE7(bounds.minLat)
      : 0
    const maxLatE7 = bounds
      ? maxLatBoundE7(bounds.maxLat)
      : 0
    const minLonE7 = bounds
      ? minLonBoundE7(bounds.minLon)
      : 0
    const maxLonE7 = bounds
      ? maxLonBoundE7(bounds.maxLon)
      : 0
    const requiresGeo = query.hasGeo === true || bounds !== undefined
    const rejectsGeo = query.hasGeo === false
    const maxAssetIds = limit + 1
    const view = this.view
    const recordSize = this.recordSize

    if (direction === 'desc') {
      for (let chunkEnd = end; chunkEnd > start;) {
        throwIfCancelled(isCancelled)
        const count = Math.min(PACKED_MAP_SCAN_RECORDS, chunkEnd - start)
        const chunkStart = chunkEnd - count
        metrics.pagesRead += 1
        for (let recordIndex = chunkEnd - 1; recordIndex >= chunkStart; recordIndex -= 1) {
          metrics.candidatesInspected += 1
          const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
          const kindFlags = view.getUint8(recordOffset + 16)
          if ((acceptedKinds & (1 << (kindFlags & KIND_CODE_MASK))) === 0) continue
          const hasGeo = (kindFlags & KIND_FLAG_HAS_GEO) !== 0
          if (requiresGeo && !hasGeo) continue
          if (rejectsGeo && hasGeo) continue
          if (bounds) {
            const recordLatE7 = view.getInt32(recordOffset + 4, true)
            if (recordLatE7 < minLatE7 || recordLatE7 > maxLatE7) continue
            const recordLonE7 = view.getInt32(recordOffset + 8, true)
            if (recordLonE7 < minLonE7 || recordLonE7 > maxLonE7) continue
          }
          assetIds.push(view.getUint32(recordOffset + 12, true))
          if (assetIds.length >= maxAssetIds) {
            return {
              assetIds: assetIds.slice(0, limit),
              limitReached: true,
              metrics,
            }
          }
        }
        chunkEnd = chunkStart
        if (chunkEnd > start) await yieldToEventLoop()
      }
      return { assetIds, limitReached: false, metrics }
    }

    for (let chunkStart = start; chunkStart < end;) {
      throwIfCancelled(isCancelled)
      const chunkEnd = Math.min(chunkStart + PACKED_MAP_SCAN_RECORDS, end)
      metrics.pagesRead += 1
      for (let recordIndex = chunkStart; recordIndex < chunkEnd; recordIndex += 1) {
        metrics.candidatesInspected += 1
        const recordOffset = PACKED_INDEX_HEADER_SIZE + recordIndex * recordSize
        const kindFlags = view.getUint8(recordOffset + 16)
        if ((acceptedKinds & (1 << (kindFlags & KIND_CODE_MASK))) === 0) continue
        const hasGeo = (kindFlags & KIND_FLAG_HAS_GEO) !== 0
        if (requiresGeo && !hasGeo) continue
        if (rejectsGeo && hasGeo) continue
        if (bounds) {
          const recordLatE7 = view.getInt32(recordOffset + 4, true)
          if (recordLatE7 < minLatE7 || recordLatE7 > maxLatE7) continue
          const recordLonE7 = view.getInt32(recordOffset + 8, true)
          if (recordLonE7 < minLonE7 || recordLonE7 > maxLonE7) continue
        }
        assetIds.push(view.getUint32(recordOffset + 12, true))
        if (assetIds.length >= maxAssetIds) {
          return {
            assetIds: assetIds.slice(0, limit),
            limitReached: true,
            metrics,
          }
        }
      }
      chunkStart = chunkEnd
      if (chunkStart < end) await yieldToEventLoop()
    }
    return { assetIds, limitReached: false, metrics }
  }

  private async scanRecordRange(
    start: number,
    end: number,
    direction: 'asc' | 'desc',
    onRecord: (record: PackedIndexRecord) => Promise<boolean>,
  ): Promise<PackedIndexMetrics> {
    const metrics = { pagesRead: 0, diskReadBytes: 0, candidatesInspected: 0 }
    if (end <= start) return metrics
    if (direction === 'desc') {
      for (let offset = end; offset > start;) {
        const count = Math.min(PACKED_SCAN_RECORDS, offset - start)
        const first = offset - count
        metrics.pagesRead += 1
        for (let index = count - 1; index >= 0; index -= 1) {
          metrics.candidatesInspected += 1
          const shouldContinue = await onRecord(
            this.readRecord(this.recordOffset(first + index)),
          )
          if (!shouldContinue) return metrics
        }
        offset = first
        await yieldToEventLoop()
      }
      return metrics
    }
    for (let offset = start; offset < end; offset += PACKED_SCAN_RECORDS) {
      const count = Math.min(PACKED_SCAN_RECORDS, end - offset)
      metrics.pagesRead += 1
      for (let index = 0; index < count; index += 1) {
        metrics.candidatesInspected += 1
        const shouldContinue = await onRecord(
          this.readRecord(this.recordOffset(offset + index)),
        )
        if (!shouldContinue) return metrics
      }
      await yieldToEventLoop()
    }
    return metrics
  }
}

class FileCatalogStore implements CatalogStore {
  readonly storageMode = 'file' as const
  readonly geoImportWriteBatchSize = GEO_IMPORT_WRITE_BATCH_SIZE
  private manifest: CatalogManifest | undefined
  private materialized: MaterializedCatalog | undefined
  private importSource:
    | {
        sourceId: string
        generation: number
      }
    | undefined
  private transactionDepth = 0
  private backgroundIndexPromise: Promise<void> | undefined
  private residentPackedIndexes = new Map<FileCatalogIndexId, ResidentPackedGeoIndex>()
  private residentPackedIndexLoadPromise: Promise<void> | undefined
  private residentPackedIndexLoadError: Error | undefined

  async init(): Promise<InitResult> {
    await this.ensureManifest()
    return {
      storageMode: 'file',
      filename: `opfs://${CATALOG_DIR}`,
    }
  }

  async upsertSource(source: MediaSource): Promise<void> {
    const manifest = await this.ensureManifest()
    const existing = manifest.sources[source.id]
    manifest.sources[source.id] = {
      ...source,
      generation: existing?.generation ?? 0,
      active: true,
      importedAt: Date.now(),
    }
    await this.saveManifest()
  }

  async upsertMedia(items: MediaItem[]): Promise<number> {
    if (items.length === 0) return 0
    await this.writeMediaBatch(items)
    this.scheduleBackgroundCatalogIndexing()
    return items.length
  }

  async prepareImportSource(
    source: MediaSource,
    duplicateSourceIds: string[],
  ): Promise<void> {
    const manifest = await this.ensureManifest()
    const existing = manifest.sources[source.id]
    const generation = (existing?.generation ?? 0) + 1
    manifest.sources[source.id] = {
      ...source,
      generation,
      active: true,
      importedAt: Date.now(),
    }
    const inactiveIds = new Set([source.id, ...duplicateSourceIds])
    for (const sourceId of inactiveIds) {
      if (sourceId !== source.id && manifest.sources[sourceId]) {
        manifest.sources[sourceId] = {
          ...manifest.sources[sourceId],
          active: false,
        }
      }
    }
    for (const chunk of manifest.chunks) {
      if (inactiveIds.has(chunk.sourceId)) chunk.active = false
    }
    this.importSource = { sourceId: source.id, generation }
    await this.markDirty()
    clearResidentDistanceRuntimeCaches()
  }

  async writeMediaBatch(items: MediaItem[]): Promise<MediaBatchWriteResult> {
    if (items.length === 0) return { written: 0 }
    const manifest = await this.ensureManifest()
    const chunkId = `chunk-${String(manifest.nextChunkId).padStart(6, '0')}`
    manifest.nextChunkId += 1
    const sourceId = this.importSource?.sourceId ?? items[0]?.sourceId ?? ''
    const generation =
      this.importSource?.generation ?? manifest.sources[sourceId]?.generation ?? 0
    const occurrences = items.map((item) => ({
      item,
      sourceId: item.sourceId || sourceId,
      generation,
    }))
    const root = await rootDirectory()
    const occurrencesDir = await childDirectory(root, 'occurrences')
    await writeFile(
      occurrencesDir,
      `${chunkId}.bin`,
      occurrences.map((occurrence) => JSON.stringify(occurrence)).join('\n') + '\n',
    )
    manifest.chunks.push({
      id: chunkId,
      sourceId,
      generation,
      count: occurrences.length,
      createdAt: Date.now(),
      active: true,
    })
    manifest.occurrenceCount += occurrences.length
    await this.markDirty()
    if (this.transactionDepth === 0) this.scheduleBackgroundCatalogIndexing()
    return { written: items.length }
  }

  async commitImport(): Promise<void> {
    this.scheduleBackgroundCatalogIndexing()
  }

  async withImportTransaction<T>(run: () => Promise<T>): Promise<T> {
    this.transactionDepth += 1
    try {
      const result = await run()
      return result
    } finally {
      this.transactionDepth -= 1
      if (this.transactionDepth === 0) {
        this.importSource = undefined
        this.scheduleBackgroundCatalogIndexing()
      }
    }
  }

  async listMedia(query: CatalogQuery): Promise<MediaItem[]> {
    return (await this.searchRows(query)).items
  }

  async searchMedia(
    spec: SearchSpec,
    isCancelled: CancellationSignal = neverCancelled,
  ): Promise<SearchPage> {
    return createSearchRegistry(
      (query, indexId, isSearchCancelled) =>
        this.searchRows(query, indexId, isSearchCancelled),
      (ids) => this.getMediaByIds(ids),
      (assetIds) => this.getMediaByAssetIds(assetIds),
      (indexId) => this.ensureSearchIndexReady(indexId),
      isCancelled,
    ).search(spec)
  }

  async searchMapPoints(
    spec: SearchSpec,
    isCancelled: CancellationSignal = neverCancelled,
  ): Promise<MapPointPage> {
    throwIfCancelled(isCancelled)
    const startedAt = performance.now()
    const readyStartedAt = performance.now()
    const index = await this.residentPackedIndex('file-time-geo')
    const queryIndexReadyMs = performance.now() - readyStartedAt
    throwIfCancelled(isCancelled)
    const limit = Math.max(1, Math.min(spec.limit ?? 500, MAX_RENDERED_MAP_BUBBLES))
    const offset = Math.max(0, spec.offset ?? 0)
    const query = searchSpecToCatalogQuery(spec, limit + 1)
    const minTime = scanMinTimestampSec(query)
    const maxTime = query.endTime === undefined ? 0xffffffff : timestampSeconds(query.endTime)

    const scanStartedAt = performance.now()
    if (spec.mapMode === 'polyline') {
      const page = await index.scanMapPolyline(
        minTime,
        maxTime,
        query.sort === 'timestamp_asc' ? 'asc' : 'desc',
        query,
        spec.mapAggregation,
        spec.mapPolyline,
        isCancelled,
      )
      const queryIndexScanMs = performance.now() - scanStartedAt
      throwIfCancelled(isCancelled)
      return {
        points: page.points,
        polyline: page.polyline,
        limitReached: page.limitReached,
        resultMetrics: withQueryMetrics(
          {
            ...defaultSearchStats('file-time-geo', fileCatalogIndexSpec().label),
            pagesRead: page.metrics.pagesRead,
            candidatesInspected: page.metrics.candidatesInspected,
            diskReadBytes: page.metrics.diskReadBytes,
            indexStorage: 'memory',
            residentBytes: index.indexSizeBytes,
            pointCount: index.assetCount,
          },
          spec,
          performance.now() - startedAt,
          page.renderedLinePoints + page.renderedLineDots,
          spec.mapPolyline?.maxPoints ?? limit,
          offset,
          Boolean(page.limitReached),
          {
            queryIndexReadyMs,
            queryIndexScanMs,
            matchedRecords: page.matchedRecords,
            sourceLinePoints: page.sourceLinePoints,
            acceptedLinePoints: page.acceptedLinePoints,
            filteredLinePoints: page.filteredLinePoints,
            filteredQualityPoints: page.filteredQualityPoints,
            filteredJumpPoints: page.filteredJumpPoints,
            lineSpeedBreaks: page.lineSpeedBreaks,
            lineDistanceBreaks: page.lineDistanceBreaks,
            lineSegments: page.lineSegments,
            renderedLinePoints: page.renderedLinePoints,
            renderedLineDots: page.renderedLineDots,
            simplificationTolerancePx: page.simplificationTolerancePx,
          },
        ),
      }
    }

    const page = await index.scanMapPoints(
      minTime,
      maxTime,
      query.sort === 'timestamp_asc' ? 'asc' : 'desc',
      query,
      spec.mapAggregation,
      limit,
      offset,
      isCancelled,
    )
    const queryIndexScanMs = performance.now() - scanStartedAt
    throwIfCancelled(isCancelled)
    return {
      points: page.points,
      limitReached: page.limitReached,
      resultMetrics: withQueryMetrics(
        {
          ...defaultSearchStats('file-time-geo', fileCatalogIndexSpec().label),
          pagesRead: page.metrics.pagesRead,
          candidatesInspected: page.metrics.candidatesInspected,
          diskReadBytes: page.metrics.diskReadBytes,
          indexStorage: 'memory',
          residentBytes: index.indexSizeBytes,
          pointCount: index.assetCount,
        },
        spec,
        performance.now() - startedAt,
        page.points.length,
        limit,
        offset,
        Boolean(page.limitReached),
        {
          queryIndexReadyMs,
          queryIndexScanMs,
          matchedRecords: page.matchedRecords,
          renderedBubbles: page.renderedBubbles,
          largestBubbleCount: page.largestBubbleCount,
          aggregationZoom: page.aggregationZoom,
          aggregationCellSizePx: page.aggregationCellSizePx,
        },
      ),
    }
  }

  async getMediaByIds(ids: string[]): Promise<MediaItem[]> {
    if (ids.length === 0) return []
    const assetTable = await this.openAssetTable()
    const idMap = await this.openAssetIdMap()
    if (!assetTable || !idMap) {
      const catalog = await this.ensureMaterialized()
      return ids.flatMap((id) => {
        const item = catalog.byId.get(id)
        return item ? [item] : []
      })
    }
    const assetIds: number[] = []
    for (const id of ids) {
      const assetId = await idMap.findAssetId(id)
      if (assetId !== undefined) assetIds.push(assetId)
    }
    return (await assetTable.readByAssetIds(assetIds)).items.map(({ item }) => item)
  }

  async getMediaByAssetIds(assetIds: number[]): Promise<AssetMediaResult[]> {
    if (assetIds.length === 0) return []
    const assetTable = await this.openAssetTable()
    if (!assetTable) {
      const catalog = await this.ensureMaterialized()
      return assetIds.flatMap((assetId) => {
        const item = catalog.assets[assetId]
        return item ? [{ assetId, item }] : []
      })
    }
    return (await assetTable.readByAssetIds(assetIds)).items
  }

  async getGeoPoints(range: TimeRange = {}): Promise<GeoIndexPoint[]> {
    const assetTable = await this.openAssetTable()
    if (!assetTable) {
      const catalog = await this.ensureMaterialized()
      return catalog.geoPoints.filter((point) => {
        if (range.startTime !== undefined) {
          if (point.timestamp === undefined || point.timestamp < range.startTime) return false
        }
        if (range.endTime !== undefined) {
          if (point.timestamp === undefined || point.timestamp > range.endTime) return false
        }
        return true
      })
    }
    const points: GeoIndexPoint[] = []
    for await (const { item } of assetTable.scan()) {
      if (item.latitude === undefined || item.longitude === undefined) continue
      const point = {
        mediaId: item.id,
        kind: item.kind,
        lat: item.latitude,
        lon: item.longitude,
        timestamp: item.timestamp,
      }
      if (range.startTime !== undefined) {
        if (point.timestamp === undefined || point.timestamp < range.startTime) continue
      }
      if (range.endTime !== undefined) {
        if (point.timestamp === undefined || point.timestamp > range.endTime) continue
      }
      if (range.startTime !== undefined && point.timestamp === undefined) continue
      points.push(point)
    }
    return points
  }

  async forEachGeoPointBatch(
    batchSize: number,
    onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
  ): Promise<number> {
    const assetTable = await this.openAssetTable()
    if (assetTable) {
      let processed = 0
      let batch: GeoIndexPoint[] = []
      for await (const { item } of assetTable.scan()) {
        if (item.latitude !== undefined && item.longitude !== undefined) {
          batch.push({
            mediaId: item.id,
            kind: item.kind,
            lat: item.latitude,
            lon: item.longitude,
            timestamp: item.timestamp,
          })
          processed += 1
        }
        if (batch.length >= batchSize) {
          await onBatch(batch, processed)
          batch = []
          await yieldToEventLoop()
        }
      }
      if (batch.length > 0) await onBatch(batch, processed)
      return processed
    }
    const points = await this.getGeoPoints()
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize)
      await onBatch(batch, Math.min(points.length, offset + batch.length))
      await yieldToEventLoop()
    }
    return points.length
  }

  async forEachGeoAssetBatch(
    batchSize: number,
    onBatch: (batch: ResidentDistanceBuildPoint[], processedPoints: number) => Promise<void>,
  ): Promise<number> {
    let assetTable = await this.openAssetTable()
    if (!assetTable) {
      await this.ensureMaterialized()
      assetTable = await this.openAssetTable()
    }
    if (!assetTable) {
      throw new Error('Catalog asset table is missing. Finish the import before rebuilding indexes.')
    }
    let processed = 0
    let batch: ResidentDistanceBuildPoint[] = []
    for await (const { assetId, item } of assetTable.scan()) {
      if (item.latitude !== undefined && item.longitude !== undefined) {
        batch.push({
          assetId,
          kind: item.kind,
          lat: item.latitude,
          lon: item.longitude,
          timestamp: item.timestamp,
        })
        processed += 1
      }
      if (batch.length >= batchSize) {
        await onBatch(batch, processed)
        batch = []
        await yieldToEventLoop()
      }
    }
    if (batch.length > 0) await onBatch(batch, processed)
    return processed
  }

  residentDistanceIndexStore(): ResidentPackedDistanceStore {
    return createOpfsResidentDistanceIndexStore()
  }

  async catalogEpoch(): Promise<number> {
    return (await this.ensureManifest()).catalogVersion
  }

  async buildSearchIndexes(
    indexId: string,
    forceRebuild: boolean,
    postProgress: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary & { engineCount: number }> {
    if (isFileCatalogIndexId(indexId)) {
      return this.buildFileCatalogIndexes(indexId, postProgress)
    }
    return buildSearchIndexes(this, indexId, forceRebuild, postProgress)
  }

  async getSearchIndexStats(): Promise<SearchIndexStats[]> {
    const registry = createSearchRegistry(
      (query, indexId) => this.searchRows(query, indexId),
      (ids) => this.getMediaByIds(ids),
      (assetIds) => this.getMediaByAssetIds(assetIds),
      (indexId) => this.ensureSearchIndexReady(indexId),
    )
    const stats = await registry.stats()
    const timeGeoStats = await this.fileCatalogIndexStats('file-time-geo')
    const segmentedStats = await residentDistanceStatusStats(
      this,
      'segmented-ball-tree',
    )
    return stats.map((entry) =>
      entry.engineId === 'file-time-geo'
        ? timeGeoStats
        : entry.engineId === 'segmented-ball-tree'
            ? segmentedStats
            : entry,
    )
  }

  async countMedia(): Promise<number> {
    return (await this.ensureManifest()).assetCount
  }

  async clear(): Promise<void> {
    await clearDirectory(await rootDirectory())
    this.manifest = emptyManifest()
    this.materialized = undefined
    this.importSource = undefined
    this.clearResidentPackedIndexes()
    residentDistanceIndexInstances.clear()
    await this.saveManifest()
  }

  private async openAssetTable(): Promise<AssetTable | undefined> {
    return AssetTable.open(await childDirectory(await rootDirectory(), 'assets'))
  }

  private async openAssetIdMap(): Promise<AssetIdMap | undefined> {
    return AssetIdMap.open(await childDirectory(await rootDirectory(), 'assets'))
  }

  private clearResidentPackedIndexes(): void {
    this.residentPackedIndexes.clear()
    this.residentPackedIndexLoadPromise = undefined
    this.residentPackedIndexLoadError = undefined
  }

  private async readPackedIndexHeader(): Promise<PackedIndexHeader | undefined> {
    const spec = fileCatalogIndexSpec()
    const indexesDir = await childDirectory(await rootDirectory(), 'indexes')
    const file = await readFile(indexesDir, spec.fileName)
    if (!file) return undefined
    const headerBuffer = await readFileRange(file, 0, PACKED_INDEX_HEADER_SIZE)
    return parsePackedIndexHeader(headerBuffer, spec.kind, file.size)
  }

  private async loadResidentPackedIndex(
    catalogVersion: number,
  ): Promise<ResidentPackedGeoIndex> {
    const spec = fileCatalogIndexSpec()
    const indexesDir = await childDirectory(await rootDirectory(), 'indexes')
    const file = await readFile(indexesDir, spec.fileName)
    if (!file) {
      throw new Error(`${spec.label} file is missing.`)
    }
    const bytes = await file.arrayBuffer()
    const index = ResidentPackedGeoIndex.fromArrayBuffer(bytes, spec.kind)
    if (!index) {
      throw new Error(`${spec.label} file is invalid.`)
    }
    if (index.catalogVersion !== catalogVersion) {
      throw new Error(`${spec.label} file is stale.`)
    }
    return index
  }

  private residentIndexesCurrent(catalogVersion: number): boolean {
    return this.residentPackedIndexes.get('file-time-geo')?.catalogVersion === catalogVersion
  }

  private async ensureResidentPackedIndexes(): Promise<void> {
    const manifest = await this.ensureManifest()
    if (
      manifest.materializedVersion !== manifest.catalogVersion ||
      manifest.indexAppliedVersion !== manifest.catalogVersion
    ) {
      this.clearResidentPackedIndexes()
      throw new Error('Catalog indexes are not current. Update the indexes before querying.')
    }
    if (this.residentIndexesCurrent(manifest.catalogVersion)) return
    if (this.residentPackedIndexLoadError) {
      throw this.residentPackedIndexLoadError
    }
    if (!this.residentPackedIndexLoadPromise) {
      this.residentPackedIndexLoadPromise = this.loadAllResidentPackedIndexes(
        manifest.catalogVersion,
      )
    }
    await this.residentPackedIndexLoadPromise
  }

  private async residentPackedIndex(
    indexId: FileCatalogIndexId,
  ): Promise<ResidentPackedGeoIndex> {
    await this.ensureResidentPackedIndexes()
    const index = this.residentPackedIndexes.get(indexId)
    if (!index) {
      throw new Error(
        'Catalog indexes could not be loaded into memory. Rebuild indexes or reduce catalog size.',
      )
    }
    return index
  }

  private async loadAllResidentPackedIndexes(catalogVersion: number): Promise<void> {
    try {
      console.log('[geo-index:worker] loading packed catalog indexes into memory', {
        catalogVersion,
      })
      const timeIndex = await this.loadResidentPackedIndex(catalogVersion)
      this.residentPackedIndexes.set('file-time-geo', timeIndex)
      this.residentPackedIndexLoadError = undefined
      console.log('[geo-index:worker] packed catalog indexes loaded into memory', {
        catalogVersion,
        residentBytes: timeIndex.indexSizeBytes,
      })
    } catch (caught) {
      console.error('[geo-index:worker] failed to load packed catalog indexes into memory', caught)
      this.residentPackedIndexes.clear()
      this.residentPackedIndexLoadError = new Error(
        'Catalog indexes could not be loaded into memory. Rebuild indexes or reduce catalog size.',
      )
      throw this.residentPackedIndexLoadError
    } finally {
      this.residentPackedIndexLoadPromise = undefined
    }
  }

  private scheduleResidentPackedIndexPreload(): void {
    if (this.residentPackedIndexLoadPromise || this.residentPackedIndexLoadError) return
    void this.ensureResidentPackedIndexes().catch((caught) => {
      console.error('[geo-index:worker] resident packed index preload failed', caught)
    })
  }

  private async searchRows(
    query: CatalogQuery,
    indexId: FileCatalogIndexId = 'file-time-geo',
    isCancelled: CancellationSignal = neverCancelled,
  ): Promise<MediaSearchRows> {
    throwIfCancelled(isCancelled)
    const index = await this.residentPackedIndex(indexId)
    throwIfCancelled(isCancelled)
    const assetTable = await this.openAssetTable()
    throwIfCancelled(isCancelled)
    if (!assetTable) {
      throw new Error('Catalog asset table is missing. Finish the import before querying.')
    }
    return this.searchTimeGeoRows(assetTable, index, query, isCancelled)
  }

  private async searchTimeGeoRows(
    assetTable: AssetTable,
    timeIndex: ResidentPackedGeoIndex,
    query: CatalogQuery,
    isCancelled: CancellationSignal,
  ): Promise<MediaSearchRows> {
    throwIfCancelled(isCancelled)
    const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
    const offset = Math.max(0, query.offset ?? 0)
    const minTime = scanMinTimestampSec(query)
    const maxTime = query.endTime === undefined ? 0xffffffff : timestampSeconds(query.endTime)
    let assetDiskReadBytes = 0
    let assetDiskReadCount = 0
    let indexMetrics: PackedIndexMetrics | undefined
    let queryIndexScanMs = 0
    let queryAssetReadMs = 0
    let queryAssetFilterMs = 0
    let items: MediaItem[] = []
    let packedCandidateLimit = Math.max(1, offset + limit)
    const direction = query.sort === 'timestamp_asc' ? 'asc' : 'desc'

    for (;;) {
      const scanStartedAt = performance.now()
      const scanPage = await timeIndex.scanAssetIds(
        minTime,
        maxTime,
        direction,
        query,
        packedCandidateLimit,
        isCancelled,
      )
      queryIndexScanMs += performance.now() - scanStartedAt
      indexMetrics = scanPage.metrics
      throwIfCancelled(isCancelled)
      const assetStartedAt = performance.now()
      const assetResult = await assetTable.readByAssetIds(scanPage.assetIds)
      queryAssetReadMs += performance.now() - assetStartedAt
      assetDiskReadBytes += assetResult.metrics.diskReadBytes
      assetDiskReadCount += assetResult.metrics.diskReadCount
      throwIfCancelled(isCancelled)
      const filterStartedAt = performance.now()
      const matchedItems = assetResult.items.flatMap(({ item }) =>
        itemMatchesQuery(item, query) ? [item] : [],
      )
      queryAssetFilterMs += performance.now() - filterStartedAt
      if (matchedItems.length >= offset + limit || !scanPage.limitReached) {
        items = matchedItems.slice(offset, offset + limit)
        break
      }
      packedCandidateLimit = Math.min(
        timeIndex.entryCount,
        Math.max(packedCandidateLimit + 1, packedCandidateLimit * 2),
      )
      if (packedCandidateLimit <= scanPage.assetIds.length) break
    }

    throwIfCancelled(isCancelled)
    return {
      items,
      metrics: {
        pagesRead: indexMetrics?.pagesRead ?? 0,
        diskReadBytes: assetDiskReadBytes,
        diskReadCount: assetDiskReadCount,
        candidatesInspected: indexMetrics?.candidatesInspected ?? 0,
        indexStorage: 'memory',
        residentBytes: timeIndex.indexSizeBytes,
        queryIndexScanMs,
        queryAssetReadMs,
        queryAssetFilterMs,
      },
    }
  }

  async ensureSearchIndexReady(indexId: string): Promise<SearchIndexStats> {
    const stats = isFileCatalogIndexId(indexId)
      ? await this.fileCatalogIndexStats(indexId)
      : isResidentDistanceEngineId(indexId)
        ? await residentDistanceStatusStats(this, indexId)
        : undefined
    if (!stats) {
      throw new Error(`Search index "${indexId}" is not available.`)
    }
    if (isFileCatalogIndexId(indexId) && this.residentPackedIndexLoadError) {
      throw this.residentPackedIndexLoadError
    }
    if (stats.indexStatus !== 'current') {
      throw new Error(
        `${stats.engineLabel ?? indexId} index is ${stats.indexStatus ?? 'not ready'}. Update the index before querying.`,
      )
    }
    if (isFileCatalogIndexId(indexId)) {
      await this.ensureResidentPackedIndexes()
      return this.fileCatalogIndexStats(indexId)
    }
    if (isResidentDistanceEngineId(indexId)) {
      const catalogVersion = await this.catalogEpoch()
      await residentDistanceIndex(this, indexId).ensureResident(catalogVersion)
      return residentDistanceStatusStats(this, indexId)
    }
    return stats
  }

  private async ensureManifest(): Promise<CatalogManifest> {
    if (this.manifest) return this.manifest
    const text = await readTextFile(await rootDirectory(), MANIFEST_FILE)
    this.manifest = text ? normalizeManifest(JSON.parse(text)) : emptyManifest()
    return this.manifest
  }

  private async saveManifest(): Promise<void> {
    await writeFile(
      await rootDirectory(),
      MANIFEST_FILE,
      JSON.stringify(await this.ensureManifest()),
    )
  }

  private async markDirty(): Promise<void> {
    const manifest = await this.ensureManifest()
    manifest.catalogVersion += 1
    manifest.materializedVersion = -1
    manifest.assetStoreVersion = -1
    manifest.indexJob = {
      status: 'pending',
      pendingSince: Date.now(),
    }
    this.materialized = undefined
    this.clearResidentPackedIndexes()
    await this.saveManifest()
  }

  private scheduleBackgroundCatalogIndexing(): void {
    if (this.backgroundIndexPromise) return
    this.backgroundIndexPromise = this.applyCatalogIndexJounal(postBackgroundIndexProgress)
      .catch((error) => {
        console.error('[geo-index:worker] background catalog indexing failed', error)
      })
      .finally(() => {
        this.backgroundIndexPromise = undefined
      })
  }

  private async applyCatalogIndexJounal(
    postProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<void> {
    const manifest = await this.ensureManifest()
    if (manifest.indexAppliedVersion === manifest.catalogVersion) return
    manifest.indexJob = {
      status: 'indexing',
      pendingSince: manifest.indexJob?.pendingSince,
      startedAt: Date.now(),
    }
    await this.saveManifest()
    try {
      if (manifest.materializedVersion !== manifest.catalogVersion) {
        await this.materialize(postProgress, 'Catalog packed indexes: background materializing catalog')
      }
      await this.writeMaterializedIndexFiles(postProgress, 'Catalog packed indexes')
      const updated = await this.ensureManifest()
      updated.indexAppliedVersion = updated.catalogVersion
      updated.indexJob = {
        status: 'current',
        pendingSince: manifest.indexJob?.pendingSince,
        startedAt: manifest.indexJob?.startedAt,
        finishedAt: Date.now(),
      }
      await this.saveManifest()
      await this.ensureResidentPackedIndexes()
      postProgress?.({
        phase: 'ready',
        pointCount: updated.assetCount,
        builtIndexes: 1,
        totalIndexes: 1,
        currentIndexId: 'file-time-geo',
        currentIndexLabel: 'Catalog packed indexes',
        currentIndexProcessedPoints: updated.assetCount,
        currentIndexTotalPoints: updated.assetCount,
      })
    } catch (error) {
      const failed = await this.ensureManifest()
      failed.indexJob = {
        status: 'failed',
        pendingSince: manifest.indexJob?.pendingSince,
        startedAt: manifest.indexJob?.startedAt,
        failedMessage: error instanceof Error ? error.message : String(error),
      }
      await this.saveManifest()
      throw error
    }
  }

  private async ensureMaterialized(): Promise<MaterializedCatalog> {
    const manifest = await this.ensureManifest()
    if (
      this.materialized &&
      this.materialized.version === manifest.catalogVersion &&
      manifest.materializedVersion === manifest.catalogVersion
    ) {
      return this.materialized
    }
    if (manifest.materializedVersion === manifest.catalogVersion) {
      const loaded = await this.loadMaterialized()
      if (loaded) {
        this.materialized = loaded
        return loaded
      }
    }
    return this.materialize()
  }

  private async loadMaterialized(): Promise<MaterializedCatalog | undefined> {
    const root = await rootDirectory()
    const assetsDir = await childDirectory(root, 'assets')
    const manifest = await this.ensureManifest()
    const assetTable = await AssetTable.open(assetsDir)
    if (assetTable && assetTable.catalogVersion === manifest.catalogVersion) {
      const assets: MediaItem[] = []
      for await (const { item } of assetTable.scan()) assets.push(item)
      return this.createMaterializedCatalog(manifest.catalogVersion, assets)
    }
    const entries = await directoryEntries(assetsDir)
    const chunkNames = entries
      .filter(
        ([name, handle]) =>
          handle.kind === 'file' &&
          name.startsWith(ASSET_CHUNK_PREFIX) &&
          name.endsWith(ASSET_CHUNK_EXTENSION),
      )
      .map(([name]) => name)
      .sort()
    const assets: MediaItem[] = []
    if (chunkNames.length > 0) {
      for (const chunkName of chunkNames) {
        const file = await readFile(assetsDir, chunkName)
        if (!file) continue
        const text = await file.text()
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          const item = mediaFromUnknown(JSON.parse(line) as unknown)
          if (item) assets.push(item)
        }
        await yieldToEventLoop()
      }
    } else {
      const text = await readTextFile(assetsDir, ASSETS_FILE)
      if (!text) return undefined
      const parsed = JSON.parse(text) as unknown
      if (!Array.isArray(parsed)) return undefined
      for (const value of parsed) {
        const item = mediaFromUnknown(value)
        if (item) assets.push(item)
      }
    }
    return this.createMaterializedCatalog(manifest.catalogVersion, assets)
  }

  private async materialize(
    postProgress?: (progress: GeoIndexBuildProgress) => void,
    progressLabel = 'Catalog packed indexes: materializing catalog',
  ): Promise<MaterializedCatalog> {
    const manifest = await this.ensureManifest()
    const root = await rootDirectory()
    const occurrencesDir = await childDirectory(root, 'occurrences')
    const assetsByHash = new Map<string, MediaItem>()
    const locationsByHash = new Map<string, Map<string, MediaLocation>>()
    const activeChunks = manifest.chunks.filter((chunk) => chunk.active)
    const totalOccurrences = activeChunks.reduce((total, chunk) => total + chunk.count, 0)
    let processedOccurrences = 0

    for (const chunk of activeChunks) {
      const file = await readFile(occurrencesDir, `${chunk.id}.bin`)
      if (!file) continue
      const text = await file.text()
      for (const line of text.split('\n')) {
        const occurrence = occurrenceFromLine(line)
        if (!occurrence) {
          continue
        }
        processedOccurrences += 1
        const source = manifest.sources[occurrence.sourceId]
        if (!source?.active || source.generation !== occurrence.generation) continue
        const existing = assetsByHash.get(occurrence.item.contentHash)
        assetsByHash.set(
          occurrence.item.contentHash,
          existing ? mergeMediaItems(existing, occurrence.item) : occurrence.item,
        )
        const locationMap =
          locationsByHash.get(occurrence.item.contentHash) ?? new Map<string, MediaLocation>()
        for (const location of itemLocations(occurrence.item)) {
          locationMap.set(location.id, location)
        }
        locationsByHash.set(occurrence.item.contentHash, locationMap)
        if (processedOccurrences % 50_000 === 0) {
          console.log('[geo-index:worker] materialize read progress', {
            processedOccurrences,
            totalOccurrences,
            assets: assetsByHash.size,
          })
          postProgress?.({
            phase: 'building',
            pointCount: totalOccurrences,
            builtIndexes: 0,
            totalIndexes: 1,
            currentIndexId: 'file-time-geo',
            currentIndexLabel: `${progressLabel}: reading occurrences`,
            currentIndexProcessedPoints: processedOccurrences,
            currentIndexTotalPoints: totalOccurrences,
          })
          await yieldToEventLoop()
        }
      }
      await yieldToEventLoop()
    }

    const assets: MediaItem[] = []
    const sourceAssets = Array.from(assetsByHash.values())
    let locationCount = 0
    for (let index = 0; index < sourceAssets.length; index += 1) {
      const item = sourceAssets[index]
      const locations = Array.from(locationsByHash.get(item.contentHash)?.values() ?? [])
      locationCount += locations.length
      assets.push(
        normalizeMediaItem(
          item,
          locations,
        ),
      )
      const processedAssets = index + 1
      if (processedAssets % 50_000 === 0 || processedAssets === sourceAssets.length) {
        console.log('[geo-index:worker] materialize normalize progress', {
          processedAssets,
          totalAssets: sourceAssets.length,
        })
        postProgress?.({
          phase: 'building',
          pointCount: sourceAssets.length,
          builtIndexes: 0,
          totalIndexes: 1,
          currentIndexId: 'file-time-geo',
          currentIndexLabel: `${progressLabel}: normalizing assets`,
          currentIndexProcessedPoints: processedAssets,
          currentIndexTotalPoints: sourceAssets.length,
        })
        await yieldToEventLoop()
      }
    }
    postProgress?.({
      phase: 'building',
      pointCount: assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: preparing asset table`,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: assets.length,
    })
    await yieldToEventLoop()
    const materialized: MaterializedCatalog = {
      version: manifest.catalogVersion,
      assets,
      byId: new Map(),
      geoPoints: [],
    }
    manifest.assetCount = materialized.assets.length
    manifest.locationCount = locationCount
    manifest.materializedVersion = manifest.catalogVersion
    manifest.assetStoreVersion = manifest.catalogVersion
    manifest.nextAssetId = Math.max(manifest.nextAssetId, materialized.assets.length)

    await this.writeMaterializedCatalogFiles(materialized, postProgress, progressLabel)
    postProgress?.({
      phase: 'building',
      pointCount: materialized.assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: saving manifest`,
      currentIndexProcessedPoints: materialized.assets.length,
      currentIndexTotalPoints: materialized.assets.length,
    })
    await this.saveManifest()
    postProgress?.({
      phase: 'building',
      pointCount: materialized.assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: complete`,
      currentIndexProcessedPoints: materialized.assets.length,
      currentIndexTotalPoints: materialized.assets.length,
    })
    this.materialized = undefined
    return materialized
  }

  private async writeMaterializedCatalogFiles(
    materialized: MaterializedCatalog,
    postProgress?: (progress: GeoIndexBuildProgress) => void,
    progressLabel = 'Catalog packed indexes: materializing catalog',
  ): Promise<void> {
    const root = await rootDirectory()
    const assetsDir = await childDirectory(root, 'assets')
    postProgress?.({
      phase: 'building',
      pointCount: materialized.assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: clearing old asset table`,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: materialized.assets.length,
    })
    await clearDirectory(assetsDir)
    await this.writeAssetTable(assetsDir, materialized, postProgress, progressLabel)
  }

  private async writeAssetTable(
    assetsDir: FileSystemDirectoryHandle,
    materialized: MaterializedCatalog,
    postProgress?: (progress: GeoIndexBuildProgress) => void,
    progressLabel = 'Catalog packed indexes: materializing catalog',
  ): Promise<void> {
    const assets = materialized.assets
    postProgress?.({
      phase: 'building',
      pointCount: assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: preparing record index`,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: assets.length,
    })
    const recordIndexParts: BlobPart[] = [
      bytesAsBlobPart(encodeHeader(
          ASSET_TABLE_MAGIC,
          materialized.version,
          assets.length,
          ASSET_RECORD_INDEX_ENTRY_SIZE,
        )),
    ]
    const idMapIds = new Uint32Array(assets.length)

    for (let offset = 0; offset < assets.length; offset += ASSET_CHUNK_SIZE) {
      const chunk = assets.slice(offset, offset + ASSET_CHUNK_SIZE)
      const payloads = chunk.map((item) => textEncoder.encode(JSON.stringify(item)))
      const chunkByteLength = payloads.reduce(
        (total, payload) => total + 4 + payload.byteLength,
        0,
      )
      const chunkBytes = new Uint8Array(chunkByteLength)
      const chunkView = new DataView(
        chunkBytes.buffer,
        chunkBytes.byteOffset,
        chunkBytes.byteLength,
      )
      const recordBytes = new Uint8Array(chunk.length * ASSET_RECORD_INDEX_ENTRY_SIZE)
      const recordView = new DataView(recordBytes.buffer)
      let chunkOffset = 0
      for (let index = 0; index < chunk.length; index += 1) {
        const assetId = offset + index
        const payload = payloads[index]
        chunkView.setUint32(chunkOffset, payload.byteLength, true)
        chunkBytes.set(payload, chunkOffset + 4)
        const recordOffset = index * ASSET_RECORD_INDEX_ENTRY_SIZE
        recordView.setUint32(recordOffset, offset / ASSET_CHUNK_SIZE, true)
        recordView.setUint32(recordOffset + 4, chunkOffset, true)
        recordView.setUint32(recordOffset + 8, payload.byteLength, true)
        idMapIds[assetId] = assetId
        chunkOffset += 4 + payload.byteLength
      }
      const chunkId = String(offset / ASSET_CHUNK_SIZE).padStart(6, '0')
      await writeFileParts(
        assetsDir,
        `${ASSET_CHUNK_PREFIX}${chunkId}${ASSET_BINARY_CHUNK_EXTENSION}`,
        [bytesAsBlobPart(chunkBytes)],
      )
      recordIndexParts.push(bytesAsBlobPart(recordBytes))
      const written = Math.min(assets.length, offset + chunk.length)
      if (written % 50_000 === 0 || written === assets.length) {
        console.log('[geo-index:worker] materialize asset write progress', {
          written,
          total: assets.length,
        })
        postProgress?.({
          phase: 'building',
          pointCount: assets.length,
          builtIndexes: 0,
          totalIndexes: 1,
          currentIndexId: 'file-time-geo',
          currentIndexLabel: `${progressLabel}: writing asset table`,
          currentIndexProcessedPoints: written,
          currentIndexTotalPoints: assets.length,
        })
      }
      await yieldToEventLoop()
    }
    postProgress?.({
      phase: 'building',
      pointCount: assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: sorting asset id map`,
      currentIndexProcessedPoints: assets.length,
      currentIndexTotalPoints: assets.length,
    })
    idMapIds.sort((left, right) =>
      assets[left].contentHash < assets[right].contentHash
        ? -1
        : assets[left].contentHash > assets[right].contentHash
          ? 1
          : left - right,
    )
    const idMapParts: BlobPart[] = [
      bytesAsBlobPart(encodeHeader(
        ASSET_ID_MAP_MAGIC,
        materialized.version,
        assets.length,
        ASSET_ID_MAP_ENTRY_SIZE,
      )),
    ]
    for (let offset = 0; offset < idMapIds.length; offset += ASSET_CHUNK_SIZE) {
      const count = Math.min(ASSET_CHUNK_SIZE, idMapIds.length - offset)
      const idMapBytes = new Uint8Array(count * ASSET_ID_MAP_ENTRY_SIZE)
      const idMapView = new DataView(idMapBytes.buffer)
      for (let index = 0; index < count; index += 1) {
        const assetId = idMapIds[offset + index]
        const idMapOffset = index * ASSET_ID_MAP_ENTRY_SIZE
        idMapBytes.set(encodeHashKey(assets[assetId].contentHash), idMapOffset)
        setUint64(idMapView, idMapOffset + 64, assetId)
      }
      idMapParts.push(bytesAsBlobPart(idMapBytes))
      const processed = offset + count
      if (processed % 50_000 === 0 || processed === idMapIds.length) {
        postProgress?.({
          phase: 'building',
          pointCount: assets.length,
          builtIndexes: 0,
          totalIndexes: 1,
          currentIndexId: 'file-time-geo',
          currentIndexLabel: `${progressLabel}: writing asset id map`,
          currentIndexProcessedPoints: processed,
          currentIndexTotalPoints: idMapIds.length,
        })
        await yieldToEventLoop()
      }
    }
    postProgress?.({
      phase: 'building',
      pointCount: assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: writing record index`,
      currentIndexProcessedPoints: assets.length,
      currentIndexTotalPoints: assets.length,
    })
    await writeFileParts(assetsDir, ASSET_RECORD_INDEX_FILE, recordIndexParts)
    postProgress?.({
      phase: 'building',
      pointCount: assets.length,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${progressLabel}: writing asset id index`,
      currentIndexProcessedPoints: assets.length,
      currentIndexTotalPoints: assets.length,
    })
    await writeFileParts(assetsDir, ASSET_ID_MAP_FILE, idMapParts)
  }

  private async writeMaterializedIndexFiles(
    postProgress?: (progress: GeoIndexBuildProgress) => void,
    currentIndexLabel = 'Catalog packed indexes',
  ): Promise<void> {
    const manifest = await this.ensureManifest()
    this.clearResidentPackedIndexes()
    manifest.indexAppliedVersion = -1
    console.log('[geo-index:worker] write packed file catalog indexes start', {
      catalogVersion: manifest.catalogVersion,
      assetCount: manifest.assetCount,
    })
    const assetTable = await this.openAssetTable()
    if (!assetTable || assetTable.catalogVersion !== manifest.catalogVersion) {
      throw new Error('Catalog asset table is missing or stale. Finish the import before rebuilding indexes.')
    }
    const timeRecords: PackedIndexRecord[] = []
    let processed = 0
    for await (const { assetId, item } of assetTable.scan()) {
      if (
        item.timestamp !== undefined ||
        (item.latitude !== undefined && item.longitude !== undefined)
      ) {
        const hasGeo = item.latitude !== undefined && item.longitude !== undefined
        const record: PackedIndexRecord = {
          timestampSec:
            item.timestamp === undefined ? 0 : timestampSeconds(item.timestamp),
          latE7: hasGeo ? latE7(item.latitude!) : 0,
          lonE7: hasGeo ? lonE7(item.longitude!) : 0,
          assetId,
          kindFlags: kindFlags(item),
          ...linePayloadFromItem(item),
        }
        timeRecords.push(record)
      }
      processed += 1
      if (processed % 50_000 === 0) {
        console.log('[geo-index:worker] packed file catalog index scan progress', {
          processed,
          total: manifest.assetCount,
        })
        postProgress?.({
          phase: 'building',
          pointCount: manifest.assetCount,
          builtIndexes: 0,
          totalIndexes: 1,
          currentIndexId: 'file-time-geo',
          currentIndexLabel: `${currentIndexLabel}: scanning asset table`,
          currentIndexProcessedPoints: processed,
          currentIndexTotalPoints: manifest.assetCount,
        })
        await yieldToEventLoop()
      }
    }
    const indexesDir = await childDirectory(await rootDirectory(), 'indexes')
    await indexesDir.removeEntry('cell-time.idx').catch(() => undefined)
    console.log('[geo-index:worker] writing packed file catalog index files', {
      timeRecords: timeRecords.length,
    })
    await this.writePackedIndex(
      indexesDir,
      TIME_GEO_INDEX_FILE,
      INDEX_KIND_TIME_GEO,
      timeRecords,
      postProgress,
      currentIndexLabel,
      0,
      'time-first index',
    )
    console.log('[geo-index:worker] write packed file catalog indexes complete', {
      catalogVersion: manifest.catalogVersion,
      timeRecords: timeRecords.length,
    })
  }

  private async writePackedIndex(
    indexesDir: FileSystemDirectoryHandle,
    fileName: string,
    kind: number,
    records: PackedIndexRecord[],
    postProgress: ((progress: GeoIndexBuildProgress) => void) | undefined,
    currentIndexLabel: string,
    builtIndexes: number,
    indexLabel: string,
  ): Promise<void> {
    postProgress?.({
      phase: 'building',
      pointCount: records.length,
      builtIndexes,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${currentIndexLabel}: sorting ${indexLabel}`,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: records.length,
    })
    await yieldToEventLoop()
    records.sort((a, b) => a.timestampSec - b.timestampSec || a.assetId - b.assetId)
    postProgress?.({
      phase: 'building',
      pointCount: records.length,
      builtIndexes,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${currentIndexLabel}: encoding ${indexLabel}`,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: records.length,
    })
    await yieldToEventLoop()
    const recordSize = TIME_GEO_RECORD_SIZE
    const header = new Uint8Array(PACKED_INDEX_HEADER_SIZE)
    const headerView = new DataView(header.buffer)
    const manifest = await this.ensureManifest()
    headerView.setUint32(0, PACKED_INDEX_MAGIC, true)
    headerView.setUint32(4, BINARY_SCHEMA_VERSION, true)
    headerView.setFloat64(8, manifest.catalogVersion, true)
    headerView.setFloat64(16, manifest.assetCount, true)
    headerView.setFloat64(24, records.length, true)
    headerView.setUint32(32, 0, true)
    headerView.setUint32(36, recordSize, true)
    headerView.setUint32(40, kind, true)
    headerView.setUint32(44, 0, true)
    headerView.setUint32(48, 0, true)
    headerView.setFloat64(56, PACKED_INDEX_HEADER_SIZE, true)
    headerView.setFloat64(80, manifest.indexAppliedVersion, true)
    const parts: BlobPart[] = [header]
    for (let offset = 0; offset < records.length; offset += PACKED_SCAN_RECORDS) {
      const chunk = records.slice(offset, offset + PACKED_SCAN_RECORDS)
      const bytes = new Uint8Array(chunk.length * recordSize)
      const view = new DataView(bytes.buffer)
      for (let index = 0; index < chunk.length; index += 1) {
        const record = chunk[index]
        const recordOffset = index * recordSize
        view.setUint32(recordOffset, record.timestampSec, true)
        view.setInt32(recordOffset + 4, record.latE7, true)
        view.setInt32(recordOffset + 8, record.lonE7, true)
        view.setUint32(recordOffset + 12, record.assetId, true)
        view.setUint8(recordOffset + 16, record.kindFlags)
        view.setUint8(recordOffset + 17, record.sourceCode ?? LINE_SOURCE_UNKNOWN)
        view.setUint16(recordOffset + 18, record.qualityFlags ?? 0, true)
        view.setFloat32(recordOffset + 20, record.accuracyMeters ?? Number.NaN, true)
        view.setFloat32(
          recordOffset + 24,
          record.velocityMetersPerSecond ?? Number.NaN,
          true,
        )
        view.setFloat32(recordOffset + 28, record.headingDegrees ?? Number.NaN, true)
        view.setUint32(recordOffset + 32, record.groupHashLo ?? 0, true)
        view.setUint32(recordOffset + 36, record.groupHashHi ?? 0, true)
        view.setInt32(recordOffset + 40, record.sequence ?? -1, true)
      }
      parts.push(bytes)
      const processed = Math.min(records.length, offset + chunk.length)
      if (processed % (PACKED_SCAN_RECORDS * 8) === 0 || processed === records.length) {
        postProgress?.({
          phase: 'building',
          pointCount: records.length,
          builtIndexes,
          totalIndexes: 1,
          currentIndexId: 'file-time-geo',
          currentIndexLabel: `${currentIndexLabel}: encoding ${indexLabel}`,
          currentIndexProcessedPoints: processed,
          currentIndexTotalPoints: records.length,
        })
        await yieldToEventLoop()
      }
    }
    postProgress?.({
      phase: 'building',
      pointCount: records.length,
      builtIndexes,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${currentIndexLabel}: writing ${indexLabel}`,
      currentIndexProcessedPoints: records.length,
      currentIndexTotalPoints: records.length,
    })
    await writeFileParts(indexesDir, fileName, parts)
    postProgress?.({
      phase: 'building',
      pointCount: records.length,
      builtIndexes: builtIndexes + 1,
      totalIndexes: 1,
      currentIndexId: 'file-time-geo',
      currentIndexLabel: `${currentIndexLabel}: wrote ${indexLabel}`,
      currentIndexProcessedPoints: records.length,
      currentIndexTotalPoints: records.length,
    })
  }

  private async buildFileCatalogIndexes(
    indexId: FileCatalogIndexId,
    postProgress: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary & { engineCount: number }> {
    if (this.backgroundIndexPromise) {
      await this.backgroundIndexPromise
    }
    const startedAt = performance.now()
    const label = 'Catalog packed indexes'
    console.log('[geo-index:worker] buildFileCatalogIndexes start', {
      indexId,
      label,
    })
    postProgress({
      phase: 'building',
      pointCount: 0,
      builtIndexes: 0,
      totalIndexes: 1,
      currentIndexId: indexId,
      currentIndexLabel: label,
    })
    let manifest = await this.ensureManifest()
    manifest.indexAppliedVersion = -1
    manifest.indexJob = {
      status: 'indexing',
      pendingSince: manifest.indexJob?.pendingSince ?? Date.now(),
      startedAt: Date.now(),
    }
    await this.saveManifest()
    if (manifest.materializedVersion !== manifest.catalogVersion) {
      console.log('[geo-index:worker] materializing catalog before file index build', {
        catalogVersion: manifest.catalogVersion,
        materializedVersion: manifest.materializedVersion,
      })
      postProgress({
        phase: 'building',
        pointCount: manifest.assetCount || manifest.occurrenceCount,
        builtIndexes: 0,
        totalIndexes: 1,
        currentIndexId: indexId,
        currentIndexLabel: `${label}: materializing catalog`,
        currentIndexProcessedPoints: 0,
        currentIndexTotalPoints: manifest.assetCount || manifest.occurrenceCount,
      })
      await this.materialize(postProgress, `${label}: materializing catalog`)
    }
    await this.writeMaterializedIndexFiles(postProgress, label)
    manifest = await this.ensureManifest()
    manifest.indexAppliedVersion = manifest.catalogVersion
    manifest.indexJob = {
      status: 'current',
      pendingSince: manifest.indexJob?.pendingSince,
      startedAt: manifest.indexJob?.startedAt,
      finishedAt: Date.now(),
    }
    await this.saveManifest()
    await this.ensureResidentPackedIndexes()
    console.log('[geo-index:worker] buildFileCatalogIndexes ready', {
      indexId,
      elapsedMs: performance.now() - startedAt,
      pointCount: manifest.assetCount,
    })
    postProgress({
      phase: 'ready',
      pointCount: manifest.assetCount,
      builtIndexes: 1,
      totalIndexes: 1,
      currentIndexId: indexId,
      currentIndexLabel: label,
      currentIndexProcessedPoints: manifest.assetCount,
      currentIndexTotalPoints: manifest.assetCount,
    })
    return {
      pointCount: manifest.assetCount,
      buildTimeMs: performance.now() - startedAt,
      engineCount: 1,
    }
  }

  private async fileCatalogIndexStats(
    indexId: FileCatalogIndexId,
  ): Promise<SearchIndexStats> {
    const manifest = await this.ensureManifest()
    const index = await this.readPackedIndexHeader()
    const resident = this.residentPackedIndexes.get(indexId)
    const indexCatalogVersion = index?.catalogVersion
    const isCurrent =
      Boolean(index) &&
      manifest.materializedVersion === manifest.catalogVersion &&
      manifest.indexAppliedVersion === manifest.catalogVersion &&
      indexCatalogVersion === manifest.catalogVersion
    const isResident =
      isCurrent &&
      resident?.catalogVersion === manifest.catalogVersion &&
      resident?.indexSizeBytes === index?.indexSizeBytes
    if (isCurrent && !isResident && !this.residentPackedIndexLoadError) {
      this.scheduleResidentPackedIndexPreload()
    }

    return {
      ...defaultSearchStats(
        indexId,
        fileCatalogIndexSpec().label,
      ),
      pointCount: manifest.assetCount,
      indexSizeBytes: index?.indexSizeBytes,
      residentBytes: isResident ? resident.indexSizeBytes : undefined,
      indexStorage: isResident ? 'memory' : 'disk',
      indexStatus: this.residentPackedIndexLoadError
        ? 'failed'
        : isCurrent
        ? 'current'
        : manifest.indexJob?.status === 'indexing'
          ? 'indexing'
          : manifest.indexJob?.status === 'pending'
            ? 'pending'
          : manifest.indexJob?.status === 'failed'
              ? 'failed'
              : index ? 'stale' : 'missing',
      catalogVersion: manifest.catalogVersion,
      indexCatalogVersion,
    }
  }

  private createMaterializedCatalog(
    version: number,
    assets: MediaItem[],
    alreadyNormalized = false,
  ): MaterializedCatalog {
    const normalized = alreadyNormalized
      ? assets
      : assets.map((item) => normalizeMediaItem(item, item.locations))
    const byId = new Map(normalized.map((item) => [item.id, item]))
    const geoPoints = normalized.flatMap((item) => {
      if (item.latitude === undefined || item.longitude === undefined) return []
      return [
        {
          mediaId: item.id,
          kind: item.kind,
          lat: item.latitude,
          lon: item.longitude,
          timestamp: item.timestamp,
        },
      ]
    })
    return {
      version,
      assets: normalized,
      byId,
      geoPoints,
    }
  }
}

async function residentDistanceIndexOpfsDirectory(
  engineId: ResidentPackedDistanceEngineId,
): Promise<FileSystemDirectoryHandle> {
  const root = await rootDirectory()
  const indexes = await childDirectory(root, 'indexes')
  const engine = await childDirectory(indexes, engineId)
  return childDirectory(engine, 'v3')
}

async function residentDistanceIndexEngineDirectory(
  engineId: ResidentPackedDistanceEngineId,
): Promise<FileSystemDirectoryHandle> {
  const root = await rootDirectory()
  const indexes = await childDirectory(root, 'indexes')
  return childDirectory(indexes, engineId)
}

function createOpfsResidentDistanceIndexStore(): ResidentPackedDistanceStore {
  return {
    async readManifest(engineId) {
      const directory = await residentDistanceIndexOpfsDirectory(engineId)
      const file = await readFile(directory, 'manifest.json')
      if (!file) return undefined
      return JSON.parse(await file.text()) as ResidentPackedDistanceManifest
    },
    async writeManifest(engineId, manifest) {
      const directory = await residentDistanceIndexOpfsDirectory(engineId)
      await writeFile(directory, 'manifest.json', JSON.stringify(manifest))
    },
    async readIndex(engineId) {
      const directory = await residentDistanceIndexOpfsDirectory(engineId)
      return (await readFile(directory, 'index.bin'))?.arrayBuffer()
    },
    async writeIndex(engineId, data) {
      const directory = await residentDistanceIndexOpfsDirectory(engineId)
      await writeFile(directory, 'index.bin', data)
    },
    async clear(engineId) {
      await clearDirectory(await residentDistanceIndexEngineDirectory(engineId))
    },
  }
}

async function buildSearchIndexes(
  store: CatalogStore,
  requestedIndexId: string,
  forceRebuild: boolean,
  postProgress: (progress: GeoIndexBuildProgress) => void,
): Promise<GeoIndexBuildSummary & { engineCount: number }> {
  const startedAt = performance.now()
  const selectedIndexId = isResidentDistanceEngineId(requestedIndexId)
    ? requestedIndexId
    : 'segmented-ball-tree'
  const catalogEpoch = await store.catalogEpoch()
  const distanceIndex = residentDistanceIndex(store, selectedIndexId)

  postProgress({
    phase: 'loading',
    pointCount: 0,
    builtIndexes: 0,
    totalIndexes: 1,
    currentIndexId: selectedIndexId,
    currentIndexLabel: distanceIndex.label,
  })

  if (!forceRebuild) {
    const restored = await distanceIndex.prepare(catalogEpoch)
    if (restored) {
      await distanceIndex.ensureResident(catalogEpoch)
      const stats = await distanceIndex.stats()
      postProgress({
        phase: 'ready',
        pointCount: stats.pointCount,
        builtIndexes: 1,
        totalIndexes: 1,
        currentIndexId: selectedIndexId,
        currentIndexLabel: distanceIndex.label,
      })
      return {
        pointCount: stats.pointCount,
        buildTimeMs: performance.now() - startedAt,
        engineCount: 1,
      }
    }
  }

  const pointCount = await distanceIndex.build(
    (onBatch) => store.forEachGeoAssetBatch(100_000, onBatch),
    catalogEpoch,
    (processedPoints, totalPoints) => {
      postProgress({
        phase: 'building',
        pointCount: totalPoints ?? processedPoints,
        builtIndexes: 0,
        totalIndexes: 1,
        currentIndexId: selectedIndexId,
        currentIndexLabel: distanceIndex.label,
        currentIndexProcessedPoints: processedPoints,
        currentIndexTotalPoints: totalPoints,
      })
    },
  )
  postProgress({
    phase: 'ready',
    pointCount,
    builtIndexes: 1,
    totalIndexes: 1,
    currentIndexId: selectedIndexId,
    currentIndexLabel: distanceIndex.label,
  })
  return {
    pointCount,
    buildTimeMs: performance.now() - startedAt,
    engineCount: 1,
  }
}

export async function fileContentHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function stableId(...parts: string[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(parts.join('\n')).buffer)
}

async function stableOccurrenceId(sourceId: string, relativePath: string): Promise<string> {
  return stableId(sourceId, relativePath)
}

async function writeThumbnail(id: string, file: File): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    return undefined
  }
  try {
    const bitmap = await createImageBitmap(file)
    const maxSide = 360
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.78,
    })
    const root = await navigator.storage.getDirectory()
    const thumbs = await childDirectory(root, 'thumbs')
    const key = `${id}.webp`
    await writeFile(thumbs, key, blob)
    return `thumbs/${key}`
  } catch {
    return undefined
  }
}

async function readImageMetadata(file: File): Promise<{
  timestamp?: number
  latitude?: number
  longitude?: number
}> {
  const metadata = await exifr
    .parse(file, {
      gps: true,
      exif: true,
      tiff: true,
      xmp: true,
      reviveValues: true,
    })
    .catch(() => undefined)
  const record = isRecord(metadata) ? metadata : {}
  return {
    latitude: numeric(record.latitude) ?? numeric(record.GPSLatitude),
    longitude: numeric(record.longitude) ?? numeric(record.GPSLongitude),
    timestamp:
      dateMillis(record.DateTimeOriginal) ??
      dateMillis(record.CreateDate) ??
      dateMillis(record.DateCreated) ??
      dateMillis(record.ModifyDate) ??
      dateMillis(record.DateTime),
  }
}

async function mediaFromFile(
  sourceId: string,
  sourceLabel: string,
  relativePath: string,
  fileHandle: FileSystemFileHandle,
): Promise<MediaItem | undefined> {
  const file = await fileHandle.getFile()
  const kind = detectMediaKind(file)
  if (!kind || kind === 'geo_point') return undefined
  const contentHash = await fileContentHash(file)
  const locationId = await stableOccurrenceId(sourceId, relativePath)
  const location: MediaLocation = {
    id: locationId,
    sourceId,
    sourceLabel,
    relativePath,
  }
  const base = {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath,
    displayName: pathDisplayName(relativePath),
    kind,
    mimeType: file.type || (kind === 'image' ? 'image/*' : 'video/*'),
    sizeBytes: file.size,
    locations: [location],
  }
  if (kind === 'video') {
    return {
      ...base,
      timestamp: file.lastModified || undefined,
    }
  }
  const imageMetadata = await readImageMetadata(file)
  const thumbnailKey = await writeThumbnail(contentHash, file)
  return {
    ...base,
    ...imageMetadata,
    timestamp: imageMetadata.timestamp ?? file.lastModified ?? undefined,
    thumbnailKey,
  }
}

function parsedItemContentHash(item: ParsedGeoItem): string {
  if (item.contentHash) return item.contentHash
  if (
    item.kind === 'geo_point' &&
    item.latitude !== undefined &&
    item.longitude !== undefined &&
    item.timestamp !== undefined
  ) {
    return geoPointContentHash(item.latitude, item.longitude, item.timestamp)
  }
  return semanticContentHash(item.kind, [
    item.timestamp,
    item.endTimestamp,
    item.latitude,
    item.longitude,
    item.sourceDataset,
    item.sourceType,
    item.groupId,
    item.sequence,
    JSON.stringify(item.metadata ?? {}),
  ])
}

function geoPointLocationId(
  sourceId: string,
  contentHash: string,
  item?: Pick<ParsedGeoItem, 'sourceDataset' | 'sourceType' | 'groupId' | 'sequence'>,
): string {
  return [
    'geo_point_location:v2',
    sourceId,
    contentHash,
    item?.sourceDataset ?? '',
    item?.sourceType ?? '',
    item?.groupId ?? '',
    item?.sequence ?? '',
  ].join(':')
}

function semanticLocationId(sourceId: string, contentHash: string): string {
  return `semantic_location:v1:${sourceId}:${contentHash}`
}

function mediaItemFromParsedGeoItem(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  item: ParsedGeoItem,
): MediaItem {
  const contentHash = parsedItemContentHash(item)
  const isPoint = item.kind === 'geo_point'
  const location: MediaLocation = {
    id: isPoint
      ? geoPointLocationId(sourceId, contentHash, item)
      : semanticLocationId(sourceId, contentHash),
    sourceId,
    sourceLabel,
    pointIndex: item.index,
    sourceDataset: item.sourceDataset,
    sourceType: item.sourceType,
    groupId: item.groupId,
    sequence: item.sequence,
    timestamp: item.timestamp,
    endTimestamp: item.endTimestamp,
  }
  return {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath: sourceLabel,
    displayName: item.displayName ?? `${sourceLabel} #${item.index}`,
    kind: item.kind,
    mimeType,
    sizeBytes: 0,
    durationMs: numeric(item.metadata?.durationMs),
    timestamp: item.timestamp,
    endTimestamp: item.endTimestamp,
    latitude: item.latitude,
    longitude: item.longitude,
    sourceDataset: item.sourceDataset,
    sourceType: item.sourceType,
    accuracyMeters: item.accuracyMeters,
    altitudeMeters: item.altitudeMeters,
    verticalAccuracyMeters: item.verticalAccuracyMeters,
    velocityMetersPerSecond: item.velocityMetersPerSecond,
    headingDegrees: item.headingDegrees,
    groupId: item.groupId,
    sequence: item.sequence,
    metadata: item.metadata,
    locations: [location],
  }
}

function geoPointItemFromParsedPoint(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  point: ParsedGeoPoint,
): MediaItem {
  const contentHash = geoPointContentHash(
    point.latitude,
    point.longitude,
    point.timestamp,
  )
  const location: MediaLocation = {
    id: geoPointLocationId(sourceId, contentHash, point),
    sourceId,
    sourceLabel,
    pointIndex: point.index,
    sourceDataset: point.sourceDataset,
    sourceType: point.sourceType,
    groupId: point.groupId,
    sequence: point.sequence,
    timestamp: point.timestamp,
    endTimestamp: point.endTimestamp,
  }
  return {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath: sourceLabel,
    displayName: `${sourceLabel} #${point.index}`,
    kind: 'geo_point',
    mimeType,
    sizeBytes: 0,
    timestamp: point.timestamp,
    endTimestamp: point.endTimestamp,
    latitude: point.latitude,
    longitude: point.longitude,
    sourceDataset: point.sourceDataset,
    sourceType: point.sourceType,
    accuracyMeters: point.accuracyMeters,
    altitudeMeters: point.altitudeMeters,
    verticalAccuracyMeters: point.verticalAccuracyMeters,
    velocityMetersPerSecond: point.velocityMetersPerSecond,
    headingDegrees: point.headingDegrees,
    groupId: point.groupId,
    sequence: point.sequence,
    metadata: point.metadata,
    locations: [location],
  }
}

function geoItemsFromParsedItems(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  items: ParsedGeoItem[],
): MediaItem[] {
  return items.map((item) =>
    mediaItemFromParsedGeoItem(sourceId, sourceLabel, mimeType, item),
  )
}

function geoPointItemsFromParsedPoints(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  points: ParsedGeoPoint[],
): MediaItem[] {
  return points.map((point) =>
    geoPointItemFromParsedPoint(sourceId, sourceLabel, mimeType, point),
  )
}

async function importFolderIntoCatalog(
  payload: ImportFolderPayload,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<ImportSummary> {
  const { source, duplicateSourceIds, handle } = payload
  const sourceLabel = source.label
  const errors: string[] = []
  const batch: MediaItem[] = []
  let totalFiles = 0
  let scannedFiles = 0
  let acceptedMedia = 0
  let skippedFiles = 0
  let cancelled = false

  const summary = (): ImportSummary => ({
    source,
    sourceLabel,
    scannedFiles,
    totalFiles,
    acceptedMedia,
    skippedFiles,
    errors,
    cancelled,
  })

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const items = batch.splice(0)
    await store.writeMediaBatch(items)
    postProgress({
      phase,
      sourceLabel,
      scannedFiles,
      totalFiles,
      acceptedMedia,
      skippedFiles,
    })
  }

  async function countFiles(directoryHandle: FileSystemDirectoryHandle): Promise<void> {
    for await (const [, entry] of directoryHandle.entries()) {
      if (isCancelled()) {
        cancelled = true
        return
      }
      if (entry.kind === 'directory') {
        await countFiles(entry as FileSystemDirectoryHandle)
      } else {
        totalFiles += 1
      }
    }
  }

  async function walk(directoryHandle: FileSystemDirectoryHandle, prefix: string): Promise<void> {
    for await (const [name, entry] of directoryHandle.entries()) {
      if (isCancelled()) {
        cancelled = true
        return
      }
      const relativePath = prefix ? `${prefix}/${name}` : name
      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, relativePath)
        if (cancelled) return
        continue
      }
      scannedFiles += 1
      try {
        const item = await mediaFromFile(
          source.id,
          sourceLabel,
          relativePath,
          entry as FileSystemFileHandle,
        )
        if (item) {
          batch.push(item)
          acceptedMedia += 1
          if (batch.length >= IMPORT_BATCH_SIZE) await flushBatch('scanning')
        } else {
          skippedFiles += 1
        }
      } catch (error) {
        skippedFiles += 1
        errors.push(
          `${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (scannedFiles % 20 === 0) {
        postProgress({
          phase: 'scanning',
          sourceLabel,
          scannedFiles,
          totalFiles,
          acceptedMedia,
          skippedFiles,
          currentPath: relativePath,
        })
      }
    }
  }

  postProgress({
    phase: 'counting',
    sourceLabel,
    scannedFiles: 0,
    totalFiles,
    acceptedMedia,
    skippedFiles,
  })
  await countFiles(handle)
  if (cancelled) return summary()
  await store.prepareImportSource(source, duplicateSourceIds)
  await store.withImportTransaction(async () => {
    await walk(handle, '')
    await flushBatch('storing')
  })
  return summary()
}

async function readFileTextWithProgress(
  file: File,
  sourceLabel: string,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<{ text: string; cancelled: boolean }> {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytesRead = 0
  let lastProgressAt = 0
  while (true) {
    if (isCancelled()) {
      await reader.cancel()
      return { text: '', cancelled: true }
    }
    const { done, value } = await reader.read()
    if (done) break
    bytesRead += value.byteLength
    chunks.push(decoder.decode(value, { stream: true }))
    const now = performance.now()
    if (now - lastProgressAt >= PROGRESS_HEARTBEAT_MS) {
      lastProgressAt = now
      postProgress({
        phase: 'scanning',
        sourceLabel,
        scannedFiles: 0,
        totalFiles: 1,
        acceptedMedia: 0,
        skippedFiles: 0,
        currentPath: sourceLabel,
        scannedBytes: bytesRead,
        totalBytes: file.size,
      })
    }
  }
  const finalChunk = decoder.decode()
  if (finalChunk) chunks.push(finalChunk)
  return { text: chunks.join(''), cancelled: false }
}

function jsonLikePrefix(prefix: string): boolean {
  const trimmed = prefix.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function throwKnownUnsupportedJsonPrefix(prefix: string): void {
  if (/"timelineObjects"\s*:/.test(prefix)) {
    throw new Error(
      'This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only the raw Records.json location export.',
    )
  }
  if (/"type"\s*:\s*"(FeatureCollection|Feature|Point)"/.test(prefix)) {
    throw new Error(
      'GeoJSON files are not supported yet. Supported formats are GPX and Google Takeout Location History JSON.',
    )
  }
}

async function importGpxIntoCatalog(
  file: File,
  source: MediaSource,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<{ acceptedMedia: number; skippedFiles: number; cancelled: boolean }> {
  const sourceLabel = source.label
  const readResult = await readFileTextWithProgress(file, sourceLabel, postProgress, isCancelled)
  if (readResult.cancelled) return { acceptedMedia: 0, skippedFiles: 0, cancelled: true }
  const parsed = parseGeoFilePoints(file.name || sourceLabel, readResult.text)
  let acceptedMedia = 0
  let cancelled = false
  const batch: MediaItem[] = []

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const flushedItems = batch.length
    await store.writeMediaBatch(batch.splice(0))
    acceptedMedia += flushedItems
    postProgress({
      phase,
      sourceLabel,
      scannedFiles: 1,
      totalFiles: 1,
      acceptedMedia,
      skippedFiles: parsed.skippedPoints,
      currentPath: sourceLabel,
      scannedBytes: file.size,
      totalBytes: file.size,
    })
    await yieldToEventLoop()
  }

  await store.withImportTransaction(async () => {
    for (let offset = 0; offset < parsed.points.length; offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      batch.push(
        ...geoPointItemsFromParsedPoints(
          source.id,
          sourceLabel,
          parsed.mimeType,
          parsed.points.slice(offset, offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE),
        ),
      )
      if (batch.length >= store.geoImportWriteBatchSize) await flushBatch('storing')
    }
    await flushBatch('storing')
  })
  return { acceptedMedia, skippedFiles: parsed.skippedPoints, cancelled }
}

async function importGoogleTakeoutIntoCatalog(
  file: File,
  source: MediaSource,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<{ acceptedMedia: number; skippedFiles: number; cancelled: boolean }> {
  const sourceLabel = source.label
  const parser = new GoogleTakeoutLocationStreamParser()
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const pendingPoints: ParsedGeoPoint[] = []
  const batch: MediaItem[] = []
  let bytesRead = 0
  let acceptedMedia = 0
  let skippedFiles = 0
  let lastProgressAt = 0
  let cancelled = false

  const emitProgress = (phase: ImportProgress['phase']) => {
    postProgress({
      phase,
      sourceLabel,
      scannedFiles: phase === 'storing' && bytesRead >= file.size ? 1 : 0,
      totalFiles: 1,
      acceptedMedia,
      skippedFiles,
      currentPath: sourceLabel,
      scannedBytes: bytesRead,
      totalBytes: file.size,
    })
  }
  const maybeEmitProgress = () => {
    const now = performance.now()
    if (now - lastProgressAt < PROGRESS_HEARTBEAT_MS) return
    lastProgressAt = now
    emitProgress('scanning')
  }
  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const flushedItems = batch.length
    await store.writeMediaBatch(batch.splice(0))
    acceptedMedia += flushedItems
    emitProgress(phase)
    await yieldToEventLoop()
  }
  const consumePoints = async () => {
    const points = pendingPoints.splice(0)
    for (let offset = 0; offset < points.length; offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      batch.push(
        ...geoPointItemsFromParsedPoints(
          source.id,
          sourceLabel,
          'application/json',
          points.slice(offset, offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE),
        ),
      )
      if (batch.length >= store.geoImportWriteBatchSize) await flushBatch('scanning')
      maybeEmitProgress()
      await yieldToEventLoop()
    }
  }
  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      const result = parser.feed(chunk, { maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS })
      chunk = ''
      skippedFiles += result.skippedPoints
      pendingPoints.push(...result.points)
      await consumePoints()
      maybeEmitProgress()
      if (cancelled || !result.paused) break
      await yieldToEventLoop()
    }
  }

  emitProgress('scanning')
  await store.withImportTransaction(async () => {
    while (true) {
      if (isCancelled()) {
        cancelled = true
        await reader.cancel()
        break
      }
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      await consumeText(decoder.decode(value, { stream: true }))
      if (cancelled) break
    }
    if (!cancelled) {
      const finalChunk = decoder.decode()
      if (finalChunk) await consumeText(finalChunk)
      const final = parser.finish()
      skippedFiles = final.skippedPoints
      await consumePoints()
    }
    await flushBatch('storing')
  })
  emitProgress('storing')
  return { acceptedMedia, skippedFiles, cancelled }
}

async function importGoogleTimelineIntoCatalog(
  file: File,
  source: MediaSource,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<{ acceptedMedia: number; skippedFiles: number; cancelled: boolean }> {
  const sourceLabel = source.label
  const readResult = await readFileTextWithProgress(file, sourceLabel, postProgress, isCancelled)
  if (readResult.cancelled) return { acceptedMedia: 0, skippedFiles: 0, cancelled: true }
  const parsed = parseGeoFilePoints(file.name || sourceLabel, readResult.text)
  const items = parsed.items ?? parsed.points.map((point) => ({ ...point, kind: 'geo_point' as const }))
  let acceptedMedia = 0
  let cancelled = false
  const batch: MediaItem[] = []

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const flushedItems = batch.length
    await store.writeMediaBatch(batch.splice(0))
    acceptedMedia += flushedItems
    postProgress({
      phase,
      sourceLabel,
      scannedFiles: 1,
      totalFiles: 1,
      acceptedMedia,
      skippedFiles: parsed.skippedPoints,
      currentPath: sourceLabel,
      scannedBytes: file.size,
      totalBytes: file.size,
    })
    await yieldToEventLoop()
  }

  await store.withImportTransaction(async () => {
    for (let offset = 0; offset < items.length; offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      batch.push(
        ...geoItemsFromParsedItems(
          source.id,
          sourceLabel,
          parsed.mimeType,
          items.slice(offset, offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE),
        ),
      )
      if (batch.length >= store.geoImportWriteBatchSize) await flushBatch('storing')
    }
    await flushBatch('storing')
  })
  return { acceptedMedia, skippedFiles: parsed.skippedPoints, cancelled }
}

async function importGeoFileIntoCatalog(
  payload: ImportGeoFilePayload,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  isCancelled: CancellationSignal,
): Promise<ImportSummary> {
  const { source, duplicateSourceIds, file } = payload
  const sourceLabel = source.label
  const cancelledSummary = (): ImportSummary => ({
    source,
    sourceLabel,
    scannedFiles: 0,
    totalFiles: 1,
    acceptedMedia: 0,
    skippedFiles: 0,
    errors: [],
    cancelled: true,
  })
  postProgress({
    phase: 'counting',
    sourceLabel,
    scannedFiles: 0,
    totalFiles: 1,
    acceptedMedia: 0,
    skippedFiles: 0,
    currentPath: sourceLabel,
    scannedBytes: 0,
    totalBytes: file.size,
  })
  if (isCancelled()) return cancelledSummary()
  await store.prepareImportSource(source, duplicateSourceIds)
  if (isCancelled()) return cancelledSummary()
  const prefix = await file.slice(0, GEO_IMPORT_PREFIX_BYTES).text()
  if (isCancelled()) return cancelledSummary()
  const result = jsonLikePrefix(prefix)
    ? await (async () => {
        throwKnownUnsupportedJsonPrefix(prefix)
        if (
          /"semanticSegments"\s*:/.test(prefix) ||
          /"rawSignals"\s*:/.test(prefix) ||
          /"userLocationProfile"\s*:/.test(prefix)
        ) {
          return importGoogleTimelineIntoCatalog(file, source, store, postProgress, isCancelled)
        }
        return importGoogleTakeoutIntoCatalog(file, source, store, postProgress, isCancelled)
      })()
    : await importGpxIntoCatalog(file, source, store, postProgress, isCancelled)
  return {
    source,
    sourceLabel,
    scannedFiles: 1,
    totalFiles: 1,
    acceptedMedia: result.acceptedMedia,
    skippedFiles: result.skippedFiles,
    errors: [],
    cancelled: result.cancelled,
  }
}

const fileCatalogStore = new FileCatalogStore()

async function handleRequest(
  request: WorkerRequest,
  postProgress: (progress: GeoIndexBuildProgress | ImportProgress) => void,
): Promise<unknown> {
  const store = fileCatalogStore
  switch (request.type) {
    case 'init':
      return store.init()
    case 'upsertSource':
      return store.upsertSource(request.payload as MediaSource)
    case 'upsertMedia':
      return store.upsertMedia(request.payload as MediaItem[])
    case 'importFolder':
      return importFolderIntoCatalog(
        request.payload as ImportFolderPayload,
        store,
        postProgress,
        () => cancelledRequests.has(request.id),
      )
    case 'importGeoFile':
      return importGeoFileIntoCatalog(
        request.payload as ImportGeoFilePayload,
        store,
        postProgress,
        () => cancelledRequests.has(request.id),
      )
    case 'commitImport':
      return store.commitImport()
    case 'listMedia':
      return store.listMedia(request.payload as CatalogQuery)
    case 'searchMedia':
      return store.searchMedia(
        request.payload as SearchSpec,
        () => cancelledRequests.has(request.id),
      )
    case 'searchMapPoints':
      return store.searchMapPoints(
        request.payload as SearchSpec,
        () => cancelledRequests.has(request.id),
      )
    case 'getMediaByIds':
      return store.getMediaByIds(request.payload as string[])
    case 'getGeoPoints':
      return store.getGeoPoints(request.payload as TimeRange)
    case 'countMedia':
      return store.countMedia()
    case 'buildGeoIndexes':
      return store.buildSearchIndexes('segmented-ball-tree', false, postProgress)
    case 'buildSearchIndexes': {
      const payload = request.payload as { indexId: string; forceRebuild?: boolean }
      return store.buildSearchIndexes(
        payload.indexId,
        Boolean(payload.forceRebuild),
        postProgress,
      )
    }
    case 'searchGeoIndex': {
      const payload = request.payload as { indexId: string; query: GeoSearchQuery }
      if (isResidentDistanceEngineId(payload.indexId)) {
        await store.ensureSearchIndexReady(payload.indexId)
      }
      const distanceIndex = activeResidentDistanceIndex(payload.indexId)
      if (distanceIndex) {
        const results = await distanceIndex.search(payload.query)
        const resultAssetIds = Array.from(new Set(results.map((result) => result.assetId)))
        const items = await store.getMediaByAssetIds(resultAssetIds)
        const itemsByAssetId = new Map(
          items.map((result) => [result.assetId, result.item]),
        )
        return results.flatMap((result) => {
          const item = itemsByAssetId.get(result.assetId)
          return item ? [{ mediaId: item.id, distanceMeters: result.distanceMeters }] : []
        })
      }
      return geoIndexRegistry.get(payload.indexId).search(payload.query)
    }
    case 'getGeoIndexStats': {
      const indexId = request.payload as string
      const distanceIndex = activeResidentDistanceIndex(indexId)
      return distanceIndex ? distanceIndex.stats() : geoIndexRegistry.get(indexId).stats()
    }
    case 'getSearchIndexStats':
      return store.getSearchIndexStats()
    case 'validateGeoIndex': {
      const payload = request.payload as { indexId: string; query: GeoSearchQuery }
      if (isResidentDistanceEngineId(payload.indexId)) {
        await store.ensureSearchIndexReady(payload.indexId)
      }
      const distanceIndex = activeResidentDistanceIndex(payload.indexId)
      return distanceIndex
        ? distanceIndex.validateAgainstBruteForce(payload.query)
        : geoIndexRegistry.get(payload.indexId).validateAgainstBruteForce(payload.query)
    }
    case 'clear':
      return store.clear()
    default:
      throw new Error(`Unknown catalog worker request: ${request.type}`)
  }
}

const ctx = globalThis as unknown as {
  addEventListener?: (
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void
  postMessage?: (message: unknown) => void
}

function postBackgroundIndexProgress(progress: GeoIndexBuildProgress): void {
  ctx.postMessage?.({ type: 'backgroundProgress', progress })
}

if (typeof document === 'undefined' && ctx.addEventListener && ctx.postMessage) {
  ctx.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    if (event.data.type === 'cancel') {
      cancelledRequests.add(event.data.id)
      return
    }
    const postProgress = (progress: GeoIndexBuildProgress | ImportProgress) => {
      ctx.postMessage?.({ id: event.data.id, type: 'progress', progress })
    }
    handleRequest(event.data, postProgress)
      .then((result) => {
        ctx.postMessage?.({ id: event.data.id, ok: true, result })
      })
      .catch((caught) => {
        ctx.postMessage?.({
          id: event.data.id,
          ok: false,
          error: caught instanceof Error ? caught.message : String(caught),
        })
      })
      .finally(() => {
        cancelledRequests.delete(event.data.id)
      })
  })
}
