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
    __ZEITFADEN_E2E_GEO_FILE__?: () =>
      | File
      | File[]
      | Promise<File | File[]>
    __ZEITFADEN_E2E_DIRECTORY_HANDLE__?: () =>
      | FileSystemDirectoryHandle
      | Promise<FileSystemDirectoryHandle>
    __ZEITFADEN_E2E_GEO_DIRECTORY_HANDLE__?: () =>
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

function geoImportCandidateName(name: string): boolean {
  const normalized = name.toLowerCase()
  return (
    normalized.endsWith('.gpx') ||
    normalized.endsWith('.json') ||
    normalized.endsWith('.geojson')
  )
}

type GeoImportEntry = {
  sourceRecord: {
    id: string
    label: string
    duplicateSourceIds?: string[]
  }
  file: File
  handle?: FileSystemFileHandle
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

  private async importGeoEntries(
    entries: GeoImportEntry[],
    sourceLabel: string,
    onProgress?: (progress: ImportProgress) => void,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const aggregateSource = {
      id: `geo-import-batch:${sourceLabel}`,
      label: sourceLabel,
    }
    const aggregate: ImportSummary = {
      source: sourceFromRecord(aggregateSource),
      sourceLabel,
      scannedFiles: 0,
      totalFiles: entries.length,
      acceptedMedia: 0,
      skippedFiles: 0,
      errors: [],
    }

    for (const entry of entries) {
      if (options.signal?.aborted) {
        aggregate.cancelled = true
        break
      }

      const duplicateSourceIds = entry.sourceRecord.duplicateSourceIds ?? []
      try {
        if (entry.handle) {
          await putGeoFileHandle({
            id: entry.sourceRecord.id,
            label: entry.sourceRecord.label,
            handle: entry.handle,
          })
          await Promise.all(
            duplicateSourceIds.map((id) => removeGeoFileHandle(id)),
          )
        }

        const summary = await this.catalog.importGeoFile(
          {
            source: sourceFromRecord(entry.sourceRecord),
            duplicateSourceIds,
            file: entry.file,
          },
          (progress) => {
            onProgress?.({
              ...progress,
              sourceLabel,
              scannedFiles: aggregate.scannedFiles + progress.scannedFiles,
              totalFiles: entries.length,
              acceptedMedia: aggregate.acceptedMedia + progress.acceptedMedia,
              skippedFiles: aggregate.skippedFiles + progress.skippedFiles,
            })
          },
          options.signal,
        )
        aggregate.scannedFiles += summary.scannedFiles
        aggregate.acceptedMedia += summary.acceptedMedia
        aggregate.skippedFiles += summary.skippedFiles
        aggregate.errors.push(...summary.errors)
        aggregate.cancelled = aggregate.cancelled || summary.cancelled
        if (summary.cancelled) break
      } catch (error) {
        aggregate.scannedFiles += 1
        aggregate.skippedFiles += 1
        aggregate.errors.push(
          `${entry.sourceRecord.label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }

    return aggregate
  }

  private async geoEntriesFromDirectory(
    handle: FileSystemDirectoryHandle,
  ): Promise<GeoImportEntry[]> {
    const entries: GeoImportEntry[] = []
    const walk = async (directory: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [, entry] of directory.entries()) {
        if (entry.kind === 'directory') {
          await walk(entry as FileSystemDirectoryHandle)
          continue
        }
        if (!geoImportCandidateName(entry.name)) continue
        const fileHandle = entry as FileSystemFileHandle
        const sourceRecord = await sourceRecordForGeoFileHandle(fileHandle)
        entries.push({
          sourceRecord,
          file: await fileHandle.getFile(),
          handle: fileHandle,
        })
      }
    }
    await walk(handle)
    return entries
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
    const testGeoFiles = import.meta.env.DEV
      ? await window.__ZEITFADEN_E2E_GEO_FILE__?.()
      : undefined
    if (testGeoFiles) {
      const files = Array.isArray(testGeoFiles) ? testGeoFiles : [testGeoFiles]
      if (options.signal?.aborted) {
        return this.cancelledSummary({
          id: 'e2e-geo-files',
          label: 'Selected geo files',
        })
      }
      return this.importGeoEntries(
        files.map((file) => ({
          sourceRecord: {
            id: `e2e-geo-file:${file.name}`,
            label: file.name,
          },
          file,
        })),
        files.length === 1 ? files[0].name : 'Selected geo files',
        onProgress,
        options,
      )
    }

    if (!window.showOpenFilePicker) {
      throw new Error('This browser does not expose the File System Access API.')
    }

    const handles = await window.showOpenFilePicker({
      multiple: true,
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
    if (handles.length === 0) throw new Error('Import cancelled')
    if (options.signal?.aborted) {
      return this.cancelledSummary({
        id: 'selected-geo-files',
        label: 'Selected geo files',
      })
    }

    const entries = await Promise.all(
      handles.map(async (handle) => {
        const sourceRecord = await sourceRecordForGeoFileHandle(handle)
        return {
          sourceRecord,
          file: await handle.getFile(),
          handle,
        }
      }),
    )

    return this.importGeoEntries(
      entries,
      entries.length === 1
        ? entries[0].sourceRecord.label
        : 'Selected geo files',
      onProgress,
      options,
    )
  }

  async importGeoFolder(
    onProgress?: (progress: ImportProgress) => void,
    options: ImportOptions = {},
  ): Promise<ImportSummary> {
    const testHandle = import.meta.env.DEV
      ? await window.__ZEITFADEN_E2E_GEO_DIRECTORY_HANDLE__?.()
      : undefined
    if (!testHandle && !window.showDirectoryPicker) {
      throw new Error('This browser does not expose the File System Access API.')
    }

    const handle = testHandle ?? await window.showDirectoryPicker!({
      mode: 'read',
    })
    if (options.signal?.aborted) {
      return this.cancelledSummary({
        id: `geo-folder:${handle.name}`,
        label: handle.name,
      })
    }

    const entries = await this.geoEntriesFromDirectory(handle)
    return this.importGeoEntries(
      entries,
      handle.name || 'Geo folder',
      onProgress,
      options,
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
