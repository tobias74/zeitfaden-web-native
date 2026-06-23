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
import { traceStartup } from '../../lib/startupTrace'

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
  startedAt: number
  type: string
}

export class CatalogClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest<unknown>>()
  private readonly storageMode: WebCatalogStorageMode

  constructor(storageMode: WebCatalogStorageMode) {
    this.storageMode = storageMode
    traceStartup('[startup:catalog-client]', 'CatalogClient constructed', {
      storageMode,
    })
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

  rebuildSearchIndex(
    indexId: string,
    onProgress?: (progress: GeoIndexBuildProgress) => void,
  ): Promise<SearchIndexBuildSummary> {
    return this.request(
      'buildSearchIndexes',
      { indexId, forceRebuild: true },
      (progress) => {
        onProgress?.(progress as GeoIndexBuildProgress)
      },
    )
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
    if (this.worker) {
      traceStartup('[startup:catalog-client]', 'reusing catalog worker', {
        storageMode: this.storageMode,
      })
      return this.worker
    }

    traceStartup('[startup:catalog-client]', 'creating catalog worker', {
      storageMode: this.storageMode,
    })
    const worker = new Worker(new URL('./catalog.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker = worker
    traceStartup('[startup:catalog-client]', 'catalog worker constructed', {
      storageMode: this.storageMode,
    })

    worker.addEventListener('message', (event: MessageEvent) => {
      const response = event.data as WorkerResponse<unknown>
      const pending = this.pending.get(response.id)
      if (!pending) return

      if ('type' in response && response.type === 'progress') {
        traceStartup('[startup:catalog-client]', 'worker progress received', {
          id: response.id,
          type: pending.type,
          elapsedMs: performance.now() - pending.startedAt,
          progress: response.progress,
        })
        pending.onProgress?.(response.progress)
        return
      }

      this.pending.delete(response.id)
      pending.cleanup?.()
      if ('ok' in response && response.ok) {
        traceStartup('[startup:catalog-client]', 'worker response ok', {
          id: response.id,
          type: pending.type,
          elapsedMs: performance.now() - pending.startedAt,
        })
        pending.resolve(response.result)
      } else if ('ok' in response) {
        traceStartup('[startup:catalog-client]', 'worker response failed', {
          id: response.id,
          type: pending.type,
          elapsedMs: performance.now() - pending.startedAt,
          error: response.error,
        })
        pending.reject(new Error(response.error))
      }
    })

    worker.addEventListener('error', (event) => {
      traceStartup('[startup:catalog-client]', 'catalog worker error', {
        storageMode: this.storageMode,
        message: event.message,
      })
      event.preventDefault()
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error(`Catalog worker failed: ${event.message}`))
    })

    worker.addEventListener('messageerror', () => {
      traceStartup('[startup:catalog-client]', 'catalog worker messageerror', {
        storageMode: this.storageMode,
      })
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
    const startedAt = performance.now()
    traceStartup('[startup:catalog-client]', 'request queued', {
      id,
      type,
      storageMode: this.storageMode,
      hasPayload: payload !== undefined,
    })

    return new Promise<T>((resolve, reject) => {
      const cancelRequest = () => {
        traceStartup('[startup:catalog-client]', 'request cancellation posted', {
          id,
          type,
          elapsedMs: performance.now() - startedAt,
        })
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
        startedAt,
        type,
      })
      try {
        const worker = this.ensureWorker()
        traceStartup('[startup:catalog-client]', 'posting request to worker', {
          id,
          type,
          storageMode: this.storageMode,
          elapsedMs: performance.now() - startedAt,
        })
        worker.postMessage({
          id,
          type,
          payload,
          storageMode: this.storageMode,
        })
        if (signal?.aborted) {
          traceStartup('[startup:catalog-client]', 'signal already aborted', {
            id,
            type,
            elapsedMs: performance.now() - startedAt,
          })
          worker.postMessage({ id, type: 'cancel' })
        }
      } catch (error) {
        this.pending.delete(id)
        cleanup?.()
        traceStartup('[startup:catalog-client]', 'request post failed', {
          id,
          type,
          elapsedMs: performance.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        })
        reject(error)
      }
    })
  }
}
