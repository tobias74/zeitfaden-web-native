import type {
  GeoIndexPoint,
  GeoSearchQuery,
  GeoTemporalIndex,
  ValidationReport,
} from '../types'
import { BruteForceGeoIndex } from './bruteForceIndex'
import { DynamicZOrderGeoIndex } from './dynamicZOrderGeoIndex'

export class GeoIndexRegistry {
  readonly indexes: GeoTemporalIndex[]

  constructor() {
    this.indexes = [new BruteForceGeoIndex(), new DynamicZOrderGeoIndex()]
  }

  get(id: string): GeoTemporalIndex {
    return this.indexes.find((index) => index.id === id) ?? this.indexes[0]
  }

  async buildAll(points: GeoIndexPoint[]): Promise<void> {
    await Promise.all(this.indexes.map((index) => index.build(points)))
  }

  async insertMany(points: GeoIndexPoint[]): Promise<void> {
    for (const point of points) {
      await Promise.all(this.indexes.map((index) => index.insert(point)))
    }
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
