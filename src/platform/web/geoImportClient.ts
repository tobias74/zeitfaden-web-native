import type { MediaItem } from '../../types'
import type { ImportProgress } from '../types'

type GeoImportWorkerResult = {
  acceptedMedia: number
  skippedFiles: number
}

type GeoImportResponse =
  | { id: number; ok: true; result: GeoImportWorkerResult }
  | { id: number; ok: false; error: string }
  | { id: number; type: 'progress'; progress: ImportProgress }
  | { id: number; type: 'batch'; batchId: number; items: MediaItem[] }

type PendingGeoImport = {
  resolve: (value: GeoImportWorkerResult) => void
  reject: (reason?: unknown) => void
  onProgress?: (progress: ImportProgress) => void
  onBatch: (items: MediaItem[]) => Promise<void>
}

export class GeoImportClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingGeoImport>()

  importGoogleTakeoutFile(
    file: File,
    sourceId: string,
    sourceLabel: string,
    onBatch: (items: MediaItem[]) => Promise<void>,
    onProgress?: (progress: ImportProgress) => void,
  ): Promise<GeoImportWorkerResult> {
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, onBatch })
      try {
        this.ensureWorker().postMessage({
          id,
          type: 'importGoogleTakeout',
          payload: { file, sourceId, sourceLabel },
        })
      } catch (error) {
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
    this.rejectAll(new Error('Geo import worker terminated'))
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL('./geoImport.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker = worker

    worker.addEventListener('message', (event: MessageEvent) => {
      void this.handleMessage(event.data as GeoImportResponse)
    })

    worker.addEventListener('error', (event) => {
      event.preventDefault()
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error(`Geo import worker failed: ${event.message}`))
    })

    worker.addEventListener('messageerror', () => {
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error('Geo import worker sent an unreadable response'))
    })

    return worker
  }

  private async handleMessage(response: GeoImportResponse): Promise<void> {
    const pending = this.pending.get(response.id)
    if (!pending) return

    if ('type' in response && response.type === 'progress') {
      pending.onProgress?.(response.progress)
      return
    }

    if ('type' in response && response.type === 'batch') {
      try {
        await pending.onBatch(response.items)
        this.worker?.postMessage({
          id: response.id,
          type: 'batchAck',
          batchId: response.batchId,
        })
      } catch (error) {
        this.worker?.postMessage({
          id: response.id,
          type: 'batchAck',
          batchId: response.batchId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    this.pending.delete(response.id)
    if ('ok' in response && response.ok) {
      pending.resolve(response.result)
    } else if ('ok' in response) {
      pending.reject(new Error(response.error))
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
