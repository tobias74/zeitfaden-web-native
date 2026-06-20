import { useEffect, useState } from 'react'
import type { ThumbnailBackend } from '../platform/types'

type ThumbnailProps = {
  thumbnails: ThumbnailBackend
  thumbnailKey?: string
  label: string
  kind: 'image' | 'video'
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
  }, [thumbnailKey, thumbnails])

  if (url) {
    return <img className="thumb-image" src={url} alt={label} loading="lazy" />
  }

  return (
    <div className="thumb-placeholder" aria-label={label}>
      {kind === 'video' ? 'VID' : 'IMG'}
    </div>
  )
}
