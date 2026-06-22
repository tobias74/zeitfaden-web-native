import type { MediaItem, MediaSource } from '../types'

export const sampleSource: MediaSource = {
  id: 'sample-source',
  label: 'Sample geotagged library',
}

function sampleItem(item: Omit<MediaItem, 'contentHash' | 'locations'>): MediaItem {
  return {
    ...item,
    contentHash: item.id,
    locations: [
      {
        id: `${item.id}-location`,
        sourceId: item.sourceId,
        sourceLabel: sampleSource.label,
        rootPath: sampleSource.rootPath,
        relativePath: item.relativePath,
      },
    ],
  }
}

export const sampleMedia: MediaItem[] = [
  sampleItem({
    id: 'sample-zurich-limmat',
    sourceId: sampleSource.id,
    relativePath: 'zurich/limmat-evening.jpg',
    displayName: 'Limmat evening',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 4_200_000,
    timestamp: Date.UTC(2024, 4, 11, 18, 20),
    latitude: 47.3769,
    longitude: 8.5417,
  }),
  sampleItem({
    id: 'sample-basel-rhine',
    sourceId: sampleSource.id,
    relativePath: 'basel/rhine-walk.jpg',
    displayName: 'Rhine walk',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 3_600_000,
    timestamp: Date.UTC(2023, 8, 2, 10, 5),
    latitude: 47.5596,
    longitude: 7.5886,
  }),
  sampleItem({
    id: 'sample-munich-park',
    sourceId: sampleSource.id,
    relativePath: 'munich/english-garden.jpg',
    displayName: 'English Garden',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 5_100_000,
    timestamp: Date.UTC(2022, 6, 20, 14, 45),
    latitude: 48.1582,
    longitude: 11.5878,
  }),
  sampleItem({
    id: 'sample-venice-canal',
    sourceId: sampleSource.id,
    relativePath: 'venice/canal.mp4',
    displayName: 'Canal clip',
    kind: 'video',
    mimeType: 'video/mp4',
    sizeBytes: 32_000_000,
    durationMs: 42_000,
    timestamp: Date.UTC(2021, 9, 5, 9, 15),
    latitude: 45.4408,
    longitude: 12.3155,
  }),
  sampleItem({
    id: 'sample-reykjavik-harbor',
    sourceId: sampleSource.id,
    relativePath: 'iceland/reykjavik-harbor.jpg',
    displayName: 'Reykjavik harbor',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 6_400_000,
    timestamp: Date.UTC(2020, 1, 12, 16, 0),
    latitude: 64.1466,
    longitude: -21.9426,
  }),
  sampleItem({
    id: 'sample-no-gps',
    sourceId: sampleSource.id,
    relativePath: 'unsorted/kitchen.jpg',
    displayName: 'Kitchen no GPS',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 2_100_000,
    timestamp: Date.UTC(2024, 0, 7, 8, 30),
  }),
]
