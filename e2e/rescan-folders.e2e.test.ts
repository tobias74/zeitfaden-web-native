// @vitest-environment node

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'

const env = process.env
const describeE2E = env.RUN_E2E_TESTS === '1' ? describe : describe.skip
const TEST_TIMEOUT_MS = 300_000
const STEP_TIMEOUT_MS = 120_000

let server: ViteDevServer | undefined
let baseUrl = ''
let context: BrowserContext | undefined
let page: Page | undefined
let userDataDir = ''

type TestFile = {
  name: string
  body: string
}

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

async function installFolderHarness(pageContext: BrowserContext): Promise<void> {
  await pageContext.addInitScript(() => {
    const testWindow = window as typeof window & {
      __ZEITFADEN_E2E_DIRECTORY_HANDLE__?: () => Promise<FileSystemDirectoryHandle>
      __ZEITFADEN_E2E_SET_DIRECTORY__?: (id: string) => void
      __ZEITFADEN_E2E_SET_DIRECTORY_FILES__?: (
        id: string,
        files: TestFile[],
      ) => Promise<void>
    }
    let currentDirectoryId = 'a'

    async function directory(id: string): Promise<FileSystemDirectoryHandle> {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(`rescan-${id}`, { create: true })
    }

    testWindow.__ZEITFADEN_E2E_SET_DIRECTORY__ = (id: string) => {
      currentDirectoryId = id
    }
    testWindow.__ZEITFADEN_E2E_SET_DIRECTORY_FILES__ = async (
      id: string,
      files: TestFile[],
    ) => {
      const dir = await directory(id)
      for await (const [name] of dir.entries()) {
        await dir.removeEntry(name, { recursive: true })
      }
      for (const file of files) {
        const handle = await dir.getFileHandle(file.name, { create: true })
        const writable = await handle.createWritable()
        await writable.write(new Blob([file.body], { type: 'image/jpeg' }))
        await writable.close()
      }
    }
    testWindow.__ZEITFADEN_E2E_DIRECTORY_HANDLE__ = () =>
      directory(currentDirectoryId)
  })
}

async function setDirectoryFiles(
  activePage: Page,
  id: string,
  files: TestFile[],
): Promise<void> {
  await activePage.evaluate(
    async ({ directoryId, nextFiles }) => {
      const testWindow = window as typeof window & {
        __ZEITFADEN_E2E_SET_DIRECTORY_FILES__?: (
          id: string,
          files: TestFile[],
        ) => Promise<void>
      }
      await testWindow.__ZEITFADEN_E2E_SET_DIRECTORY_FILES__?.(
        directoryId,
        nextFiles,
      )
    },
    { directoryId: id, nextFiles: files },
  )
}

async function importDirectory(activePage: Page, id: string): Promise<void> {
  await activePage.evaluate((directoryId) => {
    const testWindow = window as typeof window & {
      __ZEITFADEN_E2E_SET_DIRECTORY__?: (id: string) => void
    }
    testWindow.__ZEITFADEN_E2E_SET_DIRECTORY__?.(directoryId)
  }, id)
  await activePage.getByRole('button', { name: /Import media folder/i }).click()
  await waitForIndexCurrent(activePage)
}

async function rescanFolders(activePage: Page): Promise<void> {
  await activePage.getByRole('button', { name: /Rescan folders/i }).click()
  await waitForIndexCurrent(activePage)
}

async function waitForIndexCurrent(activePage: Page): Promise<void> {
  await activePage
    .locator('[data-index-id="file-time-geo"] .index-status-badge.current')
    .first()
    .waitFor({ timeout: STEP_TIMEOUT_MS })
}

async function waitForCards(
  activePage: Page,
  expectedCount: number,
  present: string[],
  absent: string[],
): Promise<void> {
  await activePage.waitForFunction(
    ({ count, presentNames, absentNames }) => {
      const grid = document.querySelector('.media-grid')
      const busy = grid?.getAttribute('aria-busy')
      const cards = Array.from(document.querySelectorAll('.media-card'))
      const text = cards.map((card) => card.textContent ?? '').join('\n')
      return (
        busy !== 'true' &&
        cards.length === count &&
        presentNames.every((name) => text.includes(name)) &&
        absentNames.every((name) => !text.includes(name))
      )
    },
    { count: expectedCount, presentNames: present, absentNames: absent },
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

describeE2E('folder rescan e2e', () => {
  beforeAll(async () => {
    const port = 6500 + Math.floor(Math.random() * 500)
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
    userDataDir = await mkdtemp(path.join(tmpdir(), 'zeitfaden-rescan-e2e-'))
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
      window.localStorage.setItem('geo-media-index-lab:result-page-size', '50')
      window.localStorage.setItem('geo-media-index-lab:result-display-mode', 'cards')
    })
    await installFolderHarness(context)
    page = await context.newPage()
    await page.goto(baseUrl)
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

  it('removes deleted folder occurrences while preserving other locations', async () => {
    if (!page) throw new Error('Page was not initialized.')

    await setDirectoryFiles(page, 'a', [
      { name: 'shared.jpg', body: 'shared-content' },
      { name: 'a-only.jpg', body: 'a-only-content' },
    ])
    await setDirectoryFiles(page, 'b', [
      { name: 'shared.jpg', body: 'shared-content' },
      { name: 'b-only.jpg', body: 'b-only-content' },
    ])

    await importDirectory(page, 'a')
    await importDirectory(page, 'b')
    await page.getByLabel('Kind').selectOption('image')
    await waitForCards(
      page,
      3,
      ['shared.jpg', 'a-only.jpg', 'b-only.jpg'],
      [],
    )
    await expectNoUiError(page)

    await setDirectoryFiles(page, 'a', [
      { name: 'a-only.jpg', body: 'a-only-content' },
    ])
    await rescanFolders(page)
    await waitForCards(
      page,
      3,
      ['shared.jpg', 'a-only.jpg', 'b-only.jpg'],
      [],
    )
    await expectNoUiError(page)

    await setDirectoryFiles(page, 'b', [
      { name: 'b-only.jpg', body: 'b-only-content' },
    ])
    await rescanFolders(page)
    await waitForCards(
      page,
      2,
      ['a-only.jpg', 'b-only.jpg'],
      ['shared.jpg'],
    )
    await expectNoUiError(page)
  }, TEST_TIMEOUT_MS)
})
