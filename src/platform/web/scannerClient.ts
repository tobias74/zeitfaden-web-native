import type { ScanProgress, ScanResult } from './scanner.worker'

type ScanResponse =
  | { id: number; ok: true; result: ScanResult }
  | { id: number; ok: false; error: string }
  | { id: number; type: 'progress'; progress: ScanProgress }

type PendingScan = {
  resolve: (value: ScanResult) => void
  reject: (reason?: unknown) => void
  onProgress?: (progress: ScanProgress) => void
}

export class ScannerClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingScan>()

  scanDirectory(
    sourceId: string,
    sourceLabel: string,
    handle: FileSystemDirectoryHandle,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanResult> {
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      try {
        this.ensureWorker().postMessage({
          id,
          type: 'scanDirectory',
          payload: { sourceId, sourceLabel, handle },
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
    this.rejectAll(new Error('Scanner worker terminated'))
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker

    const worker = new Worker(new URL('./scanner.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker = worker

    worker.addEventListener('message', (event: MessageEvent) => {
      const response = event.data as ScanResponse
      const pending = this.pending.get(response.id)
      if (!pending) return

      if ('type' in response && response.type === 'progress') {
        pending.onProgress?.(response.progress)
        return
      }

      this.pending.delete(response.id)
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
      this.rejectAll(new Error(`Scanner worker failed: ${event.message}`))
    })

    worker.addEventListener('messageerror', () => {
      this.worker = undefined
      worker.terminate()
      this.rejectAll(new Error('Scanner worker sent an unreadable response'))
    })

    return worker
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
