import { useEffect, useState } from 'react'

type ThumbnailProps = {
  thumbnailKey?: string
  label: string
  kind: 'image' | 'video'
}

export function Thumbnail({ thumbnailKey, label, kind }: ThumbnailProps) {
  const [url, setUrl] = useState<string>()

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | undefined

    async function loadThumbnail() {
      if (!thumbnailKey) {
        setUrl(undefined)
        return
      }

      try {
        const [directory, fileName] = thumbnailKey.split('/')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle(directory)
        const handle = await dir.getFileHandle(fileName)
        const file = await handle.getFile()
        objectUrl = URL.createObjectURL(file)
        if (!cancelled) setUrl(objectUrl)
      } catch {
        if (!cancelled) setUrl(undefined)
      }
    }

    loadThumbnail()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [thumbnailKey])

  if (url) {
    return <img className="thumb-image" src={url} alt={label} loading="lazy" />
  }

  return (
    <div className="thumb-placeholder" aria-label={label}>
      {kind === 'video' ? 'VID' : 'IMG'}
    </div>
  )
}

