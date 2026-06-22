import type {
  SegmentedKdTreeSnapshot,
  SegmentedKdTreeSnapshotSegment,
} from './segmentedKdTreeGeoIndex'
import type { GeoIndexPoint, MediaKind } from '../types'

export type SegmentedKdTreeManifest = {
  engineId: 'segmented-kd-tree'
  engineVersion: 1
  leafSize: number
  segmentPointLimit: number
  deltaFlushPointLimit: number
  catalogEpoch: number
  pointCount: number
  segmentCount: number
  createdAt: number
  dataChecksum: string
}

const MAGIC = 'ZFKDIDX1'
const FORMAT_VERSION = 1
const HEADER_BYTES = 8 + 4 + 4 + 4 + 4 + 4 + 4
const SEGMENT_FIXED_BYTES = 1 + 4 + 4 + 4 + 4
const NODE_FIXED_BYTES = 4 + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 1
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

function intToOptionalIndex(value: number): number | undefined {
  return value >= 0 ? value : undefined
}

function optionalIndexToInt(value: number | undefined): number {
  return typeof value === 'number' ? value : -1
}

function encodedPointSize(point: GeoIndexPoint): number {
  return POINT_FIXED_BYTES + textEncoder.encode(point.mediaId).byteLength
}

function encodedStringSize(value: string): number {
  return 4 + textEncoder.encode(value).byteLength
}

function encodedSegmentSize(segment: SegmentedKdTreeSnapshotSegment): number {
  return (
    encodedStringSize(segment.id) +
    SEGMENT_FIXED_BYTES +
    segment.nodes.length * NODE_FIXED_BYTES +
    segment.points.reduce((total, point) => total + encodedPointSize(point), 0)
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

function writeString(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  value: string,
): number {
  const encoded = textEncoder.encode(value)
  view.setUint32(offset, encoded.byteLength, true)
  offset += 4
  bytes.set(encoded, offset)
  return offset + encoded.byteLength
}

function readString(view: DataView, bytes: Uint8Array, offset: number): {
  value: string
  offset: number
} {
  const length = view.getUint32(offset, true)
  offset += 4
  if (offset + length > bytes.byteLength) {
    throw new Error('Segmented KD-tree string exceeds file length.')
  }
  return {
    value: textDecoder.decode(bytes.slice(offset, offset + length)),
    offset: offset + length,
  }
}

function writePoint(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  point: GeoIndexPoint,
): number {
  offset = writeString(view, bytes, offset, point.mediaId)
  view.setUint8(offset, kindToByte(point.kind))
  offset += 1
  view.setFloat64(offset, point.lat, true)
  offset += 8
  view.setFloat64(offset, point.lon, true)
  offset += 8
  view.setFloat64(offset, optionalNumberToBinary(point.timestamp), true)
  return offset + 8
}

function readPoint(view: DataView, bytes: Uint8Array, offset: number): {
  point: GeoIndexPoint
  offset: number
} {
  const mediaId = readString(view, bytes, offset)
  offset = mediaId.offset
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
      mediaId: mediaId.value,
      kind,
      lat,
      lon,
      timestamp,
    },
    offset,
  }
}

export function encodeSegmentedKdTreeSnapshot(
  snapshot: SegmentedKdTreeSnapshot,
): ArrayBuffer {
  const totalBytes =
    HEADER_BYTES +
    snapshot.segments.reduce(
      (total, segment) => total + encodedSegmentSize(segment),
      0,
    ) +
    snapshot.pendingPoints.reduce(
      (total, point) => total + encodedPointSize(point),
      0,
    )
  const buffer = new ArrayBuffer(totalBytes)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  let offset = writeAscii(view, 0, MAGIC)
  view.setUint32(offset, FORMAT_VERSION, true)
  offset += 4
  view.setUint32(offset, snapshot.leafSize, true)
  offset += 4
  view.setUint32(offset, snapshot.segmentPointLimit, true)
  offset += 4
  view.setUint32(offset, snapshot.deltaFlushPointLimit, true)
  offset += 4
  view.setUint32(offset, snapshot.segments.length, true)
  offset += 4
  view.setUint32(offset, snapshot.pendingPoints.length, true)
  offset += 4

  for (const segment of snapshot.segments) {
    offset = writeString(view, bytes, offset, segment.id)
    view.setUint8(offset, segment.isDelta ? 1 : 0)
    offset += 1
    view.setUint32(offset, segment.pointCount, true)
    offset += 4
    view.setUint32(offset, segment.maxLeafSize, true)
    offset += 4
    view.setUint32(offset, segment.nodes.length, true)
    offset += 4
    view.setUint32(offset, segment.points.length, true)
    offset += 4

    for (const node of segment.nodes) {
      view.setInt32(offset, optionalIndexToInt(node.left), true)
      offset += 4
      view.setInt32(offset, optionalIndexToInt(node.right), true)
      offset += 4
      view.setUint32(offset, node.pointStart, true)
      offset += 4
      view.setUint32(offset, node.pointEnd, true)
      offset += 4
      view.setFloat64(offset, node.latMin, true)
      offset += 8
      view.setFloat64(offset, node.latMax, true)
      offset += 8
      view.setFloat64(offset, node.lonMin, true)
      offset += 8
      view.setFloat64(offset, node.lonMax, true)
      offset += 8
      view.setFloat64(offset, optionalNumberToBinary(node.minTimestamp), true)
      offset += 8
      view.setFloat64(offset, optionalNumberToBinary(node.maxTimestamp), true)
      offset += 8
      view.setUint8(offset, node.kindMask)
      offset += 1
    }

    for (const point of segment.points) {
      offset = writePoint(view, bytes, offset, point)
    }
  }

  for (const point of snapshot.pendingPoints) {
    offset = writePoint(view, bytes, offset, point)
  }

  return buffer
}

