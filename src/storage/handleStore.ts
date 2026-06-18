import { openDB } from 'idb'

type SourceHandleRecord = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemDirectoryHandle
}

const DB_NAME = 'geo-media-index-lab-handles'
const DB_VERSION = 1
const SOURCE_STORE = 'sources'

async function db() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(SOURCE_STORE)) {
        database.createObjectStore(SOURCE_STORE, { keyPath: 'id' })
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

