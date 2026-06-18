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
  private readonly worker = new Worker(
    new URL('./scanner.worker.ts', import.meta.url),
    { type: 'module' },
  )

  private nextId = 1
  private readonly pending = new Map<number, PendingScan>()

  constructor() {
    this.worker.addEventListener('message', (event: MessageEvent) => {
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
  }

  scanDirectory(
    sourceId: string,
    sourceLabel: string,
    handle: FileSystemDirectoryHandle,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<ScanResult> {
    const id = this.nextId++

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
      this.worker.postMessage({
        id,
        type: 'scanDirectory',
        payload: { sourceId, sourceLabel, handle },
      })
    })
  }

  dispose(): void {
    this.worker.terminate()
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Scanner worker terminated'))
    }
    this.pending.clear()
  }
}
