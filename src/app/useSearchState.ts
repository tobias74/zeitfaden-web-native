import {
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  buildSearchUrlParams,
  parseSearchUrlState,
  type QueryPoint,
  type SearchSortMode,
  type SearchUrlDefaults,
  type SearchUrlState,
} from '../lib/searchUrl'
import { dateInputEndToMillis, dateInputToMillis } from '../lib/time'
import type {
  CatalogQuery,
  CatalogSort,
  GeoBounds,
  KindFilter,
  TimeRange,
} from '../types'

export type { QueryPoint, SearchSortMode }

export type UseSearchStateOptions = {
  allowedIndexIds: readonly string[]
  defaultSelectedIndexId: string
  defaultQueryPoint: QueryPoint
  defaultResultPageSize: number
  allowedPageSizes: readonly number[]
  pageSizeStorageKey: string
  mapPointLimit: number
}

export type SearchStateValues = {
  selectedIndexId: string
  queryPoint: QueryPoint
  startDate: string
  endDate: string
  sort: SearchSortMode
  kindFilter: KindFilter
  geoBounds?: GeoBounds
  boundsDrawing: boolean
  resultPage: number
  resultPageSize: number
  distanceSortActive: boolean
  catalogSort: CatalogSort
  resultOffset: number
  timeRange: TimeRange
  catalogQuery: CatalogQuery
  mapCatalogQuery: CatalogQuery
  searchUrlState: SearchUrlState
  searchUrlDefaults: SearchUrlDefaults
  appHref: string
}

export type SearchStateActions = {
  setSelectedIndexId(indexId: string): void
  setQueryPoint(point: QueryPoint): void
  setStartDate(value: string): void
  setEndDate(value: string): void
  setSort(sort: SearchSortMode): void
  setKindFilter(kind: KindFilter): void
  setGeoBounds(bounds: GeoBounds): void
  clearGeoBounds(): void
  toggleBoundsDrawing(): void
  setPage(page: SetStateAction<number>): void
  setPageSize(size: number): void
  clearSearch(): void
}

