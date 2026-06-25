import type { GeoIndexPoint, MediaItem, MediaKind } from '../types'

export const FIXTURE_START_TIME = 1_700_000_000_000

export function fixtureKind(index: number): MediaKind {
  if (index % 17 === 0) return 'image'
  if (index % 19 === 0) return 'video'
  return 'geo_point'
}

export function fixtureTimestamp(index: number): number {
  return FIXTURE_START_TIME + index * 1_000
}

export function fixtureLat(index: number): number {
  return -80 + ((index * 37) % 1_600_000) / 10_000
}

export function fixtureLon(index: number): number {
  return -170 + ((index * 53) % 3_400_000) / 10_000
}

export function makeGeoPoint(index: number): GeoIndexPoint {
  return {
    mediaId: `media-${index.toString().padStart(7, '0')}`,
    kind: fixtureKind(index),
    lat: fixtureLat(index),
    lon: fixtureLon(index),
    timestamp: fixtureTimestamp(index),
  }
}

export function makeGeoPoints(count: number): GeoIndexPoint[] {
  return Array.from({ length: count }, (_, index) => makeGeoPoint(index))
}

export function makeMediaItem(index: number): MediaItem {
  const mediaId = `media-${index.toString().padStart(7, '0')}`
  const kind = fixtureKind(index)
  return {
    id: mediaId,
    contentHash: mediaId,
    sourceId: 'fixture-source',
    relativePath: `${kind}/${mediaId}.jpg`,
    displayName: `${mediaId}.jpg`,
    kind,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/jpeg',
    sizeBytes: 1_024 + index,
    timestamp: fixtureTimestamp(index),
    latitude: fixtureLat(index),
    longitude: fixtureLon(index),
    locations: [
      {
        id: `location-${mediaId}`,
        sourceId: 'fixture-source',
        sourceLabel: 'Fixture source',
        rootPath: '/fixture',
        relativePath: `${kind}/${mediaId}.jpg`,
      },
    ],
  }
}

export function makeMediaItems(count: number): MediaItem[] {
  return Array.from({ length: count }, (_, index) => makeMediaItem(index))
}
