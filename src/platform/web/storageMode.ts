export const WEB_CATALOG_STORAGE_MODE_KEY =
  'geo-media-index-lab:web-catalog-storage-mode'

export const WEB_CATALOG_STORAGE_MODES = [
  'sqlite',
  'sqlite-memory',
  'indexeddb',
] as const

export type WebCatalogStorageMode =
  (typeof WEB_CATALOG_STORAGE_MODES)[number]

export function isWebCatalogStorageMode(
  value: string | null | undefined,
): value is WebCatalogStorageMode {
  return WEB_CATALOG_STORAGE_MODES.includes(value as WebCatalogStorageMode)
}

export function storedWebCatalogStorageMode(): WebCatalogStorageMode {
  const stored = window.localStorage.getItem(WEB_CATALOG_STORAGE_MODE_KEY)
  return isWebCatalogStorageMode(stored) ? stored : 'sqlite'
}
