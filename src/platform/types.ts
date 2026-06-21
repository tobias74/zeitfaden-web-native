import type {
  CatalogQuery,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MediaItem,
  MediaLocation,
  MediaSource,
  TimeRange,
  ValidationReport,
} from '../types'

export type CatalogInfo = {
  storageMode: 'opfs' | 'indexeddb' | 'native'
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
  scannedBytes?: number
  totalBytes?: number
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

export type GeoParseDebugSummary = {
  sourceLabel: string
  sizeBytes: number
  bytesRead: number
  totalEntries: number
  parsedPoints: number
  skippedPoints: number
  durationMs: number
  bytesPerSecond: number
  pointsPerSecond: number
}

export type GeoIndexBuildProgress = {
  phase: 'loading' | 'building' | 'ready'
  pointCount: number
  builtIndexes: number
  totalIndexes: number
  currentIndexId?: string
  currentIndexLabel?: string
  currentIndexProcessedPoints?: number
  currentIndexTotalPoints?: number
}

export type GeoIndexBuildSummary = {
  pointCount: number
  buildTimeMs: number
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
  buildGeoIndexes(
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary>
  searchGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<GeoSearchResult[]>
  getGeoIndexStats(indexId: string): Promise<GeoIndexStats>
  validateGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<ValidationReport>
  clear(): Promise<void>
  dispose(): void
}

export interface ImportBackend {
  importFolder(onProgress?: (progress: ImportProgress) => void): Promise<ImportSummary>
  importGeoFile(onProgress?: (progress: ImportProgress) => void): Promise<ImportSummary>
  debugParseGeoFile?(): Promise<GeoParseDebugSummary>
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
