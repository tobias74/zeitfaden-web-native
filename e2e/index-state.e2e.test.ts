// @vitest-environment node

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

const env = process.env
const describeE2E = env.RUN_E2E_TESTS === '1' ? describe : describe.skip
const TEST_TIMEOUT_MS = 300_000
const STEP_TIMEOUT_MS = 120_000

type TestGeoPoint = {
  lat: number
  lon: number
  timestamp: string
}

let server: ViteDevServer | undefined
let baseUrl = ''
let context: BrowserContext | undefined
let page: Page | undefined
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

function pointsNearZurich(count: number, startMinute = 0): TestGeoPoint[] {
  const baseTime = new Date(2024, 0, 1, 12, 0, 0).getTime()
  return Array.from({ length: count }, (_, index) => ({
    lat: 47.36 + index * 0.001,
    lon: 8.52 + index * 0.001,
    timestamp: new Date(baseTime + (startMinute + index) * 60_000).toISOString(),
  }))
}

async function setGeoFile(
  activePage: Page,
  name: string,
  points: TestGeoPoint[],
): Promise<void> {
  await activePage.evaluate(
    ({ fileName, geoPoints }) => {
      const testWindow = window as typeof window & {
        __ZEITFADEN_E2E_GEO_FILE__?: () => File
      }
      testWindow.__ZEITFADEN_E2E_GEO_FILE__ = () =>
        new File(
          [
            JSON.stringify({
              locations: geoPoints.map((point) => ({
                latitudeE7: Math.round(point.lat * 10_000_000),
                longitudeE7: Math.round(point.lon * 10_000_000),
                timestamp: point.timestamp,
              })),
            }),
          ],
          fileName,
          { type: 'application/json' },
        )
    },
    { fileName: name, geoPoints: points },
  )
}

async function importGeoFile(
  activePage: Page,
  name: string,
  points: TestGeoPoint[],
): Promise<void> {
  await setGeoFile(activePage, name, points)
  await activePage.getByRole('button', { name: /Import geo file/i }).click()
}

function panel(activePage: Page, title: string) {
  return activePage.locator('section.panel').filter({ hasText: title })
}

function indexesPanel(activePage: Page) {
  return panel(activePage, 'Indexes')
}

