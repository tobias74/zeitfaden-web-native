import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  CatalogQuery,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  LineTileRequest,
  LineTileResult,
  LineTileSourceSummary,
  MapPointPage,
  MediaItem,
  MediaLocation,
  MediaSource,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
  TimeRange,
  ValidationReport,
} from '../../types'
import type {
  CatalogBackend,
  CatalogInfo,
  CatalogSearchOptions,
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  ImportBackend,
  ImportOptions,
  ImportProgress,
  ImportSummary,
  PlatformBackend,
  SearchIndexBuildSummary,
  ThumbnailBackend,
} from '../types'

function abortError(): Error {
  const error = new Error('Catalog request aborted')
  error.name = 'AbortError'
  return error
}

function invokeWithAbort<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return invoke<T>(command, args)
  if (signal.aborted) return Promise.reject(abortError())

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      reject(abortError())
    }
    signal.addEventListener('abort', abort, { once: true })
    invoke<T>(command, args)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', abort)
      })
  })
}

type NativeLineTileResult = Omit<LineTileResult, 'blob'> & {
  bytes: number[] | Uint8Array
}

class TauriCatalogBackend implements CatalogBackend {
  init(): Promise<CatalogInfo> {
    return invoke('init_catalog')
  }

  upsertSource(source: MediaSource): Promise<void> {
    return invoke('upsert_source', { source })
  }

  upsertMedia(items: MediaItem[]): Promise<number> {
    return invoke('upsert_media', { items })
  }

  listMedia(query: CatalogQuery): Promise<MediaItem[]> {
    return invoke('list_media', { query })
  }

  searchMedia(
    spec: SearchSpec,
    options: CatalogSearchOptions = {},
  ): Promise<SearchPage> {
    return invokeWithAbort('search_media', { spec }, options.signal)
  }

  searchMapPoints(
    spec: SearchSpec,
    options: CatalogSearchOptions = {},
  ): Promise<MapPointPage> {
    return invokeWithAbort('search_map_points', { spec }, options.signal)
  }

  prepareLineTileSource(
    spec: SearchSpec,
    options: CatalogSearchOptions = {},
  ): Promise<LineTileSourceSummary> {
    return invokeWithAbort('prepare_line_tile_source', { spec }, options.signal)
  }

  async getLineTile(
    request: LineTileRequest,
    options: CatalogSearchOptions = {},
  ): Promise<LineTileResult> {
    const result = await invokeWithAbort<NativeLineTileResult>(
      'get_line_tile',
      { request },
      options.signal,
    )
    return {
      ...result,
      blob: new Blob([new Uint8Array(result.bytes)], {
        type: result.mimeType,
      }),
    }
  }

  clearLineTileCache(scope?: { sourceKey?: string }): Promise<void> {
    return invoke('clear_line_tile_cache', { scope })
  }

  getMediaByIds(ids: string[]): Promise<MediaItem[]> {
    return invoke('get_media_by_ids', { ids })
  }

  getGeoPoints(range: TimeRange = {}): Promise<GeoIndexPoint[]> {
    return invoke('get_geo_points', { range })
  }

  countMedia(): Promise<number> {
    return invoke('count_media')
  }

  async buildGeoIndexes(
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary> {
    const summary = await this.buildSearchIndexes(
      'segmented-ball-tree',
      onProgress,
    )
    return {
      pointCount: summary.pointCount,
      buildTimeMs: summary.buildTimeMs,
    }
  }

  async buildSearchIndexes(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary> {
    return this.runSearchIndexBuild(indexId, false, onProgress)
  }

  async rebuildSearchIndex(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary> {
    return this.runSearchIndexBuild(indexId, true, onProgress)
  }

  private async runSearchIndexBuild(
    indexId: string,
    forceRebuild: boolean,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary> {
    const unlisten = await listen<GeoIndexBuildProgress>(
      'geo-index-progress',
      (event) => {
        onProgress?.(event.payload)
      },
    )

    try {
      return await invoke('build_search_indexes', { indexId, forceRebuild })
    } finally {
      unlisten()
    }
  }

  searchGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<GeoSearchResult[]> {
    return invoke('search_geo_index', { indexId, query })
  }

  getGeoIndexStats(indexId: string): Promise<GeoIndexStats> {
    return invoke('get_geo_index_stats', { indexId })
  }

  getSearchIndexStats(): Promise<SearchIndexStats[]> {
    return invoke('get_search_index_stats')
  }

  validateGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    return invoke('validate_geo_index', { indexId, query })
  }

  clear(): Promise<void> {
    return invoke('clear_catalog')
  }

  dispose(): void {}
}

class TauriImportBackend implements ImportBackend {
  async importFolder(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary> {
    return this.importWithProgress('import_folder', onProgress, options)
  }

  async rescanFolders(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary> {
    return this.importWithProgress('rescan_folders', onProgress, options)
  }

  async importGeoFile(
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary> {
    return this.importWithProgress('import_geo_file', onProgress, options)
  }

  private async importWithProgress(
    command: string,
    onProgress?: (progress: ImportProgress) => void,
    options?: ImportOptions,
  ): Promise<ImportSummary> {
    if (options?.signal?.aborted) {
      throw new DOMException('Import cancelled', 'AbortError')
    }
    const cancelImport = () => {
      void invoke('cancel_import')
    }
    options?.signal?.addEventListener('abort', cancelImport, { once: true })
    const unlisten = await listen<ImportProgress>('import-progress', (event) => {
      onProgress?.(event.payload)
    })

    try {
      return await invoke(command)
    } finally {
      options?.signal?.removeEventListener('abort', cancelImport)
      unlisten()
    }
  }

  commitImport(): Promise<void> {
    return invoke('commit_import')
  }

  dispose(): void {}
}

class TauriThumbnailBackend implements ThumbnailBackend {
  async resolveThumbnailUrl(thumbnailKey?: string): Promise<string | undefined> {
    if (!thumbnailKey) return undefined
    const path = await invoke<string | undefined>('resolve_thumbnail_path', {
      thumbnailKey,
    })
    return path ? convertFileSrc(path) : undefined
  }

  revokeThumbnailUrl(): void {}
}

class TauriFileLocationBackend {
  async resolveOriginalUrl(
    item: MediaItem,
    location?: MediaLocation,
  ): Promise<string | undefined> {
    const selectedLocation =
      location ?? item.locations.find((candidate) => candidate.absolutePath)
    return selectedLocation?.absolutePath
      ? convertFileSrc(selectedLocation.absolutePath)
      : undefined
  }

  revokeOriginalUrl(): void {}

  revealLocation(location: MediaLocation): Promise<void> {
    return invoke('reveal_location', { location })
  }
}

export function createTauriPlatformBackend(): PlatformBackend {
  const catalog = new TauriCatalogBackend()

  return {
    kind: 'tauri',
    capabilities: {
      absolutePaths: true,
      persistentFileHandles: false,
      nativeThumbnails: true,
      nativeCatalog: true,
    },
    catalog,
    importer: new TauriImportBackend(),
    thumbnails: new TauriThumbnailBackend(),
    files: new TauriFileLocationBackend(),
    dispose() {
      catalog.dispose()
    },
  }
}
