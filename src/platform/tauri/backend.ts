import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { GeoIndexRegistry } from '../../geo/registry'
import type {
  CatalogQuery,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  GeoIndexPoint,
  MediaItem,
  MediaLocation,
  MediaSource,
  TimeRange,
  ValidationReport,
} from '../../types'
import type {
  CatalogBackend,
  CatalogInfo,
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  ImportBackend,
  ImportProgress,
  ImportSummary,
  PlatformBackend,
  ThumbnailBackend,
} from '../types'

class TauriCatalogBackend implements CatalogBackend {
  private readonly geoIndexRegistry = new GeoIndexRegistry()

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

  getMediaByIds(ids: string[]): Promise<MediaItem[]> {
    return invoke('get_media_by_ids', { ids })
  }

  getGeoPoints(range: TimeRange = {}): Promise<GeoIndexPoint[]> {
    return invoke('get_geo_points', { range })
  }

  listSources(): Promise<MediaSource[]> {
    return invoke('list_sources')
  }

  removeSources(sourceIds: string[]): Promise<void> {
    return invoke('remove_sources', { sourceIds })
  }

  countMedia(): Promise<number> {
    return invoke('count_media')
  }

  async buildGeoIndexes(
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary> {
    const startedAt = performance.now()
    const points = await this.getGeoPoints()
    const totalIndexes = this.geoIndexRegistry.indexes.length
    let builtIndexes = 0

    onProgress?.({
      phase: 'building',
      pointCount: points.length,
      builtIndexes,
      totalIndexes,
    })

    for (const index of this.geoIndexRegistry.indexes) {
      onProgress?.({
        phase: 'building',
        pointCount: points.length,
        builtIndexes,
        totalIndexes,
        currentIndexId: index.id,
        currentIndexLabel: index.label,
      })
      await index.build(points)
      builtIndexes += 1
      onProgress?.({
        phase: 'building',
        pointCount: points.length,
        builtIndexes,
        totalIndexes,
        currentIndexId: index.id,
        currentIndexLabel: index.label,
      })
    }

    onProgress?.({
      phase: 'ready',
      pointCount: points.length,
      builtIndexes,
      totalIndexes,
    })

    return {
      pointCount: points.length,
      buildTimeMs: performance.now() - startedAt,
    }
  }

  searchGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<GeoSearchResult[]> {
    return this.geoIndexRegistry.get(indexId).search(query)
  }

  getGeoIndexStats(indexId: string): Promise<GeoIndexStats> {
    return this.geoIndexRegistry.get(indexId).stats()
  }

  validateGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    return this.geoIndexRegistry
      .get(indexId)
      .validateAgainstBruteForce(query)
  }

  clear(): Promise<void> {
    return invoke('clear_catalog')
  }

  dispose(): void {}
}

class TauriImportBackend implements ImportBackend {
  async importFolder(
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportSummary> {
    return this.importWithProgress('import_folder', onProgress)
  }

  async importGeoFile(
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportSummary> {
    return this.importWithProgress('import_geo_file', onProgress)
  }

  private async importWithProgress(
    command: string,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<ImportSummary> {
    const unlisten = await listen<ImportProgress>('import-progress', (event) => {
      onProgress?.(event.payload)
    })

    try {
      return await invoke(command)
    } finally {
      unlisten()
    }
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