async function waitForCombinedIndexStatus(
  activePage: Page,
  status: 'current' | 'missing' | 'stale' | 'failed' | 'indexing' | 'pending',
): Promise<void> {
  await indexesPanel(activePage)
    .locator('.index-status-row')
    .locator(`.index-status-badge.${status}`)
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function waitForAnyCombinedIndexStatus(
  activePage: Page,
  statuses: Array<'current' | 'missing' | 'stale' | 'failed' | 'indexing' | 'pending'>,
): Promise<void> {
  await indexesPanel(activePage)
    .locator('.index-status-row')
    .locator(statuses.map((status) => `.index-status-badge.${status}`).join(', '))
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function waitForIndexStatus(
  activePage: Page,
  indexId: string,
  status: 'current' | 'missing' | 'stale' | 'failed' | 'indexing' | 'pending' | 'building',
): Promise<void> {
  await indexesPanel(activePage)
    .locator(`[data-index-id="${indexId}"] .index-status-badge.${status}`)
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function expectIndexButtonLabel(
  activePage: Page,
  pattern: RegExp,
): Promise<void> {
  const button = indexesPanel(activePage).getByRole('button', { name: pattern })
  await button.waitFor({ timeout: STEP_TIMEOUT_MS })
  expect((await button.innerText()).trim()).toMatch(pattern)
}

async function waitForResultCardCount(
  activePage: Page,
  expectedCount: number,
): Promise<void> {
  await activePage.waitForFunction(
    (count) => {
      const grid = document.querySelector('.media-grid')
      const busy = grid?.getAttribute('aria-busy')
      return (
        busy !== 'true' &&
        document.querySelectorAll('.media-card').length === count
      )
    },
    expectedCount,
    { timeout: STEP_TIMEOUT_MS },
  )
}

async function expectNoUiError(activePage: Page): Promise<void> {
  const alert = activePage.getByRole('alert')
  if (await alert.count()) {
    const message = (await alert.first().innerText()).trim()
    throw new Error(`Unexpected UI error: ${message}`)
  }
}

async function waitForAlert(
  activePage: Page,
  pattern: RegExp,
): Promise<string> {
  const alert = activePage.getByRole('alert')
  await alert.waitFor({ timeout: STEP_TIMEOUT_MS })
  await activePage.waitForFunction(
    (source) => {
      const alertText = document.querySelector('[role="alert"]')?.textContent ?? ''
      return new RegExp(source, 'i').test(alertText)
    },
    pattern.source,
    { timeout: STEP_TIMEOUT_MS },
  )
  return (await alert.first().innerText()).trim()
}

async function waitForNoAlert(activePage: Page): Promise<void> {
  await activePage.waitForFunction(
    () => !document.querySelector('[role="alert"]'),
    { timeout: STEP_TIMEOUT_MS },
  )
}

async function buildDistanceIndex(activePage: Page): Promise<void> {
  await indexesPanel(activePage)
    .getByRole('button', { name: /Update indexes|Rebuild indexes/i })
    .click()
  await waitForIndexStatus(activePage, 'segmented-ball-tree', 'current')
  await waitForCombinedIndexStatus(activePage, 'current')
}

async function buildCatalogIndexes(activePage: Page): Promise<void> {
  await indexesPanel(activePage)
    .getByRole('button', { name: /Update indexes|Rebuild indexes/i })
    .click()
  await waitForIndexStatus(activePage, 'file-time-geo', 'current')
  await waitForCombinedIndexStatus(activePage, 'current')
}

async function deletePackedCatalogIndex(activePage: Page): Promise<void> {
  await activePage.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    const catalog = await root.getDirectoryHandle('catalog-file-v1')
    const indexes = await catalog.getDirectoryHandle('indexes')
    await indexes.removeEntry('time-geo.idx')
  })
}

async function openFreshApp(): Promise<Page> {
  if (!context) throw new Error('Browser context was not initialized.')
  const activePage = await context.newPage()
  await activePage.goto(baseUrl)
  return activePage
}

describeE2E('index state and query result e2e', () => {
  beforeAll(async () => {
    const port = 5800 + Math.floor(Math.random() * 500)
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

  beforeEach(async () => {
    userDataDir = await mkdtemp(path.join(tmpdir(), 'zeitfaden-index-e2e-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromeExecutable(),
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    await context.route(/tile\.openstreetmap\.org/, async (route) => {
      await route.fulfill({ status: 204, body: '' })
    })
    await context.addInitScript(() => {
      window.localStorage.setItem('geo-media-index-lab:language', 'en')
      window.localStorage.setItem('geo-media-index-lab:cookie-consent', 'accepted')
      window.localStorage.setItem('geo-media-index-lab:result-page-size', '100')
      window.localStorage.setItem('geo-media-index-lab:result-display-mode', 'cards')
    })
    page = await openFreshApp()
  }, TEST_TIMEOUT_MS)

  afterEach(async () => {
    await page?.close().catch(() => undefined)
    page = undefined
    await context?.close()
    context = undefined
    if (userDataDir) await rm(userDataDir, { force: true, recursive: true })
    userDataDir = ''
  })

  afterAll(async () => {
    await server?.close()
  })

  it('returns timestamp results with a current catalog index and clears them when the catalog index is missing', async () => {
    if (!page) throw new Error('Page was not initialized.')

    await importGeoFile(page, 'catalog-index-a.json', pointsNearZurich(3))
    await waitForIndexStatus(page, 'file-time-geo', 'current')
    await expectIndexButtonLabel(page, /Update indexes/i)
    await page.getByLabel('Kind').selectOption('geo_point')
    await page.getByLabel('Sort').selectOption('timestamp_asc')
    await waitForResultCardCount(page, 3)
    await expectNoUiError(page)

    await deletePackedCatalogIndex(page)
    await page.reload()
    await waitForAlert(
      page,
      /Catalog indexes|Time-first packed index|missing|loaded into memory/,
    )
    await waitForResultCardCount(page, 0)
    await waitForAnyCombinedIndexStatus(page, ['missing', 'failed'])

    await buildCatalogIndexes(page)
    await waitForNoAlert(page)
    await waitForResultCardCount(page, 3)
  }, TEST_TIMEOUT_MS)

  it('shows the catalog index headline as current when only the distance index is missing', async () => {
    if (!page) throw new Error('Page was not initialized.')

    await importGeoFile(page, 'catalog-index-current-distance-missing.json', pointsNearZurich(3))
    await waitForIndexStatus(page, 'file-time-geo', 'current')
    await waitForIndexStatus(page, 'segmented-ball-tree', 'missing')
    await waitForCombinedIndexStatus(page, 'current')
    expect(
      await indexesPanel(page)
        .locator('.index-status-row .index-status-badge.missing')
        .count(),
    ).toBe(0)
    await expectNoUiError(page)
  }, TEST_TIMEOUT_MS)

  it('clears distance results when the selected distance index is missing, stale, and restores them after rebuild', async () => {
    if (!page) throw new Error('Page was not initialized.')

    await importGeoFile(page, 'distance-index-a.json', pointsNearZurich(4))
    await waitForIndexStatus(page, 'file-time-geo', 'current')
    await page.getByLabel('Kind').selectOption('geo_point')
    await page.getByLabel('Sort').selectOption('timestamp_asc')
    await waitForResultCardCount(page, 4)
    await waitForIndexStatus(page, 'segmented-ball-tree', 'missing')
    await expectIndexButtonLabel(page, /Update indexes/i)

    await page.getByLabel('Sort').selectOption('distance')
    await waitForAlert(page, /index is missing|No exact search index/i)
    await waitForResultCardCount(page, 0)

    await buildDistanceIndex(page)
    await waitForCombinedIndexStatus(page, 'current')
    await expectIndexButtonLabel(page, /Rebuild indexes/i)
    await waitForNoAlert(page)
    await waitForResultCardCount(page, 4)

    await importGeoFile(page, 'distance-index-b.json', pointsNearZurich(2, 60))
    await waitForIndexStatus(page, 'file-time-geo', 'current')
    await waitForIndexStatus(page, 'segmented-ball-tree', 'stale')
    await expectIndexButtonLabel(page, /Update indexes/i)
    await waitForAlert(page, /index is stale|No exact search index/i)
    await waitForResultCardCount(page, 0)

    await buildDistanceIndex(page)
    await waitForNoAlert(page)
    await waitForResultCardCount(page, 6)
  }, TEST_TIMEOUT_MS)
})