function storedNumber(key: string, fallback: number): number {
  const stored = window.localStorage.getItem(key)
  if (stored === null || stored.trim() === '') return fallback

  const value = Number(stored)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function storedPageSize(
  storageKey: string,
  defaultPageSize: number,
  allowedPageSizes: readonly number[],
): number {
  const stored = storedNumber(storageKey, defaultPageSize)
  return allowedPageSizes.includes(stored) ? stored : defaultPageSize
}

function timeRangeFromInputs(startDate: string, endDate: string): TimeRange {
  return {
    startTime: dateInputToMillis(startDate),
    endTime: dateInputEndToMillis(endDate),
  }
}

function pathWithSearchParams(params: URLSearchParams): string {
  const search = params.toString()
  return `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
}

function clampPage(page: number): number {
  return Math.max(0, Math.trunc(page))
}

export function useSearchState(options: UseSearchStateOptions): {
  values: SearchStateValues
  actions: SearchStateActions
} {
  const searchUrlDefaults = useMemo<SearchUrlDefaults>(
    () => ({
      resultPageSize: options.defaultResultPageSize,
      selectedIndexId: options.defaultSelectedIndexId,
      queryPoint: options.defaultQueryPoint,
    }),
    [
      options.defaultQueryPoint,
      options.defaultResultPageSize,
      options.defaultSelectedIndexId,
    ],
  )
  const initialSearchUrlDefaults = useMemo<SearchUrlDefaults>(
    () => ({
      ...searchUrlDefaults,
      resultPageSize: storedPageSize(
        options.pageSizeStorageKey,
        options.defaultResultPageSize,
        options.allowedPageSizes,
      ),
    }),
    [
      options.allowedPageSizes,
      options.defaultResultPageSize,
      options.pageSizeStorageKey,
      searchUrlDefaults,
    ],
  )
  const initialSearchState = useMemo(
    () =>
      parseSearchUrlState(
        window.location.search,
        initialSearchUrlDefaults,
        options.allowedIndexIds,
        options.allowedPageSizes,
      ),
    [
      initialSearchUrlDefaults,
      options.allowedIndexIds,
      options.allowedPageSizes,
    ],
  )

  const [selectedIndexId, setSelectedIndexIdState] = useState(
    initialSearchState.selectedIndexId,
  )
  const [queryPoint, setQueryPointState] = useState<QueryPoint>(
    initialSearchState.queryPoint,
  )
  const [startDate, setStartDateState] = useState(initialSearchState.startDate)
  const [endDate, setEndDateState] = useState(initialSearchState.endDate)
  const [sort, setSortState] = useState<SearchSortMode>(
    initialSearchState.sort,
  )
  const [kindFilter, setKindFilterState] = useState<KindFilter>(
    initialSearchState.kindFilter,
  )
  const [geoBounds, setGeoBoundsState] = useState<GeoBounds | undefined>(
    initialSearchState.geoBounds,
  )
  const [boundsDrawing, setBoundsDrawing] = useState(false)
  const [resultPage, setResultPageState] = useState(
    initialSearchState.resultPage,
  )
  const [resultPageSize, setResultPageSizeState] = useState(
    initialSearchState.resultPageSize,
  )
  const hasSyncedSearchUrlRef = useRef(false)
  const applyingPopStateRef = useRef(false)

  const resetPage = useCallback(() => {
    setResultPageState(0)
  }, [])

  const setSelectedIndexId = useCallback((indexId: string) => {
    setSelectedIndexIdState(indexId)
    resetPage()
  }, [resetPage])

  const setQueryPoint = useCallback((point: QueryPoint) => {
    setQueryPointState(point)
    resetPage()
  }, [resetPage])

  const setStartDate = useCallback((value: string) => {
    setStartDateState(value)
    resetPage()
  }, [resetPage])

  const setEndDate = useCallback((value: string) => {
    setEndDateState(value)
    resetPage()
  }, [resetPage])

  const setSort = useCallback((nextSort: SearchSortMode) => {
    setSortState(nextSort)
    resetPage()
    if (nextSort === 'distance') {
      setBoundsDrawing(false)
    }
  }, [resetPage])

  const setKindFilter = useCallback((kind: KindFilter) => {
    setKindFilterState(kind)
    resetPage()
  }, [resetPage])

  const setGeoBounds = useCallback((bounds: GeoBounds) => {
    setGeoBoundsState(bounds)
    setBoundsDrawing(false)
    resetPage()
  }, [resetPage])

  const clearGeoBounds = useCallback(() => {
    setGeoBoundsState(undefined)
    setBoundsDrawing(false)
    resetPage()
  }, [resetPage])

  const toggleBoundsDrawing = useCallback(() => {
    setBoundsDrawing((active) => !active)
  }, [])

  const setPage = useCallback((page: SetStateAction<number>) => {
    setResultPageState((current) =>
      clampPage(typeof page === 'function' ? page(current) : page),
    )
  }, [])

  const setPageSize = useCallback((size: number) => {
    const nextSize = options.allowedPageSizes.includes(size)
      ? size
      : options.defaultResultPageSize
    setResultPageSizeState(nextSize)
    window.localStorage.setItem(options.pageSizeStorageKey, String(nextSize))
    resetPage()
  }, [
    options.allowedPageSizes,
    options.defaultResultPageSize,
    options.pageSizeStorageKey,
    resetPage,
  ])

  const clearSearch = useCallback(() => {
    setStartDateState('')
    setEndDateState('')
    setSortState('captured_at_desc')
    setKindFilterState('all')
    setGeoBoundsState(undefined)
    setBoundsDrawing(false)
    resetPage()
  }, [resetPage])

  const timeRange = useMemo(
    () => timeRangeFromInputs(startDate, endDate),
    [endDate, startDate],
  )
  const distanceSortActive = sort === 'distance'
  const catalogSort: CatalogSort =
    sort === 'distance' ? 'captured_at_desc' : sort
  const resultOffset = resultPage * resultPageSize

  const catalogQuery = useMemo<CatalogQuery>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      geoBounds,
      sort: catalogSort,
      limit: resultPageSize,
      offset: resultOffset,
    }),
    [
      catalogSort,
      geoBounds,
      kindFilter,
      resultOffset,
      resultPageSize,
      timeRange,
    ],
  )
  const mapCatalogQuery = useMemo<CatalogQuery>(
    () => ({
      ...timeRange,
      kind: kindFilter,
      hasGeo: true,
      sort: catalogSort,
      limit: options.mapPointLimit + 1,
      offset: 0,
    }),
    [catalogSort, kindFilter, options.mapPointLimit, timeRange],
  )
  const searchUrlState = useMemo<SearchUrlState>(
    () => ({
      startDate,
      endDate,
      sort,
      kindFilter,
      geoBounds,
      resultPage,
      resultPageSize,
      selectedIndexId,
      queryPoint,
    }),
    [
      endDate,
      geoBounds,
      kindFilter,
      queryPoint,
      resultPage,
      resultPageSize,
      selectedIndexId,
      sort,
      startDate,
    ],
  )
  const appHref = useMemo(
    () => pathWithSearchParams(buildSearchUrlParams(searchUrlState, searchUrlDefaults)),
    [searchUrlDefaults, searchUrlState],
  )

  const applySearchUrlState = useCallback((nextState: SearchUrlState) => {
    setSelectedIndexIdState(nextState.selectedIndexId)
    setQueryPointState(nextState.queryPoint)
    setStartDateState(nextState.startDate)
    setEndDateState(nextState.endDate)
    setSortState(nextState.sort)
    setKindFilterState(nextState.kindFilter)
    setGeoBoundsState(nextState.geoBounds)
    setBoundsDrawing(false)
    setResultPageState(clampPage(nextState.resultPage))
    setResultPageSizeState(nextState.resultPageSize)
  }, [])

  useEffect(() => {
    const params = buildSearchUrlParams(searchUrlState, searchUrlDefaults)
    const nextUrl = pathWithSearchParams(params)
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`

    if (nextUrl === currentUrl) {
      hasSyncedSearchUrlRef.current = true
      applyingPopStateRef.current = false
      return
    }

    if (applyingPopStateRef.current) {
      applyingPopStateRef.current = false
      hasSyncedSearchUrlRef.current = true
      return
    }

    const method = hasSyncedSearchUrlRef.current ? 'pushState' : 'replaceState'
    window.history[method](null, '', nextUrl)
    hasSyncedSearchUrlRef.current = true
  }, [searchUrlDefaults, searchUrlState])

  useEffect(() => {
    function onPopState() {
      applyingPopStateRef.current = true
      applySearchUrlState(
        parseSearchUrlState(
          window.location.search,
          initialSearchUrlDefaults,
          options.allowedIndexIds,
          options.allowedPageSizes,
        ),
      )
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [
    applySearchUrlState,
    initialSearchUrlDefaults,
    options.allowedIndexIds,
    options.allowedPageSizes,
  ])

  return {
    values: {
      selectedIndexId,
      queryPoint,
      startDate,
      endDate,
      sort,
      kindFilter,
      geoBounds,
      boundsDrawing,
      resultPage,
      resultPageSize,
      distanceSortActive,
      catalogSort,
      resultOffset,
      timeRange,
      catalogQuery,
      mapCatalogQuery,
      searchUrlState,
      searchUrlDefaults,
      appHref,
    },
    actions: {
      setSelectedIndexId,
      setQueryPoint,
      setStartDate,
      setEndDate,
      setSort,
      setKindFilter,
      setGeoBounds,
      clearGeoBounds,
      toggleBoundsDrawing,
      setPage,
      setPageSize,
      clearSearch,
    },
  }
}
