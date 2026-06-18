import * as exifr from 'exifr'
import { detectMediaKind, pathDisplayName } from '../lib/media'
import type { CapturedAtSource, GeoSource, MediaItem, MediaSource } from '../types'

type ScanRequest = {
  id: number
  type: 'scanDirectory'
  payload: {
    sourceId: string
    sourceLabel: string
    handle: FileSystemDirectoryHandle
  }
}

export type ScanProgress = {
  scannedFiles: number
  acceptedMedia: number
  currentPath?: string
}

export type ScanResult = {
  source: MediaSource
  items: MediaItem[]
  errors: string[]
  stats: {
    scannedFiles: number
    acceptedMedia: number
    skippedFiles: number
  }
}

const ctx = self as unknown as {
  postMessage: (message: unknown) => void
  addEventListener: (
    type: 'message',
    listener: (event: MessageEvent<ScanRequest>) => void,
  ) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function dateMillis(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

async function stableMediaId(
  sourceId: string,
  relativePath: string,
  file: File,
): Promise<string> {
  const material = `${sourceId}\n${relativePath}\n${file.size}\n${file.lastModified}`
  const encoded = new TextEncoder().encode(material)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return hex.slice(0, 32)
}

async function writeThumbnail(id: string, file: File): Promise<string | undefined> {
  if (
    typeof createImageBitmap !== 'function' ||
    typeof OffscreenCanvas === 'undefined'
  ) {
    return undefined
  }

  try {
    const bitmap = await createImageBitmap(file)
    const maxSide = 360
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) return undefined

    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()

    const blob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.78,
    })
    const root = await navigator.storage.getDirectory()
    const thumbs = await root.getDirectoryHandle('thumbs', { create: true })
    const key = `${id}.webp`
    const handle = await thumbs.getFileHandle(key, { create: true })
    const writable = await handle.createWritable?.()
    if (!writable) return undefined
    await writable.write(blob)
    await writable.close()
    return `thumbs/${key}`
  } catch {
    return undefined
  }
}

async function readImageMetadata(file: File): Promise<{
  width?: number
  height?: number
  capturedAt?: number
  capturedAtSource?: CapturedAtSource
  latitude?: number
  longitude?: number
  geoSource?: GeoSource
}> {
  const metadata = await exifr
    .parse(file, {
      gps: true,
      exif: true,
      tiff: true,
      xmp: true,
      reviveValues: true,
    })
    .catch(() => undefined)

  const record = isRecord(metadata) ? metadata : {}
  const latitude = numeric(record.latitude) ?? numeric(record.GPSLatitude)
  const longitude = numeric(record.longitude) ?? numeric(record.GPSLongitude)
  const capturedAt =
    dateMillis(record.DateTimeOriginal) ??
    dateMillis(record.CreateDate) ??
    dateMillis(record.DateCreated) ??
    dateMillis(record.ModifyDate) ??
    dateMillis(record.DateTime)

  let width = numeric(record.ImageWidth) ?? numeric(record.ExifImageWidth)
  let height = numeric(record.ImageHeight) ?? numeric(record.ExifImageHeight)

  if ((!width || !height) && typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      width = bitmap.width
      height = bitmap.height
      bitmap.close()
    } catch {
      // EXIF-less or browser-unsupported image formats are still valid media.
    }
  }

  return {
    width,
    height,
    capturedAt,
    capturedAtSource: capturedAt ? 'exif' : undefined,
    latitude,
    longitude,
    geoSource:
      typeof latitude === 'number' && typeof longitude === 'number'
        ? 'exif'
        : undefined,
  }
}

async function mediaFromFile(
  sourceId: string,
  relativePath: string,
  fileHandle: FileSystemFileHandle,
): Promise<MediaItem | undefined> {
  const file = await fileHandle.getFile()
  const kind = detectMediaKind(file)
  if (!kind) return undefined

  const id = await stableMediaId(sourceId, relativePath, file)
  const base = {
    id,
    sourceId,
    relativePath,
    displayName: pathDisplayName(relativePath),
    kind,
    mimeType: file.type || (kind === 'image' ? 'image/*' : 'video/*'),
    sizeBytes: file.size,
    lastSeenAt: Date.now(),
  }

  if (kind === 'video') {
    return {
      ...base,
      capturedAt: file.lastModified || undefined,
      capturedAtSource: file.lastModified ? 'filesystem' : undefined,
    }
  }

  const imageMetadata = await readImageMetadata(file)
  const thumbnailKey = await writeThumbnail(id, file)

  return {
    ...base,
    ...imageMetadata,
    capturedAt: imageMetadata.capturedAt ?? file.lastModified ?? undefined,
    capturedAtSource:
      imageMetadata.capturedAtSource ??
      (file.lastModified ? 'filesystem' : undefined),
    thumbnailKey,
  }
}

async function scanDirectory(
  sourceId: string,
  handle: FileSystemDirectoryHandle,
): Promise<Omit<ScanResult, 'source'>> {
  const items: MediaItem[] = []
  const errors: string[] = []
  let scannedFiles = 0
  let acceptedMedia = 0
  let skippedFiles = 0

  async function walk(
    directoryHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<void> {
    const entries = directoryHandle.entries()
    for await (const [name, entry] of entries) {
      const relativePath = prefix ? `${prefix}/${name}` : name

      if (entry.kind === 'directory') {
        await walk(entry as FileSystemDirectoryHandle, relativePath)
        continue
      }

      scannedFiles += 1
      try {
        const item = await mediaFromFile(
          sourceId,
          relativePath,
          entry as FileSystemFileHandle,
        )
        if (item) {
          items.push(item)
          acceptedMedia += 1
        } else {
          skippedFiles += 1
        }
      } catch (error) {
        skippedFiles += 1
        errors.push(
          `${relativePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }

      if (scannedFiles % 20 === 0) {
        ctx.postMessage({
          id: currentRequestId,
          type: 'progress',
          progress: { scannedFiles, acceptedMedia, currentPath: relativePath },
        })
      }
    }
  }

  await walk(handle, '')
  return { items, errors, stats: { scannedFiles, acceptedMedia, skippedFiles } }
}

let currentRequestId = 0

ctx.addEventListener('message', async (event: MessageEvent<ScanRequest>) => {
  currentRequestId = event.data.id

  try {
    if (event.data.type !== 'scanDirectory') {
      throw new Error(`Unknown scanner request: ${event.data.type}`)
    }

    const { sourceId, sourceLabel, handle } = event.data.payload
    const partial = await scanDirectory(sourceId, handle)
    const result: ScanResult = {
      source: {
        id: sourceId,
        label: sourceLabel,
        addedAt: Date.now(),
      },
      ...partial,
    }
    ctx.postMessage({ id: event.data.id, ok: true, result })
  } catch (error) {
    ctx.postMessage({
      id: event.data.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
