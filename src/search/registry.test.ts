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
  return {
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
  return {
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
  return {
    id,
    label: id,
    capabilities: baseCapabilities,
    canHandle,
    search,
    stats: vi.fn(async () => stats(id)),
  }
}

describe('SearchIndexRegistry', () => {
  it('chooses the timestamp SQL engine for timestamp-only queries', async () => {
    const timestamp = engine(
      'sqlite-timestamp',
      (spec) => spec.order.kind === 'timestamp' && !spec.geoBounds,
    )
    const bbox = engine(
      'sqlite-bbox-time',
      (spec) => spec.order.kind === 'timestamp' && Boolean(spec.geoBounds),
    )
    const registry = new SearchIndexRegistry([timestamp, bbox])

    const result = await registry.search({
      order: { kind: 'timestamp', sort: 'timestamp_desc' },
      purpose: 'results',
    })

    expect(result.engineId).toBe('sqlite-timestamp')
    expect(timestamp.search).toHaveBeenCalledTimes(1)
    expect(bbox.search).not.toHaveBeenCalled()
  })

  it('chooses the bbox SQL engine for rectangle queries', async () => {
    const timestamp = engine(
      'sqlite-timestamp',
      (spec) => spec.order.kind === 'timestamp' && !spec.geoBounds,
    )
    const bbox = engine(
      'sqlite-bbox-time',
      (spec) => spec.order.kind === 'timestamp' && Boolean(spec.geoBounds),
    )
    const registry = new SearchIndexRegistry([timestamp, bbox])

    const result = await registry.search({
      geoBounds: { minLat: 1, maxLat: 2, minLon: 3, maxLon: 4 },
      order: { kind: 'timestamp', sort: 'timestamp_asc' },
      purpose: 'results',
    })

    expect(result.engineId).toBe('sqlite-bbox-time')
    expect(timestamp.search).not.toHaveBeenCalled()
    expect(bbox.search).toHaveBeenCalledTimes(1)
  })

  it('tries a legacy selected distance engine first and falls back to another exact engine', async () => {
    const selected = engine(
      'brute-force',
      (spec) => spec.order.kind === 'distance',
      vi.fn(async () => {
        throw new Error('selected engine failed')
      }),
    )
    const fallback = engine(
      'segmented-ball-tree',
      (spec) => spec.order.kind === 'distance',
    )
    const registry = new SearchIndexRegistry([fallback, selected])

    const result = await registry.search({
      order: {
        kind: 'distance',
        point: { lat: 1, lon: 2 },
        engineId: 'brute-force',
      },
      purpose: 'results',
    })

    expect(result.engineId).toBe('segmented-ball-tree')
    expect(selected.search).toHaveBeenCalledTimes(1)
    expect(fallback.search).toHaveBeenCalledTimes(1)
  })
})
