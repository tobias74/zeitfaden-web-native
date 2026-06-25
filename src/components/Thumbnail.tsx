import { useEffect, useRef, useState } from 'react'
import { MapPin } from 'lucide-react'
import type { ThumbnailBackend } from '../platform/types'
import type { MediaKind } from '../types'

type ThumbnailProps = {
  thumbnails: ThumbnailBackend
  thumbnailKey?: string
  label: string
  kind: MediaKind
}

export function Thumbnail({
  thumbnails,
  thumbnailKey,
  label,
  kind,
}: ThumbnailProps) {
  const [shouldLoad, setShouldLoad] = useState(false)
  const targetRef = useRef<HTMLDivElement | HTMLImageElement | null>(null)
  const [loadedThumbnail, setLoadedThumbnail] = useState<{
    key: string
    url?: string
  }>()
  const url =
    loadedThumbnail && loadedThumbnail.key === thumbnailKey
      ? loadedThumbnail.url
      : undefined

  useEffect(() => {
    if (shouldLoad || kind === 'geo_point' || !thumbnailKey) return

    const target = targetRef.current
    if (!target || !('IntersectionObserver' in window)) {
      const timer = window.setTimeout(() => setShouldLoad(true), 0)
      return () => window.clearTimeout(timer)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setShouldLoad(true)
        observer.disconnect()
      },
      { rootMargin: '240px' },
    )

    observer.observe(target)
    return () => observer.disconnect()
  }, [kind, shouldLoad, thumbnailKey])

  useEffect(() => {
    let cancelled = false
    let resolvedUrl: string | undefined

    async function loadThumbnail() {
      if (!shouldLoad || kind === 'geo_point' || !thumbnailKey) return

      try {
        resolvedUrl = await thumbnails.resolveThumbnailUrl(thumbnailKey)
        if (!cancelled) {
          setLoadedThumbnail({ key: thumbnailKey, url: resolvedUrl })
        }
      } catch {
        if (!cancelled) setLoadedThumbnail({ key: thumbnailKey })
      }
    }

    loadThumbnail()

    return () => {
      cancelled = true
      if (resolvedUrl) thumbnails.revokeThumbnailUrl(resolvedUrl)
    }
  }, [kind, shouldLoad, thumbnailKey, thumbnails])

  if (url) {
    return (
      <img
        ref={(node) => {
          targetRef.current = node
        }}
        className="thumb-image"
        src={url}
        alt={label}
        loading="lazy"
      />
    )
  }

  if (kind === 'geo_point') {
    return (
      <div
        ref={(node) => {
          targetRef.current = node
        }}
        className="thumb-placeholder"
        aria-label={label}
      >
        <MapPin size={24} />
        <span>GEO</span>
      </div>
    )
  }

  return (
    <div
      ref={(node) => {
        targetRef.current = node
      }}
      className="thumb-placeholder"
      aria-label={label}
    >
      {kind === 'video' ? 'VID' : 'IMG'}
    </div>
  )
}
