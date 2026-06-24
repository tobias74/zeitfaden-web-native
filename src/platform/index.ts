import { createTauriPlatformBackend } from './tauri/backend'
import type { PlatformBackend } from './types'
import { createWebPlatformBackend } from './web/backend'
import { traceStartup } from '../lib/startupTrace'

export function hasTauriRuntime(candidate: unknown): boolean {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    ('__TAURI_INTERNALS__' in candidate || '__TAURI__' in candidate)
  )
}

function isTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    hasTauriRuntime(window)
  )
}

export function createPlatformBackend(): PlatformBackend {
  const tauri = isTauriRuntime()
  traceStartup('[startup:platform]', 'createPlatformBackend selected runtime', {
    tauri,
  })
  return tauri ? createTauriPlatformBackend() : createWebPlatformBackend()
}
