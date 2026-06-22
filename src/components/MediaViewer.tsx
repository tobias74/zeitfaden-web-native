import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  MapPin,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { TranslationKey, TranslationValues } from '../i18n'
import { formatDistance } from '../lib/distance'
import { formatDateTime } from '../lib/time'
import type { PlatformBackend } from '../platform/types'
import type { EnrichedSearchResult, MediaItem, MediaLocation } from '../types'

type MediaViewerProps = {
  platform: PlatformBackend
  items: EnrichedSearchResult[]
  index: number
  absoluteIndex: number
  totalItems?: number
  canNavigatePrevious: boolean
  canNavigateNext: boolean
  navigationPending?: boolean
  locale: string
  t: (key: TranslationKey, values?: TranslationValues) => string
  onClose: () => void
  onNavigate: (index: number) => void
}

type MediaUrlState = {
  loading: boolean
  source: 'original' | 'thumbnail' | 'none'
  url?: string
}

function formatDimensions(item: MediaItem): string | undefined {
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
  absoluteIndex,
  totalItems,
  canNavigatePrevious,
  canNavigateNext,
  navigationPending = false,
  locale,
  t,
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

  const canReveal =
    platform.capabilities.absolutePaths && Boolean(location?.absolutePath)

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
      if (
        event.key === 'ArrowLeft' &&
        canNavigatePrevious &&
        !navigationPending
      ) {
        event.preventDefault()
        onNavigate(absoluteIndex - 1)
      }
      if (event.key === 'ArrowRight' && canNavigateNext && !navigationPending) {
        event.preventDefault()
        onNavigate(absoluteIndex + 1)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    canNavigateNext,
    canNavigatePrevious,
    absoluteIndex,
    index,
    navigationPending,
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

      if (item.kind === 'geo_point') {
        setMediaUrl({ loading: false, source: 'none' })
        return
      }

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
              {(absoluteIndex + 1).toLocaleString(locale)}
              {typeof totalItems === 'number'
                ? ` / ${totalItems.toLocaleString(locale)}`
                : ''}
              {navigationPending ? ` · ${t('loading')}` : ''}
            </p>
          </div>
          <div className="media-viewer-actions">
            {canReveal && (
              <button type="button" onClick={revealOriginal}>
                <ExternalLink size={17} />
                {t('reveal')}
              </button>
            )}
            <button type="button" onClick={onClose} title={t('closeViewer')}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="media-viewer-body">
          <button
            type="button"
            className="media-viewer-nav media-viewer-nav-prev"
            onClick={() => onNavigate(absoluteIndex - 1)}
            disabled={!canNavigatePrevious || navigationPending}
            title={t('previousItem')}
          >
            <ChevronLeft size={26} />
          </button>

          <figure className="media-viewer-stage">
            {mediaUrl.loading && (
              <div className="media-viewer-placeholder">{t('loading')}</div>
            )}
            {!mediaUrl.loading && mediaUrl.url && item.kind === 'image' && (
              <img src={mediaUrl.url} alt={item.displayName} />
            )}
            {!mediaUrl.loading && mediaUrl.url && item.kind === 'video' && (
              <video src={mediaUrl.url} controls />
            )}
            {!mediaUrl.loading && item.kind === 'geo_point' && (
              <div className="media-viewer-placeholder">
                <MapPin size={34} />
                <span>{t('geo_point')}</span>
              </div>
            )}
            {!mediaUrl.loading && !mediaUrl.url && item.kind !== 'geo_point' && (
              <div className="media-viewer-placeholder">
                {item.kind === 'video' ? 'VID' : 'IMG'}
              </div>
            )}
            {!mediaUrl.loading && mediaUrl.source !== 'none' && (
              <figcaption>
                {t(
                  mediaUrl.source === 'original'
                    ? 'mediaSourceOriginal'
                    : 'mediaSourceThumbnail',
                )}
              </figcaption>
            )}
          </figure>

          <button
            type="button"
            className="media-viewer-nav media-viewer-nav-next"
            onClick={() => onNavigate(absoluteIndex + 1)}
            disabled={!canNavigateNext || navigationPending}
            title={t('nextItem')}
          >
            <ChevronRight size={26} />
          </button>

          <aside className="media-viewer-details">
            <dl>
              <div>
                <dt>{t('captured')}</dt>
                <dd>
                  {formatDateTime(item.timestamp, locale, t('noTimestamp'))}
                </dd>
              </div>
              <div>
                <dt>{t('kind')}</dt>
                <dd>{t(item.kind)}</dd>
              </div>
              {dimensions && (
                <div>
                  <dt>{t('size')}</dt>
                  <dd>{dimensions}</dd>
                </div>
              )}
              {geo && (
                <div>
                  <dt>GPS</dt>
                  <dd>{geo}</dd>
                </div>
              )}
              {typeof result.distanceMeters === 'number' &&
                Number.isFinite(result.distanceMeters) && (
                <div>
                  <dt>{t('distance')}</dt>
                  <dd>{formatDistance(result.distanceMeters)}</dd>
                </div>
              )}
              <div>
                <dt>{t('locations')}</dt>
                <dd>{item.locations.length.toLocaleString(locale)}</dd>
              </div>
              <div>
                <dt>{t('path')}</dt>
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
