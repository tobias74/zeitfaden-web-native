import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGeoIndexes } from './useGeoIndexes'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import type { SearchIndexStats } from '../types'

const catalogInfo: CatalogInfo = {
  storageMode: 'opfs',
  sqliteVersion: 'test',
  filename: ':memory:',
}

const stats: SearchIndexStats = {
  engineId: 'brute-force',
  engineLabel: 'Brute force oracle',
  exact: true,
  persistent: true,
  pointCount: 0,
  distanceComputations: 0,
  nodesVisited: 0,
  pagesRead: 0,
  candidatesInspected: 0,
  prunedByGeo: 0,
  prunedByTime: 0,
}

function createCatalog(): CatalogBackend {
  return {
    init: vi.fn(),
    upsertSource: vi.fn(),
    upsertMedia: vi.fn(),
    searchMedia: vi.fn(),
    buildSearchIndexes: vi.fn(async () => ({
      pointCount: 123,
      buildTimeMs: 1,
      engineCount: 4,
    })),
    getSearchIndexStats: vi.fn(async () => [
      stats,
      {
        ...stats,
        engineId: 'dynamic-z-order-cells',
        engineLabel: 'Dynamic Z-order cells',
      },
    ]),
    listMedia: vi.fn(),
    getMediaByIds: vi.fn(),
    getGeoPoints: vi.fn(),
    listSources: vi.fn(),
    removeSources: vi.fn(),
    countMedia: vi.fn(),
    buildGeoIndexes: vi.fn(async () => ({
      pointCount: 123,
      buildTimeMs: 1,
    })),
    searchGeoIndex: vi.fn(),
    getGeoIndexStats: vi.fn(),
    validateGeoIndex: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
  } as unknown as CatalogBackend
}

function Harness({
  catalog,
  onError,
  revision,
  selectedIndexId,
}: {
  catalog: CatalogBackend
  onError(message: string): void
  revision: number
  selectedIndexId: string
}) {
  useGeoIndexes({
    catalog,
    catalogInfo,
    catalogRevision: revision,
    selectedIndexId,
    onError,
  })
  return null
}

describe('useGeoIndexes', () => {
  afterEach(() => {
    cleanup()
  })

  it('prepares the selected index on selection and catalog revision changes', async () => {
    const catalog = createCatalog()
    const onError = vi.fn()
    const { rerender } = render(
      <Harness
        catalog={catalog}
        onError={onError}
        revision={0}
        selectedIndexId="brute-force"
      />,
    )

    await waitFor(() => {
      expect(catalog.buildSearchIndexes).toHaveBeenCalledTimes(1)
    })
    expect(catalog.buildSearchIndexes).toHaveBeenLastCalledWith(
      'brute-force',
      expect.any(Function),
    )

    rerender(
      <Harness
        catalog={catalog}
        onError={onError}
        revision={0}
        selectedIndexId="dynamic-z-order-cells"
      />,
    )

    await waitFor(() => {
      expect(catalog.buildSearchIndexes).toHaveBeenCalledTimes(2)
    })
    expect(catalog.buildSearchIndexes).toHaveBeenLastCalledWith(
      'dynamic-z-order-cells',
      expect.any(Function),
    )

    rerender(
      <Harness
        catalog={catalog}
        onError={onError}
        revision={1}
        selectedIndexId="dynamic-z-order-cells"
      />,
    )

    await waitFor(() => {
      expect(catalog.buildSearchIndexes).toHaveBeenCalledTimes(3)
    })
    expect(catalog.buildSearchIndexes).toHaveBeenLastCalledWith(
      'dynamic-z-order-cells',
      expect.any(Function),
    )
  })
})
