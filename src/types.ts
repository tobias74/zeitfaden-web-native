export type MediaKind = 'image' | 'video' | 'geo_point'
export type KindFilter = MediaKind | 'all' | 'media'

export type MediaLocation = {
  id: string
  sourceId: string
  sourceLabel: string
  rootPath?: string
  relativePath?: string
  absolutePath?: string
  pointIndex?: number
}

export type MediaItem = {
  id: string
  contentHash: string
  sourceId: string
  relativePath: string
  displayName: string
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  durationMs?: number
  timestamp?: number
  latitude?: number
  longitude?: number
  thumbnailKey?: string
  locations: MediaLocation[]
}

export type MediaSource = {
  id: string
  label: string
  rootPath?: string
}

export type TimeRange = {
  startTime?: number
  endTime?: number
}

export type GeoBounds = {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export type CatalogSort = 'timestamp_asc' | 'timestamp_desc'

export type CatalogQuery = TimeRange & {
  kind?: KindFilter
  sourceId?: string
  hasGeo?: boolean
  geoBounds?: GeoBounds
  sort: CatalogSort
  limit?: number
  offset?: number
}

export type GeoIndexPoint = {
  mediaId: string
  kind?: MediaKind
  lat: number
  lon: number
  timestamp?: number
}

export type GeoSearchQuery = TimeRange & {
  lat: number
  lon: number
  k: number
  offset?: number
  kind?: KindFilter
  geoBounds?: GeoBounds
}

export type GeoSearchResult = {
  mediaId: string
  distanceMeters: number
}

export type GeoIndexBuildStep = {
  indexId: string
  indexLabel: string
  processedPoints: number
  totalPoints: number
}

export type GeoIndexBuildOptions = {
  onProgress?: (progress: GeoIndexBuildStep) => void
  yieldEvery?: number
}

export type GeoIndexCapabilities = {
  exact: boolean
  persistent: boolean
  incrementalInsert: boolean
  incrementalDelete: boolean
  supportsTimePruning: boolean
}

export type GeoIndexStats = {
  engineId: string
  pointCount: number
  indexSizeBytes?: number
  buildTimeMs?: number
  insertTimeMs?: number
  deleteTimeMs?: number
  lastQueryTimeMs?: number
  distanceComputations: number
  nodesVisited: number
  pagesRead: number
  candidatesInspected: number
  prunedByGeo: number
  prunedByTime: number
}

export type ValidationReport = {
  checked: boolean
  equal: boolean
  comparedWith: string
  message: string
}

export interface GeoTemporalIndex {
  id: string
  label: string
  capabilities: GeoIndexCapabilities

  build(points: GeoIndexPoint[], options?: GeoIndexBuildOptions): Promise<void>
  insert(point: GeoIndexPoint): Promise<void>
  remove(mediaId: string): Promise<void>
  search(query: GeoSearchQuery): Promise<GeoSearchResult[]>
  stats(): Promise<GeoIndexStats>
  validateAgainstBruteForce(query: GeoSearchQuery): Promise<ValidationReport>
}

export type EnrichedSearchResult = GeoSearchResult & {
  item: MediaItem
}
