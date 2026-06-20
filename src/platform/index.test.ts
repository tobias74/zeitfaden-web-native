import { describe, expect, it } from 'vitest'
import { hasTauriRuntime } from './index'

describe('platform detection', () => {
  it('detects Tauri runtime globals', () => {
    expect(hasTauriRuntime({ __TAURI_INTERNALS__: {} })).toBe(true)
    expect(hasTauriRuntime({ __TAURI__: {} })).toBe(true)
    expect(hasTauriRuntime({})).toBe(false)
  })
})
