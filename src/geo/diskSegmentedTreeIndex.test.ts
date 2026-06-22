import { describe, expect, it } from 'vitest'
import type { GeoIndexPoint } from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'
import {
  DiskSegmentedTreeIndex,
  type DiskSegmentedEngineId,
  type DiskSegmentedTreeManifest,
  type DiskSegmentedTreeStore,
} from './diskSegmentedTreeIndex'

const points: GeoIndexPoint[] = [
  { mediaId: 'zurich-a', kind: 'geo_point', lat: 47.3769, lon: 8.5417, timestamp: 100 },
  { mediaId: 'zurich-b', kind: 'geo_point', lat: 47.3769, lon: 8.5417, timestamp: 200 },
  { mediaId: 'basel', kind: 'geo_point', lat: 47.5596, lon: 7.5886, timestamp: 300 },
  { mediaId: 'munich', kind: 'geo_point', lat: 48.1351, lon: 11.582, timestamp: 400 },
  { mediaId: 'vienna', kind: 'geo_point', lat: 48.2082, lon: 16.3738, timestamp: 500 },
]

class CountingStore implements DiskSegmentedTreeStore {
  manifest: DiskSegmentedTreeManifest | undefined
  readonly segments = new Map<string, ArrayBuffer>()
  readSegmentCount = 0

  async readManifest(): Promise<DiskSegmentedTreeManifest | undefined> {
    return this.manifest ? structuredClone(this.manifest) : undefined
  }

  async writeManifest(
    _engineId: DiskSegmentedEngineId,
    manifest: DiskSegmentedTreeManifest,
  ): Promise<void> {
    this.manifest = structuredClone(manifest)
  }

  async readSegment(
    _engineId: DiskSegmentedEngineId,
    segmentId: string,
  ): Promise<ArrayBuffer | undefined> {
    this.readSegmentCount += 1
    return this.segments.get(segmentId)?.slice(0)
  }

  async writeSegment(
    _engineId: DiskSegmentedEngineId,
    segmentId: string,
    data: ArrayBuffer,
  ): Promise<void> {
    this.segments.set(segmentId, data.slice(0))
  }

  async clear(): Promise<void> {
    this.manifest = undefined
    this.segments.clear()
    this.readSegmentCount = 0
  }
}

async function expectDiskIndexMatchesBruteForce(engineId: DiskSegmentedEngineId) {
  const store = new CountingStore()
  const index = new DiskSegmentedTreeIndex(engineId, store)
  await index.build(async (onBatch) => {
    await onBatch(points.slice(0, 2), 2)
    await onBatch(points.slice(2), points.length)
    return points.length
  }, 7)

  const restored = new DiskSegmentedTreeIndex(engineId, store)
  await expect(restored.prepare(7)).resolves.toBe(true)
  expect(store.readSegmentCount).toBe(0)

  const query = { lat: 48.13, lon: 11.58, k: 3, startTime: 100, endTime: 500 }
  const oracle = new BruteForceGeoIndex()
  await oracle.build(points)
  const [actual, expected] = await Promise.all([
    restored.search(query),
    oracle.search(query),
  ])

  expect(actual.map((result) => result.mediaId)).toEqual(
    expected.map((result) => result.mediaId),
  )
  expect(store.readSegmentCount).toBeGreaterThan(0)
  const stats = await restored.stats()
  expect(stats.indexStorage).toBe('disk')
  expect(stats.diskReadCount).toBeGreaterThan(0)
  expect(stats.loadedPages).toBeGreaterThan(0)
}

describe('disk segmented tree indexes', () => {
  it('restores KD-tree manifest without loading segments and searches exactly', async () => {
    await expectDiskIndexMatchesBruteForce('segmented-kd-tree')
  })

  it('restores ball-tree manifest without loading segments and searches exactly', async () => {
    await expectDiskIndexMatchesBruteForce('segmented-ball-tree')
  })
})
