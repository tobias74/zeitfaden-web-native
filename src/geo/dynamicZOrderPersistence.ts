import type {
  DynamicZOrderGeoIndexSnapshot,
  DynamicZOrderSnapshotCell,
} from './dynamicZOrderGeoIndex'
import type { GeoIndexPoint, MediaKind } from '../types'

export type DynamicZOrderIndexManifest = {
  engineId: 'dynamic-z-order-cells'
  engineVersion: 1
  resolution: number
  catalogEpoch: number
  pointCount: number
  cellCount: number
  createdAt: number
  dataChecksum: string
}

const MAGIC = 'ZFDZIDX1'
const FORMAT_VERSION = 1
const HEADER_BYTES = 8 + 4 + 4 + 4 + 4
const CELL_FIXED_BYTES = 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 4
const POINT_FIXED_BYTES = 4 + 1 + 8 + 8 + 8
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function kindToByte(kind: MediaKind | undefined): number {
  if (kind === 'image') return 1
  if (kind === 'video') return 2
  if (kind === 'geo_point') return 3
  return 0
}

function byteToKind(value: number): MediaKind | undefined {
  if (value === 1) return 'image'
  if (value === 2) return 'video'
  if (value === 3) return 'geo_point'
  return undefined
}

function optionalNumberToBinary(value: number | undefined): number {
  return typeof value === 'number' ? value : Number.NaN
}

function binaryToOptionalNumber(value: number): number | undefined {
  return Number.isNaN(value) ? undefined : value
}

function encodedPointSize(point: GeoIndexPoint): number {
  return POINT_FIXED_BYTES + textEncoder.encode(point.mediaId).byteLength
}

function encodedCellSize(cell: DynamicZOrderSnapshotCell): number {
  return (
    CELL_FIXED_BYTES +
    cell.points.reduce((total, point) => total + encodedPointSize(point), 0)
  )
}

function writeAscii(view: DataView, offset: number, value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
  return offset + value.length
}

function readAscii(view: DataView, offset: number, length: number): string {
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index))
  }
  return value
}

function writePoint(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  point: GeoIndexPoint,
): number {
  const idBytes = textEncoder.encode(point.mediaId)
  view.setUint32(offset, idBytes.byteLength, true)
  offset += 4
  bytes.set(idBytes, offset)
  offset += idBytes.byteLength
  view.setUint8(offset, kindToByte(point.kind))
  offset += 1
  view.setFloat64(offset, point.lat, true)
  offset += 8
  view.setFloat64(offset, point.lon, true)
  offset += 8
  view.setFloat64(offset, optionalNumberToBinary(point.timestamp), true)
  offset += 8
  return offset
}

function readPoint(view: DataView, bytes: Uint8Array, offset: number): {
  point: GeoIndexPoint
  offset: number
} {
  const idLength = view.getUint32(offset, true)
  offset += 4
  if (offset + idLength > bytes.byteLength) {
    throw new Error('Dynamic Z-order index point id exceeds file length.')
  }
  const mediaId = textDecoder.decode(bytes.slice(offset, offset + idLength))
  offset += idLength
  const kind = byteToKind(view.getUint8(offset))
  offset += 1
  const lat = view.getFloat64(offset, true)
  offset += 8
  const lon = view.getFloat64(offset, true)
  offset += 8
  const timestamp = binaryToOptionalNumber(view.getFloat64(offset, true))
  offset += 8

  return {
    point: {
      mediaId,
      kind,
      lat,
      lon,
      timestamp,
    },
    offset,
  }
}

export function encodeDynamicZOrderSnapshot(
  snapshot: DynamicZOrderGeoIndexSnapshot,
): ArrayBuffer {
  const totalBytes =
    HEADER_BYTES +
    snapshot.cells.reduce((total, cell) => total + encodedCellSize(cell), 0)
  const buffer = new ArrayBuffer(totalBytes)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let offset = writeAscii(view, 0, MAGIC)
  view.setUint32(offset, FORMAT_VERSION, true)
  offset += 4
  view.setUint32(offset, snapshot.resolution, true)
  offset += 4
  view.setUint32(offset, snapshot.cellCount, true)
  offset += 4
  view.setUint32(offset, snapshot.pointCount, true)
  offset += 4

  for (const cell of snapshot.cells) {
    view.setUint32(offset, cell.z, true)
    offset += 4
    view.setUint32(offset, cell.x, true)
    offset += 4
    view.setUint32(offset, cell.y, true)
    offset += 4
    view.setFloat64(offset, cell.latMin, true)
    offset += 8
    view.setFloat64(offset, cell.latMax, true)
    offset += 8
    view.setFloat64(offset, cell.lonMin, true)
    offset += 8
    view.setFloat64(offset, cell.lonMax, true)
    offset += 8
    view.setFloat64(offset, optionalNumberToBinary(cell.minTimestamp), true)
    offset += 8
    view.setFloat64(offset, optionalNumberToBinary(cell.maxTimestamp), true)
    offset += 8
    view.setUint32(offset, cell.points.length, true)
    offset += 4

    for (const point of cell.points) {
      offset = writePoint(view, bytes, offset, point)
    }
  }

  return buffer
}

