import type { MediaKind } from '../types'

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'heic',
  'heif',
  'tif',
  'tiff',
  'avif',
])

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'm4v',
  'webm',
  'avi',
  'mkv',
  '3gp',
])

export function detectMediaKind(file: File): MediaKind | undefined {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'

  const extension = file.name.split('.').pop()?.toLowerCase()
  if (!extension) return undefined
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  return undefined
}

export function pathDisplayName(path: string): string {
  return path.split('/').pop() || path
}

