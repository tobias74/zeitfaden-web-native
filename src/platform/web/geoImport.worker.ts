import { GoogleTakeoutLocationStreamParser } from '../../lib/googleTakeoutStream'
import { geoPointContentHash, type ParsedGeoPoint } from '../../lib/geoPoint'
import type { MediaItem, MediaLocation } from '../../types'
import type { ImportProgress, ImportProgressPhase } from '../types'

type GeoImportRequest =
  | {
      id: number
      type: 'importGoogleTakeout'
      payload: {
        file: File
        sourceId: string
        sourceLabel: string
      }
    }
  | {
      id: number
      type: 'batchAck'
      batchId: number
      error?: string
    }

type GeoImportResult = {
  acceptedMedia: number
  skippedFiles: number
}

type PendingBatchAck = {
  resolve: () => void
  reject: (error: Error) => void
}

const GEO_IMPORT_LOG_PREFIX = '[geo-import]'
const GEO_IMPORT_BATCH_SIZE = 1000
const GEO_IMPORT_BATCH_MAX_AGE_MS = 1000
const GEO_IMPORT_PARSE_SLICE_MS = 250
const GEO_IMPORT_UI_PROGRESS_HEARTBEAT_MS = 1000
const GEO_IMPORT_READ_PROGRESS_BYTES = 100 * 1024 * 1024

const pendingBatchAcks = new Map<string, PendingBatchAck>()

