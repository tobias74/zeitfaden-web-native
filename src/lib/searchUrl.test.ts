import { describe, expect, it } from 'vitest'
import { buildSearchUrlParams, parseSearchUrlState } from './searchUrl'
import type { SearchUrlDefaults, SearchUrlState } from './searchUrl'

const defaults: SearchUrlDefaults = {
  resultPageSize: 100,
  selectedIndexId: 'brute-force',
  queryPoint: { lat: 47.3769, lon: 8.5417 },
}

const allowedIndexes = [
  'brute-force',
  's2-cell-btree',
  'dynamic-z-order-cells',
  'segmented-kd-tree',
  'segmented-ball-tree',
]
const allowedPageSizes = [50, 100, 250, 500]

describe('search URL state', () => {
  it('parses a complete distance search URL', () => {
    const state = parseSearchUrlState(
      '?from=2026-06-20T10%3A30&to=2026-06-21T12%3A45&sort=distance&kind=image&page=3&pageSize=250&engine=dynamic-z-order-cells&lat=48.1&lon=11.5&minLat=46&maxLat=49&minLon=7&maxLon=12',
      defaults,
      allowedIndexes,
      allowedPageSizes,
    )

    expect(state).toEqual({
      startDate: '2026-06-20T10:30',
      endDate: '2026-06-21T12:45',
      sort: 'distance',
      kindFilter: 'image',
      resultPage: 2,
      resultPageSize: 250,
      selectedIndexId: 'dynamic-z-order-cells',
      queryPoint: { lat: 48.1, lon: 11.5 },
      geoBounds: {
        minLat: 46,
        maxLat: 49,
        minLon: 7,
        maxLon: 12,
      },
    })
  })

  it('normalizes invalid and reversed values to safe defaults', () => {
    const state = parseSearchUrlState(
      '?sort=nope&kind=audio&page=-2&pageSize=999&engine=missing&lat=999&lon=-999&minLat=20&maxLat=10&minLon=30&maxLon=25',
      defaults,
      allowedIndexes,
      allowedPageSizes,
    )

    expect(state.sort).toBe('timestamp_desc')
    expect(state.kindFilter).toBe('all')
    expect(state.resultPage).toBe(0)
    expect(state.resultPageSize).toBe(100)
    expect(state.selectedIndexId).toBe('brute-force')
    expect(state.queryPoint).toEqual({ lat: 90, lon: -180 })
    expect(state.geoBounds).toEqual({
      minLat: 10,
      maxLat: 20,
      minLon: 25,
      maxLon: 30,
    })
  })

  it('serializes only non-default search values', () => {
    const state: SearchUrlState = {
      startDate: '',
      endDate: '2026-06-21T12:45',
      sort: 'timestamp_asc',
      kindFilter: 'video',
      resultPage: 1,
      resultPageSize: 50,
      selectedIndexId: 'brute-force',
      queryPoint: defaults.queryPoint,
      geoBounds: {
        minLat: 46.1234567,
        maxLat: 49,
        minLon: 7,
        maxLon: 12,
      },
    }

    expect(buildSearchUrlParams(state, defaults).toString()).toBe(
      'to=2026-06-21T12%3A45&sort=timestamp_asc&kind=video&page=2&pageSize=50&minLat=46.123457&maxLat=49&minLon=7&maxLon=12',
    )
  })

  it('serializes the distance point but not the legacy engine parameter', () => {
    const state: SearchUrlState = {
      startDate: '',
      endDate: '',
      sort: 'distance',
      kindFilter: 'all',
      resultPage: 0,
      resultPageSize: 100,
      selectedIndexId: 'dynamic-z-order-cells',
      queryPoint: { lat: 48.1, lon: 11.5 },
    }

    expect(buildSearchUrlParams(state, defaults).toString()).toBe(
      'sort=distance&lat=48.1&lon=11.5',
    )

    expect(
      buildSearchUrlParams(
        { ...state, sort: 'timestamp_desc' },
        defaults,
    ).toString(),
    ).toBe('')
  })

  it('round-trips geo point kind filters', () => {
    const state = parseSearchUrlState(
      '?kind=geo_point',
      defaults,
      allowedIndexes,
      allowedPageSizes,
    )

    expect(state.kindFilter).toBe('geo_point')
    expect(buildSearchUrlParams(state, defaults).get('kind')).toBe('geo_point')
  })

  it('round-trips the all media kind filter', () => {
    const state = parseSearchUrlState(
      '?kind=media',
      defaults,
      allowedIndexes,
      allowedPageSizes,
    )

    expect(state.kindFilter).toBe('media')
    expect(buildSearchUrlParams(state, defaults).get('kind')).toBe('media')
  })

  it('parses the legacy S2 engine URL parameter', () => {
    const state = parseSearchUrlState(
      '?sort=distance&engine=s2-cell-btree',
      defaults,
      allowedIndexes,
      allowedPageSizes,
    )

    expect(state.selectedIndexId).toBe('s2-cell-btree')
  })
})
