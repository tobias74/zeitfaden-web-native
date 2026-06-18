import type { GeoIndexPoint, GeoSearchQuery } from '../types'

const EARTH_RADIUS_METERS = 6_371_008.8

const toRadians = (degrees: number) => (degrees * Math.PI) / 180

export function haversineMeters(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const lat1 = toRadians(aLat)
  const lat2 = toRadians(bLat)
  const deltaLat = toRadians(bLat - aLat)
  const deltaLon = toRadians(bLon - aLon)

  const sinLat = Math.sin(deltaLat / 2)
  const sinLon = Math.sin(deltaLon / 2)
  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function distanceToQueryMeters(
  point: GeoIndexPoint,
  query: Pick<GeoSearchQuery, 'lat' | 'lon'>,
): number {
  return haversineMeters(point.lat, point.lon, query.lat, query.lon)
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return 'n/a'
  if (meters < 1_000) return `${Math.round(meters)} m`
  if (meters < 100_000) return `${(meters / 1_000).toFixed(2)} km`
  return `${Math.round(meters / 1_000).toLocaleString()} km`
}

