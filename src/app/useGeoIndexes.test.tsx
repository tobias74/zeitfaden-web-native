import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useGeoIndexes } from './useGeoIndexes'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import type { GeoIndexStats } from '../types'

const catalogInfo: CatalogInfo = {
  storageMode: 'opfs',
  sqliteVersion: 'test',
  filename: ':memory:',
}

const stats: GeoIndexStats = {
  engineId: 'brute-force',
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
    getGeoIndexStats: vi.fn(async () => stats),
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
    indexCount: 2,
    onError,
  })
  return null
}

describe('useGeoIndexes', () => {
  afterEach(() => {
    cleanup()
  })

  it('rebuilds on catalog revision changes, not selected index changes', async () => {
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
      expect(catalog.buildGeoIndexes).toHaveBeenCalledTimes(1)
    })

    rerender(
      <Harness
        catalog={catalog}
        onError={onError}
        revision={0}
        selectedIndexId="dynamic-z-order-cells"
      />,
    )

    await waitFor(() => {
      expect(catalog.getGeoIndexStats).toHaveBeenCalledWith(
        'dynamic-z-order-cells',
      )
    })
    expect(catalog.buildGeoIndexes).toHaveBeenCalledTimes(1)

    rerender(
      <Harness
        catalog={catalog}
        onError={onError}
        revision={1}
        selectedIndexId="dynamic-z-order-cells"
      />,
    )

    await waitFor(() => {
      expect(catalog.buildGeoIndexes).toHaveBeenCalledTimes(2)
    })
  })
})
