import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_INDEX_ID, DISTANCE_INDEX_ID, useGeoIndexes } from './useGeoIndexes'
import type { CatalogBackend, CatalogInfo } from '../platform/types'
import type { SearchIndexStats } from '../types'

const catalogInfo: CatalogInfo = {
  storageMode: 'file',
  filename: 'test-catalog',
}

function indexStats(engineId: string, indexStatus: SearchIndexStats['indexStatus']) {
  return {
    engineId,
    indexStatus,
    exact: true,
    persistent: true,
    pointCount: 3,
    distanceComputations: 0,
    nodesVisited: 0,
    pagesRead: 0,
    candidatesInspected: 0,
    prunedByGeo: 0,
    prunedByTime: 0,
  }
}

function createCatalog() {
  const indexes = [
    indexStats(CATALOG_INDEX_ID, 'current'),
    indexStats(DISTANCE_INDEX_ID, 'current'),
  ]
  const build = async (indexId: string) => {
    const index = indexes.find((entry) => entry.engineId === indexId)
    if (index) index.indexStatus = 'current'
    return { pointCount: 3, buildTimeMs: 1, engineCount: 1 }
  }
  const backend = {
    buildSearchIndexes: vi.fn(build),
    rebuildSearchIndex: vi.fn(build),
    getSearchIndexStats: vi.fn(async () => indexes.map((entry) => ({ ...entry }))),
  }
  const catalog = backend as unknown as CatalogBackend
  return { catalog, backend, indexes }
}

function renderIndexes(catalog: CatalogBackend, catalogBusy = false) {
  return renderHook(
    (props) => useGeoIndexes({
      catalog,
      catalogInfo,
      selectedIndexId: DISTANCE_INDEX_ID,
      ...props,
    }),
    { initialProps: { catalogRevision: 0, catalogBusy } },
  )
}

describe('useGeoIndexes', () => {
  afterEach(cleanup)

  it('builds missing and stale indexes one at a time and enables the catalog search first', async () => {
    const { catalog, backend, indexes } = createCatalog()
    indexes[0].indexStatus = 'missing'
    indexes[1].indexStatus = 'stale'
    const build = backend.buildSearchIndexes.getMockImplementation()!
    let finishDistanceBuild!: () => void
    const distanceBuild = new Promise<void>((resolve) => {
      finishDistanceBuild = resolve
    })
    backend.buildSearchIndexes.mockImplementation(async (indexId) => {
      if (indexId === DISTANCE_INDEX_ID) await distanceBuild
      return build(indexId)
    })
    const { result } = renderIndexes(catalog)

    await waitFor(() => expect(backend.buildSearchIndexes).toHaveBeenCalledTimes(2))
    expect(result.current.catalogIndexReady).toBe(true)
    expect(result.current.distanceIndexReady).toBe(false)
    expect(result.current.update?.phase).toBe('updating')
    expect(backend.buildSearchIndexes.mock.calls).toEqual([
      [CATALOG_INDEX_ID],
      [DISTANCE_INDEX_ID],
    ])

    finishDistanceBuild()
    await waitFor(() => expect(result.current.distanceIndexReady).toBe(true))
    expect(result.current.update?.phase).toBe('ready')
  })

  it('rechecks after an import and builds only the stale index', async () => {
    const { catalog, backend, indexes } = createCatalog()
    const { result, rerender } = renderIndexes(catalog)
    await waitFor(() => expect(result.current.distanceIndexReady).toBe(true))
    expect(backend.buildSearchIndexes).not.toHaveBeenCalled()

    indexes[1].indexStatus = 'stale'
    rerender({ catalogRevision: 1, catalogBusy: true })
    expect(result.current.distanceIndexReady).toBe(false)
    expect(backend.buildSearchIndexes).not.toHaveBeenCalled()

    rerender({ catalogRevision: 1, catalogBusy: false })
    await waitFor(() => expect(result.current.distanceIndexReady).toBe(true))
    expect(backend.buildSearchIndexes.mock.calls).toEqual([[DISTANCE_INDEX_ID]])
  })

  it('shows a failed repair and waits for an explicit retry', async () => {
    const { catalog, backend, indexes } = createCatalog()
    indexes[0].indexStatus = 'failed'
    backend.rebuildSearchIndex.mockRejectedValueOnce(new Error('Storage error'))
    const { result } = renderIndexes(catalog)

    await waitFor(() => expect(result.current.update).toEqual({
      phase: 'failed',
      message: 'Storage error',
    }))
    expect(result.current.updating).toBe(false)
    expect(backend.rebuildSearchIndex.mock.calls).toEqual([[CATALOG_INDEX_ID]])
    expect(backend.buildSearchIndexes).not.toHaveBeenCalled()

    act(() => result.current.retryUpdate())
    await waitFor(() => expect(result.current.catalogIndexReady).toBe(true))
    expect(backend.rebuildSearchIndex).toHaveBeenCalledTimes(2)
  })
})
