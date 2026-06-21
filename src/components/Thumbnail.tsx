import { useEffect, useState } from 'react'
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
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let resolvedUrl: string | undefined

    async function loadThumbnail() {
      if (kind === 'geo_point') {
        setUrl(undefined)
        return
      }

      if (!thumbnailKey) {
        setUrl(undefined)
        return
      }

      try {
        resolvedUrl = await thumbnails.resolveThumbnailUrl(thumbnailKey)
        if (!cancelled) setUrl(resolvedUrl)
      } catch {
        if (!cancelled) setUrl(undefined)
      }
    }

    loadThumbnail()

    return () => {
      cancelled = true
      if (resolvedUrl) thumbnails.revokeThumbnailUrl(resolvedUrl)
    }
  }, [kind, thumbnailKey, thumbnails])

  if (url) {
    return <img className="thumb-image" src={url} alt={label} loading="lazy" />
  }

  if (kind === 'geo_point') {
    return (
      <div className="thumb-placeholder" aria-label={label}>
        <MapPin size={24} />
        <span>GEO</span>
      </div>
    )
  }

  return (
    <div className="thumb-placeholder" aria-label={label}>
      {kind === 'video' ? 'VID' : 'IMG'}
    </div>
  )
}
