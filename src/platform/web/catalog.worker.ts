import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import * as exifr from 'exifr'
import { GeoIndexRegistry } from '../../geo/registry'
import {
  geoPointContentHash,
  parseGeoFilePoints,
  type ParsedGeoPoint,
} from '../../lib/geoPoint'
import { GoogleTakeoutLocationStreamParser } from '../../lib/googleTakeoutStream'
import { detectMediaKind, pathDisplayName } from '../../lib/media'
import type {
  CapturedAtSource,
  CatalogQuery,
  GeoSource,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MediaItem,
  MediaLocation,
  MediaSource,
  TimeRange,
  ValidationReport,
} from '../../types'
import type {
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  GeoParseDebugSummary,
  ImportProgress,
  ImportSummary,
} from '../types'
import type { WebCatalogStorageMode } from './storageMode'

type WorkerRequest = {
  id: number
  type: string
  storageMode?: WebCatalogStorageMode
  payload?: unknown
}

type InitResult = {
  storageMode: 'opfs' | 'indexeddb'
  sqliteVersion: string
  filename: string
}

type SqliteDb = {
  filename: string
  exec: (sqlOrOptions: unknown, options?: unknown) => unknown
  prepare: (sql: string) => {
    bind: (values: unknown[] | Record<string, unknown>) => {
      stepReset: (clearBindings?: boolean) => void
    }
    finalize: () => void
  }
  selectObjects: (
    sql: string,
    bind?: unknown[],
  ) => Record<string, unknown>[]
  selectValue: (sql: string, bind?: unknown[]) => unknown
}

type IdbAsset = {
  contentHash: string
  kind: MediaItem['kind']
  mimeType: string
  sizeBytes: number
  width?: number
  height?: number
  durationMs?: number
  capturedAt?: number
  capturedAtSource?: MediaItem['capturedAtSource']
  latitude?: number
  longitude?: number
  geoSource?: MediaItem['geoSource']
  thumbnailKey?: string
  lastSeenAt: number
}

type IdbLocation = MediaLocation & {
  contentHash: string
}

type SqliteUpsertChunkTiming = {
  offset: number
  rows: number
  columnCount: number
  bindValues: number
  sqlChars: number
  placeholderMs: number
  sqlBuildMs: number
  bindFlattenMs: number
  execMs: number
}

type SqliteUpsertTiming = {
  label: string
  rows: number
  columnCount: number
  chunks: number
  bindValues: number
  sqlChars: number
  placeholderMs: number
  sqlBuildMs: number
  bindFlattenMs: number
  execMs: number
  totalMs: number
  chunkTimings: SqliteUpsertChunkTiming[]
}

type SqliteMediaWriteTiming = {
  items: number
  locations: number
  totalMs: number
  assetRowsMs: number
  locationRowsMs: number
  asset: SqliteUpsertTiming
  location: SqliteUpsertTiming
  accountedMs: number
  unaccountedMs: number
}

type MediaBatchWriteTiming = {
  storageMode: WebCatalogStorageMode
  items: number
  transactionActive: boolean
  totalMs: number
  ensureDbMs: number
  requireDbMs: number
  writeMs: number
  accountedMs: number
  unaccountedMs: number
  sqlite?: SqliteMediaWriteTiming
}

type MediaBatchWriteResult = {
  written: number
  timing: MediaBatchWriteTiming
}

type ImportTransactionOptions = {
  traceId?: string
  sourceLabel?: string
}

type CatalogStore = {
  geoImportWriteBatchSize: number
  init(): Promise<InitResult>
  upsertSource(source: MediaSource): Promise<void>
  upsertMedia(items: MediaItem[]): Promise<number>
  prepareImportSource(
    source: MediaSource,
    duplicateSourceIds: string[],
  ): Promise<void>
  writeMediaBatch(
    items: MediaItem[],
    options?: { transactionActive?: boolean },
  ): Promise<MediaBatchWriteResult>
  withImportTransaction<T>(
    run: () => Promise<T>,
    options?: ImportTransactionOptions,
  ): Promise<T>
  listMedia(query: CatalogQuery): Promise<MediaItem[]>
  getMediaByIds(ids: string[]): Promise<MediaItem[]>
  getGeoPoints(range: TimeRange): Promise<GeoIndexPoint[]>
  listSources(): Promise<MediaSource[]>
  removeSources(sourceIds: string[]): Promise<void>
  countMedia(): Promise<number>
  clear(): Promise<void>
}

let db: SqliteDb | undefined
let initResult: InitResult | undefined
let indexedDb: IDBDatabase | undefined
let indexedDbInitResult: InitResult | undefined
const geoIndexRegistry = new GeoIndexRegistry()

const IMPORT_BATCH_SIZE = 1000
const SQLITE_BIND_CHUNK_LIMIT = 12000
const ASSET_BIND_COLUMNS = 14
const LOCATION_BIND_COLUMNS = 6
const GEO_IMPORT_PREFIX_BYTES = 512 * 1024
const GEO_IMPORT_PARSE_SLICE_MS = 250
const PROGRESS_HEARTBEAT_MS = 1000
const GEO_POINT_ITEM_BUILD_CHUNK_SIZE = 250
const GEO_IMPORT_SQLITE_WRITE_BATCH_SIZE = 250
const GEO_IMPORT_INDEXEDDB_WRITE_BATCH_SIZE = 2000
const INDEXED_DB_NAME = 'zeitfaden-catalog-indexeddb-v2'
const INDEXED_DB_VERSION = 1

const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void
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
  traceId?: string
}

