import type {
  CatalogQuery,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MapPointPage,
  MediaItem,
  MediaLocation,
  MediaSource,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
  TimeRange,
  ValidationReport,
} from '../types'

export type CatalogInfo = {
  storageMode: 'file' | 'native'
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
  cancelled?: boolean
}

export type ImportOptions = {
  signal?: AbortSignal
}

export type CatalogSearchOptions = {
  signal?: AbortSignal
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

export type SearchIndexBuildSummary = GeoIndexBuildSummary & {
  engineCount: number
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
  searchMedia(spec: SearchSpec, options?: CatalogSearchOptions): Promise<SearchPage>
  searchMapPoints(
    spec: SearchSpec,
    options?: CatalogSearchOptions,
  ): Promise<MapPointPage>
  buildSearchIndexes(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary>
  rebuildSearchIndex(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary>
  onIndexProgress?(listener: (progress: GeoIndexBuildProgress) => void): () => void
  getSearchIndexStats(): Promise<SearchIndexStats[]>
  listMedia(query: CatalogQuery): Promise<MediaItem[]>
  getMediaByIds(ids: string[]): Promise<MediaItem[]>
  getGeoPoints(range?: TimeRange): Promise<GeoIndexPoint[]>
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
  importFolder(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary>
  rescanFolders(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary>
  importGeoFile(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary>
  commitImport(): Promise<void> | void
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
