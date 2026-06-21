import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
  lastSeenAt: 1,
  locations: [
    {
      id: 'location-1',
      sourceId: 'source-1',
      relativePath: 'folder/image.jpg',
      displayName: 'image.jpg',
      lastSeenAt: 1,
    },
  ],
}

const result: EnrichedSearchResult = {
  item: mediaItem,
  mediaId: mediaItem.id,
  distanceMeters: Number.NaN,
}

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
})
