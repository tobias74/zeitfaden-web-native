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
const DEFAULT_POINT_COUNT = 100_000
const GEO_POINT_COUNT = Number(env.E2E_GEO_POINT_COUNT ?? DEFAULT_POINT_COUNT)
const TEST_TIMEOUT_MS = 300_000
const STEP_TIMEOUT_MS = 120_000

let server: ViteDevServer | undefined
let baseUrl = ''
let context: BrowserContext | undefined
let userDataDir = ''

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

async function expectNoUiError(page: Page): Promise<void> {
  const alert = page.getByRole('alert')
  if (await alert.count()) {
    const message = (await alert.first().innerText()).trim()
    throw new Error(`Unexpected UI error: ${message}`)
  }
}

async function waitForResultCards(page: Page, minimum = 1): Promise<void> {
  await page.waitForFunction(
    (minimumCount) => {
      const grid = document.querySelector('.media-grid')
      const busy = grid?.getAttribute('aria-busy')
      return (
        busy !== 'true' &&
        document.querySelectorAll('.media-card').length >= minimumCount
      )
    },
    minimum,
    { timeout: STEP_TIMEOUT_MS },
  )
}

async function waitForMapIdle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector('.map-loading-strip'),
    { timeout: STEP_TIMEOUT_MS },
  )
}

async function waitForIndexCurrent(page: Page, panelTitle: string): Promise<void> {
  const panel = page.locator('section.panel').filter({ hasText: panelTitle })
  await panel.locator('.index-status-badge.current').first().waitFor({
    timeout: STEP_TIMEOUT_MS,
  })
}

async function readMapMetricNumber(page: Page, label: string): Promise<number> {
  return page.evaluate((metricLabel) => {
    const mapSection = Array.from(document.querySelectorAll('.metrics-section'))
      .find((section) =>
        section.querySelector('.metrics-section-title')?.textContent?.trim() ===
          'Map query',
      )
    if (!mapSection) throw new Error('Map query metrics section not found')

    const metric = Array.from(mapSection.querySelectorAll('dl.metrics-grid > div'))
      .find((row) => row.querySelector('dt')?.textContent?.trim() === metricLabel)
    const value = metric?.querySelector('dd')?.textContent?.trim()
    if (!value) throw new Error(`Map metric not found: ${metricLabel}`)

    const normalized = value.replace(/[^\d.,-]/g, '').replace(/,/g, '')
    const parsed = Number(normalized)
    if (!Number.isFinite(parsed)) {
      throw new Error(`Map metric is not numeric: ${metricLabel}=${value}`)
    }
    return parsed
  }, label)
}

async function appDiagnostic(page: Page): Promise<string> {
  return page.evaluate(() => {
    const text = (selector: string) =>
      document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim()
        ?? ''
    const panelText = (title: string) =>
      Array.from(document.querySelectorAll('section.panel'))
        .find((panel) => panel.textContent?.includes(title))
        ?.textContent
        ?.replace(/\s+/g, ' ')
        .trim()
        .slice(0, 1_000)
        ?? ''

    return JSON.stringify(
      {
        alert: text('[role="alert"]'),
        topbarProgress: text('.topbar-progress-slot'),
        catalogPanel: panelText('Catalog indexes'),
        distancePanel: panelText('Distance index'),
        mediaCards: document.querySelectorAll('.media-card').length,
        mediaGridBusy: document.querySelector('.media-grid')?.getAttribute('aria-busy') ?? '',
        mapLoading: Boolean(document.querySelector('.map-loading-strip')),
      },
      null,
      2,
    )
  })
}