export function decodeSegmentedKdTreeSnapshot(
  buffer: ArrayBuffer,
): SegmentedKdTreeSnapshot {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  if (buffer.byteLength < HEADER_BYTES || readAscii(view, 0, 8) !== MAGIC) {
    throw new Error('Segmented KD-tree index data has an invalid header.')
  }

  let offset = 8
  const version = view.getUint32(offset, true)
  offset += 4
  if (version !== FORMAT_VERSION) {
    throw new Error('Segmented KD-tree index data version is unsupported.')
  }
  const leafSize = view.getUint32(offset, true)
  offset += 4
  const segmentPointLimit = view.getUint32(offset, true)
  offset += 4
  const deltaFlushPointLimit = view.getUint32(offset, true)
  offset += 4
  const segmentCount = view.getUint32(offset, true)
  offset += 4
  const pendingPointCount = view.getUint32(offset, true)
  offset += 4

  const segments: SegmentedKdTreeSnapshotSegment[] = []
  let pointCount = 0

  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const id = readString(view, bytes, offset)
    offset = id.offset
    const isDelta = view.getUint8(offset) === 1
    offset += 1
    const segmentPointCount = view.getUint32(offset, true)
    offset += 4
    const maxLeafSize = view.getUint32(offset, true)
    offset += 4
    const nodeCount = view.getUint32(offset, true)
    offset += 4
    const pointBlockCount = view.getUint32(offset, true)
    offset += 4
    const nodes: SegmentedKdTreeSnapshotSegment['nodes'] = []
    const points: GeoIndexPoint[] = []

    for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
      const left = intToOptionalIndex(view.getInt32(offset, true))
      offset += 4
      const right = intToOptionalIndex(view.getInt32(offset, true))
      offset += 4
      const pointStart = view.getUint32(offset, true)
      offset += 4
      const pointEnd = view.getUint32(offset, true)
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
      const kindMask = view.getUint8(offset)
      offset += 1
      nodes.push({
        left,
        right,
        pointStart,
        pointEnd,
        latMin,
        latMax,
        lonMin,
        lonMax,
        minTimestamp,
        maxTimestamp,
        kindMask,
      })
    }

    for (let pointIndex = 0; pointIndex < pointBlockCount; pointIndex += 1) {
      const decoded = readPoint(view, bytes, offset)
      points.push(decoded.point)
      offset = decoded.offset
    }
    pointCount += points.length
    if (points.length !== segmentPointCount) {
      throw new Error('Segmented KD-tree segment point count mismatch.')
    }
    segments.push({
      id: id.value,
      isDelta,
      pointCount: segmentPointCount,
      maxLeafSize,
      nodes,
      points,
    })
  }

  const pendingPoints: GeoIndexPoint[] = []
  for (let index = 0; index < pendingPointCount; index += 1) {
    const decoded = readPoint(view, bytes, offset)
    pendingPoints.push(decoded.point)
    offset = decoded.offset
  }
  if (offset !== buffer.byteLength) {
    throw new Error('Segmented KD-tree index data has trailing bytes.')
  }

  return {
    engineId: 'segmented-kd-tree',
    version: 1,
    leafSize,
    segmentPointLimit,
    deltaFlushPointLimit,
    pointCount: pointCount + pendingPoints.length,
    segmentCount: segments.length,
    segments,
    pendingPoints,
  }
}

export function createSegmentedKdTreeManifest(
  snapshot: SegmentedKdTreeSnapshot,
  catalogEpoch: number,
  dataChecksum: string,
): SegmentedKdTreeManifest {
  return {
    engineId: 'segmented-kd-tree',
    engineVersion: 1,
    leafSize: snapshot.leafSize,
    segmentPointLimit: snapshot.segmentPointLimit,
    deltaFlushPointLimit: snapshot.deltaFlushPointLimit,
    catalogEpoch,
    pointCount: snapshot.pointCount,
    segmentCount: snapshot.segmentCount,
    createdAt: Date.now(),
    dataChecksum,
  }
}

export function validateSegmentedKdTreeManifest(
  manifest: SegmentedKdTreeManifest,
  catalogEpoch: number,
): void {
  if (
    manifest.engineId !== 'segmented-kd-tree' ||
    manifest.engineVersion !== 1 ||
    manifest.catalogEpoch !== catalogEpoch
  ) {
    throw new Error('Segmented KD-tree index manifest does not match catalog.')
  }
}
