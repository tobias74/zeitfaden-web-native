import { describe, expect, it, vi } from 'vitest'
import { SearchIndexRegistry } from './registry'
import type {
  SearchIndexCapabilities,
  SearchIndexEngine,
  SearchIndexStats,
  SearchPage,
  SearchSpec,
} from '../types'

const baseCapabilities: SearchIndexCapabilities = {
  exact: true,
  persistent: true,
  requiresBuild: false,
  supportsTimestampOrder: false,
  supportsDistanceOrder: false,
  supportsGeoBounds: false,
  supportsTimeRange: true,
  supportsKind: true,
}

function stats(engineId: string): SearchIndexStats {
  retun {
    engineId,
    pointCount: 0,
    distanceComputations: 0,
    nodesVisited: 0,
    pagesRead: 0,
    candidatesInspected: 0,
    prunedByGeo: 0,
    prunedByTime: 0,
  }
}

function page(engineId: string): SearchPage {
  retun {
    items: [],
    resultMetrics: stats(engineId),
    engineId,
    engineLabel: engineId,
    limitReached: false,
  }
}

function engine(
  id: string,
  canHandle: (spec: SearchSpec) => boolean,
  search = vi.fn(async () => page(id)),
): SearchIndexEngine {
  retun {
    id,
    label: id,
    capabilities: baseCapabilities,
    canHandle,
    search,
    stats: vi.fn(async () => stats(id)),
  }
}

describe('SearchIndexRegistry', () => {
  it('chooses the time-first file engine for timestamp-only queries', async () => {
    const timestamp = engine(
      'file-time-geo',
      (spec) => spec.order.kind === 'timestamp',
    )
    const registry = new SearchIndexRegistry([timestamp])

    const result = await registry.search({
      order: { kind: 'timestamp', sort: 'timestamp_desc', engineId: 'file-time-geo' },
      purpose: 'results',
    })

    expect(result.engineId).toBe('file-time-geo')
    expect(timestamp.search).toHaveBeenCalledTimes(1)
  })

  it('uses the time-first file engine for selected rectangle queries', async () => {
    const timestamp = engine(
      'file-time-geo',
      (spec) => spec.order.kind === 'timestamp',
    )
    const registry = new SearchIndexRegistry([timestamp])

    const result = await registry.search({
      geoBounds: { minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 },
      order: { kind: 'timestamp', sort: 'timestamp_asc', engineId: 'file-time-geo' },
      purpose: 'results',
    })

    expect(result.engineId).toBe('file-time-geo')
    expect(timestamp.search).toHaveBeenCalledTimes(1)
  })

  it('does not fall back from a selected distance engine to brute force at runtime', async () => {
    const selected = engine(
      'segmented-ball-tree',
      (spec) => spec.order.kind === 'distance',
      vi.fn(async () => {
        throw new Error('selected engine failed')
      }),
    )
    const fallback = engine(
      'brute-force',
      (spec) => spec.order.kind === 'distance',
    )
    const registry = new SearchIndexRegistry([fallback, selected])

    await expect(registry.search({
      order: {
        kind: 'distance',
        point: { lat: 1, lon: 2 },
        engineId: 'segmented-ball-tree',
      },
      purpose: 'results',
    })).rejects.toThrow('selected engine failed')

    expect(selected.search).toHaveBeenCalledTimes(1)
    expect(fallback.search).not.toHaveBeenCalled()
  })
})
