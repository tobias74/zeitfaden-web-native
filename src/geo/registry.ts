import type {
  GeoIndexPoint,
  GeoSearchQuery,
  GeoTemporalIndex,
  ValidationReport,
} from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'
import { DynamicZOrderGeoIndex } from './dynamicZOrderGeoIndex'
import { SegmentedKdTreeGeoIndex } from './segmentedKdTreeGeoIndex'

export class GeoIndexRegistry {
  readonly indexes: GeoTemporalIndex[]

  constructor() {
    this.indexes = [
      new BruteForceGeoIndex(),
      new DynamicZOrderGeoIndex(),
      new SegmentedKdTreeGeoIndex(),
    ]
  }

  get(id: string): GeoTemporalIndex {
    return this.indexes.find((index) => index.id === id) ?? this.indexes[0]
  }

  async buildAll(points: GeoIndexPoint[]): Promise<void> {
    await Promise.all(this.indexes.map((index) => index.build(points)))
  }

  async insertMany(points: GeoIndexPoint[]): Promise<void> {
    await Promise.all(this.indexes.map((index) => index.insertMany(points)))
  }

  async removeMany(mediaIds: string[]): Promise<void> {
    for (const mediaId of mediaIds) {
      await Promise.all(this.indexes.map((index) => index.remove(mediaId)))
    }
  }

  async validateSelected(
    selectedId: string,
    query: GeoSearchQuery,
  ): Promise<ValidationReport> {
    const selected = this.get(selectedId)
    return selected.validateAgainstBruteForce(query)
  }
}
