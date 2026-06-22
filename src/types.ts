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

export type SearchPurpose = 'results' | 'map' | 'viewer'

export type SearchOrder =
  | {
      kind: 'timestamp'
      sort: CatalogSort
    }
  | {
      kind: 'distance'
      point: {
        lat: number
        lon: number
      }
      engineId?: string
    }

export type SearchDiagnostics = {
  explainSql?: boolean
}

export type SearchSpec = TimeRange & {
  kind?: KindFilter
  sourceId?: string
  hasGeo?: boolean
  geoBounds?: GeoBounds
  order: SearchOrder
  limit?: number
  offset?: number
  purpose: SearchPurpose
  diagnostics?: SearchDiagnostics
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

export type SearchStorageMode = 'sqlite' | 'indexeddb' | 'native'

export type SqlExplainPlanRow = {
  id: number
  parent: number
  detail: string
}

export type SqlExplainPlan = {
  rows: SqlExplainPlanRow[]
  usedIndexes: string[]
}

export type SearchIndexStats = GeoIndexStats & {
  engineLabel?: string
  exact?: boolean
  persistent?: boolean
  queryPurpose?: SearchPurpose
  storageMode?: SearchStorageMode
  queryTimeMs?: number
  rowsReturned?: number
  limit?: number
  offset?: number
  limitReached?: boolean
  sqlPlan?: SqlExplainPlan
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
  supportsSource: boolean
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
