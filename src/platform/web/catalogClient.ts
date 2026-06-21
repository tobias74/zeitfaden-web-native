import type {
  CatalogQuery,
  GeoIndexPoint,
  MediaItem,
  MediaSource,
  TimeRange,
} from '../../types'
import type { CatalogInfo } from '../types'

type WorkerResponse<T> =
  | { id: number; ok: true; result: T }
  | { id: number; ok: false; error: string }

type PendingRequest<T> = {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

export class CatalogClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest<unknown>>()

  init(): Promise<CatalogInfo> {
    return this.request('init')
  }

  upsertSource(source: MediaSource): Promise<void> {
    return this.request('upsertSource', source)
  }

  upsertMedia(items: MediaItem[]): Promise<number> {
    return this.request('upsertMedia', items)
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

      this.pending.delete(response.id)
      if (response.ok) {
        pending.resolve(response.result)
      } else {
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
      pending.reject(error)
    }
    this.pending.clear()
  }

  private request<T>(type: string, payload?: unknown): Promise<T> {
    const id = this.nextId++

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      try {
        this.ensureWorker().postMessage({ id, type, payload })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }
}
