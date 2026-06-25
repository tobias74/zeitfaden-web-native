import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dateInputEndToMillis, dateInputToMillis } from './lib/time'
import type { CatalogBackend, CatalogInfo, PlatformBackend } from './platform/types'
import type { MediaItem, SearchPage, SearchSpec } from './types'

vi.mock('./components/MapView', async () => {
  const React = await import('react')

  return {
    MapView: ({
      onQueryPointChange,
      onVisibleBoundsChange,
    }: {
      onQueryPointChange?: (point: { lat: number; lon: number }) => void
      onVisibleBoundsChange?: (bounds: {
        minLat: number
        maxLat: number
        minLon: number
        maxLon: number
      }) => void
    }) => {
      React.useEffect(() => {
        onVisibleBoundsChange?.({
          minLat: 47,
          maxLat: 48,
          minLon: 8,
          maxLon: 9,
        })
      }, [onVisibleBoundsChange])

      return (
        <>
          <button
            type="button"
            data-testid="map-view"
            onClick={() =>
              onVisibleBoundsChange?.({
                minLat: 49,
                maxLat: 50,
                minLon: 10,
                maxLon: 11,
              })
            }
          />
          <button
            type="button"
            data-testid="map-query-point"
            onClick={() =>
              onQueryPointChange?.({
                lat: 52,
                lon: 13,
              })
            }
          />
        </>
      )
    },
  }
})

vi.mock('./components/Thumbnail', () => ({
  Thumbnail: ({ label }: { label: string }) => (
    <div data-testid="thumbnail">{label}</div>
  ),
}))

vi.mock('./components/MediaViewer', () => ({
  MediaViewer: () => <div data-testid="media-viewer" />,
}))

let searchMediaCalls: SearchSpec[]
let searchMapPointCalls: SearchSpec[]
let resultSearchDelay: Promise<void> | undefined
let resultSearchSignals: AbortSignal[]
let mapSearchDelay: Promise<void> | undefined
let mapSearchSignals: AbortSignal[]

function abortError(): Error {
  const error = new Error('Catalog request aborted')
  error.name = 'AbortError'
  return error
}

function item(id: number): MediaItem {
  return {
    id: `item-${id}`,
    contentHash: `item-${id}`,
    sourceId: 'source-1',
    relativePath: `item-${id}.jpg`,
    displayName: `item-${id}.jpg`,
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 1,
    timestamp: 1_000_000 - id,
    locations: [
      {
        id: `location-${id}`,
        sourceId: 'source-1',
        sourceLabel: 'Source 1',
        relativePath: `item-${id}.jpg`,
      },
    ],
  }
}

function createItems(offset: number, limit: number): MediaItem[] {
  return Array.from({ length: limit }, (_, index) => item(offset + index))
}

function createSearchPage(items: MediaItem[], limitReached = false): SearchPage {
  return {
    items: items.map((mediaItem) => ({
      mediaId: mediaItem.id,
      item: mediaItem,
    })),
    resultMetrics: {
      engineId: 'file-time-geo',
      engineLabel: 'Time-first packed index',
      exact: true,
      persistent: true,
      pointCount: 0,
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    },
    engineId: 'file-time-geo',
    engineLabel: 'Time-first packed index',
    limitReached,
  }
}

function createMapPoints(offset: number, limit: number) {
  return Array.from({ length: limit }, (_, index) => ({
    assetId: offset + index,
    kind: 'image' as const,
    lat: 47 + index / 1000,
    lon: 8 + index / 1000,
    timestamp: 1_000_000 - index,
  }))
}

