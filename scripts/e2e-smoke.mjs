import { chromium } from 'playwright-core'

const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:5173/'
const chromePath =
  process.env.CHROME_PATH ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitForText(page, text) {
  await page.getByText(text, { exact: false }).first().waitFor({
    timeout: 15_000,
  })
}

async function main() {
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  })
  await page.addInitScript(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('geo-media-index-lab:')) {
        localStorage.removeItem(key)
      }
    }
  })

  const consoleMessages = []
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      consoleMessages.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => {
    consoleMessages.push(`pageerror: ${error.message}`)
  })

  await page.goto(appUrl, { waitUntil: 'domcontentloaded' })
  await page.screenshot({ path: '/tmp/ding-e2e-initial.png', fullPage: true })

  await waitForText(page, 'Geo Media Index Lab')
  await waitForText(page, 'SQLite')
  await waitForText(page, 'OPFS')

  const verticalHandle = page.getByRole('separator', {
    name: /resize left tools and results/i,
  })
  const horizontalHandle = page.getByRole('separator', {
    name: /resize map and query panels/i,
  })
  const leftBefore = await page.locator('.left-stack').boundingBox()
  const verticalBox = await verticalHandle.boundingBox()
  expect(leftBefore && verticalBox, 'Vertical resize handle was not visible')
  await page.mouse.move(
    verticalBox.x + verticalBox.width / 2,
    verticalBox.y + verticalBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    verticalBox.x + verticalBox.width / 2 + 90,
    verticalBox.y + verticalBox.height / 2,
    { steps: 6 },
  )
  await page.mouse.up()
  const leftAfter = await page.locator('.left-stack').boundingBox()
  expect(
    leftAfter.width > leftBefore.width + 50,
    'Vertical resize did not expand left column',
  )

  const mapBefore = await page.locator('.map-pane').boundingBox()
  const horizontalBox = await horizontalHandle.boundingBox()
  expect(mapBefore && horizontalBox, 'Horizontal resize handle was not visible')
  await page.mouse.move(
    horizontalBox.x + horizontalBox.width / 2,
    horizontalBox.y + horizontalBox.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    horizontalBox.x + horizontalBox.width / 2,
    horizontalBox.y + horizontalBox.height / 2 + 70,
    { steps: 6 },
  )
  await page.mouse.up()
  const mapAfter = await page.locator('.map-pane').boundingBox()
  expect(
    mapAfter.height > mapBefore.height + 35,
    'Horizontal resize did not expand map panel',
  )

  expect(
    (await page.getByRole('button', { name: /sample data/i }).count()) === 0,
    'Sample data button should not be visible',
  )
  expect(
    (await page.getByRole('button', { name: /^clear$/i }).count()) === 0,
    'Clear should not be a top-level action',
  )

  const resultsSubtitle = await page.locator('.library-header .subtle').innerText()
  expect(
    !/Imported|Catalog cleared|Indexed|Building/i.test(resultsSubtitle),
    `Results subtitle contains operation status: ${resultsSubtitle}`,
  )

  await page.getByText('Settings', { exact: true }).click()
  await waitForText(page, 'Activity log')
  await waitForText(page, 'Clear catalog')

  let sawClearConfirmation = false
  page.once('dialog', async (dialog) => {
    sawClearConfirmation = true
    expect(
      /Clear the catalog/i.test(dialog.message()),
      'Clear confirmation dialog had unexpected copy',
    )
    await dialog.accept()
  })
  await page.getByRole('button', { name: /clear catalog/i }).click()
  expect(sawClearConfirmation, 'Clear catalog did not ask for confirmation')
  await waitForText(page, 'Catalog cleared')
  await page.screenshot({ path: '/tmp/ding-e2e-settings.png', fullPage: true })
  await page.getByText('Settings', { exact: true }).click()

  await page.getByText('Display').click()
  await page.getByRole('button', { name: /list/i }).click()
  await page.getByRole('button', { name: /large/i }).click()
  await page.locator('.media-grid-list').waitFor({ timeout: 5_000 })
  await page.locator('.media-thumb-large').waitFor({ timeout: 5_000 })
  await page.getByRole('button', { name: /images/i }).click()
  await page.locator('.media-grid-images').waitFor({ timeout: 5_000 })
  await page.getByLabel('Show metadata').uncheck()
  await page.getByLabel('Show metadata').check()
  await page.getByRole('button', { name: /cards/i }).click()
  await page.getByText('Display').click()

  await page
    .locator('label')
    .filter({ hasText: 'From' })
    .locator('input')
    .fill('2024-01-01T00:00')
  await page
    .locator('label')
    .filter({ hasText: 'To' })
    .locator('input')
    .fill('2024-12-31T23:59')
  expect(
    page.url().includes('from=2024-01-01T00%3A00'),
    'From time was not reflected in the URL',
  )

  await page
    .locator('label')
    .filter({ hasText: 'Sort' })
    .locator('select')
    .selectOption('distance')
  await page
    .locator('label')
    .filter({ hasText: 'Engine' })
    .locator('select')
    .waitFor({ timeout: 5_000 })

  await page.screenshot({ path: '/tmp/ding-e2e-final.png', fullPage: true })

  expect(
    consoleMessages.every(
      (message) =>
        !message.includes('pageerror') &&
        !message.includes('Unhandled') &&
        !message.includes('Uncaught'),
    ),
    `Unexpected console issues:\n${consoleMessages.join('\n')}`,
  )

  await browser.close()
  console.log('E2E smoke passed')
  console.log('Screenshots:')
  console.log('/tmp/ding-e2e-initial.png')
  console.log('/tmp/ding-e2e-settings.png')
  console.log('/tmp/ding-e2e-final.png')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
