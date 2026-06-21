import { describe, expect, it } from 'vitest'
import { detectMediaKind } from './media'

describe('media helpers', () => {
  it('detects only file-backed media kinds', () => {
    expect(detectMediaKind(new File(['x'], 'photo.jpg'))).toBe('image')
    expect(detectMediaKind(new File(['x'], 'clip.mp4'))).toBe('video')
    expect(detectMediaKind(new File(['x'], 'track.gpx'))).toBeUndefined()
  })
})