function createPlatform(): PlatformBackend {
  searchMediaCalls = []
  searchMapPointCalls = []
  const catalog: CatalogBackend = {
    init: vi.fn(async (): Promise<CatalogInfo> => ({
      storageMode: 'file',
      filename: 'test-catalog',
    })),
    upsertSource: vi.fn(),
    upsertMedia: vi.fn(),
    searchMedia: async (spec, options) => {
      searchMediaCalls.push(spec)
      if (options?.signal) {
        resultSearchSignals.push(options.signal)
      }
      if (resultSearchDelay && spec.purpose === 'results') {
        if (options?.signal?.aborted) throw abortError()
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            reject(abortError())
          }
          options?.signal?.addEventListener('abort', abort, { once: true })
          resultSearchDelay
            ?.then(resolve, reject)
            .finally(() => {
              options?.signal?.removeEventListener('abort', abort)
            })
        })
      }
      return createSearchPage(
        createItems(spec.offset ?? 0, spec.limit ?? 100),
        spec.purpose === 'results',
      )
    },
    searchMapPoints: async (spec, options) => {
      searchMapPointCalls.push(spec)
      if (options?.signal) {
        mapSearchSignals.push(options.signal)
      }
      if (mapSearchDelay) {
        if (options?.signal?.aborted) throw abortError()
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            reject(abortError())
          }
          options?.signal?.addEventListener('abort', abort, { once: true })
          mapSearchDelay
            ?.then(resolve, reject)
            .finally(() => {
              options?.signal?.removeEventListener('abort', abort)
            })
        })
      }
      return {
        points: createMapPoints(spec.offset ?? 0, spec.limit ?? 100),
        limitReached: false,
      }
    },
    buildSearchIndexes: vi.fn(async () => ({
      pointCount: 0,
      buildTimeMs: 0,
      engineCount: 4,
    })),
    rebuildSearchIndex: vi.fn(async () => ({
      pointCount: 0,
      buildTimeMs: 0,
      engineCount: 4,
    })),
    getSearchIndexStats: vi.fn(async () => [
      {
        engineId: 'file-time-geo',
        engineLabel: 'Time-first packed index',
        exact: true,
        persistent: true,
        pointCount: 0,
        distanceComputations: 0,
        nodesVisited: 0,
        pagesRead: 0,
        candidatesInspected: 0,
        prunedByGeo: 0,
        prunedByTime: 0,
      },
    ]),
    listMedia: async (query) => {
      return createItems(query.offset ?? 0, query.limit ?? 100)
    },
    getMediaByIds: vi.fn(),
    getGeoPoints: vi.fn(),
    countMedia: vi.fn(),
    buildGeoIndexes: vi.fn(async () => ({
      pointCount: 0,
      buildTimeMs: 0,
    })),
    searchGeoIndex: vi.fn(),
    getGeoIndexStats: vi.fn(async () => ({
      engineId: 'brute-force',
      pointCount: 0,
      distanceComputations: 0,
      nodesVisited: 0,
      pagesRead: 0,
      candidatesInspected: 0,
      prunedByGeo: 0,
      prunedByTime: 0,
    })),
    validateGeoIndex: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  }

  return {
    kind: 'web',
    capabilities: {
      absolutePaths: false,
      persistentFileHandles: true,
      nativeThumbnails: false,
      nativeCatalog: false,
    },
    catalog,
    importer: {
      importFolder: vi.fn(),
      importGeoFile: vi.fn(),
      commitImport: vi.fn(),
      dispose: vi.fn(),
    },
    thumbnails: {
      resolveThumbnailUrl: vi.fn(),
      revokeThumbnailUrl: vi.fn(),
    },
    files: {
      resolveOriginalUrl: vi.fn(),
      revokeOriginalUrl: vi.fn(),
      revealLocation: vi.fn(),
    },
    dispose: vi.fn(),
  }
}

vi.mock('./platform', () => ({
  createPlatformBackend: vi.fn(() => createPlatform()),
}))