const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<GeoImportRequest>) => void,
  ) => void
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function stableId(...parts: string[]): Promise<string> {
  const encoded = new TextEncoder().encode(parts.join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return bytesToHex(new Uint8Array(digest))
}

async function geoPointItemFromParsedPoint(
  sourceId: string,
  sourceLabel: string,
  point: ParsedGeoPoint,
): Promise<MediaItem> {
  const contentHash = await geoPointContentHash(
    point.latitude,
    point.longitude,
    point.capturedAt,
  )
  const lastSeenAt = Date.now()
  const displayName = `${sourceLabel} #${point.index}`
  const location: MediaLocation = {
    id: await stableId(sourceId, sourceLabel, contentHash),
    sourceId,
    relativePath: sourceLabel,
    displayName,
    lastSeenAt,
  }

  return {
    id: contentHash,
    contentHash,
    sourceId,
    relativePath: sourceLabel,
    displayName,
    kind: 'geo_point',
    mimeType: 'application/json',
    sizeBytes: 0,
    capturedAt: point.capturedAt,
    capturedAtSource: 'geo-file',
    latitude: point.latitude,
    longitude: point.longitude,
    geoSource: 'geo-file',
    lastSeenAt,
    locations: [location],
  }
}

function batchAckKey(requestId: number, batchId: number): string {
  return `${requestId}:${batchId}`
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function importGoogleTakeout(
  requestId: number,
  file: File,
  sourceId: string,
  sourceLabel: string,
): Promise<GeoImportResult> {
  const parser = new GoogleTakeoutLocationStreamParser()
  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  const pendingPoints: ParsedGeoPoint[] = []
  let bytesRead = 0
  let acceptedMedia = 0
  let inFlightAcceptedMedia = 0
  let skippedFiles = 0
  let batchId = 0
  let firstPendingPointAt: number | undefined
  let nextProgressAt = GEO_IMPORT_READ_PROGRESS_BYTES
  let currentProgressPhase: ImportProgressPhase = 'scanning'
  let progressHeartbeat:
    | ReturnType<typeof globalThis.setInterval>
    | undefined

  const visibleAcceptedMedia = (phase: ImportProgressPhase) =>
    phase === 'storing'
      ? acceptedMedia + inFlightAcceptedMedia
      : acceptedMedia + pendingPoints.length + inFlightAcceptedMedia

  const emitProgress = (phase: ImportProgressPhase = currentProgressPhase) => {
    currentProgressPhase = phase
    const progress: ImportProgress = {
      phase,
      sourceLabel,
      scannedFiles: phase === 'storing' && bytesRead >= file.size ? 1 : 0,
      totalFiles: 1,
      acceptedMedia: visibleAcceptedMedia(phase),
      skippedFiles,
      currentPath: sourceLabel,
      scannedBytes: bytesRead,
      totalBytes: file.size,
    }
    ctx.postMessage({ id: requestId, type: 'progress', progress })
  }

  const startProgressHeartbeat = () => {
    progressHeartbeat = globalThis.setInterval(() => {
      emitProgress()
    }, GEO_IMPORT_UI_PROGRESS_HEARTBEAT_MS)
  }

  const stopProgressHeartbeat = () => {
    if (progressHeartbeat !== undefined) {
      globalThis.clearInterval(progressHeartbeat)
      progressHeartbeat = undefined
    }
  }

  const emitBatch = async (items: MediaItem[]) => {
    batchId += 1
    const key = batchAckKey(requestId, batchId)
    const ack = new Promise<void>((resolve, reject) => {
      pendingBatchAcks.set(key, { resolve, reject })
    })
    ctx.postMessage({ id: requestId, type: 'batch', batchId, items })
    await ack
  }

  const flushPendingBatch = async () => {
    if (pendingPoints.length === 0) return

    const points = pendingPoints.splice(0, GEO_IMPORT_BATCH_SIZE)
    if (pendingPoints.length === 0) {
      firstPendingPointAt = undefined
    }
    inFlightAcceptedMedia += points.length
    emitProgress('storing')
    try {
      const items = await Promise.all(
        points.map((point) =>
          geoPointItemFromParsedPoint(sourceId, sourceLabel, point),
        ),
      )
      await emitBatch(items)
      acceptedMedia += items.length
    } finally {
      inFlightAcceptedMedia -= points.length
    }
  }

  const flushPending = async (force = false) => {
    let flushed = false
    while (pendingPoints.length > 0) {
      if (!force && pendingPoints.length < GEO_IMPORT_BATCH_SIZE) {
        const pendingAgeMs =
          firstPendingPointAt === undefined
            ? 0
            : performance.now() - firstPendingPointAt
        if (pendingAgeMs < GEO_IMPORT_BATCH_MAX_AGE_MS) return
      }
      await flushPendingBatch()
      flushed = true
    }
    if (flushed) {
      emitProgress('scanning')
    }
  }

  const consumeText = async (text: string) => {
    let chunk = text
    while (true) {
      const result = parser.feed(chunk, {
        maxDurationMs: GEO_IMPORT_PARSE_SLICE_MS,
      })
      chunk = ''
      skippedFiles += result.skippedPoints
      if (result.points.length > 0) {
        firstPendingPointAt ??= performance.now()
        pendingPoints.push(...result.points)
      }

      await flushPending()

      if (!result.paused) break
      await yieldToEventLoop()
    }
  }

  startProgressHeartbeat()
  emitProgress('scanning')

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      bytesRead += value.byteLength
      await consumeText(decoder.decode(value, { stream: true }))

      if (bytesRead >= nextProgressAt) {
        console.log(GEO_IMPORT_LOG_PREFIX, {
          phase: 'takeout worker stream progress',
          fileName: file.name,
          sourceLabel,
          bytesRead,
          sizeBytes: file.size,
          acceptedMedia: visibleAcceptedMedia('scanning'),
          skippedFiles,
        })
        emitProgress('scanning')
        while (nextProgressAt <= bytesRead) {
          nextProgressAt += GEO_IMPORT_READ_PROGRESS_BYTES
        }
      }
    }

    const finalChunk = decoder.decode()
    if (finalChunk) {
      await consumeText(finalChunk)
    }

    const final = parser.finish()
    skippedFiles = final.skippedPoints
    await flushPending(true)

    console.log(GEO_IMPORT_LOG_PREFIX, {
      phase: 'takeout worker stream complete',
      fileName: file.name,
      sourceLabel,
      bytesRead,
      sizeBytes: file.size,
      bytesReadMatchesFileSize: bytesRead === file.size,
      totalEntries: final.totalEntries,
      acceptedMedia,
      skippedFiles,
    })

    emitProgress('storing')
    return { acceptedMedia, skippedFiles }
  } finally {
    stopProgressHeartbeat()
  }
}

ctx.addEventListener('message', async (event) => {
  const request = event.data

  if (request.type === 'batchAck') {
    const key = batchAckKey(request.id, request.batchId)
    const ack = pendingBatchAcks.get(key)
    if (!ack) return

    pendingBatchAcks.delete(key)
    if (request.error) {
      ack.reject(new Error(request.error))
    } else {
      ack.resolve()
    }
    return
  }

  try {
    const result = await importGoogleTakeout(
      request.id,
      request.payload.file,
      request.payload.sourceId,
      request.payload.sourceLabel,
    )
    ctx.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    ctx.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
