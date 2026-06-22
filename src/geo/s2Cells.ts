import {
  S2Cell,
  S2CellId,
  S2LatLng,
  type S1Angle,
} from 'nodes2ts'

const EARTH_RADIUS_METERS = 6_371_008.8

export const S2_CELL_INDEX_LEVEL = 15

export type S2QueuedCell = {
  id: S2CellId
  hex: string
  level: number
  lowerBoundMeters: number
}

export function s2CellIdHexForLatLon(
  lat: number,
  lon: number,
  level = S2_CELL_INDEX_LEVEL,
): string {
  const cellId = S2CellId.fromPoint(
    S2LatLng.fromDegrees(lat, lon).normalized().toPoint(),
  ).parentL(level)
  return s2CellIdToHex(cellId)
}

export function s2CellIdFromHex(hex: string): S2CellId {
  return new S2CellId(BigInt(`0x${hex}`))
}

export function s2CellIdToHex(cellId: S2CellId): string {
  return cellId.id.toString(16).padStart(16, '0')
}

export function s2RootCells(
  queryLat: number,
  queryLon: number,
): S2QueuedCell[] {
  const query = S2LatLng.fromDegrees(queryLat, queryLon).normalized()
  return Array.from({ length: S2CellId.NUM_FACES }, (_, face) =>
    s2QueuedCell(S2CellId.fromFace(face), query),
  )
}

export function s2ChildCells(
  parent: S2QueuedCell,
  queryLat: number,
  queryLon: number,
): S2QueuedCell[] {
  const query = S2LatLng.fromDegrees(queryLat, queryLon).normalized()
  const firstChild = parent.id.childBegin()
  const children: S2QueuedCell[] = []
  let child = firstChild
  for (let index = 0; index < 4; index += 1) {
    children.push(s2QueuedCell(child, query))
    child = child.next()
  }
  return children
}

function s2QueuedCell(cellId: S2CellId, query: S2LatLng): S2QueuedCell {
  return {
    id: cellId,
    hex: s2CellIdToHex(cellId),
    level: cellId.level(),
    lowerBoundMeters: s2CellLowerBoundMeters(cellId, query),
  }
}

function s2CellLowerBoundMeters(
  cellId: S2CellId,
  query: S2LatLng,
): number {
  const rect = new S2Cell(cellId).getRectBound()
  return angleToMeters(rect.getDistanceLL(query))
}

function angleToMeters(angle: S1Angle): number {
  return Math.max(0, angle.radians * EARTH_RADIUS_METERS)
}
