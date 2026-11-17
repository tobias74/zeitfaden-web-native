export const APP_PATH = '/'

export const INFO_PAGES = [
  { id: 'about', path: '/about' },
  { id: 'imprint', path: '/impressum' },
  { id: 'privacy', path: '/datenschutz' },
] as const

export function pageFromPath(pathname: string): 'app' | (typeof INFO_PAGES)[number]['id'] {
  const path = pathname.replace(/\/+$/, '')
  return INFO_PAGES.find((page) => page.path === path)?.id ?? 'app'
}
