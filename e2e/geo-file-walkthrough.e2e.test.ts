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
const TEST_TIMEOUT_MS = 180_000
const STEP_TIMEOUT_MS = 90_000

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

function indexesPanel(page: Page) {
  return page.locator('section.panel').filter({ hasText: 'Indexes' })
}

async function waitForIndexCurrent(page: Page, indexId: string): Promise<void> {
  await indexesPanel(page)
    .locator(`[data-index-id="${indexId}"] .index-status-badge.current`)
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function waitForResultCardCount(
  page: Page,
  expectedCount: number,
): Promise<void> {
  await page.waitForFunction(
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

async function expectNoUiError(page: Page): Promise<void> {
  const alert = page.getByRole('alert')
  if (await alert.count()) {
    const message = (await alert.first().innerText()).trim()
    throw new Error(`Unexpected UI error: ${message}`)
  }
}

function installSampleGeoFile(pageContext: BrowserContext): Promise<void> {
  return pageContext.addInitScript(() => {
    window.localStorage.setItem('geo-media-index-lab:language', 'en')
    window.localStorage.setItem('geo-media-index-lab:result-page-size', '50')
    window.localStorage.setItem('geo-media-index-lab:result-display-mode', 'cards')
    window.__ZEITFADEN_E2E_GEO_FILE__ = () =>
      new File(
        [
          JSON.stringify({
            locations: [
              {
                latitudeE7: 481370673,
                longitudeE7: 115758708,
                timestamp: '2024-06-01T10:00:00.000Z',
                source: 'GPS',
                accuracy: 8,
              },
              {
                latitudeE7: 481377000,
                longitudeE7: 115762000,
                timestamp: '2024-06-01T10:30:00.000Z',
                source: 'WIFI',
                accuracy: 18,
              },
              {
                latitudeE7: 481385000,
                longitudeE7: 115769000,
                timestamp: '2024-06-01T11:00:00.000Z',
                source: 'GPS',
                accuracy: 6,
              },
              {
                latitudeE7: 481400000,
                longitudeE7: 115780000,
                timestamp: '2024-06-03T10:00:00.000Z',
                source: 'CELL',
                accuracy: 600,
              },
            ],
          }),
        ],
        'zeitfaden-sample-walkthrough.json',
        { type: 'application/json' },
      )
  })
}

describeE2E('sample geo file import walkthrough', () => {
  beforeAll(async () => {
    const port = 6100 + Math.floor(Math.random() * 500)
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

    userDataDir = await mkdtemp(path.join(tmpdir(), 'zeitfaden-walkthrough-e2e-'))
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: chromeExecutable(),
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    await context.route(/tile\.openstreetmap\.org/, async (route) => {
      await route.fulfill({ status: 204, body: '' })
    })
    await installSampleGeoFile(context)
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await context?.close()
    await server?.close()
    if (userDataDir) await rm(userDataDir, { force: true, recursive: true })
  })

  it('imports a sample geo file, runs a time query, and shows matching results', async () => {
    if (!context) throw new Error('Browser context was not initialized.')
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto(baseUrl)
    await page.getByRole('button', { name: /Import geo files?/i }).click()
    await waitForIndexCurrent(page, 'file-time-geo')

    await page.getByLabel('Kind').selectOption('geo_point')
    await page.getByLabel('Sort').selectOption('timestamp_asc')
    await waitForResultCardCount(page, 4)
    await expectNoUiError(page)

    await page.getByRole('textbox', { name: 'From' }).fill('2024-06-01T00:00')
    await page.getByRole('textbox', { name: 'To' }).fill('2024-06-01T23:59')
    await waitForResultCardCount(page, 3)
    await expectNoUiError(page)

    const resultText = (await page.locator('.media-card').allInnerTexts()).join(
      '\n',
    )
    expect(resultText).toContain('zeitfaden-sample-walkthrough.json #1')
    expect(resultText).toContain('zeitfaden-sample-walkthrough.json #2')
    expect(resultText).toContain('zeitfaden-sample-walkthrough.json #3')
    expect(resultText).not.toContain('zeitfaden-sample-walkthrough.json #4')
    expect(pageErrors).toEqual([])
  }, TEST_TIMEOUT_MS)
})
