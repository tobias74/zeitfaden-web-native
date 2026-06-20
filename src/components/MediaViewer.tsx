import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { formatDistance } from '../lib/distance'
import { formatDateTime } from '../lib/time'
import type { PlatformBackend } from '../platform/types'
import type { EnrichedSearchResult, MediaItem, MediaLocation } from '../types'

type MediaViewerProps = {
  platform: PlatformBackend
  items: EnrichedSearchResult[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
}

type MediaUrlState = {
  loading: boolean
  source: 'original' | 'thumbnail' | 'none'
  url?: string
}

function formatDimensions(item: MediaItem): string | undefined {
  if (typeof item.width === 'number' && typeof item.height === 'number') {
    return `${item.width} x ${item.height}`
  }
  if (typeof item.durationMs === 'number') {
    return `${Math.round(item.durationMs / 1_000)} s`
  }
  return undefined
}

function formatGeo(item: MediaItem): string | undefined {
  if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
    return undefined
  }
  return `${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}`
}

function primaryLocation(item: MediaItem): MediaLocation | undefined {
  return (
    item.locations.find((location) => location.absolutePath) ??
    item.locations[0] ?? {
      id: item.id,
      sourceId: item.sourceId,
      relativePath: item.relativePath,
      displayName: item.displayName,
      lastSeenAt: item.lastSeenAt,
    }
  )
}

function locationPath(
  location: MediaLocation | undefined,
  item: MediaItem,
): string {
  return location?.absolutePath ?? location?.relativePath ?? item.relativePath
}

export function MediaViewer({
  platform,
  items,
  index,
  onClose,
  onNavigate,
}: MediaViewerProps) {
  const result = items[index]
  const item = result?.item
  const location = useMemo(
    () => (item ? primaryLocation(item) : undefined),
    [item],
  )
  const [mediaUrl, setMediaUrl] = useState<MediaUrlState>({
    loading: true,
    source: 'none',
  })
  const [actionError, setActionError] = useState<string>()

  const canNavigatePrevious = index > 0
  const canNavigateNext = index < items.length - 1
  const canReveal =
    platform.capabilities.absolutePaths && Boolean(location?.absolutePath)

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (event.key === 'ArrowLeft' && canNavigatePrevious) {
        event.preventDefault()
        onNavigate(index - 1)
      }
      if (event.key === 'ArrowRight' && canNavigateNext) {
        event.preventDefault()
        onNavigate(index + 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    canNavigateNext,
    canNavigatePrevious,
    index,
    onClose,
    onNavigate,
  ])

  useEffect(() => {
    if (!item) return

    let cancelled = false
    let originalUrl: string | undefined
    let thumbnailUrl: string | undefined

    async function loadMedia() {
      setActionError(undefined)
      setMediaUrl({ loading: true, source: 'none' })

      try {
        originalUrl = await platform.files.resolveOriginalUrl(item, location)
      } catch {
        originalUrl = undefined
      }
      if (cancelled) {
        if (originalUrl) platform.files.revokeOriginalUrl(originalUrl)
        return
      }
      if (originalUrl) {
        setMediaUrl({
          loading: false,
          source: 'original',
          url: originalUrl,
        })
        return
      }

      thumbnailUrl = await platform.thumbnails.resolveThumbnailUrl(
        item.thumbnailKey,
      )
      if (cancelled) {
        if (thumbnailUrl) platform.thumbnails.revokeThumbnailUrl(thumbnailUrl)
        return
      }

      setMediaUrl({
        loading: false,
        source: thumbnailUrl ? 'thumbnail' : 'none',
        url: thumbnailUrl,
      })
    }

    loadMedia().catch((error) => {
      if (!cancelled) {
        setMediaUrl({ loading: false, source: 'none' })
        setActionError(error instanceof Error ? error.message : String(error))
      }
    })

    return () => {
      cancelled = true
      if (originalUrl) platform.files.revokeOriginalUrl(originalUrl)
      if (thumbnailUrl) platform.thumbnails.revokeThumbnailUrl(thumbnailUrl)
    }
  }, [item, location, platform])

  if (!item || !result) return null

  async function revealOriginal() {
    if (!location) return
    setActionError(undefined)
    try {
      await platform.files.revealLocation(location)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const dimensions = formatDimensions(item)
  const geo = formatGeo(item)
  const path = locationPath(location, item)

  return (
    <div className="media-viewer" role="dialog" aria-modal="true">
      <div className="media-viewer-backdrop" onClick={onClose} />
      <section className="media-viewer-dialog" aria-label={item.displayName}>
        <header className="media-viewer-header">
          <div>
            <h2>{item.displayName}</h2>
            <p>
              {(index + 1).toLocaleString()} / {items.length.toLocaleString()}
            </p>
          </div>
          <div className="media-viewer-actions">
            {canReveal && (
              <button type="button" onClick={revealOriginal}>
                <ExternalLink size={17} />
                Reveal
              </button>
            )}
            <button type="button" onClick={onClose} title="Close viewer">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="media-viewer-body">
          <button
            type="button"
            className="media-viewer-nav media-viewer-nav-prev"
            onClick={() => onNavigate(index - 1)}
            disabled={!canNavigatePrevious}
            title="Previous item"
          >
            <ChevronLeft size={26} />
          </button>

          <figure className="media-viewer-stage">
            {mediaUrl.loading && (
              <div className="media-viewer-placeholder">Loading</div>
            )}
            {!mediaUrl.loading && mediaUrl.url && item.kind === 'image' && (
              <img src={mediaUrl.url} alt={item.displayName} />
            )}
            {!mediaUrl.loading && mediaUrl.url && item.kind === 'video' && (
              <video src={mediaUrl.url} controls />
            )}
            {!mediaUrl.loading && !mediaUrl.url && (
              <div className="media-viewer-placeholder">
                {item.kind === 'video' ? 'VID' : 'IMG'}
              </div>
            )}
            {!mediaUrl.loading && mediaUrl.source !== 'none' && (
              <figcaption>{mediaUrl.source}</figcaption>
            )}
          </figure>

          <button
            type="button"
            className="media-viewer-nav media-viewer-nav-next"
            onClick={() => onNavigate(index + 1)}
            disabled={!canNavigateNext}
            title="Next item"
          >
            <ChevronRight size={26} />
          </button>

          <aside className="media-viewer-details">
            <dl>
              <div>
                <dt>Captured</dt>
                <dd>{formatDateTime(item.capturedAt)}</dd>
              </div>
              <div>
                <dt>Kind</dt>
                <dd>{item.kind}</dd>
              </div>
              {dimensions && (
                <div>
                  <dt>Size</dt>
                  <dd>{dimensions}</dd>
                </div>
              )}
              {geo && (
                <div>
                  <dt>GPS</dt>
                  <dd>{geo}</dd>
                </div>
              )}
              {Number.isFinite(result.distanceMeters) && (
                <div>
                  <dt>Distance</dt>
                  <dd>{formatDistance(result.distanceMeters)}</dd>
                </div>
              )}
              <div>
                <dt>Locations</dt>
                <dd>{item.locations.length.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>{path}</dd>
              </div>
            </dl>
            {actionError && <p className="media-viewer-error">{actionError}</p>}
          </aside>
        </div>
      </section>
    </div>
  )
}
