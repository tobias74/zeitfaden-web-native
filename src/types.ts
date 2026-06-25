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

export type MapPoint = {
  mediaId?: string
  assetId?: number
  cellId?: string
  kind?: MediaKind
  lat: number
  lon: number
  timestamp?: number
  count?: number
  bounds?: GeoBounds
}

export type MapPointPage = {
  points: MapPoint[]
  limitReached?: boolean
  resultMetrics?: SearchResultMetrics
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

export type SearchPurpose = 'results' | 'map' | 'viewer'

export type SearchOrder =
  | {
      kind: 'timestamp'
      sort: CatalogSort
      engineId?: string
    }
  | {
      kind: 'distance'
      point: {
        lat: number
        lon: number
      }
      engineId?: string
    }

export type SearchSpec = TimeRange & {
  kind?: KindFilter
  hasGeo?: boolean
  geoBounds?: GeoBounds
  mapAggregation?: {
    zoom: number
    viewportWidthPx: number
    viewportHeightPx: number
    bubbleCellSizePx: number
  }
  order: SearchOrder
  limit?: number
  offset?: number
  purpose: SearchPurpose
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
  indexStatus?: 'missing' | 'current' | 'stale' | 'building' | 'pending' | 'indexing' | 'failed'
  catalogVersion?: number
  indexCatalogVersion?: number
  indexSizeBytes?: number
  residentBytes?: number
  diskReadBytes?: number
  diskReadCount?: number
  pageCacheHits?: number
  pageCacheMisses?: number
  loadedPages?: number
  indexStorage?: 'memory' | 'disk'
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
  segmentCount?: number
  deltaSegmentCount?: number
  loadedSegments?: number
  maxLeafSize?: number
  pendingPointCount?: number
  needsOptimization?: boolean
  cellCount?: number
}

export type SearchStorageMode = 'file' | 'native'

export type SearchIndexStats = GeoIndexStats & {
  engineLabel?: string
  exact?: boolean
  persistent?: boolean
  queryPurpose?: SearchPurpose
  storageMode?: SearchStorageMode
  queryTimeMs?: number
  queryRoundTripMs?: number
  queryTransferMs?: number
  queryPaintMs?: number
  queryRenderMs?: number
  queryIndexReadyMs?: number
  queryIndexScanMs?: number
  queryAssetReadMs?: number
  queryAssetFilterMs?: number
  matchedRecords?: number
  renderedBubbles?: number
  largestBubbleCount?: number
  aggregationZoom?: number
  aggregationCellSizePx?: number
  rowsReturned?: number
  limit?: number
  offset?: number
  limitReached?: boolean
}

export type SearchResultMetrics = SearchIndexStats

export type SearchPage = {
  items: EnrichedSearchResult[]
  resultMetrics: SearchResultMetrics
  engineId: string
  engineLabel: string
  limitReached?: boolean
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
  insertMany(points: GeoIndexPoint[]): Promise<void>
  flushPending(catalogEpoch: number): Promise<void>
  remove(mediaId: string): Promise<void>
  search(query: GeoSearchQuery): Promise<GeoSearchResult[]>
  stats(): Promise<GeoIndexStats>
  validateAgainstBruteForce(query: GeoSearchQuery): Promise<ValidationReport>
}

export type EnrichedSearchResult = {
  mediaId: string
  distanceMeters?: number
  item: MediaItem
}

export type SearchIndexCapabilities = {
  exact: boolean
  persistent: boolean
  requiresBuild: boolean
  supportsTimestampOrder: boolean
  supportsDistanceOrder: boolean
  supportsGeoBounds: boolean
  supportsTimeRange: boolean
  supportsKind: boolean
}

export type SearchIndexBuildSummary = {
  pointCount: number
  buildTimeMs: number
  engineCount: number
}

export interface SearchIndexEngine {
  id: string
  label: string
  capabilities: SearchIndexCapabilities

  canHandle(spec: SearchSpec): boolean
  build?(points: GeoIndexPoint[], options?: GeoIndexBuildOptions): Promise<void>
  search(spec: SearchSpec): Promise<SearchPage>
  stats(): Promise<SearchIndexStats>
  validateAgainst?(
    engine: SearchIndexEngine,
    spec: SearchSpec,
  ): Promise<ValidationReport>
}
