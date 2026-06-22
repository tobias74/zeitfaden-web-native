import type {
  CatalogQuery,
  GeoIndexPoint,
  GeoIndexStats,
  GeoSearchQuery,
  GeoSearchResult,
  MediaItem,
  MediaSource,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
  TimeRange,
  ValidationReport,
} from '../../types'
import type {
  CatalogInfo,
  GeoIndexBuildProgress,
  GeoIndexBuildSummary,
  ImportProgress,
  ImportSummary,
  SearchIndexBuildSummary,
} from '../types'
import type { WebCatalogStorageMode } from './storageMode'

type ImportFolderPayload = {
  source: MediaSource
  duplicateSourceIds: string[]
  handle: FileSystemDirectoryHandle
}

type ImportGeoFilePayload = {
  source: MediaSource
  duplicateSourceIds: string[]
  file: File
  traceId?: string
}

type WorkerResponse<T> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string }
  | { id: number; type: 'progress'; progress: unknown }

type PendingRequest<T> = {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
  onProgress?: (progress: unknown) => void
  cleanup?: () => void
}

export class CatalogClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest<unknown>>()
  private readonly storageMode: WebCatalogStorageMode

  constructor(storageMode: WebCatalogStorageMode) {
    this.storageMode = storageMode
  }

  init(): Promise<CatalogInfo> {
    return this.request('init')
  }

  upsertSource(source: MediaSource): Promise<void> {
    return this.request('upsertSource', source)
  }

  upsertMedia(items: MediaItem[]): Promise<number> {
    return this.request('upsertMedia', items)
  }

  importFolder(
    payload: ImportFolderPayload,
    onProgress?: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<ImportSummary> {
    return this.request('importFolder', payload, (progress) => {
      onProgress?.(progress as ImportProgress)
    }, signal)
  }

  importGeoFile(
    payload: ImportGeoFilePayload,
    onProgress?: (progress: ImportProgress) => void,
    signal?: AbortSignal,
  ): Promise<ImportSummary> {
    return this.request('importGeoFile', payload, (progress) => {
      onProgress?.(progress as ImportProgress)
    }, signal)
  }

  commitImport(): Promise<void> {
    return this.request('commitImport')
  }

  searchMedia(spec: SearchSpec): Promise<SearchPage> {
    return this.request('searchMedia', spec)
  }

  buildSearchIndexes(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary> {
    return this.request('buildSearchIndexes', { indexId }, (progress) => {
      onProgress?.(progress as GeoIndexBuildProgress)
    })
  }

  getSearchIndexStats(): Promise<SearchIndexStats[]> {
    return this.request('getSearchIndexStats')
  }

  listMedia(query: CatalogQuery): Promise<MediaItem[]> {
    return this.request('listMedia', query)
  }

  getMediaByIds(ids: string[]): Promise<MediaItem[]> {
    return this.request('getMediaByIds', ids)
  }

  getGeoPoints(range: TimeRange = {}): Promise<GeoIndexPoint[]> {
    return this.request('getGeoPoints', range)
  }

  listSources(): Promise<MediaSource[]> {
    return this.request('listSources')
  }

  removeSources(sourceIds: string[]): Promise<void> {
    return this.request('removeSources', sourceIds)
  }

  countMedia(): Promise<number> {
    return this.request('countMedia')
  }

  buildGeoIndexes(
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<GeoIndexBuildSummary> {
    return this.request('buildGeoIndexes', undefined, (progress) => {
      onProgress?.(progress as GeoIndexBuildProgress)
    })
  }

  searchGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<GeoSearchResult[]> {
    return this.request('searchGeoIndex', { indexId, query })
  }

  getGeoIndexStats(indexId: string): Promise<GeoIndexStats> {
    return this.request('getGeoIndexStats', indexId)
  }

  validateGeoIndex(
    indexId: string,
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    return this.request('validateGeoIndex', { indexId, query })
  }

  clear(): Promise<void> {
    return this.request('clear')
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
    this.rejectAll(new Error('Catalog worker terminated'))
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL('./catalog.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker = worker

    worker.addEventListener('message', (event: MessageEvent) => {
      const response = event.data as WorkerResponse<unknown>
      const pending = this.pending.get(response.id)
      if (!pending) return

      if ('type' in response && response.type === 'progress') {
        pending.onProgress?.(response.progress)
        return
      }

      this.pending.delete(response.id)
      pending.cleanup?.()
      if ('ok' in response && response.ok) {
        pending.resolve(response.result)
      } else if ('ok' in response) {
        pending.reject(new Error(response.error))
      }
    })

    worker.addEventListener('error', (event) => {
      event.preventDefault()
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error(`Catalog worker failed: ${event.message}`))
    })

    worker.addEventListener('messageerror', () => {
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error('Catalog worker sent an unreadable response'))
    })

    return worker
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.cleanup?.()
      pending.reject(error)
    }
    this.pending.clear()
  }

  private request<T>(
    type: string,
    payload?: unknown,
    onProgress?: (progress: unknown) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      const cancelRequest = () => {
        this.worker?.postMessage({ id, type: 'cancel' })
      }
      const cleanup = signal
        ? () => signal.removeEventListener('abort', cancelRequest)
        : undefined
      signal?.addEventListener('abort', cancelRequest, { once: true })
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress,
        cleanup,
      })
      try {
        const worker = this.ensureWorker()
        worker.postMessage({
          id,
          type,
          payload,
          storageMode: this.storageMode,
        })
        if (signal?.aborted) {
          worker.postMessage({ id, type: 'cancel' })
        }
      } catch (error) {
        this.pending.delete(id)
        cleanup?.()
        reject(error)
      }
    })
  }
}