describe('App pagination', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/')
    resultSearchDelay = undefined
    resultSearchSignals = []
    mapSearchDelay = undefined
    mapSearchSignals = []
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads and renders the next catalog page when pagination changes', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)
    await waitFor(() => {
      expect(
        searchMapPointCalls.some(
          (query) =>
            query.purpose === 'map' &&
            query.limit === 5000 &&
            query.geoBounds?.minLat === 47 &&
            query.geoBounds.maxLat === 48 &&
            query.geoBounds.minLon === 8 &&
            query.geoBounds.maxLon === 9,
        ),
      ).toBe(true)
      expect(searchMediaCalls.some((query) => query.purpose === 'map')).toBe(
        false,
      )
    })

    fireEvent.click(screen.getByTitle('Next page'))

    await waitFor(() => {
      expect(window.location.search).toBe('?page=2')
      expect(
        searchMediaCalls.some(
          (query) =>
            query.purpose === 'results' &&
            query.limit === 100 &&
            query.offset === 100,
        ),
      ).toBe(true)
      expect(screen.getAllByText('item-100.jpg')).not.toHaveLength(0)
    })
  })

  it('shows a map loading strip while map events are loading', async () => {
    let releaseMapSearch!: () => void
    mapSearchDelay = new Promise((resolve) => {
      releaseMapSearch = resolve
    })
    const { default: App } = await import('./App')

    const { container } = render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)
    await waitFor(() => {
      expect(container.querySelector('.map-loading-strip')).not.toBeNull()
    })

    releaseMapSearch()

    await waitFor(() => {
      expect(container.querySelector('.map-loading-strip')).toBeNull()
    })
  })

  it('uses the configured map bubble limit for map searches', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)

    fireEvent.change(screen.getByLabelText('Map bubble limit'), {
      target: { value: '10000' },
    })

    await waitFor(() => {
      expect(window.localStorage.getItem('geo-media-index-lab:map-point-limit'))
        .toBe('10000')
      expect(
        searchMapPointCalls.some(
          (query) => query.purpose === 'map' && query.limit === 10_000,
        ),
      ).toBe(true)
    })
  })

  it('aborts the previous map search when the map moves again', async () => {
    let releaseMapSearch!: () => void
    mapSearchDelay = new Promise((resolve) => {
      releaseMapSearch = resolve
    })
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)
    await waitFor(() => {
      expect(mapSearchSignals).toHaveLength(1)
    })

    fireEvent.click(screen.getByTestId('map-view'))

    await waitFor(() => {
      expect(mapSearchSignals[0].aborted).toBe(true)
      expect(mapSearchSignals).toHaveLength(2)
      expect(
        searchMapPointCalls.some(
          (query) =>
            query.purpose === 'map' &&
            query.geoBounds?.minLat === 49 &&
            query.geoBounds.maxLat === 50 &&
            query.geoBounds.minLon === 10 &&
            query.geoBounds.maxLon === 11,
        ),
      ).toBe(true)
    })

    releaseMapSearch()
  })

  it('aborts the previous result search when query parameters change', async () => {
    let releaseResultSearch!: () => void
    resultSearchDelay = new Promise((resolve) => {
      releaseResultSearch = resolve
    })
    const { default: App } = await import('./App')

    render(<App />)

    await waitFor(() => {
      expect(resultSearchSignals).toHaveLength(1)
    })

    fireEvent.change(screen.getByLabelText('Kind'), {
      target: { value: 'video' },
    })

    await waitFor(() => {
      expect(resultSearchSignals[0].aborted).toBe(true)
      expect(resultSearchSignals).toHaveLength(2)
    })

    releaseResultSearch()
  })

  it('does not refetch map points when only the distance query point changes', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)
    await waitFor(() => {
      expect(
        searchMapPointCalls.some((query) => query.purpose === 'map'),
      ).toBe(true)
    })

    const callsBeforeDistancePointChange = searchMapPointCalls.length
    fireEvent.change(screen.getByLabelText('Sort'), {
      target: { value: 'distance' },
    })
    fireEvent.click(screen.getByTestId('map-query-point'))

    await waitFor(() => {
      expect(
        searchMediaCalls.some(
          (query) =>
            query.purpose === 'results' &&
            query.order.kind === 'distance' &&
            query.order.point.lat === 52 &&
            query.order.point.lon === 13,
        ),
      ).toBe(true)
    })
    expect(searchMapPointCalls).toHaveLength(callsBeforeDistancePointChange)
  })

  it('applies the query time range and kind filter to map searches', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)

    fireEvent.change(screen.getByLabelText('From'), {
      target: { value: '2020-01-02T03:04' },
    })
    fireEvent.change(screen.getByLabelText('To'), {
      target: { value: '2020-01-03T04:05' },
    })
    fireEvent.change(screen.getByLabelText('Kind'), {
      target: { value: 'video' },
    })

    await waitFor(() => {
      expect(
        searchMapPointCalls.some(
          (query) =>
            query.purpose === 'map' &&
            query.kind === 'video' &&
            query.startTime === dateInputToMillis('2020-01-02T03:04') &&
            query.endTime === dateInputEndToMillis('2020-01-03T04:05') &&
            query.geoBounds?.minLat === 47 &&
            query.geoBounds.maxLat === 48 &&
            query.geoBounds.minLon === 8 &&
            query.geoBounds.maxLon === 9,
        ),
      ).toBe(true)
    })
  })

})
