import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const baseUrl = process.env.AI_ENGLISH_URL ?? 'http://127.0.0.1:4173'
const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const executablePath = edgeCandidates.find(existsSync)
if (!executablePath) throw new Error('未找到 Microsoft Edge，请设置 EDGE_PATH')

const screenshotDirectory = join(tmpdir(), `ai-english-final-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
await mkdir(screenshotDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' })
await context.route('**/*', async (route) => {
  await route.continue({ headers: { ...route.request().headers(), 'Cache-Control': 'no-cache', Pragma: 'no-cache' } })
})
const page = await context.newPage()
const consoleErrors = []
const audioResponses = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', (error) => consoleErrors.push(error.message))
page.on('response', (response) => {
  const pathname = new URL(response.url()).pathname
  if (!['/api/audio/article', '/api/audio/speech', '/api/audio/word'].includes(pathname)) return
  const headers = response.headers()
  audioResponses.push({
    pathname,
    status: response.status(),
    provider: headers['x-audio-provider'] ?? '',
    model: headers['x-audio-model'] ?? '',
    contentType: headers['content-type'] ?? '',
  })
})

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('tab', { name: '注册新账号' }).click()
  const username = `QA_NOCACHE_${Date.now()}`
  const password = 'StablePass2026'
  await page.getByLabel('用户名').fill(username)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码').fill(password)
  const startedAt = performance.now()
  const bootstrapPromise = page.waitForResponse((response) => response.url().endsWith('/api/bootstrap') && response.request().method() === 'GET')
  await page.getByRole('button', { name: '注册并开始学习' }).click()
  const bootstrapResponse = await bootstrapPromise
  await page.locator('.app-sidebar nav button').filter({ hasText: '单词' }).waitFor()
  const homeVisibleMs = Math.round(performance.now() - startedAt)
  const bootstrap = await bootstrapResponse.json()
  const compressedBootstrapBytes = Number(bootstrapResponse.headers()['content-length'] ?? 0)
  const decodedBootstrapBytes = Buffer.byteLength(JSON.stringify(bootstrap))

  await page.getByRole('button', { name: '开始今天的听力' }).click()
  const articleStartedAt = performance.now()
  await page.locator('.round-audio-button').click()
  await page.waitForFunction(() => {
    const audio = document.querySelector('.cloud-audio-element')
    const error = document.querySelector('.audio-block .form-error')?.textContent
    return Boolean(error) || Boolean(audio && Number.isFinite(audio.duration) && audio.duration > 0 && !audio.paused)
  }, undefined, { timeout: 30_000 })
  const articleState = await page.evaluate(() => ({
    duration: document.querySelector('.cloud-audio-element')?.duration ?? 0,
    paused: document.querySelector('.cloud-audio-element')?.paused ?? true,
    error: document.querySelector('.audio-block .form-error')?.textContent ?? '',
  }))
  const articleReadyMs = Math.round(performance.now() - articleStartedAt)

  const firstWordSpeaker = page.locator('button[aria-label^="播放读音"]').first()
  await firstWordSpeaker.click()
  await page.waitForFunction(() => document.querySelector('button[aria-label^="播放读音"]')?.title === '播放腾讯云读音', undefined, { timeout: 15_000 })
  const articlePausedAfterWord = await page.locator('.cloud-audio-element').evaluate((audio) => audio.paused)

  const bookmark = page.locator('button[aria-label^="加入生词本"]').first()
  await bookmark.click()
  await page.locator('.toast').waitFor({ state: 'visible' })
  const bookmarkNotice = (await page.locator('.toast').innerText()).trim()
  await page.locator('.toast').waitFor({ state: 'detached', timeout: 5_000 })

  await page.locator('.app-sidebar nav button').filter({ hasText: '单词' }).click()
  const switcher = page.getByLabel('切换背词词书')
  await switcher.waitFor()
  await page.waitForFunction(() => document.querySelector('select[aria-label="切换背词词书"]')?.options.length >= 2)
  const wordBooks = await switcher.locator('option').allTextContents()
  await switcher.selectOption({ index: 1 })
  await page.getByText(/已切换到：/u).waitFor()
  const selectedWordBook = await switcher.inputValue()
  const studyDeskVisibleBeforeStart = await page.locator('.study-desk').isVisible().catch(() => false)
  await page.locator('.word-start-section').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshotDirectory, 'desktop-word-switch.png'), fullPage: false })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('.app-sidebar nav button').filter({ hasText: '单词' }).click()
  await page.getByLabel('切换背词词书').waitFor()
  await page.waitForFunction(() => Boolean(document.querySelector('select[aria-label="切换背词词书"]')?.value))
  const selectedAfterReload = await page.getByLabel('切换背词词书').inputValue()
  const studyDeskVisibleAfterReload = await page.locator('.study-desk').isVisible().catch(() => false)

  console.log(JSON.stringify({
    ok: !consoleErrors.length && !articleState.error && !articleState.paused,
    username,
    homeVisibleMs,
    bootstrap: {
      compressedBytes: compressedBootstrapBytes,
      decodedBytes: decodedBootstrapBytes,
      lessonCount: bootstrap.lessonCatalog.length,
      currentLessonId: bootstrap.currentLesson.id,
    },
    audio: { ...articleState, articleReadyMs, articlePausedAfterWord },
    audioResponses,
    bookmarkNotice,
    wordBooks,
    selectedWordBook,
    selectedAfterReload,
    studyDeskVisibleBeforeStart,
    studyDeskVisibleAfterReload,
    consoleErrors,
    screenshotDirectory,
  }, null, 2))
} finally {
  await context.close()
  await browser.close()
}
