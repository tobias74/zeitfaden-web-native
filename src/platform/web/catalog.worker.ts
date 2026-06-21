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
  ImportProgress,
  ImportSummary,
} from '../types'

type WorkerRequest = {
  id: number
  type: string
  payload?: unknown
}

type InitResult = {
  storageMode: 'opfs'
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

let db: SqliteDb | undefined
let initResult: InitResult | undefined
const geoIndexRegistry = new GeoIndexRegistry()

const IMPORT_BATCH_SIZE = 1000
const GEO_IMPORT_PREFIX_BYTES = 512 * 1024
const GEO_IMPORT_PARSE_SLICE_MS = 250
const PROGRESS_HEARTBEAT_MS = 1000

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

  db = new opfsDb('/catalog.sqlite3') as unknown as SqliteDb
  const activeDb = db

  activeDb.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS media_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      content_hash TEXT,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
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
      deleted_at INTEGER,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(source_id, relative_path)
    );

    CREATE INDEX IF NOT EXISTS idx_media_captured_at
      ON media_items(captured_at);
    CREATE INDEX IF NOT EXISTS idx_media_kind
      ON media_items(kind);
    CREATE INDEX IF NOT EXISTS idx_media_source
      ON media_items(source_id);
    CREATE INDEX IF NOT EXISTS idx_media_geo
      ON media_items(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_media_deleted
      ON media_items(deleted_at);

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
      deleted_at INTEGER,
      last_seen_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_locations (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      deleted_at INTEGER,
      last_seen_at INTEGER NOT NULL,
      FOREIGN KEY(content_hash) REFERENCES media_assets(content_hash) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_assets_captured_at
      ON media_assets(captured_at);
    CREATE INDEX IF NOT EXISTS idx_media_assets_kind
      ON media_assets(kind);
    CREATE INDEX IF NOT EXISTS idx_media_assets_geo
      ON media_assets(latitude, longitude);
    CREATE INDEX IF NOT EXISTS idx_media_assets_deleted
      ON media_assets(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
      ON media_locations(content_hash);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source
      ON media_locations(source_id);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source_path
      ON media_locations(source_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_media_locations_deleted
      ON media_locations(deleted_at);
  `)

  migrateMediaItemsSchema(activeDb)
  migrateMediaLocationsSchema(activeDb)

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

function migrateMediaItemsSchema(activeDb: SqliteDb): void {
  const columns = new Set(
    activeDb
      .selectObjects('PRAGMA table_info(media_items)')
      .map((row) => String(row.name)),
  )

  if (!columns.has('content_hash')) {
    activeDb.exec('ALTER TABLE media_items ADD COLUMN content_hash TEXT')
  }

  activeDb.exec(`
    DROP INDEX IF EXISTS idx_media_content_hash;
    CREATE INDEX IF NOT EXISTS idx_media_content_hash
      ON media_items(content_hash);

    INSERT OR IGNORE INTO media_assets (
      content_hash, kind, mime_type, size_bytes, width, height, duration_ms,
      captured_at, captured_at_source, latitude, longitude, geo_source,
      thumbnail_key, deleted_at, last_seen_at
    )
    SELECT
      COALESCE(content_hash, id), kind, mime_type, size_bytes, width, height,
      duration_ms, captured_at, captured_at_source, latitude, longitude,
      geo_source, thumbnail_key, deleted_at, last_seen_at
    FROM media_items
    WHERE COALESCE(content_hash, id) IS NOT NULL
    ORDER BY last_seen_at DESC;

    INSERT OR IGNORE INTO media_locations (
      id, content_hash, source_id, relative_path, display_name, deleted_at,
      last_seen_at
    )
    SELECT
      id, COALESCE(content_hash, id), source_id, relative_path, display_name,
      deleted_at, last_seen_at
    FROM media_items
    WHERE COALESCE(content_hash, id) IS NOT NULL;
  `)
}

function migrateMediaLocationsSchema(activeDb: SqliteDb): void {
  const tableSql = activeDb.selectValue(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_locations'",
  )
  if (
    typeof tableSql !== 'string' ||
    !tableSql.includes('UNIQUE(source_id, relative_path)')
  ) {
    return
  }

  activeDb.exec(`
    PRAGMA foreign_keys = OFF;
    ALTER TABLE media_locations RENAME TO media_locations_old;
    CREATE TABLE media_locations (
      id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      source_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      deleted_at INTEGER,
      last_seen_at INTEGER NOT NULL,
      FOREIGN KEY(content_hash) REFERENCES media_assets(content_hash) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO media_locations (
      id, content_hash, source_id, relative_path, display_name, deleted_at,
      last_seen_at
    )
    SELECT
      id, content_hash, source_id, relative_path, display_name, deleted_at,
      last_seen_at
    FROM media_locations_old;
    DROP TABLE media_locations_old;
    PRAGMA foreign_keys = ON;

    CREATE INDEX IF NOT EXISTS idx_media_locations_content_hash
      ON media_locations(content_hash);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source
      ON media_locations(source_id);
    CREATE INDEX IF NOT EXISTS idx_media_locations_source_path
      ON media_locations(source_id, relative_path);
    CREATE INDEX IF NOT EXISTS idx_media_locations_deleted
      ON media_locations(deleted_at);
  `)
}

function locationFromRow(row: Record<string, unknown>): MediaLocation {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    relativePath: String(row.relative_path),
    displayName: String(row.display_name),
    deletedAt: toNumber(row.deleted_at),
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
    deletedAt: toNumber(row.deleted_at),
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
    item.deletedAt ?? null,
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
      deletedAt: item.deletedAt,
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

function upsertMediaIntoSqlite(activeDb: SqliteDb, items: MediaItem[]): void {
  if (items.length === 0) return

  const insertOrUpdateAsset = activeDb.prepare(`
    INSERT INTO media_assets (
      content_hash, kind, mime_type, size_bytes, width, height, duration_ms,
      captured_at, captured_at_source, latitude, longitude, geo_source,
      thumbnail_key, deleted_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      deleted_at = excluded.deleted_at,
      last_seen_at = MAX(media_assets.last_seen_at, excluded.last_seen_at)
  `)
  const insertOrUpdateLocation = activeDb.prepare(`
    INSERT INTO media_locations (
      id, content_hash, source_id, relative_path, display_name, deleted_at,
      last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content_hash = excluded.content_hash,
      source_id = excluded.source_id,
      relative_path = excluded.relative_path,
      display_name = excluded.display_name,
      deleted_at = excluded.deleted_at,
      last_seen_at = excluded.last_seen_at
  `)

  try {
    for (const item of items) {
      insertOrUpdateAsset.bind(assetBind(item)).stepReset(true)
      for (const location of itemLocations(item)) {
        insertOrUpdateLocation
          .bind([
            location.id,
            item.contentHash,
            location.sourceId,
            location.relativePath,
            location.displayName,
            location.deletedAt ?? null,
            location.lastSeenAt,
          ])
          .stepReset(true)
      }
    }
  } finally {
    insertOrUpdateAsset.finalize()
    insertOrUpdateLocation.finalize()
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
      WHERE deleted_at IS NULL AND content_hash IN (${placeholders})
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

function upsertMediaBatch(activeDb: SqliteDb, items: MediaItem[]): number {
  if (items.length === 0) return 0

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
    sql: `DELETE FROM media_items WHERE source_id IN (${placeholders})`,
    bind: sourceIds,
  })
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
): Promise<MediaItem> {
  const contentHash = await geoPointContentHash(
    point.latitude,
    point.longitude,
    point.capturedAt,
  )
  const lastSeenAt = Date.now()
  const displayName = `${sourceLabel} #${point.index}`
  const location: MediaLocation = {
    id: await stableId(sourceId, sourceLabel, contentHash),
    sourceId,
    relativePath: sourceLabel,
    displayName,
    lastSeenAt,
  }

  return {
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
}

async function importFolderIntoCatalog(
  payload: ImportFolderPayload,
  postProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary> {
  await ensureDb()
  const activeDb = requireDb()
  const { source, duplicateSourceIds, handle } = payload
  const sourceLabel = source.label
  const errors: string[] = []
  const batch: MediaItem[] = []
  let totalFiles = 0
  let scannedFiles = 0
  let acceptedMedia = 0
  let skippedFiles = 0

  const flushBatch = (phase: ImportProgress['phase']) => {
    if (batch.length === 0) return
    postProgress({
      phase,
      sourceLabel,
      scannedFiles,
      totalFiles,
      acceptedMedia,
      skippedFiles,
    })
    upsertMediaBatch(activeDb, batch)
    batch.length = 0
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
            flushBatch('scanning')
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
  prepareImportSource(activeDb, source, duplicateSourceIds)

  postProgress({
    phase: 'scanning',
    sourceLabel,
    scannedFiles,
    totalFiles,
    acceptedMedia,
    skippedFiles,
  })
  await walk(handle, '')
  flushBatch('storing')

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

async function importGpxIntoCatalog(
  file: File,
  source: MediaSource,
  activeDb: SqliteDb,
  postProgress: (progress: ImportProgress) => void,
): Promise<{ acceptedMedia: number; skippedFiles: number }> {
  const sourceLabel = source.label
  const text = await readFileTextWithProgress(file, sourceLabel, postProgress)
  const parsed = parseGeoFilePoints(file.name || sourceLabel, text)
  let acceptedMedia = 0
  const batch: MediaItem[] = []

  for (const point of parsed.points) {
    batch.push(
      await geoPointItemFromParsedPoint(
        source.id,
        sourceLabel,
        parsed.mimeType,
        point,
      ),
    )
    acceptedMedia += 1
    if (batch.length >= IMPORT_BATCH_SIZE) {
      postProgress({
        phase: 'storing',
        sourceLabel,
        scannedFiles: 1,
        totalFiles: 1,
        acceptedMedia,
        skippedFiles: parsed.skippedPoints,
        currentPath: sourceLabel,
        scannedBytes: file.size,
        totalBytes: file.size,
      })
      upsertMediaBatch(activeDb, batch)
      batch.length = 0
      await yieldToEventLoop()
    }
  }

  if (batch.length > 0) {
    postProgress({
      phase: 'storing',
      sourceLabel,
      scannedFiles: 1,
      totalFiles: 1,
      acceptedMedia,
      skippedFiles: parsed.skippedPoints,
      currentPath: sourceLabel,
      scannedBytes: file.size,
      totalBytes: file.size,
    })
    upsertMediaBatch(activeDb, batch)
  }

  return { acceptedMedia, skippedFiles: parsed.skippedPoints }
}

async function importGoogleTakeoutIntoCatalog(
  file: File,
  source: MediaSource,
  activeDb: SqliteDb,
  postProgress: (progress: ImportProgress) => void,
): Promise<{ acceptedMedia: number; skippedFiles: number }> {
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

  const emitProgress = (phase: ImportProgress['phase']) => {
    postProgress({
      phase,
      sourceLabel,
      scannedFiles: phase === 'storing' && bytesRead >= file.size ? 1 : 0,
      totalFiles: 1,
      acceptedMedia: acceptedMedia + pendingPoints.length + batch.length,
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
    emitProgress(phase)
    upsertMediaBatch(activeDb, batch)
    acceptedMedia += batch.length
    batch.length = 0
    emitProgress(phase)
    await yieldToEventLoop()
  }

  const consumePoints = async () => {
    const points = pendingPoints.splice(0)
    for (const point of points) {
      batch.push(
        await geoPointItemFromParsedPoint(
          source.id,
          sourceLabel,
          'application/json',
          point,
        ),
      )
      if (batch.length >= IMPORT_BATCH_SIZE) {
        await flushBatch('scanning')
      }
    }
  }

  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      const result = parser.feed(chunk, {
        maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS,
      })
      chunk = ''
      skippedFiles += result.skippedPoints
      pendingPoints.push(...result.points)
      await consumePoints()
      maybeEmitProgress()

      if (!result.paused) break
      await yieldToEventLoop()
    }
  }

  emitProgress('scanning')

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    bytesRead += value.byteLength
    await consumeText(decoder.decode(value, { stream: true }))
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    await consumeText(finalChunk)
  }

  const final = parser.finish()
  skippedFiles = final.skippedPoints
  await consumePoints()
  await flushBatch('storing')
  emitProgress('storing')

  return { acceptedMedia, skippedFiles }
}

async function importGeoFileIntoCatalog(
  payload: ImportGeoFilePayload,
  postProgress: (progress: ImportProgress) => void,
): Promise<ImportSummary> {
  await ensureDb()
  const activeDb = requireDb()
  const { source, duplicateSourceIds, file } = payload
  const sourceLabel = source.label

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

  prepareImportSource(activeDb, source, duplicateSourceIds)

  const prefix = await file.slice(0, GEO_IMPORT_PREFIX_BYTES).text()
  const result = jsonLikePrefix(prefix)
    ? await (async () => {
        throwKnownUnsupportedJsonPrefix(prefix)
        return importGoogleTakeoutIntoCatalog(
          file,
          source,
          activeDb,
          postProgress,
        )
      })()
    : await importGpxIntoCatalog(file, source, activeDb, postProgress)

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
    'a.deleted_at IS NULL',
    `EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL
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
        AND ls.deleted_at IS NULL
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
    'a.deleted_at IS NULL',
    'a.latitude IS NOT NULL',
    'a.longitude IS NOT NULL',
    `EXISTS (
      SELECT 1 FROM media_locations l
      WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL
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

  const points = await getGeoPoints({})

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
      sql: `DELETE FROM media_items WHERE source_id IN (${placeholders})`,
      bind: sourceIds,
    })
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
      WHERE a.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM media_locations l
          WHERE l.content_hash = a.content_hash AND l.deleted_at IS NULL
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
    DELETE FROM media_items;
    DELETE FROM media_sources;
  `)
}

async function handleRequest(
  request: WorkerRequest,
  postProgress: (progress: GeoIndexBuildProgress | ImportProgress) => void,
): Promise<unknown> {
  switch (request.type) {
    case 'init':
      return ensureDb()
    case 'upsertSource':
      return upsertSource(request.payload as MediaSource)
    case 'upsertMedia':
      return upsertMedia(request.payload as MediaItem[])
    case 'importFolder':
      return importFolderIntoCatalog(
        request.payload as ImportFolderPayload,
        postProgress as (progress: ImportProgress) => void,
      )
    case 'importGeoFile':
      return importGeoFileIntoCatalog(
        request.payload as ImportGeoFilePayload,
        postProgress as (progress: ImportProgress) => void,
      )
    case 'listMedia':
      return listMedia(request.payload as CatalogQuery)
    case 'getMediaByIds':
      return getMediaByIds(request.payload as string[])
    case 'getGeoPoints':
      return getGeoPoints((request.payload ?? {}) as TimeRange)
    case 'listSources':
      return listSources()
    case 'removeSources':
      return removeSources(request.payload as string[])
    case 'countMedia':
      return countMedia()
    case 'buildGeoIndexes':
      return buildGeoIndexes(postProgress)
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
      return clearCatalog()
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
