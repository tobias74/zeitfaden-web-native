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
  ImportOptions,
  ImportProgress,
  ImportSummary,
  PlatformBackend,
  ThumbnailBackend,
} from '../types'
import type { MediaItem, MediaLocation, MediaSource } from '../../types'
import { traceStartup } from '../../lib/startupTrace'

declare global {
  interface Window {
    __ZEITFADEN_E2E_GEO_FILE__?: () => File | Promise<File>
    __ZEITFADEN_E2E_DIRECTORY_HANDLE__?: () =>
      | FileSystemDirectoryHandle
      | Promise<FileSystemDirectoryHandle>
  }
}

type ImportSourceRecord = {
  id: string
  label: string
  handle: FileSystemDirectoryHandle
  duplicateSourceIds: string[]
}

type ImportGeoFileRecord = {
  id: string
  label: string
  handle: FileSystemFileHandle
  duplicateSourceIds: string[]
}

const e2eDirectoryRecords = new Map<
  string,
  {
    id: string
    label: string
    handle: FileSystemDirectoryHandle
  }
>()

function e2eDirectoryHandleId(
  handle: FileSystemDirectoryHandle,
): string | undefined {
  return (handle as FileSystemDirectoryHandle & { __zeitfadenId?: string })
    .__zeitfadenId
}

async function sourceRecordForHandle(
  handle: FileSystemDirectoryHandle,
): Promise<ImportSourceRecord> {
  const e2eHandleId = import.meta.env.DEV
    ? e2eDirectoryHandleId(handle)
    : undefined
  if (e2eHandleId) {
    const id = `e2e-directory:${e2eHandleId}`
    return {
      id,
      label: handle.name,
      handle,
      duplicateSourceIds: [],
    }
  }

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
      matchingRecords.sort((a, b) => a.id.localeCompare(b.id))
      const [primaryRecord, ...duplicateRecords] = matchingRecords
      return {
        id: primaryRecord.id,
        label: handle.name || primaryRecord.label,
        handle,
        duplicateSourceIds: duplicateRecords.map((record) => record.id),
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    label: handle.name,
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
      matchingRecords.sort((a, b) => a.id.localeCompare(b.id))
      const [primaryRecord, ...duplicateRecords] = matchingRecords
      return {
        id: primaryRecord.id,
        label: handle.name || primaryRecord.label,
        handle,
        duplicateSourceIds: duplicateRecords.map((record) => record.id),
      }
    }
  }

  return {
    id: crypto.randomUUID(),
    label: handle.name,
    handle,
    duplicateSourceIds: [],
  }
}

function sourceFromRecord(record: {
  id: string
  label: string
}): MediaSource {
  return {
    id: record.id,
    label: record.label,
  }
}

class WebImportBackend implements ImportBackend {
  private readonly catalog: CatalogClient

  constructor(catalog: CatalogClient) {
    this.catalog = catalog
  }

  private cancelledSummary(sourceRecord: {
    id: string
    label: string
  }): ImportSummary {
    return {
      source: sourceFromRecord(sourceRecord),
      sourceLabel: sourceRecord.label,
      scannedFiles: 0,
      totalFiles: 0,
      acceptedMedia: 0,
      skippedFiles: 0,
      errors: [],
      cancelled: true,
    }
  }

  async importFolder(
    onProgress?: (progress: ImportProgress) => void,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const testHandle = import.meta.env.DEV
      ? await window.__ZEITFADEN_E2E_DIRECTORY_HANDLE__?.()
      : undefined
    if (!testHandle && !window.showDirectoryPicker) {
      throw new Error('This browser does not expose the File System Access API.')
    }

    const handle = testHandle ?? await window.showDirectoryPicker!({
      mode: 'read',
    })
    const sourceRecord = await sourceRecordForHandle(handle)
    if (options.signal?.aborted) {
      return this.cancelledSummary(sourceRecord)
    }

    if (testHandle && e2eDirectoryHandleId(testHandle)) {
      e2eDirectoryRecords.set(sourceRecord.id, {
        id: sourceRecord.id,
        label: sourceRecord.label,
        handle: sourceRecord.handle,
      })
    } else {
      await putDirectoryHandle({
        id: sourceRecord.id,
        label: sourceRecord.label,
        handle: sourceRecord.handle,
      })
      await Promise.all(
        sourceRecord.duplicateSourceIds.map((id) => removeDirectoryHandle(id)),
      )
    }

    return this.catalog.importFolder(
      {
        source: sourceFromRecord(sourceRecord),
        duplicateSourceIds: sourceRecord.duplicateSourceIds,
        handle,
      },
      onProgress,
      options.signal,
    )
  }

  async rescanFolders(
    onProgress?: (progress: ImportProgress) => void,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const realRecords = await listDirectoryHandles()
    const recordsById = new Map<
      string,
      {
        id: string
        label: string
        handle: FileSystemDirectoryHandle
      }
    >()
    for (const record of realRecords) recordsById.set(record.id, record)
    for (const record of e2eDirectoryRecords.values()) {
      recordsById.set(record.id, record)
    }

    const records = Array.from(recordsById.values())
    const source = {
      id: 'rescan-folders',
      label: 'Previously scanned folders',
    }
    const aggregate: ImportSummary = {
      source,
      sourceLabel: source.label,
      scannedFiles: 0,
      totalFiles: 0,
      acceptedMedia: 0,
      skippedFiles: 0,
      errors: [],
    }

    for (const record of records) {
      if (options.signal?.aborted) {
        aggregate.cancelled = true
        break
      }
      try {
        if (!(await ensureReadPermission(record.handle))) {
          aggregate.errors.push(`${record.label}: read permission denied`)
          continue
        }
        const summary = await this.catalog.importFolder(
          {
            source: sourceFromRecord(record),
            duplicateSourceIds: [],
            handle: record.handle,
          },
          onProgress,
          options.signal,
        )
        aggregate.scannedFiles += summary.scannedFiles
        aggregate.totalFiles += summary.totalFiles
        aggregate.acceptedMedia += summary.acceptedMedia
        aggregate.skippedFiles += summary.skippedFiles
        aggregate.errors.push(...summary.errors)
        aggregate.cancelled = aggregate.cancelled || summary.cancelled
        if (summary.cancelled) break
      } catch (error) {
        aggregate.errors.push(
          `${record.label}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    return aggregate
  }

  async importGeoFile(
    onProgress?: (progress: ImportProgress) => void,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const testGeoFile = import.meta.env.DEV
      ? await window.__ZEITFADEN_E2E_GEO_FILE__?.()
      : undefined
    if (testGeoFile) {
      const sourceRecord = {
        id: `e2e-geo-file:${testGeoFile.name}`,
        label: testGeoFile.name,
      }
      if (options.signal?.aborted) {
        return this.cancelledSummary(sourceRecord)
      }
      return this.catalog.importGeoFile(
        {
          source: sourceFromRecord(sourceRecord),
          duplicateSourceIds: [],
          file: testGeoFile,
        },
        onProgress,
        options.signal,
      )
    }

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
    if (options.signal?.aborted) {
      return this.cancelledSummary(sourceRecord)
    }

    await putGeoFileHandle({
      id: sourceRecord.id,
      label: sourceRecord.label,
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
      options.signal,
    )
  }

  commitImport(): Promise<void> {
    return this.catalog.commitImport()
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
  traceStartup('[startup:platform]', 'createWebPlatformBackend start')
  const catalog = new CatalogClient()
  traceStartup('[startup:platform]', 'createWebPlatformBackend complete')

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