async function runStep(
  page: Page,
  name: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action()
  } catch (caught) {
    const diagnostic = await appDiagnostic(page).catch((error: unknown) =>
      `Could not read app diagnostic: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    const message = caught instanceof Error ? caught.message : String(caught)
    throw new Error(`${name} failed.\n${diagnostic}\n${message}`, {
      cause: caught,
    })
  }
}

function installGeneratedGeoFile(pageContext: BrowserContext): Promise<void> {
  return pageContext.addInitScript(
    ({ pointCount }) => {
      window.localStorage.setItem('geo-media-index-lab:language', 'en')
      window.localStorage.setItem('geo-media-index-lab:result-page-size', '100')
      window.localStorage.setItem('geo-media-index-lab:result-display-mode', 'cards')
      window.__ZEITFADEN_E2E_GEO_FILE__ = () => {
        const baseTime = new Date(2024, 0, 1, 0, 0, 0).getTime()
        const columns = 400
        const locations = Array.from({ length: pointCount }, (_, index) => ({
          latitudeE7: Math.round(
            (35 + ((index % columns) / columns) * 25) * 10_000_000,
          ),
          longitudeE7: Math.round(
            (-10 + ((Math.floor(index / columns) % 250) / 250) * 40) *
              10_000_000,
          ),
          timestamp: new Date(baseTime + index * 60_000).toISOString(),
        }))
        return new File(
          [JSON.stringify({ locations })],
          `zeitfaden-e2e-${pointCount}.json`,
          { type: 'application/json' },
        )
      }
    },
    { pointCount: GEO_POINT_COUNT },
  )
}

describeE2E('geo import and query UI e2e', () => {
  beforeAll(async () => {
    const port = 5300 + Math.floor(Math.random() * 500)
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

    userDataDir = await mkdtemp(path.join(tmpdir(), 'zeitfaden-e2e-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromeExecutable(),
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    await context.route(/tile\.openstreetmap\.org/, async (route) => {
      await route.fulfill({ status: 204, body: '' })
    })
    await installGeneratedGeoFile(context)
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await context?.close()
    await server?.close()
    if (userDataDir) await rm(userDataDir, { force: true, recursive: true })
  })

  it('imports a substantial geo file, builds indexes, and completes timestamp and distance queries', async () => {
    if (!context) throw new Error('Browser context was not initialized.')
    const page = await context.newPage()
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await runStep(page, 'Open app and import generated geo file', async () => {
      await page.goto(baseUrl)
      await page.getByRole('button', { name: /Import geo file/i }).click()
    })

    await runStep(page, 'Wait for catalog index build', async () => {
      await waitForIndexCurrent(page, 'Catalog indexes')
    })

    await runStep(page, 'Run initial timestamp query', async () => {
      await page.getByLabel('Kind').selectOption('geo_point')
      await page.getByLabel('Sort').selectOption('timestamp_asc')
      await waitForResultCards(page)
      await waitForMapIdle(page)
      await expectNoUiError(page)
      await expect(
        page.locator('.media-card').filter({ hasText: 'zeitfaden-e2e' }).first()
          .innerText(),
      ).resolves.toContain('#1')
    })

    await runStep(page, 'Change map bubble density without warnings or stalls', async () => {
      await page.locator('details.settings-menu summary').click()

      await page.getByLabel('Map bubble density').selectOption('80')
      await waitForMapIdle(page)
      await expectNoUiError(page)
      const spaciousBubbles = await readMapMetricNumber(page, 'Rendered bubbles')

      await page.getByLabel('Map bubble density').selectOption('48')
      await waitForMapIdle(page)
      await expectNoUiError(page)
      const compactBubbles = await readMapMetricNumber(page, 'Rendered bubbles')

      expect(spaciousBubbles).toBeGreaterThan(0)
      expect(compactBubbles).toBeGreaterThan(0)
      await expectNoUiError(page)
    })

    await runStep(page, 'Run bounded timeframe query', async () => {
      await page.getByRole('textbox', { name: 'From' }).fill('2024-01-10T00:00')
      await page.getByRole('textbox', { name: 'To' }).fill('2024-01-12T00:00')
      await waitForResultCards(page)
      await waitForMapIdle(page)
      await expectNoUiError(page)
    })

    await runStep(page, 'Build distance index and run distance query', async () => {
      const distancePanel = page.locator('section.panel').filter({
        hasText: 'Distance index',
      })
      await distancePanel.getByRole('button', {
        name: /Update index|Rebuild index/i,
      }).click()
      await waitForIndexCurrent(page, 'Distance index')
      await page.getByLabel('Sort').selectOption('distance')
      await waitForResultCards(page)
      await waitForMapIdle(page)
      await expectNoUiError(page)
    })

    expect(pageErrors).toEqual([])
    expect(consoleErrors.filter((entry) => !entry.includes('Failed to load resource'))).toEqual([])
  }, TEST_TIMEOUT_MS)
})
