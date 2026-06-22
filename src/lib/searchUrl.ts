import type { CatalogSort, GeoBounds, KindFilter } from '../types'

export type SearchSortMode = CatalogSort | 'distance'

export type QueryPoint = {
  lat: number
  lon: number
}

export type SearchUrlState = {
  startDate: string
  endDate: string
  sort: SearchSortMode
  kindFilter: KindFilter
  geoBounds?: GeoBounds
  resultPage: number
  resultPageSize: number
  selectedIndexId: string
  queryPoint: QueryPoint
}

export type SearchUrlDefaults = {
  resultPageSize: number
  selectedIndexId: string
  queryPoint: QueryPoint
}

const dateInputPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/

function finiteNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function positiveInteger(value: string | null): number | undefined {
  const number = finiteNumber(value)
  if (number === undefined) return undefined
  const integer = Math.trunc(number)
  return integer > 0 ? integer : undefined
}

function dateInput(value: string | null): string {
  return value && dateInputPattern.test(value) ? value : ''
}

function sortMode(value: string | null): SearchSortMode {
  if (
    value === 'timestamp_asc' ||
    value === 'timestamp_desc' ||
    value === 'distance'
  ) {
    return value
  }
  return 'timestamp_desc'
}

function kindFilter(value: string | null): KindFilter {
  if (
    value === 'image' ||
    value === 'video' ||
    value === 'geo_point' ||
    value === 'media'
  ) {
    return value
  }
  return 'all'
}

function clampedLatitude(value: number): number {
  return Math.min(90, Math.max(-90, value))
}

function clampedLongitude(value: number): number {
  return Math.min(180, Math.max(-180, value))
}

function geoBounds(params: URLSearchParams): GeoBounds | undefined {
  const minLat = finiteNumber(params.get('minLat'))
  const maxLat = finiteNumber(params.get('maxLat'))
  const minLon = finiteNumber(params.get('minLon'))
  const maxLon = finiteNumber(params.get('maxLon'))

  if (
    minLat === undefined ||
    maxLat === undefined ||
    minLon === undefined ||
    maxLon === undefined
  ) {
    return undefined
  }

  return {
    minLat: clampedLatitude(Math.min(minLat, maxLat)),
    maxLat: clampedLatitude(Math.max(minLat, maxLat)),
    minLon: clampedLongitude(Math.min(minLon, maxLon)),
    maxLon: clampedLongitude(Math.max(minLon, maxLon)),
  }
}

function queryPoint(
  params: URLSearchParams,
  fallback: QueryPoint,
): QueryPoint {
  const lat = finiteNumber(params.get('lat'))
  const lon = finiteNumber(params.get('lon'))

  if (lat === undefined || lon === undefined) return fallback

  return {
    lat: clampedLatitude(lat),
    lon: clampedLongitude(lon),
  }
}

function selectedIndexId(
  params: URLSearchParams,
  fallback: string,
  allowedIndexIds: readonly string[],
): string {
  const value = params.get('engine')
  return value && allowedIndexIds.includes(value) ? value : fallback
}

function compactNumber(value: number): string {
  return value.toFixed(6).replace(/\.?0+$/, '')
}

function setNumberParam(
  params: URLSearchParams,
  key: string,
  value: number,
): void {
  params.set(key, compactNumber(value))
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.000001
}

export function parseSearchUrlState(
  search: string | URLSearchParams,
  defaults: SearchUrlDefaults,
  allowedIndexIds: readonly string[],
  allowedPageSizes: readonly number[],
): SearchUrlState {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search
  const pageSize =
    positiveInteger(params.get('pageSize')) ?? defaults.resultPageSize
  const normalizedPageSize = allowedPageSizes.includes(pageSize)
    ? pageSize
    : defaults.resultPageSize
  const page = positiveInteger(params.get('page')) ?? 1

  return {
    startDate: dateInput(params.get('from')),
    endDate: dateInput(params.get('to')),
    sort: sortMode(params.get('sort')),
    kindFilter: kindFilter(params.get('kind')),
    geoBounds: geoBounds(params),
    resultPage: page - 1,
    resultPageSize: normalizedPageSize,
    selectedIndexId: selectedIndexId(
      params,
      defaults.selectedIndexId,
      allowedIndexIds,
    ),
    queryPoint: queryPoint(params, defaults.queryPoint),
  }
}

export function buildSearchUrlParams(
  state: SearchUrlState,
  defaults: SearchUrlDefaults,
): URLSearchParams {
  const params = new URLSearchParams()

  if (state.startDate) params.set('from', state.startDate)
  if (state.endDate) params.set('to', state.endDate)
  if (state.sort !== 'timestamp_desc') params.set('sort', state.sort)
  if (state.kindFilter !== 'all') params.set('kind', state.kindFilter)
  if (state.resultPage > 0) params.set('page', String(state.resultPage + 1))
  if (state.resultPageSize !== defaults.resultPageSize) {
    params.set('pageSize', String(state.resultPageSize))
  }
  if (
    state.sort === 'distance' &&
    state.selectedIndexId !== defaults.selectedIndexId
  ) {
    params.set('engine', state.selectedIndexId)
  }
  if (
    state.sort === 'distance' &&
    (!sameNumber(state.queryPoint.lat, defaults.queryPoint.lat) ||
      !sameNumber(state.queryPoint.lon, defaults.queryPoint.lon))
  ) {
    setNumberParam(params, 'lat', state.queryPoint.lat)
    setNumberParam(params, 'lon', state.queryPoint.lon)
  }
  if (state.geoBounds) {
    setNumberParam(params, 'minLat', state.geoBounds.minLat)
    setNumberParam(params, 'maxLat', state.geoBounds.maxLat)
    setNumberParam(params, 'minLon', state.geoBounds.minLon)
    setNumberParam(params, 'maxLon', state.geoBounds.maxLon)
  }

  return params
}
