import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaViewer } from './MediaViewer'
import { translate } from '../i18n'
import type { PlatformBackend } from '../platform/types'
import type { EnrichedSearchResult, MediaItem } from '../types'

const mediaItem: MediaItem = {
  id: 'asset-1',
  contentHash: 'hash-1',
  sourceId: 'source-1',
  relativePath: 'folder/image.jpg',
  displayName: 'image.jpg',
  kind: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: 123,
  locations: [
    {
      id: 'location-1',
      sourceId: 'source-1',
      sourceLabel: 'Source 1',
      relativePath: 'folder/image.jpg',
    },
  ],
}

const result: EnrichedSearchResult = {
  item: mediaItem,
  mediaId: mediaItem.id,
  distanceMeters: Number.NaN,
}

afterEach(() => cleanup())

function createPlatform(): PlatformBackend {
  return {
    kind: 'web',
    capabilities: {
      absolutePaths: false,
      persistentFileHandles: true,
      nativeThumbnails: false,
      nativeCatalog: false,
    },
    catalog: {} as PlatformBackend['catalog'],
    importer: {} as PlatformBackend['importer'],
    thumbnails: {
      resolveThumbnailUrl: vi.fn().mockResolvedValue(undefined),
      revokeThumbnailUrl: vi.fn(),
    },
    files: {
      resolveOriginalUrl: vi.fn().mockResolvedValue(undefined),
      revokeOriginalUrl: vi.fn(),
      revealLocation: vi.fn().mockResolvedValue(undefined),
    },
    dispose: vi.fn(),
  }
}

describe('MediaViewer', () => {
  it('navigates by absolute result index outside the local item window', () => {
    const onNavigate = vi.fn()

    render(
      <MediaViewer
        platform={createPlatform()}
        items={[result]}
        index={0}
        absoluteIndex={49}
        canNavigatePrevious={true}
        canNavigateNext={true}
        locale="en-US"
        t={(key, values) => translate('en', key, values)}
        onClose={vi.fn()}
        onNavigate={onNavigate}
      />,
    )

    expect(screen.getByText('50')).toBeTruthy()

    fireEvent.click(screen.getByTitle('Next item'))
    expect(onNavigate).toHaveBeenCalledWith(50)

    fireEvent.click(screen.getByTitle('Previous item'))
    expect(onNavigate).toHaveBeenCalledWith(48)
  })

  it('renders geo points without resolving media URLs', async () => {
    const platform = createPlatform()
    const geoItem: MediaItem = {
      ...mediaItem,
      id: 'geo-1',
      contentHash: 'geo-1',
      displayName: 'track.gpx #1',
      kind: 'geo_point',
      mimeType: 'application/gpx+xml',
      latitude: 48.1,
      longitude: 11.5,
      timestamp: Date.parse('2026-06-21T10:00:00Z'),
      thumbnailKey: undefined,
      locations: [
        {
          id: 'geo-location-1',
          sourceId: 'source-1',
          sourceLabel: 'track.gpx',
          relativePath: 'track.gpx',
          pointIndex: 1,
        },
      ],
    }
    const geoResult: EnrichedSearchResult = {
      item: geoItem,
      mediaId: geoItem.id,
      distanceMeters: Number.NaN,
    }

    render(
      <MediaViewer
        platform={platform}
        items={[geoResult]}
        index={0}
        absoluteIndex={0}
        canNavigatePrevious={false}
        canNavigateNext={false}
        locale="en-US"
        t={(key, values) => translate('en', key, values)}
        onClose={vi.fn()}
        onNavigate={vi.fn()}
      />,
    )

    expect(await screen.findAllByText('geo point')).toHaveLength(2)
    expect(platform.files.resolveOriginalUrl).not.toHaveBeenCalled()
    expect(platform.thumbnails.resolveThumbnailUrl).not.toHaveBeenCalled()
  })
})
