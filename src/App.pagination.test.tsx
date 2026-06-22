import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogBackend, CatalogInfo, PlatformBackend } from './platform/types'
import type { MediaItem, SearchPage, SearchSpec } from './types'

vi.mock('./components/MapView', () => ({
  MapView: () => <div data-testid="map-view" />,
}))

vi.mock('./components/Thumbnail', () => ({
  Thumbnail: ({ label }: { label: string }) => (
    <div data-testid="thumbnail">{label}</div>
  ),
}))

vi.mock('./components/MediaViewer', () => ({
  MediaViewer: () => <div data-testid="media-viewer" />,
}))

let searchMediaCalls: SearchSpec[]

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
      engineId: 'sqlite-timestamp',
      engineLabel: 'SQLite timestamp B-tree',
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
    engineId: 'sqlite-timestamp',
    engineLabel: 'SQLite timestamp B-tree',
    limitReached,
  }
}

function createPlatform(): PlatformBackend {
  searchMediaCalls = []
  const catalog: CatalogBackend = {
    init: vi.fn(async (): Promise<CatalogInfo> => ({
      storageMode: 'opfs',
      sqliteVersion: 'test',
      filename: ':memory:',
    })),
    upsertSource: vi.fn(),
    upsertMedia: vi.fn(),
    searchMedia: async (spec) => {
      searchMediaCalls.push(spec)
      return createSearchPage(
        createItems(spec.offset ?? 0, spec.limit ?? 100),
        spec.purpose === 'results',
      )
    },
    buildSearchIndexes: vi.fn(async () => ({
      pointCount: 0,
      buildTimeMs: 0,
      engineCount: 5,
    })),
    rebuildSearchIndex: vi.fn(async () => ({
      pointCount: 0,
      buildTimeMs: 0,
      engineCount: 5,
    })),
    getSearchIndexStats: vi.fn(async () => [
      {
        engineId: 'sqlite-timestamp',
        engineLabel: 'SQLite timestamp B-tree',
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
    listSources: vi.fn(async () => []),
    removeSources: vi.fn(),
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
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads and renders the next catalog page when pagination changes', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)

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

  it('passes the explain setting into catalog search specs', async () => {
    const { default: App } = await import('./App')

    render(<App />)

    expect(await screen.findAllByText('item-0.jpg')).not.toHaveLength(0)

    fireEvent.click(screen.getByText('Settings'))
    fireEvent.click(screen.getByLabelText('Explain SQLite queries'))

    await waitFor(() => {
      expect(
        searchMediaCalls.some(
          (query) =>
            query.purpose === 'results' &&
            query.diagnostics?.explainSql === true,
        ),
      ).toBe(true)
    })
  })
})
