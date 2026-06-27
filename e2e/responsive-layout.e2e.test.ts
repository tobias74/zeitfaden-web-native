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
const APPBAR_VIEWPORTS = [
  { name: 'narrow phone', width: 360, height: 780 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'small tablet', width: 640, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'large tablet', width: 980, height: 900 },
  { name: 'small desktop', width: 1024, height: 720 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'wide desktop', width: 1440, height: 900 },
  { name: 'large desktop', width: 1600, height: 900 },
] as const
const APPBAR_ALERT_VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'large desktop', width: 1600, height: 900 },
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

async function appbarReport(page: Page): Promise<{
  controlsOutside: string[]
  wrappedLegalLinks: string[]
  topbarOverflowPx: number
  viewportWidth: number
}> {
  return page.evaluate(() => {
    const topbar = document.querySelector('.topbar')
    if (!topbar) {
      return {
        controlsOutside: ['missing .topbar'],
        wrappedLegalLinks: [],
        topbarOverflowPx: 0,
        viewportWidth: window.innerWidth,
      }
    }
    const topbarRect = topbar.getBoundingClientRect()
    const viewportLeft = -(window.visualViewport?.offsetLeft ?? 0)
    const viewportRight = viewportLeft + window.innerWidth
    const left = Math.max(topbarRect.left, viewportLeft)
    const right = Math.min(topbarRect.right, viewportRight)
    const controlSummary = (element: Element, rect: DOMRect) =>
      `${element.tagName.toLowerCase()}.${
        typeof element.className === 'string'
          ? element.className.replace(/\s+/g, '.')
          : ''
      } "${element.textContent?.replace(/\s+/g, ' ').trim() ?? ''}" ${Math.round(
        rect.left,
      )}-${Math.round(rect.right)}`

    const controlsOutside = Array.from(
      topbar.querySelectorAll('button, select, summary'),
    ).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      if (
        rect.width <= 1 ||
        rect.height <= 1 ||
        (rect.left >= left - 2 && rect.right <= right + 2)
      ) {
        return []
      }
      return [controlSummary(element, rect)]
    })

    const wrappedLegalLinks = Array.from(
      topbar.querySelectorAll('.topbar-nav .topbar-link'),
    ).flatMap((element) => {
      const rect = element.getBoundingClientRect()
      return rect.height > 32 ? [controlSummary(element, rect)] : []
    })

    return {
      controlsOutside,
      wrappedLegalLinks,
      topbarOverflowPx: Math.max(
        0,
        topbar.scrollWidth - topbar.clientWidth,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      viewportWidth: window.innerWidth,
    }
  })
}

async function mapSettingsPlacementReport(page: Page): Promise<{
  missing: string[]
  settingsParentIsControlPane: boolean
  queryParentIsControlPane: boolean
  settingsImmediatelyBeforeQuery: boolean
  settingsBelowResizeHandle: boolean
  queryBelowResizeHandle: boolean
  hasDisclosureIcon: boolean
  settingsTop: number
  queryTop: number
  resizeBottom: number
}> {
  return page.evaluate(() => {
    const settings = document.querySelector('.map-settings-accordion')
    const resizeHandle = document.querySelector('.resize-handle-horizontal')
    const controlPane = document.querySelector('.control-pane')
    const queryPanel = Array.from(controlPane?.children ?? []).find(
      (element) =>
        element.matches('section.panel') &&
        element.querySelector('h2')?.textContent?.trim() === 'Query',
    )
    const missing = [
      settings ? undefined : '.map-settings-accordion',
      resizeHandle ? undefined : '.resize-handle-horizontal',
      controlPane ? undefined : '.control-pane',
      queryPanel ? undefined : 'query panel',
    ].filter((value): value is string => Boolean(value))
    const settingsRect = settings?.getBoundingClientRect()
    const resizeRect = resizeHandle?.getBoundingClientRect()
    const queryRect = queryPanel?.getBoundingClientRect()

    return {
      missing,
      settingsParentIsControlPane: settings?.parentElement === controlPane,
      queryParentIsControlPane: queryPanel?.parentElement === controlPane,
      settingsImmediatelyBeforeQuery: settings?.nextElementSibling === queryPanel,
      settingsBelowResizeHandle: Boolean(
        settingsRect &&
          resizeRect &&
          settingsRect.top >= resizeRect.bottom - 2,
      ),
      queryBelowResizeHandle: Boolean(
        queryRect &&
          resizeRect &&
        queryRect.top >= resizeRect.bottom - 2,
      ),
      hasDisclosureIcon: Boolean(
        settings?.querySelector('.accordion-chevron'),
      ),
      settingsTop: settingsRect?.top ?? Number.NaN,
      queryTop: queryRect?.top ?? Number.NaN,
      resizeBottom: resizeRect?.bottom ?? Number.NaN,
    }
  })
}

