export type MediaKind = 'image' | 'video' | 'geo_point'
export type KindFilter = MediaKind | 'all' | 'media'

export type CapturedAtSource =
  | 'exif'
  | 'geo-file'
  | 'video-metadata'
  | 'filesystem'
  | 'manual'

export type GeoSource = 'exif' | 'geo-file' | 'video-metadata' | 'manual'

export type MediaLocation = {
  id: string
  sourceId: string
  relativePath?: string
  absolutePath?: string
  displayName: string
  deletedAt?: number
  lastSeenAt: number
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
  width?: number
  height?: number
  durationMs?: number
  capturedAt?: number
  capturedAtSource?: CapturedAtSource
  latitude?: number
  longitude?: number
  geoSource?: GeoSource
  thumbnailKey?: string
  deletedAt?: number
  lastSeenAt: number
  locations: MediaLocation[]
}

export type MediaSource = {
  id: string
  label: string
  addedAt: number
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

export type CatalogSort = 'captured_at_asc' | 'captured_at_desc'

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
  lat: number
  lon: number
  capturedAt?: number
}

export type GeoSearchQuery = TimeRange & {
  lat: number
  lon: number
  k: number
}

export type GeoSearchResult = {
  mediaId: string
  distanceMeters: number
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

  build(points: GeoIndexPoint[]): Promise<void>
  insert(point: GeoIndexPoint): Promise<void>
  remove(mediaId: string): Promise<void>
  search(query: GeoSearchQuery): Promise<GeoSearchResult[]>
  stats(): Promise<GeoIndexStats>
  validateAgainstBruteForce(query: GeoSearchQuery): Promise<ValidationReport>
}

export type EnrichedSearchResult = GeoSearchResult & {
  item: MediaItem
}
