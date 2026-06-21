import { describe, expect, it } from 'vitest'
import {
  WEB_CATALOG_STORAGE_MODE_KEY,
  isWebCatalogStorageMode,
  storedWebCatalogStorageMode,
} from './storageMode'

describe('web catalog storage mode', () => {
  it('validates supported storage modes', () => {
    expect(isWebCatalogStorageMode('sqlite')).toBe(true)
    expect(isWebCatalogStorageMode('indexeddb')).toBe(true)
    expect(isWebCatalogStorageMode('native')).toBe(false)
  })

  it('falls back to SQLite for missing or invalid stored values', () => {
    window.localStorage.removeItem(WEB_CATALOG_STORAGE_MODE_KEY)
    expect(storedWebCatalogStorageMode()).toBe('sqlite')

    window.localStorage.setItem(WEB_CATALOG_STORAGE_MODE_KEY, 'native')
    expect(storedWebCatalogStorageMode()).toBe('sqlite')
  })

  it('reads the stored IndexedDB setting', () => {
    window.localStorage.setItem(WEB_CATALOG_STORAGE_MODE_KEY, 'indexeddb')
    expect(storedWebCatalogStorageMode()).toBe('indexeddb')
  })
})