async function appbarAlertReport(page: Page): Promise<{
  alertMissing: boolean
  alertOutside: string[]
  overlaps: string[]
  alertBelowFirstRow: boolean
  titleTopDeltaPx: number
  alertLeftDeltaToTitlePx: number
  alertRightDeltaToActionsPx: number
  topbarOverflowPx: number
  viewportWidth: number
}> {
  return page.evaluate(() => {
    const topbar = document.querySelector('.topbar')
    const alert = topbar?.querySelector('[role="alert"]')
    if (!topbar || !alert) {
      return {
        alertMissing: true,
        alertOutside: [],
        overlaps: [],
        alertBelowFirstRow: false,
        titleTopDeltaPx: Number.POSITIVE_INFINITY,
        alertLeftDeltaToTitlePx: Number.POSITIVE_INFINITY,
        alertRightDeltaToActionsPx: Number.POSITIVE_INFINITY,
        topbarOverflowPx: 0,
        viewportWidth: window.innerWidth,
      }
    }

    const topbarRect = topbar.getBoundingClientRect()
    const alertRect = alert.getBoundingClientRect()
    const viewportLeft = -(window.visualViewport?.offsetLeft ?? 0)
    const viewportRight = viewportLeft + window.innerWidth
    const visibleRect = (rect: DOMRect) => rect.width > 1 && rect.height > 1
    const outside = (rect: DOMRect) =>
      visibleRect(rect) &&
      (
        rect.left < Math.max(topbarRect.left, viewportLeft) - 2 ||
        rect.right > Math.min(topbarRect.right, viewportRight) + 2 ||
        rect.top < topbarRect.top - 2 ||
        rect.bottom > topbarRect.bottom + 2
      )
    const intersects = (a: DOMRect, b: DOMRect) =>
      visibleRect(a) &&
      visibleRect(b) &&
      a.left < b.right - 1 &&
      a.right > b.left + 1 &&
      a.top < b.bottom - 1 &&
      a.bottom > b.top + 1
    const summary = (selector: string, rect: DOMRect) =>
      `${selector} ${Math.round(rect.left)},${Math.round(rect.top)}-${Math.round(
        rect.right,
      )},${Math.round(rect.bottom)}`

    const firstRowSelectors = ['.topbar h1', '.topbar-nav', '.topbar-actions']
    const firstRowRects = firstRowSelectors.flatMap((selector) => {
      const element = topbar.querySelector(selector)
      return element ? [{ selector, rect: element.getBoundingClientRect() }] : []
    })
    const actionRect = topbar.querySelector('.topbar-actions')?.getBoundingClientRect()
    const titleRect = topbar.querySelector('.topbar h1')?.getBoundingClientRect()
    const firstRowBottom = Math.max(...firstRowRects.map(({ rect }) => rect.bottom))

    return {
      alertMissing: false,
      alertOutside: outside(alertRect) ? [summary('[role="alert"]', alertRect)] : [],
      overlaps: firstRowRects.flatMap(({ selector, rect }) =>
        intersects(alertRect, rect) ? [summary(selector, rect)] : [],
      ),
      alertBelowFirstRow: alertRect.top >= firstRowBottom + 4,
      titleTopDeltaPx:
        actionRect && titleRect ? Math.abs(titleRect.top - actionRect.top) : Number.POSITIVE_INFINITY,
      alertLeftDeltaToTitlePx:
        titleRect ? Math.abs(alertRect.left - titleRect.left) : Number.POSITIVE_INFINITY,
      alertRightDeltaToActionsPx:
        actionRect ? Math.abs(alertRect.right - actionRect.right) : Number.POSITIVE_INFINITY,
      topbarOverflowPx: Math.max(
        0,
        topbar.scrollWidth - topbar.clientWidth,
        document.documentElement.scrollWidth - window.innerWidth,
      ),
      viewportWidth: window.innerWidth,
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

  it('keeps the appbar controls inside the header across common widths', async () => {
    const { context, userDataDir } = await createContext({
      width: 1600,
      height: 900,
    })
    const page = await context.newPage()
    try {
      for (const viewport of APPBAR_VIEWPORTS) {
        await page.setViewportSize(viewport)
        await page.goto(baseUrl)
        await page.locator('.topbar').waitFor({ timeout: STEP_TIMEOUT_MS })
        const report = await appbarReport(page)
        expect(report.controlsOutside, `${viewport.name} ${JSON.stringify(report)}`).toEqual(
          [],
        )
        expect(
          report.wrappedLegalLinks,
          `${viewport.name} ${JSON.stringify(report)}`,
        ).toEqual([])
        expect(report.topbarOverflowPx, `${viewport.name} ${JSON.stringify(report)}`).toBeLessThanOrEqual(2)
      }
    } finally {
      await page.close().catch(() => undefined)
      await context.close()
      await rm(userDataDir, { force: true, recursive: true })
    }
  }, TEST_TIMEOUT_MS)

  it('keeps map settings below the map resize handle before query', async () => {
    const { context, userDataDir } = await createContext({
      width: 1280,
      height: 720,
    })
    const page = await context.newPage()
    try {
      await page.goto(baseUrl)
      await page.locator('.map-settings-accordion').waitFor({
        timeout: STEP_TIMEOUT_MS,
      })

      const report = await mapSettingsPlacementReport(page)
      expect(report.missing, JSON.stringify(report)).toEqual([])
      expect(report.settingsParentIsControlPane, JSON.stringify(report)).toBe(true)
      expect(report.queryParentIsControlPane, JSON.stringify(report)).toBe(true)
      expect(report.settingsImmediatelyBeforeQuery, JSON.stringify(report)).toBe(true)
      expect(report.queryBelowResizeHandle, JSON.stringify(report)).toBe(true)
      expect(report.settingsBelowResizeHandle, JSON.stringify(report)).toBe(true)
      expect(report.hasDisclosureIcon, JSON.stringify(report)).toBe(true)
    } finally {
      await page.close().catch(() => undefined)
      await context.close()
      await rm(userDataDir, { force: true, recursive: true })
    }
  }, TEST_TIMEOUT_MS)

  it('keeps the index error banner in its own appbar row on desktop widths', async () => {
    const { context, userDataDir } = await createContext({
      width: 1600,
      height: 900,
    })
    const page = await context.newPage()
    try {
      for (const viewport of APPBAR_ALERT_VIEWPORTS) {
        await page.setViewportSize(viewport)
        await page.goto(baseUrl)
        await page.locator('.topbar').waitFor({ timeout: STEP_TIMEOUT_MS })
        await page
          .getByRole('alert')
          .filter({ hasText: /index.*missing/i })
          .waitFor({ timeout: STEP_TIMEOUT_MS })

        const report = await appbarAlertReport(page)
        expect(report.alertMissing, `${viewport.name} ${JSON.stringify(report)}`).toBe(false)
        expect(report.alertOutside, `${viewport.name} ${JSON.stringify(report)}`).toEqual([])
        expect(report.overlaps, `${viewport.name} ${JSON.stringify(report)}`).toEqual([])
        expect(report.alertBelowFirstRow, `${viewport.name} ${JSON.stringify(report)}`).toBe(true)
        expect(report.titleTopDeltaPx, `${viewport.name} ${JSON.stringify(report)}`).toBeLessThanOrEqual(12)
        expect(report.alertLeftDeltaToTitlePx, `${viewport.name} ${JSON.stringify(report)}`).toBeLessThanOrEqual(2)
        expect(report.alertRightDeltaToActionsPx, `${viewport.name} ${JSON.stringify(report)}`).toBeLessThanOrEqual(2)
        expect(report.topbarOverflowPx, `${viewport.name} ${JSON.stringify(report)}`).toBeLessThanOrEqual(2)
      }
    } finally {
      await page.close().catch(() => undefined)
      await context.close()
      await rm(userDataDir, { force: true, recursive: true })
    }
  }, TEST_TIMEOUT_MS)

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

        const openSettingsReport = await layoutReport(page)
        expect(
          openSettingsReport.settingsPopoverOutside,
          JSON.stringify(openSettingsReport),
        ).toEqual([])

        await page.evaluate(() => {
          document.querySelector('details.settings-menu')?.removeAttribute('open')
        })
        await page.locator('details.map-settings-accordion summary').click()
        await page.getByLabel('Map bubble density').selectOption('80')

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