type DebugParseGeoFilePayload = {
  file: File
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function stableId(...parts: string[]): Promise<string> {
  const encoded = new TextEncoder().encode(parts.join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return bytesToHex(new Uint8Array(digest))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function dateMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function ensureDb(): Promise<InitResult> {
  if (db && initResult) return initResult

  const sqlite3 = await sqlite3InitModule()
  const opfsVfs = sqlite3.capi.sqlite3_vfs_find('opfs')
  const opfsDb = sqlite3.oo1.OpfsDb

  if (!opfsVfs || !opfsDb) {
    throw new Error(
      'SQLite OPFS storage is unavailable. Use a modern browser served with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
    )
  }

  db = new opfsDb('/catalog-v3.sqlite3') as unknown as SqliteDb
  const activeDb = db

  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      content_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      duration_ms INTEGER,
      captured_at INTEGER,
      captured_at_source TEXT,
      latitude REAL,
      longitude REAL,
      geo_source TEXT,
      thumbnail_key TEXT,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_locations (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      last_seen_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_assets_captured_at
      ON media_assets(captured_at);
    CREATE INDEX IF NOT EXISTS idx_media_assets_kind
      ON media_assets(kind);
    CREATE INDEX IF NOT EXISTS idx_media_assets_geo
      ON media_assets(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
      ON media_locations(content_hash);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source
      ON media_locations(source_id);
  `)

  initResult = {
    storageMode: 'opfs',
    sqliteVersion: sqlite3.version.libVersion,
    filename: activeDb.filename,
  }

  return initResult
}

function requireDb(): SqliteDb {
  if (!db) throw new Error('Catalog database is not initialized')
  return db
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return undefined
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function iterateIdbCursor(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => boolean | void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }

      try {
        if (visit(cursor) === false) {
          resolve()
          return
        }
        cursor.continue()
      } catch (error) {
        reject(error)
      }
    }
  })
}

function ensureIdbIndex(
  store: IDBObjectStore,
  name: string,
  keyPath: string | string[],
): void {
  if (!store.indexNames.contains(name)) {
    store.createIndex(name, keyPath)
  }
}

async function ensureIndexedDb(): Promise<InitResult> {
  if (indexedDb && indexedDbInitResult) return indexedDbInitResult
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable in this browser.')
  }

  indexedDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(INDEXED_DB_NAME, INDEXED_DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result

      if (!database.objectStoreNames.contains('sources')) {
        const sources = database.createObjectStore('sources', { keyPath: 'id' })
        sources.createIndex('addedAt', 'addedAt')
      } else {
        const sources = request.transaction?.objectStore('sources')
        if (sources) ensureIdbIndex(sources, 'addedAt', 'addedAt')
      }

      if (!database.objectStoreNames.contains('assets')) {
        const assets = database.createObjectStore('assets', {
          keyPath: 'contentHash',
        })
        assets.createIndex('capturedAt', 'capturedAt')
      } else {
        const assets = request.transaction?.objectStore('assets')
        if (assets) {
          ensureIdbIndex(assets, 'capturedAt', 'capturedAt')
        }
      }

      if (!database.objectStoreNames.contains('locations')) {
        const locations = database.createObjectStore('locations', {
          keyPath: 'id',
        })
        locations.createIndex('contentHash', 'contentHash')
        locations.createIndex('sourceId', 'sourceId')
      } else {
        const locations = request.transaction?.objectStore('locations')
        if (locations) {
          ensureIdbIndex(locations, 'contentHash', 'contentHash')
          ensureIdbIndex(locations, 'sourceId', 'sourceId')
        }
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB catalog failed to open'))
    request.onblocked = () =>
      reject(new Error('IndexedDB catalog upgrade is blocked by another tab.'))
  })

  indexedDb.onversionchange = () => {
    indexedDb?.close()
    indexedDb = undefined
    indexedDbInitResult = undefined
  }

  indexedDbInitResult = {
    storageMode: 'indexeddb',
    sqliteVersion: 'IndexedDB',
    filename: INDEXED_DB_NAME,
  }

  return indexedDbInitResult
}

async function requireIndexedDb(): Promise<IDBDatabase> {
  await ensureIndexedDb()
  if (!indexedDb) throw new Error('IndexedDB catalog is not initialized')
  return indexedDb
}

function idbAssetFromItem(
  item: MediaItem,
  existing?: IdbAsset,
): IdbAsset {
  return {
    contentHash: item.contentHash,
    kind: item.kind,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    capturedAt: item.capturedAt,
    capturedAtSource: item.capturedAtSource,
    latitude: item.latitude,
    longitude: item.longitude,
    geoSource: item.geoSource,
    thumbnailKey: item.thumbnailKey ?? existing?.thumbnailKey,
    lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, item.lastSeenAt),
  }
}

function mediaFromIdbAsset(
  asset: IdbAsset,
  locations: MediaLocation[],
  preferredSourceId?: string,
): MediaItem {
  const row = {
    content_hash: asset.contentHash,
    kind: asset.kind,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    duration_ms: asset.durationMs,
    captured_at: asset.capturedAt,
    captured_at_source: asset.capturedAtSource,
    latitude: asset.latitude,
    longitude: asset.longitude,
    geo_source: asset.geoSource,
    thumbnail_key: asset.thumbnailKey,
    last_seen_at: asset.lastSeenAt,
  }
  return mediaFromAssetRow(row, locations, preferredSourceId)
}

function mediaLocationFromIdbLocation(location: IdbLocation): MediaLocation {
  return {
    id: location.id,
    sourceId: location.sourceId,
    relativePath: location.relativePath,
    absolutePath: location.absolutePath,
    displayName: location.displayName,
    lastSeenAt: location.lastSeenAt,
  }
}

async function idbExistingAssets(
  database: IDBDatabase,
  contentHashes: string[],
): Promise<Map<string, IdbAsset>> {
  const uniqueHashes = Array.from(new Set(contentHashes))
  if (uniqueHashes.length === 0) return new Map()

  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  const store = transaction.objectStore('assets')
  const requests = uniqueHashes.map((hash) =>
    idbRequest<IdbAsset | undefined>(store.get(hash)),
  )
  const results = await Promise.all(requests)
  await done

  const assets = new Map<string, IdbAsset>()
  for (const asset of results) {
    if (asset) assets.set(asset.contentHash, asset)
  }
  return assets
}

async function idbLocationsForHash(
  database: IDBDatabase,
  contentHash: string,
): Promise<MediaLocation[]> {
  const transaction = database.transaction('locations', 'readonly')
  const done = idbTransactionDone(transaction)
  const index = transaction.objectStore('locations').index('contentHash')
  const rows = await idbRequest<IdbLocation[]>(index.getAll(contentHash))
  await done
  return rows.map(mediaLocationFromIdbLocation)
}

async function idbMediaItemsFromAssets(
  database: IDBDatabase,
  assets: IdbAsset[],
  preferredSourceId?: string,
): Promise<MediaItem[]> {
  if (assets.length === 0) return []

  const locationLists = await Promise.all(
    assets.map((asset) => idbLocationsForHash(database, asset.contentHash)),
  )

  return assets.map((asset, index) =>
    mediaFromIdbAsset(asset, locationLists[index] ?? [], preferredSourceId),
  )
}

async function idbUpsertSource(source: MediaSource): Promise<void> {
  const database = await requireIndexedDb()
  const transaction = database.transaction('sources', 'readwrite')
  const done = idbTransactionDone(transaction)
  transaction.objectStore('sources').put(source)
  await done
}

async function idbUpsertMedia(items: MediaItem[]): Promise<number> {
  if (items.length === 0) return 0

  const database = await requireIndexedDb()
  const needsExistingAssets = items.some(
    (item) => item.kind !== 'geo_point' || item.thumbnailKey !== undefined,
  )
  const existingAssets = needsExistingAssets
    ? await idbExistingAssets(
        database,
        items.map((item) => item.contentHash),
      )
    : new Map<string, IdbAsset>()
  const transaction = database.transaction(['assets', 'locations'], 'readwrite')
  const done = idbTransactionDone(transaction)
  const assets = transaction.objectStore('assets')
  const locations = transaction.objectStore('locations')

  for (const item of items) {
    assets.put(idbAssetFromItem(item, existingAssets.get(item.contentHash)))
    for (const location of itemLocations(item)) {
      locations.put({
        ...location,
        contentHash: item.contentHash,
      } satisfies IdbLocation)
    }
  }

  await done
  return items.length
}

async function idbRemoveSources(sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return

  const database = await requireIndexedDb()
  const locationsBySource = await Promise.all(
    sourceIds.map(async (sourceId) => {
      const transaction = database.transaction('locations', 'readonly')
      const done = idbTransactionDone(transaction)
      const rows = await idbRequest<IdbLocation[]>(
        transaction.objectStore('locations').index('sourceId').getAll(sourceId),
      )
      await done
      return rows
    }),
  )
  const locationsToDelete = locationsBySource.flat()
  const affectedHashes = Array.from(
    new Set(locationsToDelete.map((location) => location.contentHash)),
  )

  const deleteTransaction = database.transaction(
    ['sources', 'locations'],
    'readwrite',
  )
  const deleteDone = idbTransactionDone(deleteTransaction)
  const sourceStore = deleteTransaction.objectStore('sources')
  const locationStore = deleteTransaction.objectStore('locations')
  for (const sourceId of sourceIds) {
    sourceStore.delete(sourceId)
  }
  for (const location of locationsToDelete) {
    locationStore.delete(location.id)
  }
  await deleteDone

  const orphanHashes: string[] = []
  for (const contentHash of affectedHashes) {
    const locations = await idbLocationsForHash(database, contentHash)
    if (locations.length === 0) orphanHashes.push(contentHash)
  }

  if (orphanHashes.length > 0) {
    const assetTransaction = database.transaction('assets', 'readwrite')
    const assetDone = idbTransactionDone(assetTransaction)
    const assets = assetTransaction.objectStore('assets')
    for (const contentHash of orphanHashes) {
      assets.delete(contentHash)
    }
    await assetDone
  }
}

async function idbPrepareImportSource(
  source: MediaSource,
  duplicateSourceIds: string[],
): Promise<void> {
  await idbRemoveSources(duplicateSourceIds)
  await idbUpsertSource(source)
}

function idbAssetMatchesQuery(
  asset: IdbAsset,
  query: CatalogQuery,
  sourceHashes?: Set<string>,
): boolean {
  if (query.kind === 'media') {
    if (asset.kind !== 'image' && asset.kind !== 'video') return false
  } else if (query.kind && query.kind !== 'all' && asset.kind !== query.kind) {
    return false
  }
  if (sourceHashes && !sourceHashes.has(asset.contentHash)) return false
  if (query.hasGeo === true && (asset.latitude === undefined || asset.longitude === undefined)) {
    return false
  }
  if (query.hasGeo === false && asset.latitude !== undefined && asset.longitude !== undefined) {
    return false
  }
  if (query.geoBounds) {
    if (
      asset.latitude === undefined ||
      asset.longitude === undefined ||
      asset.latitude < query.geoBounds.minLat ||
      asset.latitude > query.geoBounds.maxLat ||
      asset.longitude < query.geoBounds.minLon ||
      asset.longitude > query.geoBounds.maxLon
    ) {
      return false
    }
  }
  if (query.startTime !== undefined) {
    if (asset.capturedAt === undefined || asset.capturedAt < query.startTime) {
      return false
    }
  }
  if (query.endTime !== undefined) {
    if (asset.capturedAt === undefined || asset.capturedAt > query.endTime) {
      return false
    }
  }
  return true
}

async function idbSourceContentHashes(
  database: IDBDatabase,
  sourceId: string | undefined,
): Promise<Set<string> | undefined> {
  if (!sourceId) return undefined

  const transaction = database.transaction('locations', 'readonly')
  const done = idbTransactionDone(transaction)
  const rows = await idbRequest<IdbLocation[]>(
    transaction.objectStore('locations').index('sourceId').getAll(sourceId),
  )
  await done
  return new Set(rows.map((location) => location.contentHash))
}

function capturedAtRange(query: TimeRange): IDBKeyRange | undefined {
  if (query.startTime !== undefined && query.endTime !== undefined) {
    return IDBKeyRange.bound(query.startTime, query.endTime)
  }
  if (query.startTime !== undefined) return IDBKeyRange.lowerBound(query.startTime)
  if (query.endTime !== undefined) return IDBKeyRange.upperBound(query.endTime)
  return undefined
}

async function idbListMedia(query: CatalogQuery): Promise<MediaItem[]> {
  const database = await requireIndexedDb()
  const sourceHashes = await idbSourceContentHashes(database, query.sourceId)
  const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
  const offset = Math.max(0, query.offset ?? 0)
  const results: IdbAsset[] = []
  let skipped = 0

  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  const index = transaction.objectStore('assets').index('capturedAt')
  const direction = query.sort === 'captured_at_asc' ? 'next' : 'prev'
  await iterateIdbCursor(
    index.openCursor(capturedAtRange(query), direction),
    (cursor) => {
      const asset = cursor.value as IdbAsset
      if (!idbAssetMatchesQuery(asset, query, sourceHashes)) return
      if (skipped < offset) {
        skipped += 1
        return
      }
      results.push(asset)
      return results.length < limit
    },
  )
  await done

  return idbMediaItemsFromAssets(database, results, query.sourceId)
}

async function idbGetMediaByIds(ids: string[]): Promise<MediaItem[]> {
  if (ids.length === 0) return []

  const database = await requireIndexedDb()
  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  const store = transaction.objectStore('assets')
  const assets = await Promise.all(
    ids.map((id) => idbRequest<IdbAsset | undefined>(store.get(id))),
  )
  await done
  const byId = new Map(
    (await idbMediaItemsFromAssets(
      database,
      assets.filter((asset): asset is IdbAsset => Boolean(asset)),
    )).map((item) => [item.id, item]),
  )
  return ids.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
}

async function idbGetGeoPoints(range: TimeRange): Promise<GeoIndexPoint[]> {
  const database = await requireIndexedDb()
  const points: GeoIndexPoint[] = []
  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  await iterateIdbCursor(
    transaction.objectStore('assets').openCursor(),
    (cursor) => {
      const asset = cursor.value as IdbAsset
      if (
        asset.latitude === undefined ||
        asset.longitude === undefined ||
        (range.startTime !== undefined &&
          (asset.capturedAt === undefined || asset.capturedAt < range.startTime)) ||
        (range.endTime !== undefined &&
          (asset.capturedAt === undefined || asset.capturedAt > range.endTime))
      ) {
        return
      }
      points.push({
        mediaId: asset.contentHash,
        kind: asset.kind,
        lat: asset.latitude,
        lon: asset.longitude,
        capturedAt: asset.capturedAt,
      })
    },
  )
  await done
  points.sort((a, b) => a.mediaId.localeCompare(b.mediaId))
  return points
}

async function idbListSources(): Promise<MediaSource[]> {
  const database = await requireIndexedDb()
  const transaction = database.transaction('sources', 'readonly')
  const done = idbTransactionDone(transaction)
  const sources = await idbRequest<MediaSource[]>(
    transaction.objectStore('sources').getAll(),
  )
  await done
  return sources.sort((a, b) => b.addedAt - a.addedAt)
}

async function idbCountMedia(): Promise<number> {
  const database = await requireIndexedDb()
  let count = 0
  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  await iterateIdbCursor(transaction.objectStore('assets').openCursor(), (cursor) => {
    if (cursor.value) count += 1
  })
  await done
  return count
}

async function idbClear(): Promise<void> {
  const database = await requireIndexedDb()
  const transaction = database.transaction(
    ['sources', 'assets', 'locations'],
    'readwrite',
  )
  const done = idbTransactionDone(transaction)
  transaction.objectStore('locations').clear()
  transaction.objectStore('assets').clear()
  transaction.objectStore('sources').clear()
  await done
}

function locationFromRow(row: Record<string, unknown>): MediaLocation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    relativePath: String(row.relative_path),
    displayName: String(row.display_name),
    lastSeenAt: toNumber(row.last_seen_at) ?? 0,
  }
}

function mediaFromAssetRow(
  row: Record<string, unknown>,
  locations: MediaLocation[],
  preferredSourceId?: string,
): MediaItem {
  const contentHash = String(row.content_hash)
  const sortedLocations = [...locations].sort((a, b) => {
    if (preferredSourceId) {
      if (a.sourceId === preferredSourceId && b.sourceId !== preferredSourceId) {
        return -1
      }
      if (b.sourceId === preferredSourceId && a.sourceId !== preferredSourceId) {
        return 1
      }
    }
    return (
      (a.relativePath ?? '').localeCompare(b.relativePath ?? '') ||
      a.id.localeCompare(b.id)
    )
  })
  const primaryLocation = sortedLocations[0] ?? {
    id: contentHash,
    sourceId: '',
    relativePath: '',
    displayName: contentHash,
    lastSeenAt: toNumber(row.last_seen_at) ?? 0,
  }

  return {
    id: contentHash,
    contentHash,
    sourceId: primaryLocation.sourceId,
    relativePath: primaryLocation.relativePath ?? '',
    displayName: primaryLocation.displayName,
    kind:
      row.kind === 'video' || row.kind === 'geo_point'
        ? row.kind
        : 'image',
    mimeType: String(row.mime_type),
    sizeBytes: toNumber(row.size_bytes) ?? 0,
    width: toNumber(row.width),
    height: toNumber(row.height),
    durationMs: toNumber(row.duration_ms),
    capturedAt: toNumber(row.captured_at),
    capturedAtSource: toString(row.captured_at_source) as
      | MediaItem['capturedAtSource']
      | undefined,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    geoSource: toString(row.geo_source) as MediaItem['geoSource'] | undefined,
    thumbnailKey: toString(row.thumbnail_key),
    lastSeenAt: toNumber(row.last_seen_at) ?? 0,
    locations: sortedLocations,
  }
}

function sourceFromRow(row: Record<string, unknown>): MediaSource {
  return {
    id: String(row.id),
    label: String(row.label),
    addedAt: toNumber(row.added_at) ?? 0,
  }
}

function assetBind(item: MediaItem): unknown[] {
  return [
    item.contentHash,
    item.kind,
    item.mimeType,
    item.sizeBytes,
    item.width ?? null,
    item.height ?? null,
    item.durationMs ?? null,
    item.capturedAt ?? null,
    item.capturedAtSource ?? null,
    item.latitude ?? null,
    item.longitude ?? null,
    item.geoSource ?? null,
    item.thumbnailKey ?? null,
    item.lastSeenAt,
  ]
}

function itemLocations(item: MediaItem): MediaLocation[] {
  if (item.locations.length > 0) return item.locations
  return [
    {
      id: `${item.sourceId}:${item.relativePath}`,
      sourceId: item.sourceId,
      relativePath: item.relativePath,
      displayName: item.displayName,
      lastSeenAt: item.lastSeenAt,
    },
  ]
}

function upsertSourceIntoSqlite(activeDb: SqliteDb, source: MediaSource): void {
  activeDb.exec({
    sql: `
      INSERT INTO media_sources (id, label, added_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        added_at = excluded.added_at
    `,
    bind: [source.id, source.label, source.addedAt],
  })
}

function placeholders(rowCount: number, columnCount: number): string {
  const row = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`
  return Array.from({ length: rowCount }, () => row).join(', ')
}

function emptySqliteUpsertTiming(
  label: string,
  columnCount: number,
): SqliteUpsertTiming {
  return {
    label,
    rows: 0,
    columnCount,
    chunks: 0,
    bindValues: 0,
    sqlChars: 0,
    placeholderMs: 0,
    sqlBuildMs: 0,
    bindFlattenMs: 0,
    execMs: 0,
    totalMs: 0,
    chunkTimings: [],
  }
}

function execMultiRowUpsert(
  activeDb: SqliteDb,
  label: string,
  insertPrefix: string,
  conflictClause: string,
  rows: unknown[][],
  columnCount: number,
): SqliteUpsertTiming {
  const startedAt = performance.now()
  const timing = emptySqliteUpsertTiming(label, columnCount)
  timing.rows = rows.length
  if (rows.length === 0) return timing

  const maxRows = Math.max(1, Math.floor(SQLITE_BIND_CHUNK_LIMIT / columnCount))
  for (let offset = 0; offset < rows.length; offset += maxRows) {
    const chunk = rows.slice(offset, offset + maxRows)
    const placeholderStartedAt = performance.now()
    const valuePlaceholders = placeholders(chunk.length, columnCount)
    const placeholderMs = performance.now() - placeholderStartedAt
    timing.placeholderMs += placeholderMs

    const sqlBuildStartedAt = performance.now()
    const sql = `
      ${insertPrefix}
      VALUES ${valuePlaceholders}
      ${conflictClause}
    `
    const sqlBuildMs = performance.now() - sqlBuildStartedAt
    timing.sqlBuildMs += sqlBuildMs

    const bindStartedAt = performance.now()
    const bind = chunk.flat()
    const bindFlattenMs = performance.now() - bindStartedAt
    timing.bindFlattenMs += bindFlattenMs

    const execStartedAt = performance.now()
    activeDb.exec({
      sql,
      bind,
    })
    const execMs = performance.now() - execStartedAt
    timing.execMs += execMs
    timing.chunks += 1
    timing.bindValues += bind.length
    timing.sqlChars += sql.length

    timing.chunkTimings.push({
      offset,
      rows: chunk.length,
      columnCount,
      bindValues: bind.length,
      sqlChars: sql.length,
      placeholderMs,
      sqlBuildMs,
      bindFlattenMs,
      execMs,
    })
  }

  timing.totalMs = performance.now() - startedAt
  return timing
}

function upsertMediaIntoSqlite(
  activeDb: SqliteDb,
  items: MediaItem[],
): SqliteMediaWriteTiming {
  if (items.length === 0) {
    return {
      items: 0,
      locations: 0,
      totalMs: 0,
      assetRowsMs: 0,
      locationRowsMs: 0,
      asset: emptySqliteUpsertTiming('media_assets', ASSET_BIND_COLUMNS),
      location: emptySqliteUpsertTiming(
        'media_locations',
        LOCATION_BIND_COLUMNS,
      ),
      accountedMs: 0,
      unaccountedMs: 0,
    }
  }

  const startedAt = performance.now()
  const assetRowsStartedAt = performance.now()
  const assetRows = items.map(assetBind)
  const assetRowsMs = performance.now() - assetRowsStartedAt
  const assetTiming = execMultiRowUpsert(
    activeDb,
    'media_assets',
    `
    INSERT INTO media_assets (
      content_hash, kind, mime_type, size_bytes, width, height, duration_ms,
      captured_at, captured_at_source, latitude, longitude, geo_source,
      thumbnail_key, last_seen_at
    )
    `,
    `
    ON CONFLICT(content_hash) DO UPDATE SET
      kind = excluded.kind,
      mime_type = excluded.mime_type,
      size_bytes = excluded.size_bytes,
      width = excluded.width,
      height = excluded.height,
      duration_ms = excluded.duration_ms,
      captured_at = excluded.captured_at,
      captured_at_source = excluded.captured_at_source,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      geo_source = excluded.geo_source,
      thumbnail_key = COALESCE(excluded.thumbnail_key, media_assets.thumbnail_key),
      last_seen_at = MAX(media_assets.last_seen_at, excluded.last_seen_at)
    `,
    assetRows,
    ASSET_BIND_COLUMNS,
  )

  const locationRowsStartedAt = performance.now()
  const locationRows = items.flatMap((item) =>
    itemLocations(item).map((location) => [
      location.id,
      item.contentHash,
      location.sourceId,
      location.relativePath ?? '',
      location.displayName,
      location.lastSeenAt,
    ]),
  )
  const locationRowsMs = performance.now() - locationRowsStartedAt

  const locationTiming = execMultiRowUpsert(
    activeDb,
    'media_locations',
    `
    INSERT INTO media_locations (
      id, content_hash, source_id, relative_path, display_name, last_seen_at
    )
    `,
    `
    ON CONFLICT(id) DO UPDATE SET
      content_hash = excluded.content_hash,
      source_id = excluded.source_id,
      relative_path = excluded.relative_path,
      display_name = excluded.display_name,
      last_seen_at = excluded.last_seen_at
    `,
    locationRows,
    LOCATION_BIND_COLUMNS,
  )

  const totalMs = performance.now() - startedAt
  const accountedMs =
    assetRowsMs +
    assetTiming.totalMs +
    locationRowsMs +
    locationTiming.totalMs

  return {
    items: items.length,
    locations: locationRows.length,
    totalMs,
    assetRowsMs,
    locationRowsMs,
    asset: assetTiming,
    location: locationTiming,
    accountedMs,
    unaccountedMs: totalMs - accountedMs,
  }
}

function timeWhere(
  query: Pick<CatalogQuery, 'startTime' | 'endTime'>,
  where: string[],
  bind: unknown[],
  prefix = '',
): void {
  if (typeof query.startTime === 'number') {
    where.push(`${prefix}captured_at >= ?`)
    bind.push(query.startTime)
  }
  if (typeof query.endTime === 'number') {
    where.push(`${prefix}captured_at <= ?`)
    bind.push(query.endTime)
  }
}

function mediaItemsFromAssetRows(
  activeDb: SqliteDb,
  rows: Record<string, unknown>[],
  preferredSourceId?: string,
): MediaItem[] {
  if (rows.length === 0) return []

  const contentHashes = rows.map((row) => String(row.content_hash))
  const placeholders = contentHashes.map(() => '?').join(', ')
  const locationRows = activeDb.selectObjects(
    `
      SELECT *
      FROM media_locations
      WHERE content_hash IN (${placeholders})
      ORDER BY relative_path ASC, id ASC
    `,
    contentHashes,
  )
  const locationsByHash = new Map<string, MediaLocation[]>()

  for (const row of locationRows) {
    const contentHash = String(row.content_hash)
    const locations = locationsByHash.get(contentHash) ?? []
    locations.push(locationFromRow(row))
    locationsByHash.set(contentHash, locations)
  }

  return rows.map((row) =>
    mediaFromAssetRow(
      row,
      locationsByHash.get(String(row.content_hash)) ?? [],
      preferredSourceId,
    ),
  )
}

async function upsertSource(source: MediaSource): Promise<void> {
  await ensureDb()
  upsertSourceIntoSqlite(requireDb(), source)
}

async function upsertMedia(items: MediaItem[]): Promise<number> {
  await ensureDb()
  const activeDb = requireDb()

  activeDb.exec('BEGIN')
  try {
    upsertMediaIntoSqlite(activeDb, items)
    activeDb.exec('COMMIT')
  } catch (error) {
    activeDb.exec('ROLLBACK')
    throw error
  }

  return items.length
}

function removeSourcesFromSqlite(activeDb: SqliteDb, sourceIds: string[]): void {
  if (sourceIds.length === 0) return

  const placeholders = sourceIds.map(() => '?').join(', ')
  activeDb.exec({
    sql: `DELETE FROM media_locations WHERE source_id IN (${placeholders})`,
    bind: sourceIds,
  })
  activeDb.exec(`
    DELETE FROM media_assets
    WHERE NOT EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = media_assets.content_hash
    )
  `)
  activeDb.exec({
    sql: `DELETE FROM media_sources WHERE id IN (${placeholders})`,
    bind: sourceIds,
  })
}

function prepareImportSource(
  activeDb: SqliteDb,
  source: MediaSource,
  duplicateSourceIds: string[],
): void {
  activeDb.exec('BEGIN')
  try {
    removeSourcesFromSqlite(activeDb, duplicateSourceIds)
    upsertSourceIntoSqlite(activeDb, source)
    activeDb.exec('COMMIT')
  } catch (error) {
    activeDb.exec('ROLLBACK')
    throw error
  }
}

export async function fileContentHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return bytesToHex(new Uint8Array(digest))
}

async function stableOccurrenceId(
  sourceId: string,
  relativePath: string,
): Promise<string> {
  return stableId(sourceId, relativePath)
}

async function writeThumbnail(id: string, file: File): Promise<string | undefined> {
  if (
    typeof createImageBitmap !== 'function' ||
    typeof OffscreenCanvas === 'undefined'
  ) {
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
    const thumbs = await root.getDirectoryHandle('thumbs', { create: true })
    const key = `${id}.webp`
    const handle = await thumbs.getFileHandle(key, { create: true })
    const writable = await handle.createWritable?.()
    if (!writable) return undefined
    await writable.write(blob)
    await writable.close()
    return `thumbs/${key}`
  } catch {
    return undefined
  }
}

async function readImageMetadata(file: File): Promise<{
  width?: number
  height?: number
  capturedAt?: number
  capturedAtSource?: CapturedAtSource
  latitude?: number
  longitude?: number
  geoSource?: GeoSource
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
  const latitude = numeric(record.latitude) ?? numeric(record.GPSLatitude)
  const longitude = numeric(record.longitude) ?? numeric(record.GPSLongitude)
  const capturedAt =
    dateMillis(record.DateTimeOriginal) ??
    dateMillis(record.CreateDate) ??
    dateMillis(record.DateCreated) ??
    dateMillis(record.ModifyDate) ??
    dateMillis(record.DateTime)

  let width = numeric(record.ImageWidth) ?? numeric(record.ExifImageWidth)
  let height = numeric(record.ImageHeight) ?? numeric(record.ExifImageHeight)

  if ((!width || !height) && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      width = bitmap.width
      height = bitmap.height
      bitmap.close()
    } catch {
      // EXIF-less or browser-unsupported image formats are still valid media.
    }
  }

  return {
    width,
    height,
    capturedAt,
    capturedAtSource: capturedAt ? 'exif' : undefined,
    latitude,
    longitude,
    geoSource:
      typeof latitude === 'number' && typeof longitude === 'number'
        ? 'exif'
        : undefined,
  }
}

async function mediaFromFile(
  sourceId: string,
  relativePath: string,
  fileHandle: FileSystemFileHandle,
): Promise<MediaItem | undefined> {
  const file = await fileHandle.getFile()
  const kind = detectMediaKind(file)
  if (!kind || kind === 'geo_point') return undefined

  const contentHash = await fileContentHash(file)
  const locationId = await stableOccurrenceId(sourceId, relativePath)
  const lastSeenAt = Date.now()
  const location = {
    id: locationId,
    sourceId,
    relativePath,
    displayName: pathDisplayName(relativePath),
    lastSeenAt,
  }
  const base = {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath,
    displayName: location.displayName,
    kind,
    mimeType: file.type || (kind === 'image' ? 'image/*' : 'video/*'),
    sizeBytes: file.size,
    lastSeenAt,
    locations: [location],
  }

  if (kind === 'video') {
    return {
      ...base,
      capturedAt: file.lastModified || undefined,
      capturedAtSource: file.lastModified ? 'filesystem' : undefined,
    }
  }

  const imageMetadata = await readImageMetadata(file)
  const thumbnailKey = await writeThumbnail(contentHash, file)

  return {
    ...base,
    ...imageMetadata,
    capturedAt: imageMetadata.capturedAt ?? file.lastModified ?? undefined,
    capturedAtSource:
      imageMetadata.capturedAtSource ??
      (file.lastModified ? 'filesystem' : undefined),
    thumbnailKey,
  }
}

async function geoPointItemFromParsedPoint(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  point: ParsedGeoPoint,
  timing?: GeoPointItemTiming,
): Promise<MediaItem> {
  const contentHashStartedAt = performance.now()
  const contentHash = await geoPointContentHash(
    point.latitude,
    point.longitude,
    point.capturedAt,
  )
  if (timing) {
    timing.contentHashMs += performance.now() - contentHashStartedAt
  }

  const locationHashStartedAt = performance.now()
  const locationId = await stableId(sourceId, sourceLabel, contentHash)
  if (timing) {
    timing.locationHashMs += performance.now() - locationHashStartedAt
  }

  const objectStartedAt = performance.now()
  const lastSeenAt = Date.now()
  const displayName = `${sourceLabel} #${point.index}`
  const location: MediaLocation = {
    id: locationId,
    sourceId,
    relativePath: sourceLabel,
    displayName,
    lastSeenAt,
  }

  const item: MediaItem = {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath: sourceLabel,
    displayName,
    kind: 'geo_point',
    mimeType,
    sizeBytes: 0,
    capturedAt: point.capturedAt,
    capturedAtSource: 'geo-file',
    latitude: point.latitude,
    longitude: point.longitude,
    geoSource: 'geo-file',
    lastSeenAt,
    locations: [location],
  }
  if (timing) {
    timing.objectBuildMs += performance.now() - objectStartedAt
  }

  return item
}

async function geoPointItemsFromParsedPoints(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  points: ParsedGeoPoint[],
  timing?: GeoPointItemTiming,
): Promise<MediaItem[]> {
  return Promise.all(
    points.map((point) =>
      geoPointItemFromParsedPoint(sourceId, sourceLabel, mimeType, point, timing),
    ),
  )
}

async function importFolderIntoCatalog(
  payload: ImportFolderPayload,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary> {
  const { source, duplicateSourceIds, handle } = payload
  const sourceLabel = source.label
  const errors: string[] = []
  const batch: MediaItem[] = []
  let totalFiles = 0
  let scannedFiles = 0
  let acceptedMedia = 0
  let skippedFiles = 0

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const items = batch.splice(0)
    postProgress({
      phase,
      sourceLabel,
      scannedFiles,
      totalFiles,
      acceptedMedia,
      skippedFiles,
    })
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
      if (entry.kind === 'directory') {
        await countFiles(entry as FileSystemDirectoryHandle)
        continue
      }

      totalFiles += 1
      if (totalFiles % 200 === 0) {
        postProgress({
          phase: 'counting',
          sourceLabel,
          scannedFiles: 0,
          totalFiles,
          acceptedMedia: 0,
          skippedFiles: 0,
        })
      }
    }
  }

  async function walk(
    directoryHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    for await (const [name, entry] of directoryHandle.entries()) {
      const relativePath = prefix ? `${prefix}/${name}` : name

      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, relativePath)
        continue
      }

      scannedFiles += 1
      try {
        const item = await mediaFromFile(
          source.id,
          relativePath,
          entry as FileSystemFileHandle,
        )
        if (item) {
          batch.push(item)
          acceptedMedia += 1
          if (batch.length >= IMPORT_BATCH_SIZE) {
            await flushBatch('scanning')
          }
        } else {
          skippedFiles += 1
        }
      } catch (error) {
        skippedFiles += 1
        errors.push(
          `${relativePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
    acceptedMedia: 0,
    skippedFiles: 0,
  })
  await countFiles(handle)
  await store.prepareImportSource(source, duplicateSourceIds)

  postProgress({
    phase: 'scanning',
    sourceLabel,
    scannedFiles,
    totalFiles,
    acceptedMedia,
    skippedFiles,
  })
  await walk(handle, '')
  await flushBatch('storing')

  return {
    source,
    sourceLabel,
    scannedFiles,
    totalFiles,
    acceptedMedia,
    skippedFiles,
    errors,
  }
}

async function readFileTextWithProgress(
  file: File,
  sourceLabel: string,
  postProgress: (progress: ImportProgress) => void,
): Promise<string> {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytesRead = 0
  let lastProgressAt = 0

  while (true) {
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
  return chunks.join('')
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

function debugParseRate(count: number, durationMs: number): number {
  if (durationMs <= 0) return 0
  return count / (durationMs / 1000)
}

type GeoPointItemTiming = {
  contentHashMs: number
  locationHashMs: number
  objectBuildMs: number
}

type GeoImportTimingMetrics = GeoPointItemTiming & {
  traceId: string
  sourceLabel: string
  startedAt: number
  lastLogAt: number
  batchSequence: number
  bytesRead: number
  parsedPoints: number
  skippedPoints: number
  itemsBuilt: number
  dbWritten: number
  readMs: number
  decodeMs: number
  parserFeedMs: number
  queueMs: number
  batchQueueMs: number
  dbWriteMs: number
  dbWriteBatches: number
}

function roundedMs(value: number): number {
  return Math.round(value * 10) / 10
}

let importTraceCounter = 1

function createImportTraceId(sourceLabel: string): string {
  const sanitized = sourceLabel.replace(/[^a-z0-9]+/gi, '-').slice(0, 32)
  return `import-${Date.now().toString(36)}-${importTraceCounter++}-${sanitized}`
}

function logImportTrace(
  traceId: string,
  phase: string,
  data: Record<string, unknown>,
): void {
  console.log('[import-trace]', {
    traceId,
    phase,
    ...data,
  })
}

function roundedChunkTimings(
  chunks: SqliteUpsertChunkTiming[],
): SqliteUpsertChunkTiming[] {
  return chunks.map((chunk) => ({
    ...chunk,
    placeholderMs: roundedMs(chunk.placeholderMs),
    sqlBuildMs: roundedMs(chunk.sqlBuildMs),
    bindFlattenMs: roundedMs(chunk.bindFlattenMs),
    execMs: roundedMs(chunk.execMs),
  }))
}

function roundedSqliteUpsertTiming(
  timing: SqliteUpsertTiming,
): Record<string, unknown> {
  return {
    label: timing.label,
    rows: timing.rows,
    columnCount: timing.columnCount,
    chunks: timing.chunks,
    bindValues: timing.bindValues,
    sqlChars: timing.sqlChars,
    placeholderMs: roundedMs(timing.placeholderMs),
    sqlBuildMs: roundedMs(timing.sqlBuildMs),
    bindFlattenMs: roundedMs(timing.bindFlattenMs),
    execMs: roundedMs(timing.execMs),
    totalMs: roundedMs(timing.totalMs),
    chunkTimings: roundedChunkTimings(timing.chunkTimings),
  }
}

function roundedMediaBatchWriteTiming(
  timing: MediaBatchWriteTiming,
): Record<string, unknown> {
  return {
    storageMode: timing.storageMode,
    items: timing.items,
    transactionActive: timing.transactionActive,
    totalMs: roundedMs(timing.totalMs),
    ensureDbMs: roundedMs(timing.ensureDbMs),
    requireDbMs: roundedMs(timing.requireDbMs),
    writeMs: roundedMs(timing.writeMs),
    accountedMs: roundedMs(timing.accountedMs),
    unaccountedMs: roundedMs(timing.unaccountedMs),
    sqlite: timing.sqlite
      ? {
          items: timing.sqlite.items,
          locations: timing.sqlite.locations,
          totalMs: roundedMs(timing.sqlite.totalMs),
          assetRowsMs: roundedMs(timing.sqlite.assetRowsMs),
          locationRowsMs: roundedMs(timing.sqlite.locationRowsMs),
          accountedMs: roundedMs(timing.sqlite.accountedMs),
          unaccountedMs: roundedMs(timing.sqlite.unaccountedMs),
          asset: roundedSqliteUpsertTiming(timing.sqlite.asset),
          location: roundedSqliteUpsertTiming(timing.sqlite.location),
        }
      : undefined,
  }
}

function createGeoImportTiming(
  sourceLabel: string,
  traceId: string,
): GeoImportTimingMetrics {
  const now = performance.now()
  return {
    traceId,
    sourceLabel,
    startedAt: now,
    lastLogAt: now,
    batchSequence: 0,
    bytesRead: 0,
    parsedPoints: 0,
    skippedPoints: 0,
    itemsBuilt: 0,
    dbWritten: 0,
    readMs: 0,
    decodeMs: 0,
    parserFeedMs: 0,
    contentHashMs: 0,
    locationHashMs: 0,
    objectBuildMs: 0,
    queueMs: 0,
    batchQueueMs: 0,
    dbWriteMs: 0,
    dbWriteBatches: 0,
  }
}

function geoImportTimingSnapshot(
  timing: GeoImportTimingMetrics,
): Record<string, unknown> {
  const elapsedMs = performance.now() - timing.startedAt
  return {
    traceId: timing.traceId,
    sourceLabel: timing.sourceLabel,
    elapsedMs: roundedMs(elapsedMs),
    bytesRead: timing.bytesRead,
    parsedPoints: timing.parsedPoints,
    skippedPoints: timing.skippedPoints,
    itemsBuilt: timing.itemsBuilt,
    dbWritten: timing.dbWritten,
    dbWriteBatches: timing.dbWriteBatches,
    readMs: roundedMs(timing.readMs),
    decodeMs: roundedMs(timing.decodeMs),
    parserFeedMs: roundedMs(timing.parserFeedMs),
    contentHashMs: roundedMs(timing.contentHashMs),
    locationHashMs: roundedMs(timing.locationHashMs),
    objectBuildMs: roundedMs(timing.objectBuildMs),
    queueMs: roundedMs(timing.queueMs),
    batchQueueMs: roundedMs(timing.batchQueueMs),
    dbWriteMs: roundedMs(timing.dbWriteMs),
    pointsPerSecond: Math.round(debugParseRate(timing.parsedPoints, elapsedMs)),
    writesPerSecond: Math.round(debugParseRate(timing.dbWritten, elapsedMs)),
  }
}

function logGeoImportTiming(
  timing: GeoImportTimingMetrics,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  logImportTrace(timing.traceId, phase, {
    ...geoImportTimingSnapshot(timing),
    ...extra,
  })
}

function maybeLogGeoImportTiming(
  timing: GeoImportTimingMetrics,
  phase: string,
  extra: Record<string, unknown> = {},
): void {
  const now = performance.now()
  if (now - timing.lastLogAt < PROGRESS_HEARTBEAT_MS) return
  timing.lastLogAt = now
  logGeoImportTiming(timing, phase, extra)
}

async function debugParseGoogleTakeoutFile(
  payload: DebugParseGeoFilePayload,
): Promise<GeoParseDebugSummary> {
  const { file } = payload
  const sourceLabel = file.name || 'selected JSON file'
  const prefix = await file.slice(0, GEO_IMPORT_PREFIX_BYTES).text()

  if (!jsonLikePrefix(prefix)) {
    throw new Error(
      'Debug parser expects raw Google Takeout Records.json data.',
    )
  }
  throwKnownUnsupportedJsonPrefix(prefix)

  const parser = new GoogleTakeoutLocationStreamParser()
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const startedAt = performance.now()
  let bytesRead = 0
  let parsedPoints = 0
  let hashedPoints = 0
  let skippedPoints = 0
  let hashDurationMs = 0
  let lastLogAt = startedAt

  const log = (phase: string) => {
    const now = performance.now()
    const durationMs = now - startedAt
    console.log('[geo-debug]', {
      phase,
      fileName: sourceLabel,
      sizeBytes: file.size,
      bytesRead,
      percent:
        file.size > 0 ? Math.round((bytesRead / file.size) * 1000) / 10 : 0,
      parsedPoints,
      hashedPoints,
      skippedPoints,
      elapsedMs: Math.round(durationMs),
      hashDurationMs: Math.round(hashDurationMs),
      bytesPerSecond: Math.round(debugParseRate(bytesRead, durationMs)),
      pointsPerSecond: Math.round(debugParseRate(parsedPoints, durationMs)),
      hashesPerSecond: Math.round(debugParseRate(hashedPoints, hashDurationMs)),
    })
  }

  const maybeLog = () => {
    const now = performance.now()
    if (now - lastLogAt < PROGRESS_HEARTBEAT_MS) return
    lastLogAt = now
    log('parsing')
  }

  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      const result = parser.feed(chunk, {
        maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS,
      })
      chunk = ''
      parsedPoints += result.points.length
      skippedPoints += result.skippedPoints
      const hashStartedAt = performance.now()
      for (const point of result.points) {
        const contentHash = await geoPointContentHash(
          point.latitude,
          point.longitude,
          point.capturedAt,
        )
        await stableId('debug-source', sourceLabel, contentHash)
        hashedPoints += 1
      }
      hashDurationMs += performance.now() - hashStartedAt
      maybeLog()

      if (!result.paused) break
      await yieldToEventLoop()
    }
  }

  log('start')

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    bytesRead += value.byteLength
    await consumeText(decoder.decode(value, { stream: true }))
    maybeLog()
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    await consumeText(finalChunk)
  }

  const final = parser.finish()
  skippedPoints = final.skippedPoints
  const durationMs = performance.now() - startedAt
  const summary = {
    sourceLabel,
    sizeBytes: file.size,
    bytesRead,
    totalEntries: final.totalEntries,
    parsedPoints,
    hashedPoints,
    skippedPoints,
    durationMs,
    hashDurationMs,
    bytesPerSecond: debugParseRate(bytesRead, durationMs),
    pointsPerSecond: debugParseRate(parsedPoints, durationMs),
    hashesPerSecond: debugParseRate(hashedPoints, hashDurationMs),
  }

  console.log('[geo-debug]', {
    phase: 'complete',
    ...summary,
    durationMs: Math.round(summary.durationMs),
    hashDurationMs: Math.round(summary.hashDurationMs),
    bytesPerSecond: Math.round(summary.bytesPerSecond),
    pointsPerSecond: Math.round(summary.pointsPerSecond),
    hashesPerSecond: Math.round(summary.hashesPerSecond),
  })

  return summary
}

async function importGpxIntoCatalog(
  file: File,
  source: MediaSource,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
): Promise<{ acceptedMedia: number; skippedFiles: number }> {
  const sourceLabel = source.label
  const text = await readFileTextWithProgress(file, sourceLabel, postProgress)
  const parsed = parseGeoFilePoints(file.name || sourceLabel, text)
  let acceptedMedia = 0
  const batch: MediaItem[] = []

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const flushedItems = batch.length
    await store.writeMediaBatch(batch, { transactionActive: true })
    acceptedMedia += flushedItems
    batch.length = 0

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
    for (
      let offset = 0;
      offset < parsed.points.length;
      offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE
    ) {
      const itemChunk = await geoPointItemsFromParsedPoints(
        source.id,
        sourceLabel,
        parsed.mimeType,
        parsed.points.slice(offset, offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE),
      )

      for (const item of itemChunk) {
        batch.push(item)
        if (batch.length >= store.geoImportWriteBatchSize) {
          await flushBatch('storing')
        }
      }

      postProgress({
        phase: 'scanning',
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

    await flushBatch('storing')
  })

  return { acceptedMedia, skippedFiles: parsed.skippedPoints }
}

async function importGoogleTakeoutIntoCatalog(
  file: File,
  source: MediaSource,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
  traceId: string,
): Promise<{ acceptedMedia: number; skippedFiles: number }> {
  const sourceLabel = source.label
  const timing = createGeoImportTiming(sourceLabel, traceId)
  const parser = new GoogleTakeoutLocationStreamParser()
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const pendingPoints: ParsedGeoPoint[] = []
  const batch: MediaItem[] = []
  let bytesRead = 0
  let acceptedMedia = 0
  let skippedFiles = 0
  let lastProgressAt = 0

  logGeoImportTiming(timing, 'takeout import start', {
    sizeBytes: file.size,
    writeBatchSize: store.geoImportWriteBatchSize,
  })

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
    const batchId = `${timing.traceId}:batch-${++timing.batchSequence}`
    const writeStartedAt = performance.now()
    const writeResult = await store.writeMediaBatch(batch, {
      transactionActive: true,
    })
    const writeMs = performance.now() - writeStartedAt
    timing.dbWriteMs += writeMs
    timing.dbWriteBatches += 1
    timing.dbWritten += flushedItems
    acceptedMedia += flushedItems
    batch.length = 0
    const storageTiming = writeResult.timing
    const storageTotalMs = storageTiming.totalMs
    logGeoImportTiming(timing, 'database batch written', {
      batchId,
      batchItems: flushedItems,
      batchWriteMs: roundedMs(writeMs),
      storageWritten: writeResult.written,
      storageWrite: roundedMediaBatchWriteTiming(storageTiming),
      batchAccounting: {
        outerWriteMs: roundedMs(writeMs),
        storageTotalMs: roundedMs(storageTotalMs),
        outerMinusStorageMs: roundedMs(writeMs - storageTotalMs),
      },
      importPhase: phase,
    })
    emitProgress(phase)
    await yieldToEventLoop()
  }

  const consumePoints = async () => {
    const points = pendingPoints.splice(0)

    for (
      let offset = 0;
      offset < points.length;
      offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE
    ) {
      const pointChunk = points.slice(
        offset,
        offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE,
      )
      const itemChunk = await geoPointItemsFromParsedPoints(
        source.id,
        sourceLabel,
        'application/json',
        pointChunk,
        timing,
      )
      timing.itemsBuilt += itemChunk.length

      let batchQueueStartedAt = performance.now()
      for (const item of itemChunk) {
        batch.push(item)
        if (batch.length >= store.geoImportWriteBatchSize) {
          timing.batchQueueMs += performance.now() - batchQueueStartedAt
          await flushBatch('scanning')
          batchQueueStartedAt = performance.now()
        }
      }
      timing.batchQueueMs += performance.now() - batchQueueStartedAt

      maybeEmitProgress()
      maybeLogGeoImportTiming(timing, 'building items', {
        pendingPoints: pendingPoints.length,
        currentChunkPoints: pointChunk.length,
      })
      await yieldToEventLoop()
    }
  }

  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      const feedStartedAt = performance.now()
      const result = parser.feed(chunk, {
        maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS,
      })
      timing.parserFeedMs += performance.now() - feedStartedAt
      chunk = ''
      timing.parsedPoints += result.points.length
      timing.skippedPoints += result.skippedPoints
      skippedFiles += result.skippedPoints
      const queueStartedAt = performance.now()
      pendingPoints.push(...result.points)
      timing.queueMs += performance.now() - queueStartedAt
      await consumePoints()
      maybeEmitProgress()
      maybeLogGeoImportTiming(timing, 'parsing takeout', {
        paused: result.paused,
        resultPoints: result.points.length,
      })

      if (!result.paused) break
      await yieldToEventLoop()
    }
  }

  emitProgress('scanning')

  await store.withImportTransaction(
    async () => {
      while (true) {
        const readStartedAt = performance.now()
        const { done, value } = await reader.read()
        timing.readMs += performance.now() - readStartedAt
        if (done) break

        bytesRead += value.byteLength
        timing.bytesRead = bytesRead
        const decodeStartedAt = performance.now()
        const text = decoder.decode(value, { stream: true })
        timing.decodeMs += performance.now() - decodeStartedAt
        await consumeText(text)
      }

      const finalDecodeStartedAt = performance.now()
      const finalChunk = decoder.decode()
      timing.decodeMs += performance.now() - finalDecodeStartedAt
      if (finalChunk) {
        await consumeText(finalChunk)
      }

      const final = parser.finish()
      skippedFiles = final.skippedPoints
      timing.skippedPoints = final.skippedPoints
      await consumePoints()
      await flushBatch('storing')
    },
    { traceId: timing.traceId, sourceLabel },
  )
  emitProgress('storing')
  logGeoImportTiming(timing, 'takeout import complete', {
    acceptedMedia,
    skippedFiles,
  })

  return { acceptedMedia, skippedFiles }
}

async function importGeoFileIntoCatalog(
  payload: ImportGeoFilePayload,
  store: CatalogStore,
  postProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary> {
  const { source, duplicateSourceIds, file } = payload
  const sourceLabel = source.label
  const startedAt = performance.now()
  const traceId = payload.traceId ?? createImportTraceId(sourceLabel)

  logImportTrace(traceId, 'geo import envelope start', {
    sourceLabel,
    sizeBytes: file.size,
    duplicateSourceIds: duplicateSourceIds.length,
    writeBatchSize: store.geoImportWriteBatchSize,
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

  const prepareStartedAt = performance.now()
  await store.prepareImportSource(source, duplicateSourceIds)
  logImportTrace(traceId, 'source prepared', {
    sourceLabel,
    phaseMs: roundedMs(performance.now() - prepareStartedAt),
    elapsedMs: roundedMs(performance.now() - startedAt),
  })

  const prefixStartedAt = performance.now()
  const prefix = await file.slice(0, GEO_IMPORT_PREFIX_BYTES).text()
  const prefixMs = performance.now() - prefixStartedAt
  logImportTrace(traceId, 'format prefix read', {
    sourceLabel,
    phaseMs: roundedMs(prefixMs),
    prefixBytes: Math.min(file.size, GEO_IMPORT_PREFIX_BYTES),
    jsonLike: jsonLikePrefix(prefix),
    elapsedMs: roundedMs(performance.now() - startedAt),
  })
  const result = jsonLikePrefix(prefix)
    ? await (async () => {
        throwKnownUnsupportedJsonPrefix(prefix)
        logImportTrace(traceId, 'format selected', {
          sourceLabel,
          format: 'google-takeout-json',
          elapsedMs: roundedMs(performance.now() - startedAt),
        })
        return importGoogleTakeoutIntoCatalog(
          file,
          source,
          store,
          postProgress,
          traceId,
        )
      })()
    : await (async () => {
        logImportTrace(traceId, 'format selected', {
          sourceLabel,
          format: 'gpx',
          elapsedMs: roundedMs(performance.now() - startedAt),
        })
        return importGpxIntoCatalog(file, source, store, postProgress)
      })()

  logImportTrace(traceId, 'geo import envelope complete', {
    sourceLabel,
    acceptedMedia: result.acceptedMedia,
    skippedFiles: result.skippedFiles,
    elapsedMs: roundedMs(performance.now() - startedAt),
  })

  return {
    source,
    sourceLabel,
    scannedFiles: 1,
    totalFiles: 1,
    acceptedMedia: result.acceptedMedia,
    skippedFiles: result.skippedFiles,
    errors: [],
  }
}

async function listMedia(query: CatalogQuery): Promise<MediaItem[]> {
  await ensureDb()
  const activeDb = requireDb()
  const where = [
    `EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = a.content_hash
    )`,
  ]
  const bind: unknown[] = []

  if (query.kind === 'media') {
    where.push("a.kind IN ('image', 'video')")
  } else if (query.kind && query.kind !== 'all') {
    where.push('a.kind = ?')
    bind.push(query.kind)
  }
  if (query.sourceId) {
    where.push(`EXISTS (
      SELECT 1 FROM media_locations ls
      WHERE ls.content_hash = a.content_hash
        AND ls.source_id = ?
    )`)
    bind.push(query.sourceId)
  }
  if (typeof query.hasGeo === 'boolean') {
    where.push(
      query.hasGeo
        ? 'a.latitude IS NOT NULL AND a.longitude IS NOT NULL'
        : '(a.latitude IS NULL OR a.longitude IS NULL)',
    )
  }
  if (query.geoBounds) {
    where.push('a.latitude BETWEEN ? AND ?')
    bind.push(query.geoBounds.minLat, query.geoBounds.maxLat)
    where.push('a.longitude BETWEEN ? AND ?')
    bind.push(query.geoBounds.minLon, query.geoBounds.maxLon)
  }

  timeWhere(query, where, bind, 'a.')

  const order =
    query.sort === 'captured_at_asc'
      ? 'CASE WHEN a.captured_at IS NULL THEN 1 ELSE 0 END, a.captured_at ASC, a.content_hash ASC'
      : 'CASE WHEN a.captured_at IS NULL THEN 1 ELSE 0 END, a.captured_at DESC, a.content_hash ASC'
  const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
  const offset = Math.max(0, query.offset ?? 0)
  bind.push(limit, offset)

  const rows = activeDb.selectObjects(
    `
      SELECT a.*
      FROM media_assets a
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `,
    bind,
  )

  return mediaItemsFromAssetRows(activeDb, rows, query.sourceId)
}

async function getMediaByIds(ids: string[]): Promise<MediaItem[]> {
  await ensureDb()
  if (ids.length === 0) return []

  const activeDb = requireDb()
  const placeholders = ids.map(() => '?').join(', ')
  const rows = activeDb.selectObjects(
    `SELECT * FROM media_assets WHERE content_hash IN (${placeholders})`,
    ids,
  )
  const items = mediaItemsFromAssetRows(activeDb, rows)
  const byId = new Map(items.map((item) => [item.id, item]))
  return ids.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
}

async function getGeoPoints(range: {
  startTime?: number
  endTime?: number
}): Promise<GeoIndexPoint[]> {
  await ensureDb()
  const where = [
    'a.latitude IS NOT NULL',
    'a.longitude IS NOT NULL',
    `EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = a.content_hash
    )`,
  ]
  const bind: unknown[] = []
  timeWhere(range, where, bind, 'a.')

  const rows = requireDb().selectObjects(
    `
      SELECT a.content_hash, a.latitude, a.longitude, a.captured_at
        , a.kind
      FROM media_assets a
      WHERE ${where.join(' AND ')}
      ORDER BY a.content_hash ASC
    `,
    bind,
  )

  return rows.map((row) => ({
    mediaId: String(row.content_hash),
    kind:
      row.kind === 'image' || row.kind === 'video' || row.kind === 'geo_point'
        ? row.kind
        : undefined,
    lat: toNumber(row.latitude) ?? 0,
    lon: toNumber(row.longitude) ?? 0,
    capturedAt: toNumber(row.captured_at),
  }))
}

async function buildGeoIndexes(
  store: CatalogStore,
  postProgress: (progress: GeoIndexBuildProgress) => void,
): Promise<GeoIndexBuildSummary> {
  const startedAt = performance.now()
  const totalIndexes = geoIndexRegistry.indexes.length

  postProgress({
    phase: 'loading',
    pointCount: 0,
    builtIndexes: 0,
    totalIndexes,
  })

  const points = await store.getGeoPoints({})

  postProgress({
    phase: 'building',
    pointCount: points.length,
    builtIndexes: 0,
    totalIndexes,
  })

  let builtIndexes = 0
  for (const index of geoIndexRegistry.indexes) {
    postProgress({
      phase: 'building',
      pointCount: points.length,
      builtIndexes,
      totalIndexes,
      currentIndexId: index.id,
      currentIndexLabel: index.label,
      currentIndexProcessedPoints: 0,
      currentIndexTotalPoints: points.length,
    })
    await index.build(points, {
      yieldEvery: 2_000,
      onProgress: (progress) => {
        postProgress({
          phase: 'building',
          pointCount: points.length,
          builtIndexes,
          totalIndexes,
          currentIndexId: progress.indexId,
          currentIndexLabel: progress.indexLabel,
          currentIndexProcessedPoints: progress.processedPoints,
          currentIndexTotalPoints: progress.totalPoints,
        })
      },
    })
    builtIndexes += 1
    postProgress({
      phase: 'building',
      pointCount: points.length,
      builtIndexes,
      totalIndexes,
      currentIndexId: index.id,
      currentIndexLabel: index.label,
    })
  }

  const summary = {
    pointCount: points.length,
    buildTimeMs: performance.now() - startedAt,
  }

  postProgress({
    phase: 'ready',
    pointCount: points.length,
    builtIndexes,
    totalIndexes,
  })

  return summary
}

async function searchGeoIndex(payload: {
  indexId: string
  query: GeoSearchQuery
}): Promise<GeoSearchResult[]> {
  return geoIndexRegistry.get(payload.indexId).search(payload.query)
}

async function getGeoIndexStats(indexId: string): Promise<GeoIndexStats> {
  return geoIndexRegistry.get(indexId).stats()
}

async function validateGeoIndex(payload: {
  indexId: string
  query: GeoSearchQuery
}): Promise<ValidationReport> {
  return geoIndexRegistry
    .get(payload.indexId)
    .validateAgainstBruteForce(payload.query)
}

async function listSources(): Promise<MediaSource[]> {
  await ensureDb()
  return requireDb()
    .selectObjects(
      'SELECT id, label, added_at FROM media_sources ORDER BY added_at DESC',
    )
    .map(sourceFromRow)
}

async function removeSources(sourceIds: string[]): Promise<void> {
  await ensureDb()
  if (sourceIds.length === 0) return

  const placeholders = sourceIds.map(() => '?').join(', ')
  const activeDb = requireDb()
  activeDb.exec('BEGIN')
  try {
    activeDb.exec({
      sql: `DELETE FROM media_locations WHERE source_id IN (${placeholders})`,
      bind: sourceIds,
    })
    activeDb.exec(`
      DELETE FROM media_assets
      WHERE NOT EXISTS (
        SELECT 1 FROM media_locations l
        WHERE l.content_hash = media_assets.content_hash
      )
    `)
    activeDb.exec({
      sql: `DELETE FROM media_sources WHERE id IN (${placeholders})`,
      bind: sourceIds,
    })
    activeDb.exec('COMMIT')
  } catch (error) {
    activeDb.exec('ROLLBACK')
    throw error
  }
}

async function countMedia(): Promise<number> {
  await ensureDb()
  const count = requireDb().selectValue(
    `
      SELECT COUNT(*)
      FROM media_assets a
      WHERE EXISTS (
          SELECT 1 FROM media_locations l
          WHERE l.content_hash = a.content_hash
        )
    `,
  )
  return toNumber(count) ?? 0
}

async function clearCatalog(): Promise<void> {
  await ensureDb()
  requireDb().exec(`
    DELETE FROM media_locations;
    DELETE FROM media_assets;
    DELETE FROM media_sources;
  `)
}

const sqliteCatalogStore: CatalogStore = {
  geoImportWriteBatchSize: GEO_IMPORT_SQLITE_WRITE_BATCH_SIZE,
  init: ensureDb,
  upsertSource,
  upsertMedia,
  async prepareImportSource(source, duplicateSourceIds) {
    await ensureDb()
    prepareImportSource(requireDb(), source, duplicateSourceIds)
  },
  async writeMediaBatch(items, options) {
    const startedAt = performance.now()
    const transactionActive = Boolean(options?.transactionActive)
    const ensureStartedAt = performance.now()
    await ensureDb()
    const ensureDbMs = performance.now() - ensureStartedAt
    if (items.length === 0) {
      const totalMs = performance.now() - startedAt
      return {
        written: 0,
        timing: {
          storageMode: 'sqlite',
          items: 0,
          transactionActive,
          totalMs,
          ensureDbMs,
          requireDbMs: 0,
          writeMs: 0,
          accountedMs: ensureDbMs,
          unaccountedMs: totalMs - ensureDbMs,
        },
      }
    }
    const requireStartedAt = performance.now()
    const activeDb = requireDb()
    const requireDbMs = performance.now() - requireStartedAt
    const writeStartedAt = performance.now()
    let sqliteTiming: SqliteMediaWriteTiming
    if (options?.transactionActive) {
      sqliteTiming = upsertMediaIntoSqlite(activeDb, items)
    } else {
      const wrappedWriteStartedAt = performance.now()
      activeDb.exec('BEGIN')
      try {
        sqliteTiming = upsertMediaIntoSqlite(activeDb, items)
        activeDb.exec('COMMIT')
      } catch (error) {
        activeDb.exec('ROLLBACK')
        throw error
      }
      sqliteTiming = {
        ...sqliteTiming,
        totalMs: performance.now() - wrappedWriteStartedAt,
      }
    }
    const writeMs = performance.now() - writeStartedAt
    const totalMs = performance.now() - startedAt
    const accountedMs = ensureDbMs + requireDbMs + writeMs
    return {
      written: items.length,
      timing: {
        storageMode: 'sqlite',
        items: items.length,
        transactionActive,
        totalMs,
        ensureDbMs,
        requireDbMs,
        writeMs,
        accountedMs,
        unaccountedMs: totalMs - accountedMs,
        sqlite: sqliteTiming,
      },
    }
  },
  async withImportTransaction(run, options) {
    const startedAt = performance.now()
    const ensureStartedAt = performance.now()
    await ensureDb()
    const ensureDbMs = performance.now() - ensureStartedAt
    const requireStartedAt = performance.now()
    const activeDb = requireDb()
    const requireDbMs = performance.now() - requireStartedAt
    const beginStartedAt = performance.now()
    activeDb.exec('BEGIN')
    const beginMs = performance.now() - beginStartedAt
    const runStartedAt = performance.now()
    try {
      const result = await run()
      const runMs = performance.now() - runStartedAt
      const commitStartedAt = performance.now()
      activeDb.exec('COMMIT')
      const commitMs = performance.now() - commitStartedAt
      if (options?.traceId) {
        const totalMs = performance.now() - startedAt
        logImportTrace(options.traceId, 'sqlite import transaction complete', {
          sourceLabel: options.sourceLabel,
          totalMs: roundedMs(totalMs),
          ensureDbMs: roundedMs(ensureDbMs),
          requireDbMs: roundedMs(requireDbMs),
          beginMs: roundedMs(beginMs),
          runMs: roundedMs(runMs),
          commitMs: roundedMs(commitMs),
          accountedMs: roundedMs(
            ensureDbMs + requireDbMs + beginMs + runMs + commitMs,
          ),
          unaccountedMs: roundedMs(
            totalMs - (ensureDbMs + requireDbMs + beginMs + runMs + commitMs),
          ),
        })
      }
      return result
    } catch (error) {
      const rollbackStartedAt = performance.now()
      activeDb.exec('ROLLBACK')
      const rollbackMs = performance.now() - rollbackStartedAt
      if (options?.traceId) {
        logImportTrace(options.traceId, 'sqlite import transaction rollback', {
          sourceLabel: options.sourceLabel,
          rollbackMs: roundedMs(rollbackMs),
          elapsedMs: roundedMs(performance.now() - startedAt),
        })
      }
      throw error
    }
  },
  listMedia,
  getMediaByIds,
  getGeoPoints,
  listSources,
  removeSources,
  countMedia,
  clear: clearCatalog,
}

const indexedDbCatalogStore: CatalogStore = {
  geoImportWriteBatchSize: GEO_IMPORT_INDEXEDDB_WRITE_BATCH_SIZE,
  init: ensureIndexedDb,
  upsertSource: idbUpsertSource,
  upsertMedia: idbUpsertMedia,
  prepareImportSource: idbPrepareImportSource,
  async writeMediaBatch(items, options) {
    const startedAt = performance.now()
    const writeStartedAt = performance.now()
    const written = await idbUpsertMedia(items)
    const writeMs = performance.now() - writeStartedAt
    const totalMs = performance.now() - startedAt
    return {
      written,
      timing: {
        storageMode: 'indexeddb',
        items: items.length,
        transactionActive: Boolean(options?.transactionActive),
        totalMs,
        ensureDbMs: 0,
        requireDbMs: 0,
        writeMs,
        accountedMs: writeMs,
        unaccountedMs: totalMs - writeMs,
      },
    }
  },
  async withImportTransaction(run, options) {
    const startedAt = performance.now()
    try {
      const result = await run()
      if (options?.traceId) {
        logImportTrace(options.traceId, 'indexeddb import transaction complete', {
          sourceLabel: options.sourceLabel,
          totalMs: roundedMs(performance.now() - startedAt),
        })
      }
      return result
    } catch (error) {
      if (options?.traceId) {
        logImportTrace(options.traceId, 'indexeddb import transaction failed', {
          sourceLabel: options.sourceLabel,
          elapsedMs: roundedMs(performance.now() - startedAt),
        })
      }
      throw error
    }
  },
  listMedia: idbListMedia,
  getMediaByIds: idbGetMediaByIds,
  getGeoPoints: idbGetGeoPoints,
  listSources: idbListSources,
  removeSources: idbRemoveSources,
  countMedia: idbCountMedia,
  clear: idbClear,
}

function storageModeForRequest(request: WorkerRequest): WebCatalogStorageMode {
  return request.storageMode === 'indexeddb' ? 'indexeddb' : 'sqlite'
}

function catalogStoreForMode(mode: WebCatalogStorageMode): CatalogStore {
  return mode === 'indexeddb' ? indexedDbCatalogStore : sqliteCatalogStore
}

async function handleRequest(
  request: WorkerRequest,
  postProgress: (progress: GeoIndexBuildProgress | ImportProgress) => void,
): Promise<unknown> {
  const store = catalogStoreForMode(storageModeForRequest(request))

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
        postProgress as (progress: ImportProgress) => void,
      )
    case 'importGeoFile':
      return importGeoFileIntoCatalog(
        request.payload as ImportGeoFilePayload,
        store,
        postProgress as (progress: ImportProgress) => void,
      )
    case 'debugParseGeoFile':
      return debugParseGoogleTakeoutFile(
        request.payload as DebugParseGeoFilePayload,
      )
    case 'listMedia':
      return store.listMedia(request.payload as CatalogQuery)
    case 'getMediaByIds':
      return store.getMediaByIds(request.payload as string[])
    case 'getGeoPoints':
      return store.getGeoPoints((request.payload ?? {}) as TimeRange)
    case 'listSources':
      return store.listSources()
    case 'removeSources':
      return store.removeSources(request.payload as string[])
    case 'countMedia':
      return store.countMedia()
    case 'buildGeoIndexes':
      return buildGeoIndexes(store, postProgress)
    case 'searchGeoIndex':
      return searchGeoIndex(
        request.payload as { indexId: string; query: GeoSearchQuery },
      )
    case 'getGeoIndexStats':
      return getGeoIndexStats(request.payload as string)
    case 'validateGeoIndex':
      return validateGeoIndex(
        request.payload as { indexId: string; query: GeoSearchQuery },
      )
    case 'clear':
      return store.clear()
    default:
      throw new Error(`Unknown catalog request: ${request.type}`)
  }
}

ctx.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  try {
    const postProgress = (progress: GeoIndexBuildProgress | ImportProgress) => {
      ctx.postMessage({ id: event.data.id, type: 'progress', progress })
    }
    const result = await handleRequest(event.data, postProgress)
    ctx.postMessage({ id: event.data.id, ok: true, result })
  } catch (error) {
    ctx.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
