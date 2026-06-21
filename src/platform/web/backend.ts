import { CatalogClient } from './catalogClient'
import {
  getDirectoryHandle,
  listGeoFileHandles,
  listDirectoryHandles,
  putDirectoryHandle,
  putGeoFileHandle,
  removeDirectoryHandle,
  removeGeoFileHandle,
} from './handleStore'
import type {
  ImportBackend,
  ImportProgress,
  ImportSummary,
  PlatformBackend,
  ThumbnailBackend,
} from '../types'
import type { MediaItem, MediaLocation, MediaSource } from '../../types'

type ImportSourceRecord = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemDirectoryHandle
  duplicateSourceIds: string[]
}

type ImportGeoFileRecord = {
  id: string
  label: string
  addedAt: number
  handle: FileSystemFileHandle
  duplicateSourceIds: string[]
}

async function sourceRecordForHandle(
  handle: FileSystemDirectoryHandle,
): Promise<ImportSourceRecord> {
  if (typeof handle.isSameEntry === 'function') {
    const existingRecords = await listDirectoryHandles()
    const matchingRecords = []

    for (const record of existingRecords) {
      try {
        if (await handle.isSameEntry(record.handle)) {
          matchingRecords.push(record)
        }
      } catch {
        // Ignore stale or inaccessible handle records and keep looking.
      }
    }

    if (matchingRecords.length > 0) {
      matchingRecords.sort(
        (a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id),
      )
      const [primaryRecord, ...duplicateRecords] = matchingRecords
      return {
        id: primaryRecord.id,
        label: handle.name || primaryRecord.label,
        addedAt: primaryRecord.addedAt,
        handle,
        duplicateSourceIds: duplicateRecords.map((record) => record.id),
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    label: handle.name,
    addedAt: Date.now(),
    handle,
    duplicateSourceIds: [],
  }
}

async function sourceRecordForGeoFileHandle(
  handle: FileSystemFileHandle,
): Promise<ImportGeoFileRecord> {
  if (typeof handle.isSameEntry === 'function') {
    const existingRecords = await listGeoFileHandles()
    const matchingRecords = []

    for (const record of existingRecords) {
      try {
        if (await handle.isSameEntry(record.handle)) {
          matchingRecords.push(record)
        }
      } catch {
        // Ignore stale or inaccessible handle records and keep looking.
      }
    }

    if (matchingRecords.length > 0) {
      matchingRecords.sort(
        (a, b) => a.addedAt - b.addedAt || a.id.localeCompare(b.id),
      )
      const [primaryRecord, ...duplicateRecords] = matchingRecords
      return {
        id: primaryRecord.id,
        label: handle.name || primaryRecord.label,
        addedAt: primaryRecord.addedAt,
        handle,
        duplicateSourceIds: duplicateRecords.map((record) => record.id),
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    label: handle.name,
    addedAt: Date.now(),
    handle,
    duplicateSourceIds: [],
  }
}

function sourceFromRecord(record: {
  id: string
  label: string
  addedAt: number
}): MediaSource {
  return {
    id: record.id,
    label: record.label,
    addedAt: record.addedAt,
  }
}

class WebImportBackend implements ImportBackend {
  private readonly catalog: CatalogClient

  constructor(catalog: CatalogClient) {
    this.catalog = catalog
  }

  async importFolder(
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportSummary> {
    if (!window.showDirectoryPicker) {
      throw new Error('This browser does not expose the File System Access API.')
    }

    const handle = await window.showDirectoryPicker({ mode: 'read' })
    const sourceRecord = await sourceRecordForHandle(handle)

    await putDirectoryHandle({
      id: sourceRecord.id,
      label: sourceRecord.label,
      addedAt: sourceRecord.addedAt,
      handle: sourceRecord.handle,
    })
    await Promise.all(
      sourceRecord.duplicateSourceIds.map((id) => removeDirectoryHandle(id)),
    )

    return this.catalog.importFolder(
      {
        source: sourceFromRecord(sourceRecord),
        duplicateSourceIds: sourceRecord.duplicateSourceIds,
        handle,
      },
      onProgress,
    )
  }

  async importGeoFile(
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportSummary> {
    if (!window.showOpenFilePicker) {
      throw new Error('This browser does not expose the File System Access API.')
    }

    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: 'Geo point files',
          accept: {
            'application/gpx+xml': ['.gpx'],
            'application/xml': ['.gpx'],
            'text/xml': ['.gpx'],
            'application/json': ['.json'],
            'application/geo+json': ['.geojson'],
          },
        },
      ],
    })
    if (!handle) throw new Error('Import cancelled')

    const sourceRecord = await sourceRecordForGeoFileHandle(handle)
    const file = await handle.getFile()

    await putGeoFileHandle({
      id: sourceRecord.id,
      label: sourceRecord.label,
      addedAt: sourceRecord.addedAt,
      handle: sourceRecord.handle,
    })
    await Promise.all(
      sourceRecord.duplicateSourceIds.map((id) => removeGeoFileHandle(id)),
    )

    return this.catalog.importGeoFile(
      {
        source: sourceFromRecord(sourceRecord),
        duplicateSourceIds: sourceRecord.duplicateSourceIds,
        file,
      },
      onProgress,
    )
  }

  dispose(): void {}
}

class WebThumbnailBackend implements ThumbnailBackend {
  async resolveThumbnailUrl(thumbnailKey?: string): Promise<string | undefined> {
    if (!thumbnailKey) return undefined

    const [directory, fileName] = thumbnailKey.split('/')
    if (!directory || !fileName) return undefined

    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(directory)
    const handle = await dir.getFileHandle(fileName)
    const file = await handle.getFile()
    return URL.createObjectURL(file)
  }

  revokeThumbnailUrl(url: string): void {
    URL.revokeObjectURL(url)
  }
}

async function ensureReadPermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  if (typeof handle.queryPermission === 'function') {
    const current = await handle.queryPermission({ mode: 'read' })
    if (current === 'granted') return true
  }

  if (typeof handle.requestPermission === 'function') {
    return (await handle.requestPermission({ mode: 'read' })) === 'granted'
  }

  return true
}

async function fileHandleForRelativePath(
  root: FileSystemDirectoryHandle,
  relativePath: string,
): Promise<FileSystemFileHandle | undefined> {
  const segments = relativePath.split('/').filter(Boolean)
  const fileName = segments.pop()
  if (!fileName) return undefined

  let directory = root
  for (const segment of segments) {
    directory = await directory.getDirectoryHandle(segment)
  }

  return directory.getFileHandle(fileName)
}

class WebFileLocationBackend {
  async resolveOriginalUrl(
    item: MediaItem,
    location?: MediaLocation,
  ): Promise<string | undefined> {
    if (item.kind === 'geo_point') return undefined

    const selectedLocation = location ?? item.locations[0]
    const sourceId = selectedLocation?.sourceId ?? item.sourceId
    const relativePath = selectedLocation?.relativePath ?? item.relativePath
    if (!sourceId || !relativePath) return undefined

    try {
      const sourceRecord = await getDirectoryHandle(sourceId)
      if (!sourceRecord) return undefined
      if (!(await ensureReadPermission(sourceRecord.handle))) return undefined

      const fileHandle = await fileHandleForRelativePath(
        sourceRecord.handle,
        relativePath,
      )
      const file = await fileHandle?.getFile()
      return file ? URL.createObjectURL(file) : undefined
    } catch {
      return undefined
    }
  }

  revokeOriginalUrl(url: string): void {
    URL.revokeObjectURL(url)
  }

  async revealLocation(): Promise<void> {
    throw new Error('Revealing original files is only available in Tauri.')
  }
}

export function createWebPlatformBackend(): PlatformBackend {
  const catalog = new CatalogClient()

  return {
    kind: 'web',
    capabilities: {
      absolutePaths: false,
      persistentFileHandles: true,
      nativeThumbnails: false,
      nativeCatalog: false,
    },
    catalog,
    importer: new WebImportBackend(catalog),
    thumbnails: new WebThumbnailBackend(),
    files: new WebFileLocationBackend(),
    dispose() {
      catalog.dispose()
    },
  }
}
