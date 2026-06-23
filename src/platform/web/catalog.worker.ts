import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import * as exifr from 'exifr'
import {
  DiskSegmentedTreeIndex,
  type DiskSegmentedBatchProducer,
  type DiskSegmentedEngineId,
  type DiskSegmentedTreeManifest,
  type DiskSegmentedTreeStore,
} from '../../geo/diskSegmentedTreeIndex'
import { SegmentedBallTreeGeoIndex } from '../../geo/segmentedBallTreeGeoIndex'
import {
  createSegmentedBallTreeManifest,
  decodeSegmentedBallTreeSnapshot,
  encodeSegmentedBallTreeSnapshot,
  type SegmentedBallTreeManifest,
  validateSegmentedBallTreeManifest,
} from '../../geo/segmentedBallTreePersistence'
import { GeoIndexRegistry } from '../../geo/registry'
import {
  geoPointContentHash,
  parseGeoFilePoints,
  type ParsedGeoPoint,
} from '../../lib/geoPoint'
import { GoogleTakeoutLocationStreamParser } from '../../lib/googleTakeoutStream'
import { detectMediaKind, pathDisplayName } from '../../lib/media'
import { sha256Hex } from '../../lib/sha256'
import { createSqlExplainPlan } from '../../lib/sqlExplain'
import { traceStartup } from '../../lib/startupTrace'
import { SearchIndexRegistry as SearchIndexEngineRegistry } from '../../search/registry'
import type {
  CatalogQuery,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MediaItem,
  MediaLocation,
  MediaSource,
  SearchIndexEngine,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
  SearchStorageMode,
  SqlExplainPlan,
  TimeRange,
  ValidationReport,
} from '../../types'
import type {
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  ImportProgress,
  ImportSummary,
} from '../types'
import type { WebCatalogStorageMode } from './storageMode'

traceStartup('[startup:worker]', 'catalog worker module evaluated')

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

type SqliteSelectPlanRow = {
  id?: unknown
  parent?: unknown
  detail?: unknown
}

type MediaSearchRows = {
  items: MediaItem[]
  sqlPlan?: SqlExplainPlan
}

type MediaSearchRowsFn = (
  query: CatalogQuery,
  options?: { explainSql?: boolean },
) => Promise<MediaSearchRows>

type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>
type SqliteStorageMode = 'opfs'

type IdbAsset = {
  contentHash: string
  kind: MediaItem['kind']
  mimeType: string
  sizeBytes: number
  durationMs?: number
  timestamp?: number
  latitude?: number
  longitude?: number
  thumbnailKey?: string
}

type IdbLocation = MediaLocation & {
  contentHash: string
}

type IdbMetadata = {
  key: string
  value: string
}

