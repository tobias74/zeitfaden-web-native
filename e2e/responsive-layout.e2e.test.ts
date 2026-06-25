// @vitest-environment node

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

const env = process.env
const describeE2E = env.RUN_E2E_TESTS === '1' ? describe : describe.skip
const TEST_TIMEOUT_MS = 300_000
const STEP_TIMEOUT_MS = 120_000
const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 720 },
] as const

let server: ViteDevServer | undefined
let baseUrl = ''

function chromeExecutable(): string {
  const candidates = [
    env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter((candidate): candidate is string => Boolean(candidate))
  const executable = candidates.find((candidate) => existsSync(candidate))
  if (!executable) {
    throw new Error(
      'No Chromium executable found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE.',
    )
  }
  return executable
}

async function waitForDevServerUrl(): Promise<string> {
  const urls = server?.resolvedUrls?.local ?? []
  const url = urls.find((candidate) => candidate.startsWith('http://127.0.0.1'))
    ?? urls[0]
  if (!url) throw new Error('Vite did not expose a local dev server URL.')
  return url
}

async function createContext(
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; userDataDir: string }> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'zeitfaden-responsive-'))
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeExecutable(),
    headless: true,
    viewport,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  await context.route(/tile\.openstreetmap\.org/, async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await context.addInitScript(() => {
    window.localStorage.setItem('geo-media-index-lab:language', 'en')
    window.localStorage.setItem('geo-media-index-lab:result-page-size', '50')
    window.localStorage.setItem('geo-media-index-lab:result-display-mode', 'cards')
    window.__ZEITFADEN_E2E_GEO_FILE__ = () => {
      const baseTime = new Date(2024, 0, 1, 12, 0, 0).getTime()
      const locations = Array.from({ length: 36 }, (_, index) => ({
        latitudeE7: Math.round((47.28 + (index % 6) * 0.03) * 10_000_000),
        longitudeE7: Math.round((8.38 + Math.floor(index / 6) * 0.03) * 10_000_000),
        timestamp: new Date(baseTime + index * 60_000).toISOString(),
      }))
      return new File(
        [JSON.stringify({ locations })],
        'responsive-layout-points.json',
        { type: 'application/json' },
      )
    }
  })
  return { context, userDataDir }
}

async function waitForIndexCurrent(page: Page): Promise<void> {
  await page
    .locator('[data-index-id="file-time-geo"] .index-status-badge.current')
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function waitForResultCards(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const grid = document.querySelector('.media-grid')
      const busy = grid?.getAttribute('aria-busy')
      return busy !== 'true' && document.querySelectorAll('.media-card').length > 0
    },
    { timeout: STEP_TIMEOUT_MS },
  )
}

async function expectNoUiError(page: Page): Promise<void> {
  const alert = page.getByRole('alert')
  if (await alert.count()) {
    const message = (await alert.first().innerText()).trim()
    throw new Error(`Unexpected UI error: ${message}`)
  }
}

async function layoutReport(page: Page): Promise<{
  horizontalOverflowPx: number
  keyBoxesOutside: string[]
  controlsOutside: string[]
  settingsPopoverOutside: string[]
  mobileLibraryReachable: boolean
  viewportWidth: number
  scrollWidth: number
  scrollX: number
  visualViewportOffsetLeft: number
}> {
  return page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    window.scrollTo(0, window.scrollY)
    const viewportWidth = window.innerWidth
    const viewportLeft = -(window.visualViewport?.offsetLeft ?? 0)
    const viewportRight = viewportLeft + viewportWidth
    const outside = (rect: DOMRect) =>
      rect.width > 1 &&
      rect.height > 1 &&
      (rect.left < viewportLeft - 2 || rect.right > viewportRight + 2)
    const rectSummary = (element: Element, rect: DOMRect) =>
      `${element.tagName.toLowerCase()}.${
        typeof element.className === 'string'
          ? element.className.replace(/\s+/g, '.')
          : ''
      } "${element.textContent?.replace(/\s+/g, ' ').trim() ?? ''}" ${Math.round(
        rect.left,
      )}-${Math.round(rect.right)}`

    const keyBoxesOutside = [
      '.topbar',
      '.workspace',
      '.left-stack',
      '.map-pane',
      '.control-pane',
      '.library-strip',
    ].flatMap((selector) => {
      const element = document.querySelector(selector)
      if (!element) return []
      const rect = element.getBoundingClientRect()
      return outside(rect) ? [`${selector} ${Math.round(rect.left)}-${Math.round(rect.right)}`] : []
    })

    const controlsOutside = Array.from(
      document.querySelectorAll('button, input, select, summary'),
    ).flatMap((element) => {
      if (element.closest('.map-view')) return []
      const rect = element.getBoundingClientRect()
      return outside(rect) ? [rectSummary(element, rect)] : []
    })

    const settingsPopoverOutside = Array.from(
      document.querySelectorAll('.settings-popover'),
    ).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      return outside(rect) ? [rectSummary(element, rect)] : []
    })

    let mobileLibraryReachable = true
    if (window.innerWidth <= 980) {
      const scroller = document.scrollingElement
      const library = document.querySelector('.library-strip')
      if (!scroller || !library) {
        mobileLibraryReachable = false
      } else {
        scroller.scrollTop = scroller.scrollHeight
        mobileLibraryReachable =
          library.getBoundingClientRect().bottom <= window.innerHeight + 2
      }
    }

    return {
      horizontalOverflowPx: Math.max(
        0,
        document.documentElement.scrollWidth - viewportWidth,
      ),
      keyBoxesOutside,
      controlsOutside,
      settingsPopoverOutside,
      mobileLibraryReachable,
      viewportWidth,
      scrollWidth: document.documentElement.scrollWidth,
      scrollX: window.scrollX,
      visualViewportOffsetLeft: window.visualViewport?.offsetLeft ?? 0,
    }
  })
}

describeE2E('responsive layout e2e', () => {
  beforeAll(async () => {
    const port = 6000 + Math.floor(Math.random() * 500)
    server = await createServer({
      configFile: path.join(process.cwd(), 'vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
      },
    })
    await server.listen()
    baseUrl = await waitForDevServerUrl()
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await server?.close()
  })

  for (const viewport of VIEWPORTS) {
    it(`keeps app controls usable on ${viewport.name}`, async () => {
      const { context, userDataDir } = await createContext(viewport)
      const page = await context.newPage()
      try {
        await page.goto(baseUrl)
        await page.getByRole('button', { name: /Import geo file/i }).click()
        await waitForIndexCurrent(page)
        await page.getByLabel('Kind').selectOption('geo_point')
        await waitForResultCards(page)
        await expectNoUiError(page)

        await page.locator('details.settings-menu summary').click()
        await page.getByLabel('Show debug data').check()
        await page.getByLabel('Map bubble density').selectOption('80')

        const openSettingsReport = await layoutReport(page)
        expect(
          openSettingsReport.settingsPopoverOutside,
          JSON.stringify(openSettingsReport),
        ).toEqual([])

        await page.evaluate(() => {
          document.querySelector('details.settings-menu')?.removeAttribute('open')
        })
        const report = await layoutReport(page)
        expect(report.keyBoxesOutside, JSON.stringify(report)).toEqual([])
        expect(report.controlsOutside, JSON.stringify(report)).toEqual([])
        expect(report.horizontalOverflowPx).toBeLessThanOrEqual(2)
        expect(report.mobileLibraryReachable).toBe(true)
      } finally {
        await page.close().catch(() => undefined)
        await context.close()
        await rm(userDataDir, { force: true, recursive: true })
      }
    }, TEST_TIMEOUT_MS)
  }
})
