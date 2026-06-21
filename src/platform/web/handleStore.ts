import { openDB } from 'idb'

type SourceHandleRecord = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemDirectoryHandle
}

type GeoFileHandleRecord = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemFileHandle
}

const DB_NAME = 'geo-media-index-lab-handles'
const DB_VERSION = 2
const SOURCE_STORE = 'sources'
const GEO_FILE_STORE = 'geo-files'

async function db() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(SOURCE_STORE)) {
        database.createObjectStore(SOURCE_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(GEO_FILE_STORE)) {
        database.createObjectStore(GEO_FILE_STORE, { keyPath: 'id' })
      }
    },
  })
}

export async function putDirectoryHandle(
  record: SourceHandleRecord,
): Promise<void> {
  const database = await db()
  await database.put(SOURCE_STORE, record)
}

export async function listDirectoryHandles(): Promise<SourceHandleRecord[]> {
  const database = await db()
  return database.getAll(SOURCE_STORE)
}

export async function getDirectoryHandle(
  id: string,
): Promise<SourceHandleRecord | undefined> {
  const database = await db()
  return database.get(SOURCE_STORE, id)
}

export async function removeDirectoryHandle(id: string): Promise<void> {
  const database = await db()
  await database.delete(SOURCE_STORE, id)
}

export async function putGeoFileHandle(
  record: GeoFileHandleRecord,
): Promise<void> {
  const database = await db()
  await database.put(GEO_FILE_STORE, record)
}

export async function listGeoFileHandles(): Promise<GeoFileHandleRecord[]> {
  const database = await db()
  return database.getAll(GEO_FILE_STORE)
}

export async function getGeoFileHandle(
  id: string,
): Promise<GeoFileHandleRecord | undefined> {
  const database = await db()
  return database.get(GEO_FILE_STORE, id)
}

export async function removeGeoFileHandle(id: string): Promise<void> {
  const database = await db()
  await database.delete(GEO_FILE_STORE, id)
}
