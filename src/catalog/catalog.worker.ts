import sqlite3InitModule from '@sqlite.org/sqlite-wasm'
import type {
  CatalogQuery,
  GeoIndexPoint,
  MediaItem,
  MediaSource,
  TimeRange,
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

const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ) => void
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

function mediaFromRow(row: Record<string, unknown>): MediaItem {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    relativePath: String(row.relative_path),
    displayName: String(row.display_name),
    kind: row.kind === 'video' ? 'video' : 'image',
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
  }
}

function sourceFromRow(row: Record<string, unknown>): MediaSource {
  return {
    id: String(row.id),
    label: String(row.label),
    addedAt: toNumber(row.added_at) ?? 0,
  }
}

function itemBind(item: MediaItem): unknown[] {
  return [
    item.id,
    item.sourceId,
    item.relativePath,
    item.displayName,
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

  const stmt = activeDb.prepare(`
    INSERT INTO media_items (
      id, source_id, relative_path, display_name, kind, mime_type, size_bytes,
      width, height, duration_ms, captured_at, captured_at_source, latitude,
      longitude, geo_source, thumbnail_key, deleted_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_id = excluded.source_id,
      relative_path = excluded.relative_path,
      display_name = excluded.display_name,
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
      thumbnail_key = excluded.thumbnail_key,
      deleted_at = excluded.deleted_at,
      last_seen_at = excluded.last_seen_at
  `)

  try {
    for (const item of items) {
      stmt.bind(itemBind(item)).stepReset(true)
    }
  } finally {
    stmt.finalize()
  }
}

function timeWhere(
  query: Pick<CatalogQuery, 'startTime' | 'endTime'>,
  where: string[],
  bind: unknown[],
): void {
  if (typeof query.startTime === 'number') {
    where.push('captured_at >= ?')
    bind.push(query.startTime)
  }
  if (typeof query.endTime === 'number') {
    where.push('captured_at <= ?')
    bind.push(query.endTime)
  }
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

async function listMedia(query: CatalogQuery): Promise<MediaItem[]> {
  await ensureDb()
  const where = ['deleted_at IS NULL']
  const bind: unknown[] = []

  if (query.kind && query.kind !== 'all') {
    where.push('kind = ?')
    bind.push(query.kind)
  }
  if (query.sourceId) {
    where.push('source_id = ?')
    bind.push(query.sourceId)
  }
  if (typeof query.hasGeo === 'boolean') {
    where.push(
      query.hasGeo
        ? 'latitude IS NOT NULL AND longitude IS NOT NULL'
        : '(latitude IS NULL OR longitude IS NULL)',
    )
  }

  timeWhere(query, where, bind)

  const order =
    query.sort === 'captured_at_asc'
      ? 'CASE WHEN captured_at IS NULL THEN 1 ELSE 0 END, captured_at ASC, id ASC'
      : 'CASE WHEN captured_at IS NULL THEN 1 ELSE 0 END, captured_at DESC, id ASC'
  const limit = Math.max(1, Math.min(query.limit ?? 500, 10_000))
  const offset = Math.max(0, query.offset ?? 0)
  bind.push(limit, offset)

  const rows = requireDb().selectObjects(
    `
      SELECT * FROM media_items
      WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `,
    bind,
  )

  return rows.map(mediaFromRow)
}

async function getMediaByIds(ids: string[]): Promise<MediaItem[]> {
  await ensureDb()
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(', ')
  const rows = requireDb().selectObjects(
    `SELECT * FROM media_items WHERE id IN (${placeholders})`,
    ids,
  )
  const byId = new Map(rows.map((row) => [String(row.id), mediaFromRow(row)]))
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
    'deleted_at IS NULL',
    'latitude IS NOT NULL',
    'longitude IS NOT NULL',
  ]
  const bind: unknown[] = []
  timeWhere(range, where, bind)

  const rows = requireDb().selectObjects(
    `
      SELECT id, latitude, longitude, captured_at
      FROM media_items
      WHERE ${where.join(' AND ')}
      ORDER BY id ASC
    `,
    bind,
  )

  return rows.map((row) => ({
    mediaId: String(row.id),
    lat: toNumber(row.latitude) ?? 0,
    lon: toNumber(row.longitude) ?? 0,
    capturedAt: toNumber(row.captured_at),
  }))
}

async function listSources(): Promise<MediaSource[]> {
  await ensureDb()
  return requireDb()
    .selectObjects(
      'SELECT id, label, added_at FROM media_sources ORDER BY added_at DESC',
    )
    .map(sourceFromRow)
}

async function countMedia(): Promise<number> {
  await ensureDb()
  const count = requireDb().selectValue(
    'SELECT COUNT(*) FROM media_items WHERE deleted_at IS NULL',
  )
  return toNumber(count) ?? 0
}

async function clearCatalog(): Promise<void> {
  await ensureDb()
  requireDb().exec(`
    DELETE FROM media_items;
    DELETE FROM media_sources;
  `)
}

async function handleRequest(request: WorkerRequest): Promise<unknown> {
  switch (request.type) {
    case 'init':
      return ensureDb()
    case 'upsertSource':
      return upsertSource(request.payload as MediaSource)
    case 'upsertMedia':
      return upsertMedia(request.payload as MediaItem[])
    case 'listMedia':
      return listMedia(request.payload as CatalogQuery)
    case 'getMediaByIds':
      return getMediaByIds(request.payload as string[])
    case 'getGeoPoints':
      return getGeoPoints((request.payload ?? {}) as TimeRange)
    case 'listSources':
      return listSources()
    case 'countMedia':
      return countMedia()
    case 'clear':
      return clearCatalog()
    default:
      throw new Error(`Unknown catalog request: ${request.type}`)
  }
}

ctx.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  try {
    const result = await handleRequest(event.data)
    ctx.postMessage({ id: event.data.id, ok: true, result })
  } catch (error) {
    ctx.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