export function decodeDynamicZOrderSnapshot(
  buffer: ArrayBuffer,
): DynamicZOrderGeoIndexSnapshot {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  if (buffer.byteLength < HEADER_BYTES || readAscii(view, 0, 8) !== MAGIC) {
    throw new Error('Dynamic Z-order index data has an invalid header.')
  }

  let offset = 8
  const version = view.getUint32(offset, true)
  offset += 4
  if (version !== FORMAT_VERSION) {
    throw new Error('Dynamic Z-order index data version is unsupported.')
  }
  const resolution = view.getUint32(offset, true)
  offset += 4
  const cellCount = view.getUint32(offset, true)
  offset += 4
  const pointCount = view.getUint32(offset, true)
  offset += 4
  const cells: DynamicZOrderSnapshotCell[] = []
  let decodedPointCount = 0

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    if (offset + CELL_FIXED_BYTES > buffer.byteLength) {
      throw new Error('Dynamic Z-order index cell exceeds file length.')
    }

    const z = view.getUint32(offset, true)
    offset += 4
    const x = view.getUint32(offset, true)
    offset += 4
    const y = view.getUint32(offset, true)
    offset += 4
    const latMin = view.getFloat64(offset, true)
    offset += 8
    const latMax = view.getFloat64(offset, true)
    offset += 8
    const lonMin = view.getFloat64(offset, true)
    offset += 8
    const lonMax = view.getFloat64(offset, true)
    offset += 8
    const minTimestamp = binaryToOptionalNumber(view.getFloat64(offset, true))
    offset += 8
    const maxTimestamp = binaryToOptionalNumber(view.getFloat64(offset, true))
    offset += 8
    const cellPointCount = view.getUint32(offset, true)
    offset += 4
    const points: GeoIndexPoint[] = []

    for (let pointIndex = 0; pointIndex < cellPointCount; pointIndex += 1) {
      const decoded = readPoint(view, bytes, offset)
      points.push(decoded.point)
      offset = decoded.offset
    }

    decodedPointCount += points.length
    cells.push({
      key: `${resolution}:${z}`,
      z,
      x,
      y,
      latMin,
      latMax,
      lonMin,
      lonMax,
      minTimestamp,
      maxTimestamp,
      points,
    })
  }

  if (offset !== buffer.byteLength || decodedPointCount !== pointCount) {
    throw new Error('Dynamic Z-order index data is truncated or has extra bytes.')
  }

  return {
    engineId: 'dynamic-z-order-cells',
    version: 1,
    resolution,
    pointCount,
    cellCount,
    cells,
  }
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(buffer))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function createDynamicZOrderManifest(
  snapshot: DynamicZOrderGeoIndexSnapshot,
  catalogEpoch: number,
  dataChecksum: string,
): DynamicZOrderIndexManifest {
  return {
    engineId: 'dynamic-z-order-cells',
    engineVersion: 1,
    resolution: snapshot.resolution,
    catalogEpoch,
    pointCount: snapshot.pointCount,
    cellCount: snapshot.cellCount,
    createdAt: Date.now(),
    dataChecksum,
  }
}

export function validateDynamicZOrderManifest(
  manifest: DynamicZOrderIndexManifest,
  catalogEpoch: number,
): void {
  if (
    manifest.engineId !== 'dynamic-z-order-cells' ||
    manifest.engineVersion !== 1 ||
    manifest.resolution !== 10 ||
    manifest.catalogEpoch !== catalogEpoch
  ) {
    throw new Error('Dynamic Z-order index manifest does not match catalog.')
  }
}
