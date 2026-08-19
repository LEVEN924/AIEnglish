import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverEntry = join(root, 'server', 'app.mjs')
const browserCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') return reject(new Error('Unable to reserve a UI test port'))
      probe.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function waitForHealth(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`UI test server exited early.\n${readLogs()}`)
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // Still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for UI test server.\n${readLogs()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function login(page, username, password) {
  await page.getByLabel('登录用户').fill(username)
  await page.getByLabel('密码').fill(password)
  await page.getByRole('button', { name: '进入今日学习' }).click()
  await page.getByRole('heading', { name: '今日学习' }).waitFor()
}

test('desktop and mobile learning surfaces render and respond', { timeout: 30_000 }, async (context) => {
  const executablePath = browserCandidates.find((candidate) => existsSync(candidate))
  assert.ok(executablePath, 'Microsoft Edge or Google Chrome is required for UI smoke tests')

  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const username = 'UI_TEST_USER'
  const password = 'ui-test-only-password'
  const salt = randomBytes(16)
  const databasePath = join(root, '.runtime', `ui-test-${port}.sqlite`)
  const screenshotDir = join(tmpdir(), 'ai-english-ui-qa')
  await mkdir(screenshotDir, { recursive: true })
  let logs = ''
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry, '--dev'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_USER: username,
      APP_PASSWORD_SALT: salt.toString('hex'),
      APP_PASSWORD_HASH: scryptSync(password, salt, 64).toString('hex'),
      COOKIE_SECURE: 'false',
      HTTPS_ENABLED: 'false',
      AI_ENGLISH_DB_PATH: databasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })

  const browser = await chromium.launch({ executablePath, headless: true })
  context.after(async () => {
    await browser.close()
    await stopChild(child)
    for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)

  const consoleMessages = []
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const desktop = await desktopContext.newPage()
  desktop.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(`${message.type()}: ${message.text()}`)
  })
  desktop.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`))
  await desktop.goto(baseUrl, { waitUntil: 'networkidle' })
  assert.equal(await desktop.title(), 'Ink & Air · AI English')
  await login(desktop, username, password)
  assert.equal(await desktop.locator('.step-ticket-rail li').count(), 6)
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
  assert.equal(await desktop.locator('vite-error-overlay, nextjs-portal').count(), 0)
  await desktop.screenshot({ path: join(screenshotDir, 'desktop.png'), fullPage: false })

  await desktop.locator('.app-sidebar nav button').filter({ hasText: '对话' }).click()
  await desktop.getByPlaceholder('标题、主题或来源').fill('A Short Walk Can Change Your Day')
  assert.equal(await desktop.locator('.archive-row:not(.archive-head)').count(), 1)
  assert.equal(await desktop.locator('.archive-toolbar > span').textContent(), '1 篇')
  await desktop.locator('.app-sidebar nav button').filter({ hasText: '复盘' }).click()
  assert.equal(await desktop.locator('.review-tabs button').count(), 3)
  await desktopContext.close()

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  mobile.on('pageerror', (error) => consoleMessages.push(`mobile pageerror: ${error.message}`))
  await mobile.goto(baseUrl, { waitUntil: 'networkidle' })
  await login(mobile, username, password)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
  assert.equal(await mobile.locator('.mobile-bottom-nav').isVisible(), true)
  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '对话' }).click()
  assert.equal(await mobile.getByRole('heading', { name: '对话档案' }).isVisible(), true)
  await mobile.screenshot({ path: join(screenshotDir, 'mobile.png'), fullPage: false })
  await mobileContext.close()

  assert.deepEqual(consoleMessages, [])
})
