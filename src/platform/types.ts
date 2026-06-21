import type {
  CatalogQuery,
  GeoIndexPoint,
  MediaItem,
  MediaLocation,
  MediaSource,
  TimeRange,
} from '../types'

export type CatalogInfo = {
  storageMode: 'opfs' | 'native'
  sqliteVersion: string
  filename: string
}

export type ImportProgressPhase = 'counting' | 'scanning' | 'storing'

export type ImportProgress = {
  phase: ImportProgressPhase
  sourceLabel: string
  scannedFiles: number
  totalFiles: number
  acceptedMedia: number
  skippedFiles: number
  currentPath?: string
}

export type ImportSummary = {
  source: MediaSource
  sourceLabel: string
  scannedFiles: number
  totalFiles: number
  acceptedMedia: number
  skippedFiles: number
  errors: string[]
}

export type PlatformCapabilities = {
  absolutePaths: boolean
  persistentFileHandles: boolean
  nativeThumbnails: boolean
  nativeCatalog: boolean
}

export interface CatalogBackend {
  init(): Promise<CatalogInfo>
  upsertSource(source: MediaSource): Promise<void>
  upsertMedia(items: MediaItem[]): Promise<number>
  listMedia(query: CatalogQuery): Promise<MediaItem[]>
  getMediaByIds(ids: string[]): Promise<MediaItem[]>
  getGeoPoints(range?: TimeRange): Promise<GeoIndexPoint[]>
  listSources(): Promise<MediaSource[]>
  removeSources(sourceIds: string[]): Promise<void>
  countMedia(): Promise<number>
  clear(): Promise<void>
  dispose(): void
}

export interface ImportBackend {
  importFolder(onProgress?: (progress: ImportProgress) => void): Promise<ImportSummary>
  importGeoFile(onProgress?: (progress: ImportProgress) => void): Promise<ImportSummary>
  dispose(): void
}

export interface ThumbnailBackend {
  resolveThumbnailUrl(thumbnailKey?: string): Promise<string | undefined>
  revokeThumbnailUrl(url: string): void
}

export interface FileLocationBackend {
  resolveOriginalUrl(
    item: MediaItem,
    location?: MediaLocation,
  ): Promise<string | undefined>
  revokeOriginalUrl(url: string): void
  revealLocation(location: MediaLocation): Promise<void>
}

export type PlatformBackend = {
  kind: 'web' | 'tauri'
  capabilities: PlatformCapabilities
  catalog: CatalogBackend
  importer: ImportBackend
  thumbnails: ThumbnailBackend
  files: FileLocationBackend
  dispose(): void
}