type IdbIndexCache = {
  id: string
  manifest?:
    | SegmentedBallTreeManifest
    | DiskSegmentedTreeManifest
  data?: ArrayBuffer
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

type CatalogStore = {
  storageMode: WebCatalogStorageMode
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
  commitImport(): Promise<void>
  withImportTransaction<T>(
    run: () => Promise<T>,
  ): Promise<T>
  listMedia(query: CatalogQuery): Promise<MediaItem[]>
  searchMedia(spec: SearchSpec): Promise<SearchPage>
  getMediaByIds(ids: string[]): Promise<MediaItem[]>
  getGeoPoints(range: TimeRange): Promise<GeoIndexPoint[]>
  forEachGeoPointBatch(
    batchSize: number,
    onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
  ): Promise<number>
  diskSegmentedTreeStore(): DiskSegmentedTreeStore
  catalogEpoch(): Promise<number>
  loadPersistedSegmentedBallTreeIndex(
    catalogEpoch: number,
  ): Promise<{ pointCount: number; segmentCount: number } | undefined>
  savePersistedSegmentedBallTreeIndex(catalogEpoch: number): Promise<void>
  buildSearchIndexes(
    indexId: string,
    forceRebuild: boolean,
    postProgress: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary & { engineCount: number }>
  getSearchIndexStats(): Promise<SearchIndexStats[]>
  countMedia(): Promise<number>
  clear(): Promise<void>
}

let db: SqliteDb | undefined
let initResult: InitResult | undefined
let sqliteMode: SqliteStorageMode | undefined
let indexedDb: IDBDatabase | undefined
let indexedDbInitResult: InitResult | undefined
const geoIndexRegistry = new GeoIndexRegistry()
let preparedSearchIndex:
  | {
      storageMode: WebCatalogStorageMode
      indexId: string
      catalogEpoch: number
      cacheDirty: boolean
    }
  | undefined
const diskSegmentedIndexInstances = new Map<string, DiskSegmentedTreeIndex>()

const IMPORT_BATCH_SIZE = 1000
const SQLITE_BIND_CHUNK_LIMIT = 12000
const ASSET_BIND_COLUMNS = 9
const LOCATION_BIND_COLUMNS = 7
const GEO_IMPORT_PREFIX_BYTES = 512 * 1024
const GEO_IMPORT_PARSE_SLICE_MS = 250
const PROGRESS_HEARTBEAT_MS = 1000
const GEO_POINT_ITEM_BUILD_CHUNK_SIZE = 250
const GEO_IMPORT_SQLITE_WRITE_BATCH_SIZE = 250
const GEO_IMPORT_INDEXEDDB_WRITE_BATCH_SIZE = 2000
const INDEXED_DB_NAME = 'zeitfaden-catalog-indexeddb-persisted-index-v1'
const INDEXED_DB_VERSION = 1
const CATALOG_EPOCH_KEY = 'catalogEpoch'
const SEGMENTED_BALL_TREE_CACHE_KEY = 'segmented-ball-tree:v1'

const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void
}
const cancelledRequests = new Set<number>()
let importCommitRequested = false

type CancellationSignal = () => boolean

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

async function openSqliteDb(sqlite3: SqliteModule): Promise<SqliteDb> {
  const opfsVfs = sqlite3.capi.sqlite3_vfs_find('opfs')
  const opfsDb = sqlite3.oo1.OpfsDb

  if (!opfsVfs || !opfsDb) {
    throw new Error(
      'SQLite OPFS storage is unavailable. Use a modern browser served with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.',
    )
  }

  return new opfsDb('/catalog-v10.sqlite3') as unknown as SqliteDb
}

async function ensureDb(
  mode: SqliteStorageMode = sqliteMode ?? 'opfs',
): Promise<InitResult> {
  if (db && initResult && sqliteMode === mode) return initResult

  const sqlite3 = await sqlite3InitModule()
  db = await openSqliteDb(sqlite3)
  sqliteMode = mode
  const activeDb = db

  activeDb.exec(`
    CREATE TABLE IF NOT EXISTS media_assets (
      content_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      duration_ms INTEGER,
      timestamp INTEGER,
      latitude REAL,
      longitude REAL,
      thumbnail_key TEXT
    );

    CREATE TABLE IF NOT EXISTS media_locations (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_label TEXT NOT NULL,
      root_path TEXT,
      relative_path TEXT,
      point_index INTEGER
    );

    CREATE TABLE IF NOT EXISTS catalog_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
      ON media_locations(content_hash);

    CREATE INDEX IF NOT EXISTS idx_assets_timestamp_hash
      ON media_assets(timestamp, content_hash);

    CREATE INDEX IF NOT EXISTS idx_assets_kind_timestamp_hash
      ON media_assets(kind, timestamp, content_hash);

    CREATE INDEX IF NOT EXISTS idx_assets_lat_lon_timestamp_hash
      ON media_assets(latitude, longitude, timestamp, content_hash);

  `)

  initResult = {
    storageMode: mode,
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

function iterateIdbCursorAsync(
  request: IDBRequest<IDBCursorWithValue | null>,
  visit: (cursor: IDBCursorWithValue) => Promise<boolean | void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB cursor failed'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }

      void visit(cursor)
        .then((shouldContinue) => {
          if (shouldContinue === false) {
            resolve()
            return
          }
          cursor.continue()
        })
        .catch(reject)
    }
  })
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

      if (!database.objectStoreNames.contains('assets')) {
        database.createObjectStore('assets', {
          keyPath: 'contentHash',
        })
      }

      if (!database.objectStoreNames.contains('locations')) {
        const locations = database.createObjectStore('locations', {
          keyPath: 'id',
        })
        locations.createIndex('contentHash', 'contentHash')
      }

      if (!database.objectStoreNames.contains('metadata')) {
        database.createObjectStore('metadata', {
          keyPath: 'key',
        })
      }

      if (!database.objectStoreNames.contains('indexCache')) {
        database.createObjectStore('indexCache', {
          keyPath: 'id',
        })
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

function sqliteCatalogEpochFromDb(activeDb: SqliteDb): number {
  const value = activeDb.selectValue(
    'SELECT value FROM catalog_metadata WHERE key = ?',
    [CATALOG_EPOCH_KEY],
  )
  return Number(value ?? 0) || 0
}

async function sqliteCatalogEpoch(): Promise<number> {
  await ensureDb()
  return sqliteCatalogEpochFromDb(requireDb())
}

function bumpSqliteCatalogEpochInDb(activeDb: SqliteDb): number {
  const nextEpoch = sqliteCatalogEpochFromDb(activeDb) + 1
  activeDb.exec({
    sql: `
      INSERT INTO catalog_metadata (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    bind: [CATALOG_EPOCH_KEY, String(nextEpoch)],
  })
  return nextEpoch
}

async function idbCatalogEpoch(): Promise<number> {
  const database = await requireIndexedDb()
  const transaction = database.transaction('metadata', 'readonly')
  const done = idbTransactionDone(transaction)
  const row = await idbRequest<IdbMetadata | undefined>(
    transaction.objectStore('metadata').get(CATALOG_EPOCH_KEY),
  )
  await done
  return Number(row?.value ?? 0) || 0
}

async function idbBumpCatalogEpoch(): Promise<number> {
  const database = await requireIndexedDb()
  const current = await idbCatalogEpoch()
  const nextEpoch = current + 1
  const transaction = database.transaction('metadata', 'readwrite')
  const done = idbTransactionDone(transaction)
  transaction.objectStore('metadata').put({
    key: CATALOG_EPOCH_KEY,
    value: String(nextEpoch),
  } satisfies IdbMetadata)
  await done
  return nextEpoch
}

async function segmentedBallTreeOpfsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const indexes = await root.getDirectoryHandle('indexes', { create: true })
  const engine = await indexes.getDirectoryHandle('segmented-ball-tree', {
    create: true,
  })
  return engine.getDirectoryHandle('v1', { create: true })
}

async function diskSegmentedTreeOpfsDirectory(
  engineId: DiskSegmentedEngineId,
): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  const indexes = await root.getDirectoryHandle('indexes', { create: true })
  const engine = await indexes.getDirectoryHandle(engineId, { create: true })
  return engine.getDirectoryHandle('v2', { create: true })
}

async function clearOpfsDirectory(
  directory: FileSystemDirectoryHandle,
): Promise<void> {
  const iterableDirectory = directory as FileSystemDirectoryHandle & {
    entries?: () => AsyncIterable<[string, FileSystemHandle]>
  }
  if (!iterableDirectory.entries) return
  for await (const [name] of iterableDirectory.entries()) {
    await directory.removeEntry(name, { recursive: true })
  }
}

async function readOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<File | undefined> {
  try {
    return await (await directory.getFileHandle(name)).getFile()
  } catch {
    return undefined
  }
}

async function writeOpfsFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  data: BlobPart,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true })
  if (!handle.createWritable) {
    throw new Error('OPFS writable files are unavailable.')
  }
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}

function createOpfsDiskSegmentedTreeStore(): DiskSegmentedTreeStore {
  return {
    async readManifest(engineId) {
      const directory = await diskSegmentedTreeOpfsDirectory(engineId)
      const file = await readOpfsFile(directory, 'manifest.json')
      if (!file) return undefined
      return JSON.parse(await file.text()) as DiskSegmentedTreeManifest
    },
    async writeManifest(engineId, manifest) {
      const directory = await diskSegmentedTreeOpfsDirectory(engineId)
      await writeOpfsFile(directory, 'manifest.json', JSON.stringify(manifest))
    },
    async readSegment(engineId, segmentId) {
      const directory = await diskSegmentedTreeOpfsDirectory(engineId)
      const file = await readOpfsFile(directory, `${segmentId}.bin`)
      return file?.arrayBuffer()
    },
    async writeSegment(engineId, segmentId, data) {
      const directory = await diskSegmentedTreeOpfsDirectory(engineId)
      await writeOpfsFile(directory, `${segmentId}.bin`, data)
    },
    async clear(engineId) {
      const directory = await diskSegmentedTreeOpfsDirectory(engineId)
      await clearOpfsDirectory(directory)
    },
  }
}

function idbDiskSegmentedManifestKey(engineId: DiskSegmentedEngineId): string {
  return `${engineId}:v2:manifest`
}

function idbDiskSegmentedSegmentKey(
  engineId: DiskSegmentedEngineId,
  segmentId: string,
): string {
  return `${engineId}:v2:segment:${segmentId}`
}

function createIdbDiskSegmentedTreeStore(): DiskSegmentedTreeStore {
  return {
    async readManifest(engineId) {
      const database = await requireIndexedDb()
      const transaction = database.transaction('indexCache', 'readonly')
      const done = idbTransactionDone(transaction)
      const row = await idbRequest<IdbIndexCache | undefined>(
        transaction
          .objectStore('indexCache')
          .get(idbDiskSegmentedManifestKey(engineId)),
      )
      await done
      return row?.manifest as DiskSegmentedTreeManifest | undefined
    },
    async writeManifest(engineId, manifest) {
      const database = await requireIndexedDb()
      const transaction = database.transaction('indexCache', 'readwrite')
      const done = idbTransactionDone(transaction)
      transaction.objectStore('indexCache').put({
        id: idbDiskSegmentedManifestKey(engineId),
        manifest,
      } satisfies IdbIndexCache)
      await done
    },
    async readSegment(engineId, segmentId) {
      const database = await requireIndexedDb()
      const transaction = database.transaction('indexCache', 'readonly')
      const done = idbTransactionDone(transaction)
      const row = await idbRequest<IdbIndexCache | undefined>(
        transaction
          .objectStore('indexCache')
          .get(idbDiskSegmentedSegmentKey(engineId, segmentId)),
      )
      await done
      return row?.data
    },
    async writeSegment(engineId, segmentId, data) {
      const database = await requireIndexedDb()
      const transaction = database.transaction('indexCache', 'readwrite')
      const done = idbTransactionDone(transaction)
      transaction.objectStore('indexCache').put({
        id: idbDiskSegmentedSegmentKey(engineId, segmentId),
        data,
      } satisfies IdbIndexCache)
      await done
    },
    async clear(engineId) {
      const database = await requireIndexedDb()
      const transaction = database.transaction('indexCache', 'readwrite')
      const done = idbTransactionDone(transaction)
      const store = transaction.objectStore('indexCache')
      const prefix = `${engineId}:v2:`
      await iterateIdbCursor(store.openCursor(), (cursor) => {
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          cursor.delete()
        }
      })
      await done
    },
  }
}

function segmentedBallTreeIndex(): SegmentedBallTreeGeoIndex {
  const index = geoIndexRegistry.get('segmented-ball-tree')
  if (!(index instanceof SegmentedBallTreeGeoIndex)) {
    throw new Error('Segmented ball-tree index is not available.')
  }
  return index
}

function isDiskSegmentedEngineId(
  indexId: string,
): indexId is DiskSegmentedEngineId {
  return indexId === 'segmented-ball-tree'
}

function diskSegmentedRuntimeKey(
  storageMode: WebCatalogStorageMode,
  indexId: DiskSegmentedEngineId,
): string {
  return `${storageMode}:${indexId}`
}

function diskSegmentedIndex(
  store: CatalogStore,
  indexId: DiskSegmentedEngineId,
): DiskSegmentedTreeIndex {
  const key = diskSegmentedRuntimeKey(store.storageMode, indexId)
  const existing = diskSegmentedIndexInstances.get(key)
  if (existing) return existing
  const index = new DiskSegmentedTreeIndex(indexId, store.diskSegmentedTreeStore())
  diskSegmentedIndexInstances.set(key, index)
  return index
}

function activeDiskSegmentedIndex(
  store: CatalogStore,
  indexId: string,
): DiskSegmentedTreeIndex | undefined {
  if (!isDiskSegmentedEngineId(indexId)) return undefined
  return diskSegmentedIndexInstances.get(
    diskSegmentedRuntimeKey(store.storageMode, indexId),
  )
}

function invalidatePreparedSearchIndex(): void {
  preparedSearchIndex = undefined
}

async function clearDiskSegmentedIndexCaches(store: CatalogStore): Promise<void> {
  const diskStore = store.diskSegmentedTreeStore()
  await diskStore.clear('segmented-ball-tree')
  diskSegmentedIndexInstances.delete(
    diskSegmentedRuntimeKey(store.storageMode, 'segmented-ball-tree'),
  )
  if (
    preparedSearchIndex?.storageMode === store.storageMode &&
    isDiskSegmentedEngineId(preparedSearchIndex.indexId)
  ) {
    preparedSearchIndex = undefined
  }
}

async function restoreSegmentedBallTreeIndexFromData(
  manifest: SegmentedBallTreeManifest,
  data: ArrayBuffer,
  catalogEpoch: number,
): Promise<{ pointCount: number; segmentCount: number }> {
  validateSegmentedBallTreeManifest(manifest, catalogEpoch)
  const checksum = await sha256Hex(data)
  if (checksum !== manifest.dataChecksum) {
    throw new Error('Segmented ball-tree index checksum does not match manifest.')
  }
  const snapshot = decodeSegmentedBallTreeSnapshot(data)
  if (
    snapshot.pointCount !== manifest.pointCount ||
    snapshot.segmentCount !== manifest.segmentCount
  ) {
    throw new Error('Segmented ball-tree index manifest count mismatch.')
  }
  segmentedBallTreeIndex().restore(snapshot)
  return {
    pointCount: snapshot.pointCount,
    segmentCount: snapshot.segmentCount,
  }
}

async function loadOpfsSegmentedBallTreeIndex(
  catalogEpoch: number,
): Promise<{ pointCount: number; segmentCount: number } | undefined> {
  try {
    const directory = await segmentedBallTreeOpfsDirectory()
    const [manifestFile, dataFile] = await Promise.all([
      readOpfsFile(directory, 'manifest.json'),
      readOpfsFile(directory, 'index.bin'),
    ])
    if (!manifestFile || !dataFile) return undefined

    return await restoreSegmentedBallTreeIndexFromData(
      JSON.parse(await manifestFile.text()) as SegmentedBallTreeManifest,
      await dataFile.arrayBuffer(),
      catalogEpoch,
    )
  } catch {
    return undefined
  }
}

async function saveOpfsSegmentedBallTreeIndex(
  catalogEpoch: number,
): Promise<void> {
  const snapshot = segmentedBallTreeIndex().snapshot()
  const data = encodeSegmentedBallTreeSnapshot(snapshot)
  const manifest = createSegmentedBallTreeManifest(
    snapshot,
    catalogEpoch,
    await sha256Hex(data),
  )
  const directory = await segmentedBallTreeOpfsDirectory()
  await writeOpfsFile(directory, 'index.bin', data)
  await writeOpfsFile(
    directory,
    'manifest.json',
    JSON.stringify(manifest),
  )
}

async function loadIdbSegmentedBallTreeIndex(
  catalogEpoch: number,
): Promise<{ pointCount: number; segmentCount: number } | undefined> {
  try {
    const database = await requireIndexedDb()
    const transaction = database.transaction('indexCache', 'readonly')
    const done = idbTransactionDone(transaction)
    const row = await idbRequest<IdbIndexCache | undefined>(
      transaction.objectStore('indexCache').get(SEGMENTED_BALL_TREE_CACHE_KEY),
    )
    await done
    if (!row?.manifest || !row.data) return undefined
    return await restoreSegmentedBallTreeIndexFromData(
      row.manifest as SegmentedBallTreeManifest,
      row.data,
      catalogEpoch,
    )
  } catch {
    return undefined
  }
}

async function saveIdbSegmentedBallTreeIndex(catalogEpoch: number): Promise<void> {
  const snapshot = segmentedBallTreeIndex().snapshot()
  const data = encodeSegmentedBallTreeSnapshot(snapshot)
  const manifest = createSegmentedBallTreeManifest(
    snapshot,
    catalogEpoch,
    await sha256Hex(data),
  )
  const database = await requireIndexedDb()
  const transaction = database.transaction('indexCache', 'readwrite')
  const done = idbTransactionDone(transaction)
  transaction.objectStore('indexCache').put({
    id: SEGMENTED_BALL_TREE_CACHE_KEY,
    manifest,
    data,
  } satisfies IdbIndexCache)
  await done
}

function idbAssetFromItem(item: MediaItem): IdbAsset {
  return {
    contentHash: item.contentHash,
    kind: item.kind,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    durationMs: item.durationMs,
    timestamp: item.timestamp,
    latitude: item.latitude,
    longitude: item.longitude,
    thumbnailKey: item.thumbnailKey,
  }
}

function mediaFromIdbAsset(
  asset: IdbAsset,
  locations: MediaLocation[],
): MediaItem {
  const row = {
    content_hash: asset.contentHash,
    kind: asset.kind,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    duration_ms: asset.durationMs,
    timestamp: asset.timestamp,
    latitude: asset.latitude,
    longitude: asset.longitude,
    thumbnail_key: asset.thumbnailKey,
  }
  return mediaFromAssetRow(row, locations)
}

function mediaLocationFromIdbLocation(location: IdbLocation): MediaLocation {
  return {
    id: location.id,
    sourceId: location.sourceId,
    sourceLabel: location.sourceLabel,
    rootPath: location.rootPath,
    relativePath: location.relativePath,
    absolutePath: location.absolutePath,
    pointIndex: location.pointIndex,
  }
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
): Promise<MediaItem[]> {
  if (assets.length === 0) return []

  const locationLists = await Promise.all(
    assets.map((asset) => idbLocationsForHash(database, asset.contentHash)),
  )

  return assets.map((asset, index) =>
    mediaFromIdbAsset(asset, locationLists[index] ?? []),
  )
}

async function idbUpsertSource(source: MediaSource): Promise<void> {
  void source
}

async function idbUpsertMedia(items: MediaItem[]): Promise<number> {
  if (items.length === 0) return 0

  const database = await requireIndexedDb()
  const transaction = database.transaction(['assets', 'locations'], 'readwrite')
  const done = idbTransactionDone(transaction)
  const assets = transaction.objectStore('assets')
  const locations = transaction.objectStore('locations')

  for (const item of items) {
    assets.put(idbAssetFromItem(item))
    for (const location of itemLocations(item)) {
      locations.put({
        ...location,
        contentHash: item.contentHash,
      } satisfies IdbLocation)
    }
  }

  await done
  await idbBumpCatalogEpoch()
  invalidatePreparedSearchIndex()
  return items.length
}

async function idbRemoveSources(sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return

  const database = await requireIndexedDb()
  const sourceIdSet = new Set(sourceIds)
  const locationsToDelete: IdbLocation[] = []
  const sourceTransaction = database.transaction('locations', 'readonly')
  const sourceDone = idbTransactionDone(sourceTransaction)
  await iterateIdbCursor(
    sourceTransaction.objectStore('locations').openCursor(),
    (cursor) => {
      const location = cursor.value as IdbLocation
      if (sourceIdSet.has(location.sourceId)) {
        locationsToDelete.push(location)
      }
    },
  )
  await sourceDone

  const affectedHashes = Array.from(
    new Set(locationsToDelete.map((location) => location.contentHash)),
  )

  const deleteTransaction = database.transaction('locations', 'readwrite')
  const deleteDone = idbTransactionDone(deleteTransaction)
  const locationStore = deleteTransaction.objectStore('locations')
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

  await idbBumpCatalogEpoch()
  invalidatePreparedSearchIndex()
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
): boolean {
  if (query.kind === 'media') {
    if (asset.kind !== 'image' && asset.kind !== 'video') return false
  } else if (query.kind && query.kind !== 'all' && asset.kind !== query.kind) {
    return false
  }
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
    if (asset.timestamp === undefined || asset.timestamp < query.startTime) {
      return false
    }
  }
  if (query.endTime !== undefined) {
    if (asset.timestamp === undefined || asset.timestamp > query.endTime) {
      return false
    }
  }
  return true
}

function compareIdbAssetsBytimestamp(
  sort: CatalogQuery['sort'],
  a: IdbAsset,
  b: IdbAsset,
): number {
  const aTime = a.timestamp
  const bTime = b.timestamp
  const aMissing = aTime === undefined
  const bMissing = bTime === undefined

  if (aMissing && !bMissing) return 1
  if (!aMissing && bMissing) return -1
  if (!aMissing && !bMissing && aTime !== bTime) {
    return sort === 'timestamp_asc' ? aTime - bTime : bTime - aTime
  }

  return a.contentHash.localeCompare(b.contentHash)
}

async function idbListMedia(query: CatalogQuery): Promise<MediaItem[]> {
  const database = await requireIndexedDb()
  const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
  const offset = Math.max(0, query.offset ?? 0)
  const matches: IdbAsset[] = []

  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  await iterateIdbCursor(
    transaction.objectStore('assets').openCursor(),
    (cursor) => {
      const asset = cursor.value as IdbAsset
      if (!idbAssetMatchesQuery(asset, query)) return
      matches.push(asset)
    },
  )
  await done

  matches.sort((a, b) => compareIdbAssetsBytimestamp(query.sort, a, b))
  const results = matches.slice(offset, offset + limit)
  return idbMediaItemsFromAssets(database, results)
}

async function idbSearchRows(query: CatalogQuery): Promise<MediaSearchRows> {
  return {
    items: await idbListMedia(query),
  }
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
          (asset.timestamp === undefined || asset.timestamp < range.startTime)) ||
        (range.endTime !== undefined &&
          (asset.timestamp === undefined || asset.timestamp > range.endTime))
      ) {
        return
      }
      points.push({
        mediaId: asset.contentHash,
        kind: asset.kind,
        lat: asset.latitude,
        lon: asset.longitude,
        timestamp: asset.timestamp,
      })
    },
  )
  await done
  points.sort((a, b) => a.mediaId.localeCompare(b.mediaId))
  return points
}

async function idbForEachGeoPointBatch(
  batchSize: number,
  onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
): Promise<number> {
  const database = await requireIndexedDb()
  const transaction = database.transaction('assets', 'readonly')
  const done = idbTransactionDone(transaction)
  let batch: GeoIndexPoint[] = []
  let processedPoints = 0

  const flush = async () => {
    if (batch.length === 0) return
    processedPoints += batch.length
    const current = batch
    batch = []
    await onBatch(current, processedPoints)
  }

  await iterateIdbCursorAsync(
    transaction.objectStore('assets').openCursor(),
    async (cursor) => {
      const asset = cursor.value as IdbAsset
      if (asset.latitude !== undefined && asset.longitude !== undefined) {
        batch.push({
          mediaId: asset.contentHash,
          kind: asset.kind,
          lat: asset.latitude,
          lon: asset.longitude,
          timestamp: asset.timestamp,
        })
      }
      if (batch.length >= batchSize) await flush()
    },
  )
  await flush()
  await done
  return processedPoints
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
    ['assets', 'locations'],
    'readwrite',
  )
  const done = idbTransactionDone(transaction)
  transaction.objectStore('locations').clear()
  transaction.objectStore('assets').clear()
  await done
  await idbBumpCatalogEpoch()
  invalidatePreparedSearchIndex()
}

function locationFromRow(row: Record<string, unknown>): MediaLocation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    sourceLabel: String(row.source_label),
    rootPath: toString(row.root_path),
    relativePath: toString(row.relative_path),
    pointIndex: toNumber(row.point_index),
  }
}

function displayNameForLocation(
  kind: MediaItem['kind'],
  contentHash: string,
  location: MediaLocation | undefined,
): string {
  if (kind === 'geo_point') {
    const base = location?.sourceLabel ?? location?.relativePath ?? contentHash
    return typeof location?.pointIndex === 'number'
      ? `${base} #${location.pointIndex}`
      : base
  }
  return pathDisplayName(location?.relativePath ?? contentHash)
}

function relativePathForLocation(
  location: MediaLocation | undefined,
): string {
  return location?.relativePath ?? location?.sourceLabel ?? ''
}

function mediaFromAssetRow(
  row: Record<string, unknown>,
  locations: MediaLocation[],
): MediaItem {
  const contentHash = String(row.content_hash)
  const kind =
    row.kind === 'video' || row.kind === 'geo_point'
      ? row.kind
      : 'image'
  const sortedLocations = [...locations].sort((a, b) => {
    return (
      (a.relativePath ?? '').localeCompare(b.relativePath ?? '') ||
      a.id.localeCompare(b.id)
    )
  })
  const primaryLocation = sortedLocations[0] ?? {
    id: contentHash,
    sourceId: '',
    sourceLabel: '',
    relativePath: '',
  }

  return {
    id: contentHash,
    contentHash,
    sourceId: primaryLocation.sourceId,
    relativePath: relativePathForLocation(primaryLocation),
    displayName: displayNameForLocation(
      kind,
      contentHash,
      primaryLocation,
    ),
    kind,
    mimeType: String(row.mime_type),
    sizeBytes: toNumber(row.size_bytes) ?? 0,
    durationMs: toNumber(row.duration_ms),
    timestamp: toNumber(row.timestamp),
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    thumbnailKey: toString(row.thumbnail_key),
    locations: sortedLocations,
  }
}

function assetBind(item: MediaItem): unknown[] {
  return [
    item.contentHash,
    item.kind,
    item.mimeType,
    item.sizeBytes,
    item.durationMs ?? null,
    item.timestamp ?? null,
    item.latitude ?? null,
    item.longitude ?? null,
    item.thumbnailKey ?? null,
  ]
}

function itemLocations(item: MediaItem): MediaLocation[] {
  if (item.locations.length > 0) return item.locations
  return [
    {
      id: `${item.sourceId}:${item.relativePath}`,
      sourceId: item.sourceId,
      sourceLabel: item.sourceId,
      relativePath: item.relativePath,
    },
  ]
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

function execMultiRowInsert(
  activeDb: SqliteDb,
  label: string,
  insertPrefix: string,
  rows: unknown[][],
  columnCount: number,
  conflictClause = '',
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
  const assetTiming = execMultiRowInsert(
    activeDb,
    'media_assets',
    `
    INSERT INTO media_assets (
      content_hash, kind, mime_type, size_bytes, duration_ms,
      timestamp, latitude, longitude, thumbnail_key
    )
    `,
    assetRows,
    ASSET_BIND_COLUMNS,
    `
    ON CONFLICT(content_hash) DO NOTHING
    `,
  )

  const locationRowsStartedAt = performance.now()
  const locationRows = items.flatMap((item) =>
    itemLocations(item).map((location) => [
      location.id,
      item.contentHash,
      location.sourceId,
      location.sourceLabel,
      location.rootPath ?? null,
      location.relativePath ?? null,
      location.pointIndex ?? null,
    ]),
  )
  const locationRowsMs = performance.now() - locationRowsStartedAt

  const locationTiming = execMultiRowInsert(
    activeDb,
    'media_locations',
    `
    INSERT INTO media_locations (
      id, content_hash, source_id, source_label, root_path, relative_path,
      point_index
    )
    `,
    locationRows,
    LOCATION_BIND_COLUMNS,
    `
    ON CONFLICT(id) DO NOTHING
    `,
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
    where.push(`${prefix}timestamp >= ?`)
    bind.push(query.startTime)
  }
  if (typeof query.endTime === 'number') {
    where.push(`${prefix}timestamp <= ?`)
    bind.push(query.endTime)
  }
}

function mediaItemsFromAssetRows(
  activeDb: SqliteDb,
  rows: Record<string, unknown>[],
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
    const location = locationFromRow(row)
    locations.push(location)
    locationsByHash.set(contentHash, locations)
  }

  return rows.map((row) =>
    mediaFromAssetRow(row, locationsByHash.get(String(row.content_hash)) ?? []),
  )
}

function upsertSourceIntoSqlite(activeDb: SqliteDb, source: MediaSource): void {
  void activeDb
  void source
}

function removeSourcesFromSqlite(activeDb: SqliteDb, sourceIds: string[]): void {
  if (sourceIds.length === 0) return

  const placeholders = sourceIds.map(() => '?').join(', ')
  activeDb.exec({
    sql: `DELETE FROM media_locations WHERE source_id IN (${placeholders})`,
    bind: sourceIds,
  })
  const orphanRows = activeDb.selectObjects(`
    SELECT content_hash
    FROM media_assets
    WHERE NOT EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = media_assets.content_hash
    )
  `)
  const orphanHashes = orphanRows.map((row) => String(row.content_hash))
  if (orphanHashes.length > 0) {
    for (let offset = 0; offset < orphanHashes.length; offset += 900) {
      const chunk = orphanHashes.slice(offset, offset + 900)
      const orphanPlaceholderSql = chunk.map(() => '?').join(', ')
      activeDb.exec({
        sql: `DELETE FROM media_assets WHERE content_hash IN (${orphanPlaceholderSql})`,
        bind: [...chunk],
      })
    }
  }
  bumpSqliteCatalogEpochInDb(activeDb)
  invalidatePreparedSearchIndex()
}

function prepareImportSource(
  activeDb: SqliteDb,
  source: MediaSource,
  duplicateSourceIds: string[],
): void {
  removeSourcesFromSqlite(activeDb, duplicateSourceIds)
  upsertSourceIntoSqlite(activeDb, source)
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
  const latitude = numeric(record.latitude) ?? numeric(record.GPSLatitude)
  const longitude = numeric(record.longitude) ?? numeric(record.GPSLongitude)
  const timestamp =
    dateMillis(record.DateTimeOriginal) ??
    dateMillis(record.CreateDate) ??
    dateMillis(record.DateCreated) ??
    dateMillis(record.ModifyDate) ??
    dateMillis(record.DateTime)

  return {
    timestamp,
    latitude,
    longitude,
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

function geoPointLocationId(sourceId: string, contentHash: string): string {
  return `geo_point_location:v1:${sourceId}:${contentHash}`
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

  const locationId = geoPointLocationId(sourceId, contentHash)

  const displayName = `${sourceLabel} #${point.index}`
  const location: MediaLocation = {
    id: locationId,
    sourceId,
    sourceLabel,
    pointIndex: point.index,
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
    timestamp: point.timestamp,
    latitude: point.latitude,
    longitude: point.longitude,
    locations: [location],
  }

  return item
}

function geoPointItemsFromParsedPoints(
  sourceId: string,
  sourceLabel: string,
  mimeType: string,
  points: ParsedGeoPoint[],
): MediaItem[] {
  return points.map((point) =>
    geoPointItemFromParsedPoint(
      sourceId,
      sourceLabel,
      mimeType,
      point,
    ),
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
      if (isCancelled()) {
        cancelled = true
        return
      }
      if (entry.kind === 'directory') {
        await countFiles(entry as FileSystemDirectoryHandle)
        if (cancelled) return
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
  if (cancelled) return summary()
  await store.prepareImportSource(source, duplicateSourceIds)
  if (isCancelled()) {
    cancelled = true
    return summary()
  }

  postProgress({
    phase: 'scanning',
    sourceLabel,
    scannedFiles,
    totalFiles,
    acceptedMedia,
    skippedFiles,
  })
  await store.withImportTransaction(
    async () => {
      await walk(handle, '')
      await flushBatch('storing')
    },
  )

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
  const readResult = await readFileTextWithProgress(
    file,
    sourceLabel,
    postProgress,
    isCancelled,
  )
  if (readResult.cancelled) {
    return { acceptedMedia: 0, skippedFiles: 0, cancelled: true }
  }
  const text = readResult.text
  const parsed = parseGeoFilePoints(file.name || sourceLabel, text)
  let acceptedMedia = 0
  let cancelled = false
  const batch: MediaItem[] = []

  const flushBatch = async (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    const flushedItems = batch.length
    await store.writeMediaBatch(batch)
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

  const commitIfRequested = async (phase: ImportProgress['phase']) => {
    if (!importCommitRequested) return
    importCommitRequested = false
    await flushBatch(phase)
    await store.commitImport()
  }

  await store.withImportTransaction(async () => {
    for (
      let offset = 0;
      offset < parsed.points.length;
      offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE
    ) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      const itemChunk = geoPointItemsFromParsedPoints(
        source.id,
        sourceLabel,
        parsed.mimeType,
        parsed.points.slice(offset, offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE),
      )

      for (const item of itemChunk) {
        batch.push(item)
        if (batch.length >= store.geoImportWriteBatchSize) {
          await flushBatch('storing')
          await commitIfRequested('storing')
          if (isCancelled()) {
            cancelled = true
            break
          }
        }
      }
      if (cancelled) break

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
      await commitIfRequested('storing')
    }

    await flushBatch('storing')
    await commitIfRequested('storing')
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
    await store.writeMediaBatch(batch)
    acceptedMedia += flushedItems
    batch.length = 0
    emitProgress(phase)
    await yieldToEventLoop()
    if (isCancelled()) {
      cancelled = true
    }
  }

  const commitIfRequested = async (phase: ImportProgress['phase']) => {
    if (!importCommitRequested) return
    importCommitRequested = false
    await flushBatch(phase)
    await store.commitImport()
  }

  const consumePoints = async () => {
    const points = pendingPoints.splice(0)

    for (
      let offset = 0;
      offset < points.length;
      offset += GEO_POINT_ITEM_BUILD_CHUNK_SIZE
    ) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      const pointChunk = points.slice(
        offset,
        offset + GEO_POINT_ITEM_BUILD_CHUNK_SIZE,
      )
      const itemChunk = geoPointItemsFromParsedPoints(
        source.id,
        sourceLabel,
        'application/json',
        pointChunk,
      )

      for (const item of itemChunk) {
        batch.push(item)
        if (batch.length >= store.geoImportWriteBatchSize) {
          await flushBatch('scanning')
          if (cancelled) break
        }
      }
      if (cancelled) break

      maybeEmitProgress()
      await yieldToEventLoop()
      await commitIfRequested('scanning')
    }
  }

  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      if (isCancelled()) {
        cancelled = true
        break
      }
      const result = parser.feed(chunk, {
        maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS,
      })
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

  await store.withImportTransaction(
    async () => {
      while (true) {
        if (isCancelled()) {
          cancelled = true
          await reader.cancel()
          break
        }
        const { done, value } = await reader.read()
        if (done) break

        bytesRead += value.byteLength
        const text = decoder.decode(value, { stream: true })
        await consumeText(text)
        await commitIfRequested('scanning')
        if (cancelled) break
      }

      if (!cancelled) {
        const finalChunk = decoder.decode()
        if (finalChunk) {
          await consumeText(finalChunk)
          await commitIfRequested('scanning')
        }

        const final = parser.finish()
        skippedFiles = final.skippedPoints
        await consumePoints()
      }
      await flushBatch('storing')
      await commitIfRequested('storing')
    },
  )
  emitProgress('storing')

  return { acceptedMedia, skippedFiles, cancelled }
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
        return importGoogleTakeoutIntoCatalog(
          file,
          source,
          store,
          postProgress,
          isCancelled,
        )
      })()
    : await (async () => {
        return importGpxIntoCatalog(file, source, store, postProgress, isCancelled)
      })()

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

function sqliteListMediaStatement(query: CatalogQuery): {
  sql: string
  bind: unknown[]
  limit: number
  offset: number
} {
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

  where.push('a.timestamp IS NOT NULL')
  timeWhere(query, where, bind, 'a.')

  const order =
    query.sort === 'timestamp_asc'
      ? 'a.timestamp ASC, a.content_hash ASC'
      : 'a.timestamp DESC, a.content_hash DESC'
  const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
  const offset = Math.max(0, query.offset ?? 0)
  bind.push(limit, offset)

  return {
    sql: `
      SELECT a.*
      FROM media_assets a
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `,
    bind,
    limit,
    offset,
  }
}

function sqliteExplainPlan(
  activeDb: SqliteDb,
  sql: string,
  bind: unknown[],
): SqlExplainPlan {
  const rows = activeDb.selectObjects(
    `EXPLAIN QUERY PLAN ${sql}`,
    bind,
  ) as SqliteSelectPlanRow[]

  return createSqlExplainPlan(
    rows.map((row) => ({
      id: Number(row.id ?? 0),
      parent: Number(row.parent ?? 0),
      detail: String(row.detail ?? ''),
    })),
  )
}

async function sqliteSearchRows(
  query: CatalogQuery,
  options?: { explainSql?: boolean },
): Promise<MediaSearchRows> {
  await ensureDb()
  const activeDb = requireDb()
  const statement = sqliteListMediaStatement(query)
  const sqlPlan = options?.explainSql
    ? sqliteExplainPlan(activeDb, statement.sql, statement.bind)
    : undefined
  const rows = activeDb.selectObjects(statement.sql, statement.bind)

  return {
    items: mediaItemsFromAssetRows(activeDb, rows),
    sqlPlan,
  }
}

async function listMedia(query: CatalogQuery): Promise<MediaItem[]> {
  return (await sqliteSearchRows(query)).items
}

function defaultSearchStats(
  engineId: string,
  engineLabel: string,
): SearchIndexStats {
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

function withQueryMetrics(
  base: SearchIndexStats,
  spec: SearchSpec,
  storageMode: SearchStorageMode,
  queryTimeMs: number,
  rowsReturned: number,
  limit: number,
  offset: number,
  limitReached: boolean,
  sqlPlan?: SqlExplainPlan,
): SearchIndexStats {
  return {
    ...base,
    queryPurpose: spec.purpose,
    storageMode,
    queryTimeMs,
    lastQueryTimeMs: base.lastQueryTimeMs ?? queryTimeMs,
    rowsReturned,
    limit,
    offset,
    limitReached,
    sqlPlan,
  }
}

function searchSpecToCatalogQuery(
  spec: SearchSpec,
  limit: number,
): CatalogQuery {
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

async function enrichDistanceResults(
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  results: GeoSearchResult[],
): Promise<SearchPage['items']> {
  const resultIds = Array.from(new Set(results.map((result) => result.mediaId)))
  const itemChunks = await Promise.all(
    Array.from({ length: Math.ceil(resultIds.length / 500) }, (_, index) =>
      getMediaByIdsFn(resultIds.slice(index * 500, (index + 1) * 500)),
    ),
  )
  const itemsById = new Map(
    itemChunks.flat().map((item) => [item.id, item]),
  )
  return results.flatMap((result) => {
    const item = itemsById.get(result.mediaId)
    return item ? [{ ...result, item }] : []
  })
}

function createSqlSearchEngine(
  engineId: string,
  engineLabel: string,
  supportsGeoBounds: boolean,
  storageMode: SearchStorageMode,
  searchRowsFn: MediaSearchRowsFn,
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
      supportsGeoBounds,
      supportsTimeRange: true,
      supportsKind: true,
    },
    canHandle(spec) {
      return spec.order.kind === 'timestamp' && Boolean(spec.geoBounds) === supportsGeoBounds
    },
    async search(spec) {
      const limit = Math.max(1, Math.min(spec.limit ?? 500, 10_000))
      const offset = Math.max(0, spec.offset ?? 0)
      const startedAt = performance.now()
      const rows = await searchRowsFn(searchSpecToCatalogQuery(spec, limit + 1), {
        explainSql: spec.diagnostics?.explainSql,
      })
      const limitedRows = rows.items.slice(0, limit)
      const limitReached = rows.items.length > limit
      return {
        items: mediaItemsToSearchResults(limitedRows),
        resultMetrics: withQueryMetrics(
          defaultSearchStats(engineId, engineLabel),
          spec,
          storageMode,
          performance.now() - startedAt,
          limitedRows.length,
          limit,
          offset,
          limitReached,
          rows.sqlPlan,
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

function createDistanceSearchEngine(
  geoIndex: (typeof geoIndexRegistry.indexes)[number],
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  storageMode: SearchStorageMode,
  store: CatalogStore,
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
      const activeIndex = activeDiskSegmentedIndex(store, geoIndex.id)
      const results = activeIndex
        ? await activeIndex.search(query)
        : await searchGeoIndex(store, {
            indexId: geoIndex.id,
            query,
          })
      const stats = activeIndex ? await activeIndex.stats() : await geoIndex.stats()
      const resultMetrics = {
        ...stats,
        engineLabel: activeIndex?.label ?? geoIndex.label,
        exact: activeIndex?.capabilities.exact ?? geoIndex.capabilities.exact,
        persistent:
          activeIndex?.capabilities.persistent ?? geoIndex.capabilities.persistent,
      }
      const items = await enrichDistanceResults(getMediaByIdsFn, results)
      const limitReached =
        results.length >= limit &&
        resultMetrics.pointCount > offset + limit
      return {
        items,
        resultMetrics: withQueryMetrics(
          resultMetrics,
          spec,
          storageMode,
          performance.now() - startedAt,
          items.length,
          limit,
          offset,
          limitReached,
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
  storageMode: SearchStorageMode,
  store: CatalogStore,
): SearchIndexEngineRegistry {
  const engines: SearchIndexEngine[] = [
    createSqlSearchEngine(
      'sqlite-timestamp',
      'SQLite timestamp B-tree',
      false,
      storageMode,
      searchRowsFn,
    ),
    createSqlSearchEngine(
      'sqlite-bbox-time',
      'SQLite bbox/time B-tree',
      true,
      storageMode,
      searchRowsFn,
    ),
  ]

  engines.push(
    ...geoIndexRegistry.indexes.map((index) =>
      createDistanceSearchEngine(index, getMediaByIdsFn, storageMode, store),
    ),
  )

  return new SearchIndexEngineRegistry(engines)
}

async function searchMediaWithCatalogFunctions(
  spec: SearchSpec,
  searchRowsFn: MediaSearchRowsFn,
  getMediaByIdsFn: (ids: string[]) => Promise<MediaItem[]>,
  storageMode: SearchStorageMode,
  store: CatalogStore,
): Promise<SearchPage> {
  return createSearchRegistry(
    searchRowsFn,
    getMediaByIdsFn,
    storageMode,
    store,
  ).search(spec)
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
      SELECT a.content_hash, a.latitude, a.longitude, a.timestamp
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
    timestamp: toNumber(row.timestamp),
  }))
}

async function forEachGeoPointBatch(
  batchSize: number,
  onBatch: (batch: GeoIndexPoint[], processedPoints: number) => Promise<void>,
): Promise<number> {
  await ensureDb()
  const activeDb = requireDb()
  let lastContentHash = ''
  let processedPoints = 0

  while (true) {
    const rows = activeDb.selectObjects(
      `
        SELECT a.content_hash, a.latitude, a.longitude, a.timestamp, a.kind
        FROM media_assets a
        WHERE a.content_hash > ?
          AND a.latitude IS NOT NULL
          AND a.longitude IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM media_locations l
            WHERE l.content_hash = a.content_hash
          )
        ORDER BY a.content_hash ASC
        LIMIT ?
      `,
      [lastContentHash, batchSize],
    )
    if (rows.length === 0) break

    const batch: GeoIndexPoint[] = rows.map((row) => ({
      mediaId: String(row.content_hash),
      kind:
        row.kind === 'image' || row.kind === 'video' || row.kind === 'geo_point'
          ? row.kind
          : undefined,
      lat: toNumber(row.latitude) ?? 0,
      lon: toNumber(row.longitude) ?? 0,
      timestamp: toNumber(row.timestamp),
    }))
    processedPoints += batch.length
    lastContentHash = batch[batch.length - 1]?.mediaId ?? lastContentHash
    await onBatch(batch, processedPoints)
    if (rows.length < batchSize) break
  }

  return processedPoints
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

function searchEngineCountForStore(store: CatalogStore): number {
  void store
  return geoIndexRegistry.indexes.length + 2
}

async function buildSearchIndexes(
  store: CatalogStore,
  indexId: string,
  forceRebuild: boolean,
  postProgress: (progress: GeoIndexBuildProgress) => void,
): Promise<GeoIndexBuildSummary & { engineCount: number }> {
  const startedAt = performance.now()
  const totalIndexes = 1
  const selectedIndexId =
    indexId === 'brute-force'
      ? 'brute-force'
      : isDiskSegmentedEngineId(indexId)
        ? indexId
        : 'segmented-ball-tree'
  const diskIndex = isDiskSegmentedEngineId(selectedIndexId)
    ? diskSegmentedIndex(store, selectedIndexId)
    : undefined
  const registryIndex =
    selectedIndexId === 'brute-force'
      ? geoIndexRegistry.get('brute-force')
      : geoIndexRegistry.get('segmented-ball-tree')
  const index = diskIndex ?? registryIndex

  traceStartup('[geo-index:worker]', 'buildSearchIndexes start', {
    requestedIndexId: indexId,
    selectedIndexId,
    effectiveIndexId: index.id,
    forceRebuild,
    storageMode: store.storageMode,
    hasDiskIndex: Boolean(diskIndex),
    preparedSearchIndex,
  })

  postProgress({
    phase: 'loading',
    pointCount: 0,
    builtIndexes: 0,
    totalIndexes,
    currentIndexId: index.id,
    currentIndexLabel: index.label,
  })

  const catalogEpoch = await store.catalogEpoch()
  traceStartup('[geo-index:worker]', 'catalog epoch loaded', {
    selectedIndexId,
    catalogEpoch,
    preparedSearchIndex,
  })
  if (
    !forceRebuild &&
    preparedSearchIndex?.storageMode === store.storageMode &&
    preparedSearchIndex?.indexId === index.id &&
    preparedSearchIndex.catalogEpoch === catalogEpoch
  ) {
    traceStartup('[geo-index:worker]', 'using already-prepared worker index', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
    const stats = await index.stats()
    postProgress({
      phase: 'ready',
      pointCount: stats.pointCount,
      builtIndexes: totalIndexes,
      totalIndexes,
      currentIndexId: index.id,
      currentIndexLabel: index.label,
      currentIndexProcessedPoints: stats.pointCount,
      currentIndexTotalPoints: stats.pointCount,
    })

    return {
      pointCount: stats.pointCount,
      buildTimeMs: performance.now() - startedAt,
      engineCount: searchEngineCountForStore(store),
    }
  }

  if (forceRebuild) {
    traceStartup('[geo-index:worker]', 'skipping restore because forceRebuild=true', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
  } else if (preparedSearchIndex) {
    traceStartup('[geo-index:worker]', 'already-prepared worker index did not match', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
      preparedSearchIndex,
    })
  } else {
    traceStartup('[geo-index:worker]', 'no already-prepared worker index available', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
  }

  if (!forceRebuild && diskIndex) {
    traceStartup('[geo-index:worker]', 'attempting persisted disk index restore', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
    const restored = await diskIndex.prepare(catalogEpoch)
    if (restored) {
      traceStartup('[geo-index:worker]', 'persisted disk index restored', {
        indexId: index.id,
        storageMode: store.storageMode,
        catalogEpoch,
      })
      const stats = await index.stats()
      preparedSearchIndex = {
        storageMode: store.storageMode,
        indexId: index.id,
        catalogEpoch,
        cacheDirty: false,
      }
      postProgress({
        phase: 'ready',
        pointCount: stats.pointCount,
        builtIndexes: totalIndexes,
        totalIndexes,
        currentIndexId: index.id,
        currentIndexLabel: index.label,
        currentIndexProcessedPoints: stats.pointCount,
        currentIndexTotalPoints: stats.pointCount,
      })

      return {
        pointCount: stats.pointCount,
        buildTimeMs: performance.now() - startedAt,
        engineCount: searchEngineCountForStore(store),
      }
    }
    traceStartup('[geo-index:worker]', 'persisted disk index restore failed; rebuilding', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
  }

  if (diskIndex) {
    traceStartup('[geo-index:worker]', 'disk index build branch entered', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
    })
    postProgress({
      phase: 'building',
      pointCount: 0,
      builtIndexes: 0,
      totalIndexes,
      currentIndexId: index.id,
      currentIndexLabel: index.label,
      currentIndexProcessedPoints: 0,
    })

    const producer: DiskSegmentedBatchProducer = (onBatch) =>
      store.forEachGeoPointBatch(100_000, onBatch)
    const pointCount = await diskIndex.build(
      producer,
      catalogEpoch,
      (processedPoints, totalPoints) => {
        postProgress({
          phase: 'building',
          pointCount: processedPoints,
          builtIndexes: 0,
          totalIndexes,
          currentIndexId: index.id,
          currentIndexLabel: index.label,
          currentIndexProcessedPoints: processedPoints,
          currentIndexTotalPoints: totalPoints,
        })
      },
    )

    traceStartup('[geo-index:worker]', 'disk index build complete', {
      indexId: index.id,
      storageMode: store.storageMode,
      catalogEpoch,
      pointCount,
      buildTimeMs: performance.now() - startedAt,
    })

    preparedSearchIndex = {
      storageMode: store.storageMode,
      indexId: index.id,
      catalogEpoch,
      cacheDirty: false,
    }

    postProgress({
      phase: 'ready',
      pointCount,
      builtIndexes: totalIndexes,
      totalIndexes,
      currentIndexId: index.id,
      currentIndexLabel: index.label,
      currentIndexProcessedPoints: pointCount,
      currentIndexTotalPoints: pointCount,
    })

    return {
      pointCount,
      buildTimeMs: performance.now() - startedAt,
      engineCount: searchEngineCountForStore(store),
    }
  }

  traceStartup('[geo-index:worker]', 'in-memory index build branch entered', {
    indexId: index.id,
    storageMode: store.storageMode,
    catalogEpoch,
  })
  const points = await store.getGeoPoints({})

  postProgress({
    phase: 'building',
    pointCount: points.length,
    builtIndexes: 0,
    totalIndexes,
    currentIndexId: index.id,
    currentIndexLabel: index.label,
    currentIndexProcessedPoints: 0,
    currentIndexTotalPoints: points.length,
  })

  await registryIndex.build(points, {
    yieldEvery: 2_000,
    onProgress: (progress) => {
      postProgress({
        phase: 'building',
        pointCount: points.length,
        builtIndexes: 0,
        totalIndexes,
        currentIndexId: progress.indexId,
        currentIndexLabel: progress.indexLabel,
        currentIndexProcessedPoints: progress.processedPoints,
        currentIndexTotalPoints: progress.totalPoints,
      })
    },
  })

  preparedSearchIndex = {
    storageMode: store.storageMode,
    indexId: index.id,
    catalogEpoch,
    cacheDirty: index.capabilities.persistent,
  }

  const summary = {
    pointCount: points.length,
    buildTimeMs: performance.now() - startedAt,
  }
  traceStartup('[geo-index:worker]', 'in-memory index build complete', {
    indexId: index.id,
    storageMode: store.storageMode,
    catalogEpoch,
    pointCount: points.length,
    buildTimeMs: summary.buildTimeMs,
  })

  postProgress({
    phase: 'ready',
    pointCount: points.length,
    builtIndexes: totalIndexes,
    totalIndexes,
    currentIndexId: index.id,
    currentIndexLabel: index.label,
    currentIndexProcessedPoints: points.length,
    currentIndexTotalPoints: points.length,
  })

  return {
    ...summary,
    engineCount: searchEngineCountForStore(store),
  }
}

async function searchGeoIndex(store: CatalogStore, payload: {
  indexId: string
  query: GeoSearchQuery
}): Promise<GeoSearchResult[]> {
  const diskIndex = activeDiskSegmentedIndex(store, payload.indexId)
  if (diskIndex) return diskIndex.search(payload.query)
  return geoIndexRegistry.get(payload.indexId).search(payload.query)
}

async function getGeoIndexStats(
  store: CatalogStore,
  indexId: string,
): Promise<GeoIndexStats> {
  const diskIndex = activeDiskSegmentedIndex(store, indexId)
  if (diskIndex) return diskIndex.stats()
  return geoIndexRegistry.get(indexId).stats()
}

async function getSearchIndexStats(store: CatalogStore): Promise<SearchIndexStats[]> {
  const sqlStats = [
    defaultSearchStats('sqlite-timestamp', 'SQLite timestamp B-tree'),
    defaultSearchStats('sqlite-bbox-time', 'SQLite bbox/time B-tree'),
  ]
  const geoStats = await Promise.all(
    geoIndexRegistry.indexes.map(async (index) => {
      const activeIndex = activeDiskSegmentedIndex(store, index.id)
      const stats = activeIndex ? await activeIndex.stats() : await index.stats()
      return {
        ...stats,
        engineLabel: activeIndex?.label ?? index.label,
        exact: activeIndex?.capabilities.exact ?? index.capabilities.exact,
        persistent:
          activeIndex?.capabilities.persistent ?? index.capabilities.persistent,
      }
    }),
  )
  return [...sqlStats, ...geoStats]
}

async function validateGeoIndex(store: CatalogStore, payload: {
  indexId: string
  query: GeoSearchQuery
}): Promise<ValidationReport> {
  const diskIndex = activeDiskSegmentedIndex(store, payload.indexId)
  if (diskIndex) return diskIndex.validateAgainstBruteForce(payload.query)
  return geoIndexRegistry
    .get(payload.indexId)
    .validateAgainstBruteForce(payload.query)
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
  `)
  bumpSqliteCatalogEpochInDb(requireDb())
  invalidatePreparedSearchIndex()
}

type SqliteImportTransactionState = {
  active: boolean
  writtenItems: number
  committedChunks: number
}

function beginSqliteImportTransaction(
  activeDb: SqliteDb,
  state: SqliteImportTransactionState,
): void {
  if (state.active) return
  activeDb.exec('BEGIN')
  state.active = true
  state.writtenItems = 0
}

function commitSqliteImportTransaction(
  activeDb: SqliteDb,
  state: SqliteImportTransactionState,
): void {
  if (!state.active) return
  if (state.writtenItems > 0) {
    bumpSqliteCatalogEpochInDb(activeDb)
  }
  activeDb.exec('COMMIT')
  state.active = false
  state.writtenItems = 0
  state.committedChunks += 1
}

function rollbackSqliteImportTransaction(
  activeDb: SqliteDb,
  state: SqliteImportTransactionState,
): void {
  if (!state.active) return
  activeDb.exec('ROLLBACK')
  state.active = false
  state.writtenItems = 0
}

function createSqliteCatalogStore(mode: SqliteStorageMode): CatalogStore {
  const ensureMode = () => ensureDb(mode)
  const webStorageMode: WebCatalogStorageMode = 'sqlite'
  let importTransactionState: SqliteImportTransactionState | undefined

  const store: CatalogStore = {
    storageMode: webStorageMode,
    geoImportWriteBatchSize: GEO_IMPORT_SQLITE_WRITE_BATCH_SIZE,
    init: ensureMode,
    async upsertSource(source) {
      await ensureMode()
      upsertSourceIntoSqlite(requireDb(), source)
    },
    async upsertMedia(items) {
      await ensureMode()
      upsertMediaIntoSqlite(requireDb(), items)
      if (items.length > 0) {
        bumpSqliteCatalogEpochInDb(requireDb())
        invalidatePreparedSearchIndex()
      }
      return items.length
    },
    async prepareImportSource(source, duplicateSourceIds) {
      await ensureMode()
      prepareImportSource(requireDb(), source, duplicateSourceIds)
      if (duplicateSourceIds.length > 0) {
        bumpSqliteCatalogEpochInDb(requireDb())
        invalidatePreparedSearchIndex()
        await clearDiskSegmentedIndexCaches(store)
      }
    },
    async writeMediaBatch(items) {
      const startedAt = performance.now()
      const ensureStartedAt = performance.now()
      await ensureMode()
      const ensureDbMs = performance.now() - ensureStartedAt
      if (items.length === 0) {
        const totalMs = performance.now() - startedAt
        return {
          written: 0,
          timing: {
            storageMode: webStorageMode,
            items: 0,
            transactionActive: Boolean(importTransactionState?.active),
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
      const transactionState = importTransactionState
      let transactionActive = false
      if (transactionState) {
        beginSqliteImportTransaction(activeDb, transactionState)
        transactionActive = true
      }
      const sqliteTiming = upsertMediaIntoSqlite(activeDb, items)
      if (transactionState) {
        transactionState.writtenItems += items.length
      } else {
        bumpSqliteCatalogEpochInDb(activeDb)
        invalidatePreparedSearchIndex()
      }
      const writeMs = performance.now() - writeStartedAt
      const totalMs = performance.now() - startedAt
      const accountedMs = ensureDbMs + requireDbMs + writeMs
      return {
        written: items.length,
        timing: {
          storageMode: webStorageMode,
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
    async commitImport() {
      await ensureMode()
      if (!importTransactionState) return
      commitSqliteImportTransaction(requireDb(), importTransactionState)
    },
    async withImportTransaction(run) {
      if (importTransactionState) {
        throw new Error('Nested SQLite import transactions are not supported.')
      }

      await ensureMode()
      if (preparedSearchIndex?.storageMode === store.storageMode) {
        traceStartup('[geo-index:worker]', 'prepared search index invalidated for bulk import', {
          storageMode: store.storageMode,
          preparedSearchIndex,
        })
        preparedSearchIndex = undefined
      }
      const transactionState: SqliteImportTransactionState = {
        active: false,
        writtenItems: 0,
        committedChunks: 0,
      }
      importTransactionState = transactionState

      try {
        const result = await run()
        commitSqliteImportTransaction(requireDb(), transactionState)
        return result
      } catch (error) {
        rollbackSqliteImportTransaction(requireDb(), transactionState)
        throw error
      } finally {
        importTransactionState = undefined
      }
    },
    async listMedia(query) {
      await ensureMode()
      return listMedia(query)
    },
    async searchMedia(spec) {
      await ensureMode()
      return searchMediaWithCatalogFunctions(
        spec,
        sqliteSearchRows,
        getMediaByIds,
        'sqlite',
        store,
      )
    },
    async getMediaByIds(ids) {
      await ensureMode()
      return getMediaByIds(ids)
    },
    async getGeoPoints(range) {
      await ensureMode()
      return getGeoPoints(range)
    },
    async forEachGeoPointBatch(batchSize, onBatch) {
      await ensureMode()
      return forEachGeoPointBatch(batchSize, onBatch)
    },
    diskSegmentedTreeStore() {
      return createOpfsDiskSegmentedTreeStore()
    },
    async catalogEpoch() {
      await ensureMode()
      return sqliteCatalogEpoch()
    },
    async loadPersistedSegmentedBallTreeIndex(catalogEpoch) {
      await ensureMode()
      return loadOpfsSegmentedBallTreeIndex(catalogEpoch)
    },
    async savePersistedSegmentedBallTreeIndex(catalogEpoch) {
      await ensureMode()
      return saveOpfsSegmentedBallTreeIndex(catalogEpoch)
    },
    async buildSearchIndexes(indexId, forceRebuild, postProgress) {
      await ensureMode()
      return buildSearchIndexes(this, indexId, forceRebuild, postProgress)
    },
    async getSearchIndexStats() {
      return getSearchIndexStats(store)
    },
    async countMedia() {
      await ensureMode()
      return countMedia()
    },
    async clear() {
      await ensureMode()
      await clearCatalog()
      await clearDiskSegmentedIndexCaches(store)
    },
  }

  return store
}

const sqliteCatalogStore = createSqliteCatalogStore('opfs')

const indexedDbCatalogStore: CatalogStore = {
  storageMode: 'indexeddb',
  geoImportWriteBatchSize: GEO_IMPORT_INDEXEDDB_WRITE_BATCH_SIZE,
  init: ensureIndexedDb,
  upsertSource: idbUpsertSource,
  upsertMedia: idbUpsertMedia,
  async prepareImportSource(source, duplicateSourceIds) {
    await idbPrepareImportSource(source, duplicateSourceIds)
    if (duplicateSourceIds.length > 0) {
      await clearDiskSegmentedIndexCaches(indexedDbCatalogStore)
    }
  },
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
  async commitImport() {},
  async withImportTransaction(run) {
    return run()
  },
  listMedia: idbListMedia,
  searchMedia(spec) {
    return searchMediaWithCatalogFunctions(
      spec,
      idbSearchRows,
      idbGetMediaByIds,
      'indexeddb',
      indexedDbCatalogStore,
    )
  },
  getMediaByIds: idbGetMediaByIds,
  getGeoPoints: idbGetGeoPoints,
  forEachGeoPointBatch: idbForEachGeoPointBatch,
  diskSegmentedTreeStore: createIdbDiskSegmentedTreeStore,
  catalogEpoch: idbCatalogEpoch,
  loadPersistedSegmentedBallTreeIndex: loadIdbSegmentedBallTreeIndex,
  savePersistedSegmentedBallTreeIndex: saveIdbSegmentedBallTreeIndex,
  buildSearchIndexes(indexId, forceRebuild, postProgress) {
    return buildSearchIndexes(
      indexedDbCatalogStore,
      indexId,
      forceRebuild,
      postProgress,
    )
  },
  getSearchIndexStats() {
    return getSearchIndexStats(indexedDbCatalogStore)
  },
  countMedia: idbCountMedia,
  async clear() {
    await idbClear()
    await clearDiskSegmentedIndexCaches(indexedDbCatalogStore)
  },
}

function storageModeForRequest(request: WorkerRequest): WebCatalogStorageMode {
  if (request.storageMode === 'indexeddb') return 'indexeddb'
  return 'sqlite'
}

function catalogStoreForMode(mode: WebCatalogStorageMode): CatalogStore {
  if (mode === 'indexeddb') return indexedDbCatalogStore
  return sqliteCatalogStore
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
        () => cancelledRequests.has(request.id),
      )
    case 'importGeoFile':
      return importGeoFileIntoCatalog(
        request.payload as ImportGeoFilePayload,
        store,
        postProgress as (progress: ImportProgress) => void,
        () => cancelledRequests.has(request.id),
      )
    case 'commitImport':
      importCommitRequested = true
      return undefined
    case 'listMedia':
      return store.listMedia(request.payload as CatalogQuery)
    case 'searchMedia':
      return store.searchMedia(request.payload as SearchSpec)
    case 'getMediaByIds':
      return store.getMediaByIds(request.payload as string[])
    case 'getGeoPoints':
      return store.getGeoPoints((request.payload ?? {}) as TimeRange)
    case 'countMedia':
      return store.countMedia()
    case 'buildGeoIndexes':
      return buildGeoIndexes(store, postProgress)
    case 'buildSearchIndexes':
      return store.buildSearchIndexes(
        (request.payload as { indexId?: string } | undefined)?.indexId ??
          'segmented-ball-tree',
        Boolean(
          (request.payload as { forceRebuild?: boolean } | undefined)
            ?.forceRebuild,
        ),
        postProgress,
      )
    case 'searchGeoIndex':
      return searchGeoIndex(
        store,
        request.payload as { indexId: string; query: GeoSearchQuery },
      )
    case 'getGeoIndexStats':
      return getGeoIndexStats(store, request.payload as string)
    case 'getSearchIndexStats':
      return store.getSearchIndexStats()
    case 'validateGeoIndex':
      return validateGeoIndex(
        store,
        request.payload as { indexId: string; query: GeoSearchQuery },
      )
    case 'clear':
      return store.clear()
    default:
      throw new Error(`Unknown catalog request: ${request.type}`)
  }
}

ctx.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const receivedAt = performance.now()
  if (event.data.type === 'cancel') {
    traceStartup('[startup:worker]', 'cancel request received', {
      id: event.data.id,
      elapsedSinceReceiveMs: performance.now() - receivedAt,
    })
    cancelledRequests.add(event.data.id)
    return
  }

  traceStartup('[startup:worker]', 'request received', {
    id: event.data.id,
    type: event.data.type,
    storageMode: event.data.storageMode,
    hasPayload: event.data.payload !== undefined,
  })
  try {
    const postProgress = (progress: GeoIndexBuildProgress | ImportProgress) => {
      traceStartup('[startup:worker]', 'posting progress', {
        id: event.data.id,
        type: event.data.type,
        elapsedMs: performance.now() - receivedAt,
        progress,
      })
      ctx.postMessage({ id: event.data.id, type: 'progress', progress })
    }
    const result = await handleRequest(event.data, postProgress)
    traceStartup('[startup:worker]', 'request complete', {
      id: event.data.id,
      type: event.data.type,
      elapsedMs: performance.now() - receivedAt,
    })
    ctx.postMessage({ id: event.data.id, ok: true, result })
  } catch (error) {
    traceStartup('[startup:worker]', 'request failed', {
      id: event.data.id,
      type: event.data.type,
      elapsedMs: performance.now() - receivedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    ctx.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    cancelledRequests.delete(event.data.id)
  }
})
