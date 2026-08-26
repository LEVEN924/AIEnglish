import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverEntry = join(root, 'server', 'app.mjs')
const lesson = JSON.parse(readFileSync(join(root, 'content', 'lessons.json'), 'utf8')).entries[0]
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

function testWavDataUrl() {
  const pcmLength = 32_000
  const wav = Buffer.alloc(44 + pcmLength)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcmLength, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24)
  wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcmLength, 40)
  return `data:audio/wav;base64,${wav.toString('base64')}`
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

test('desktop and mobile learning surfaces render and respond', { timeout: 60_000 }, async (context) => {
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
      TENCENTCLOUD_APP_ID: '',
      TENCENTCLOUD_SECRET_ID: '',
      TENCENTCLOUD_SECRET_KEY: '',
      AI_ENGLISH_DB_PATH: databasePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  })
  context.after(async () => {
    await browser.close()
    await stopChild(child)
    for (const suffix of ['', '-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true })
  })
  await waitForHealth(baseUrl, child, () => logs)

  const registrationContext = await browser.newContext({ viewport: { width: 900, height: 760 } })
  const registrationPage = await registrationContext.newPage()
  await registrationPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await registrationPage.getByRole('tab', { name: '注册新账号' }).click()
  await registrationPage.getByLabel('用户名').fill(`UI_NEW_${port}`)
  await registrationPage.getByLabel('密码', { exact: true }).fill('ui-register-2026')
  await registrationPage.getByLabel('确认密码').fill('ui-register-2026')
  await registrationPage.getByRole('button', { name: '注册并开始学习' }).click()
  await registrationPage.getByRole('heading', { name: '今日学习' }).waitFor()
  await registrationContext.close()

  const consoleMessages = []
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const desktop = await desktopContext.newPage()
  desktop.on('console', (message) => {
    const text = `${message.type()}: ${message.text()}`
    if (text === 'error: Failed to load resource: the server responded with a status of 400 (Bad Request)') return
    if (['error', 'warning'].includes(message.type())) consoleMessages.push(text)
  })
  desktop.on('pageerror', (error) => consoleMessages.push(`pageerror: ${error.message}`))
  await desktop.goto(baseUrl, { waitUntil: 'networkidle' })
  assert.equal(await desktop.title(), 'Ink & Air · AI English')
  await login(desktop, username, password)
  assert.equal(await desktop.locator('.step-ticket-rail li').count(), 6)
  assert.equal(await desktop.getByRole('button', { name: /^播放读音 /u }).count(), 5)
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
  assert.equal(await desktop.locator('vite-error-overlay, nextjs-portal').count(), 0)
  await desktop.getByRole('button', { name: '开始今天的听力' }).click()
  assert.equal(await desktop.locator('#step-listening .audio-timeline input[type="range"]').count(), 1)
  assert.equal(await desktop.getByRole('button', { name: '上一音频段' }).count(), 0)
  await desktop.locator('#step-listening .rate-controls button').filter({ hasText: '0.75×' }).click()
  await desktop.waitForFunction(() => document.querySelector('#step-listening audio')?.playbackRate === 0.75)
  assert.equal(await desktop.locator('#step-listening audio').evaluate((audio) => audio.playbackRate), 0.75)
  await desktop.getByRole('button', { name: '展开原文' }).click()
  assert.equal(await desktop.locator('#step-listening .article-text p').count(), 1)
  assert.equal((await desktop.locator('#step-listening .article-text p').textContent())?.trim(), lesson.body)
  await desktop.getByPlaceholder('用中文写下文章的主要意思…').fill('文章说明了一个可以落实到日常生活中的核心观点。')
  await desktop.getByRole('button', { name: '保存理解并进入翻译' }).click()
  assert.equal((await desktop.locator('#step-translation blockquote').textContent())?.trim(), lesson.body)
  assert.equal(await desktop.locator('#step-translation blockquote p').count(), 0)
  await desktop.getByPlaceholder('写下整段中文翻译…').fill(lesson.translation.referenceZh)
  await desktop.getByRole('button', { name: '提交翻译' }).click()
  await desktop.locator('#step-speaking').waitFor()
  assert.equal(await desktop.locator('#step-speaking textarea').count(), 0)
  assert.equal(await desktop.getByRole('button', { name: '开始录音' }).isVisible(), true)
  const recordButtonBox = await desktop.getByRole('button', { name: '开始录音' }).boundingBox()
  const recordingActionsBox = await desktop.locator('#step-speaking .recording-actions').boundingBox()
  assert.ok(recordButtonBox && recordButtonBox.width >= 300, 'speaking record button should have a stable, easy-to-tap width')
  assert.ok(recordButtonBox && recordingActionsBox && Math.abs(
    recordButtonBox.x + recordButtonBox.width / 2 - (recordingActionsBox.x + recordingActionsBox.width / 2),
  ) < 2, 'speaking record button should be horizontally centered')
  assert.equal((await desktop.locator('#step-speaking blockquote').textContent())?.trim(), lesson.body)
  await desktop.evaluate(() => {
    const audio = document.querySelector('#step-listening audio')
    window.__aiEnglishPauseCount = 0
    if (audio) {
      const pause = audio.pause.bind(audio)
      audio.pause = () => {
        window.__aiEnglishPauseCount += 1
        pause()
      }
    }
  })
  await desktop.getByRole('button', { name: '开始录音' }).click()
  assert.ok(await desktop.evaluate(() => window.__aiEnglishPauseCount > 0))
  await desktop.getByText(/听力与其他发音已自动暂停/u).waitFor({ state: 'visible' })
  await desktop.waitForTimeout(600)
  await desktop.getByRole('button', { name: '结束录音' }).click()
  await desktop.locator('#step-speaking .recording-review').waitFor()
  assert.equal(await desktop.locator('#step-speaking .recording-playback').count(), 1)
  assert.equal(await desktop.getByRole('button', { name: '重新录音' }).isVisible(), true)
  assert.equal(await desktop.getByText(/可先回听，再决定是否提交/u).isVisible(), true)
  const rerecordButtonBox = await desktop.getByRole('button', { name: '重新录音' }).boundingBox()
  const populatedRecordingActionsBox = await desktop.locator('#step-speaking .recording-actions').boundingBox()
  assert.ok(rerecordButtonBox && populatedRecordingActionsBox && Math.abs(
    rerecordButtonBox.x + rerecordButtonBox.width / 2 - (populatedRecordingActionsBox.x + populatedRecordingActionsBox.width / 2),
  ) < 2, 'speaking record button should remain centered after a recording is available')
  assert.equal(await desktop.getByRole('button', { name: '重新开始' }).isVisible(), true)
  await desktop.screenshot({ path: join(screenshotDir, 'desktop.png'), fullPage: false })

  const savedRecordingStatus = await desktop.evaluate(async ({ lessonId, dataUrl }) => {
    const response = await fetch('/api/audio/assess', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId, dataUrl, durationSeconds: 1 }),
    })
    return response.status
  }, { lessonId: lesson.id, dataUrl: testWavDataUrl() })
  assert.equal(savedRecordingStatus, 400)
  await desktop.reload({ waitUntil: 'domcontentloaded' })
  await desktop.locator('#step-speaking .previous-recording').waitFor()
  assert.equal(await desktop.getByText('上一次录音', { exact: true }).isVisible(), true)
  assert.equal(await desktop.locator('#step-speaking .previous-recording audio').count(), 1)

  await desktop.locator('.app-sidebar nav button').filter({ hasText: '课程' }).click()
  assert.equal(await desktop.locator('.archive-row:not(.archive-head)').count(), 40)
  assert.equal(await desktop.getByRole('button', { name: /继续加载/u }).isVisible(), true)
  await desktop.getByPlaceholder('标题、主题或来源').fill('A Short Walk Can Change Your Day')
  await desktop.waitForFunction(() => document.querySelectorAll('.archive-row:not(.archive-head)').length === 1)
  assert.equal(await desktop.locator('.archive-row:not(.archive-head)').count(), 1)
  assert.equal(await desktop.locator('.archive-toolbar > span').textContent(), '1 篇')
  await desktop.locator('.app-sidebar nav button').filter({ hasText: '复盘' }).click()
  assert.equal(await desktop.locator('.review-tabs button').count(), 3)
  await desktop.evaluate(async ({ lessonId, term }) => {
    await fetch('/api/vocabulary/toggle', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId, term }),
    })
  }, { lessonId: lesson.id, term: lesson.vocabulary[0].term })
  await desktop.locator('.app-sidebar nav button').filter({ hasText: '今日' }).click()
  await desktop.locator('.app-sidebar nav button').filter({ hasText: '复盘' }).click()
  await desktop.locator('.review-tabs button').filter({ hasText: '生词本' }).click()
  await desktop.getByText(lesson.vocabulary[0].term, { exact: true }).waitFor()
  assert.equal(await desktop.getByRole('button', { name: '跳过今天' }).isVisible(), true)
  assert.equal(await desktop.getByRole('button', { name: '标记掌握' }).isVisible(), true)
  assert.equal(await desktop.getByRole('button', { name: /删除/u }).isVisible(), true)

  await desktop.locator('.app-sidebar nav button').filter({ hasText: '单词' }).click()
  await desktop.getByRole('heading', { name: '单词档案馆' }).waitFor()
  await desktop.getByPlaceholder('输入英文、词组或中文释义…').fill(lesson.vocabulary[0].term)
  await desktop.locator('.dictionary-search-results button').first().waitFor()
  await desktop.locator('.dictionary-search-results button').first().click()
  assert.equal(await desktop.locator('.dictionary-entry-sheet').isVisible(), true)
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)

  await desktop.evaluate(async () => {
    const bootstrap = await fetch('/api/bootstrap', { credentials: 'same-origin' }).then((response) => response.json())
    const lessonId = bootstrap.lessonCatalog[0].id
    bootstrap.learningState.currentLessonId = lessonId
    bootstrap.learningState.records[lessonId] = {
      ...bootstrap.learningState.records[lessonId],
      completedSteps: ['guide', 'listening', 'translation', 'speaking'],
      skipped: false,
    }
    await fetch('/api/learning-state', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bootstrap.learningState),
    })
  })
  await desktop.reload({ waitUntil: 'domcontentloaded' })
  await desktop.locator('#step-writing').waitFor()
  assert.equal(await desktop.locator('.writing-translation-task').count(), 2)
  assert.equal((await desktop.locator('.writing-translation-task').first().locator('blockquote').textContent())?.trim(), lesson.writing.promptZh)
  assert.equal((await desktop.locator('.writing-translation-task').nth(1).locator('blockquote').textContent())?.trim(), lesson.writing.secondaryPromptZh)
  await desktop.locator('.writing-translation-task').nth(1).scrollIntoViewIfNeeded()
  await desktop.screenshot({ path: join(screenshotDir, 'second-writing.png'), fullPage: false })

  await desktop.getByLabel('译写一英文翻译').fill('i can walk for ten mini every day.')
  await desktop.getByRole('button', { name: '提交译写一 · 第 1 次' }).click()
  await desktop.getByText(/本题不判为正确/u).waitFor()
  assert.equal(await desktop.locator('.writing-translation-task').first().locator('.success-note').count(), 0)
  assert.match((await desktop.locator('.writing-translation-task').first().textContent()) ?? '', /“mini” → “minutes”/u)
  await desktop.screenshot({ path: join(screenshotDir, 'writing.png'), fullPage: false })

  await desktop.getByLabel('译写一英文翻译').fill(lesson.writing.answers[0])
  await desktop.getByRole('button', { name: '提交译写一 · 第 2 次' }).click()
  await desktop.locator('.writing-translation-task').first().locator('.success-note').waitFor()
  await desktop.getByLabel('译写二英文翻译').fill(lesson.writing.secondaryAnswers[0])
  await desktop.getByRole('button', { name: '提交译写二 · 第 1 次' }).click()
  await desktop.locator('#step-summary').waitFor()
  await desktop.getByRole('button', { name: '完成今日学习' }).click()
  await desktop.getByRole('button', { name: '重学本篇' }).first().waitFor()
  await desktop.getByRole('button', { name: '下一篇' }).first().click()
  await desktop.getByText(lesson.title, { exact: false }).waitFor({ state: 'detached' })
  assert.match((await desktop.locator('.today-heading p').textContent()) ?? '', /Coral/u)
  await desktop.locator('.app-sidebar nav button').filter({ hasText: '课程' }).click()
  await desktop.getByPlaceholder('标题、主题或来源').fill(lesson.title)
  await desktop.waitForFunction(() => document.querySelectorAll('.archive-row:not(.archive-head)').length === 1)
  await desktop.locator('.archive-row:not(.archive-head) button').first().click()
  await desktop.getByText(lesson.title, { exact: false }).first().waitFor()
  await desktop.waitForTimeout(700)
  await desktopContext.close()

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const mobile = await mobileContext.newPage()
  mobile.on('pageerror', (error) => consoleMessages.push(`mobile pageerror: ${error.message}`))
  await mobile.goto(baseUrl, { waitUntil: 'networkidle' })
  await login(mobile, username, password)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
  assert.equal(await mobile.locator('.mobile-bottom-nav').isVisible(), true)
  assert.equal(await mobile.locator('.mobile-bottom-nav button').count(), 5)
  assert.equal(await mobile.locator('#step-speaking textarea').count(), 0)
  assert.equal(await mobile.locator('#step-speaking .record-button').count(), 1)
  assert.equal(await mobile.locator('#step-speaking .thread-body').isVisible(), false)
  assert.equal(await mobile.getByRole('button', { name: /^播放读音 /u }).count(), 5)
  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '课程' }).click()
  assert.equal(await mobile.getByRole('heading', { name: '课程库' }).isVisible(), true)
  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '单词' }).click()
  await mobile.getByRole('heading', { name: '单词档案馆' }).waitFor()
  assert.equal(await mobile.getByRole('heading', { name: '单词档案馆' }).isVisible(), true)
  await mobile.waitForFunction(() => document.querySelector('.dictionary-stats strong')?.textContent !== '—')
  assert.ok(Number((await mobile.locator('.dictionary-stats strong').first().textContent())?.replaceAll(',', '')) > 0)
  assert.equal(await mobile.getByRole('heading', { name: '选择背词词书' }).count(), 0)
  assert.equal(await mobile.getByLabel('新词上限').count(), 0)
  assert.equal(await mobile.getByRole('heading', { name: '七日词汇报告' }).count(), 0)
  assert.equal(await mobile.getByRole('button', { name: /复习旧词|今日已复习完成/u }).count(), 1)
  assert.equal(await mobile.getByRole('button', { name: /学习新词/u }).isVisible(), true)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)

  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '我的' }).click()
  await mobile.getByRole('heading', { name: '背词偏好' }).waitFor()
  await mobile.locator('.profile-article-wordbook').click()
  await mobile.getByLabel('新词上限').selectOption('5')
  await mobile.getByLabel('目标日期').fill('2026-12-31')
  await mobile.getByRole('button', { name: '保存背词设置' }).click()
  await mobile.getByText(/已保存 · 当前词书/u).waitFor()

  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '复盘' }).click()
  await mobile.getByRole('button', { name: '本周报告' }).click()
  await mobile.getByRole('heading', { name: '七日词汇报告' }).waitFor()

  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '单词' }).click()
  await mobile.getByRole('heading', { name: '单词档案馆' }).waitFor()
  await mobile.getByText('目标 2026-12-31', { exact: true }).waitFor()
  await mobile.getByRole('button', { name: /学习新词/u }).click()
  await mobile.getByText('词义辨认', { exact: true }).waitFor()
  assert.equal(await mobile.locator('.mobile-bottom-nav').count(), 0)
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0)
  await mobile.getByRole('button', { name: '暂时不会' }).click()
  await mobile.getByRole('button', { name: '加入本轮重学队列' }).waitFor()
  assert.match((await mobile.locator('.study-answer-phonetics').textContent()) ?? '', /\/\s*[^/]+\s*\//u)
  assert.equal(await mobile.getByText('发音练习', { exact: true }).count(), 0)
  await mobile.getByRole('button', { name: '加入本轮重学队列' }).click()
  await mobile.getByText(/2\/6/u).waitFor()
  await mobile.getByRole('button', { name: '暂停并返回' }).click()
  await mobile.getByRole('heading', { name: '单词档案馆' }).waitFor()
  assert.equal(await mobile.getByRole('button', { name: '暂停并返回' }).count(), 0)
  await mobile.reload({ waitUntil: 'domcontentloaded' })
  await mobile.getByRole('heading', { name: '今日学习' }).waitFor()
  await mobile.locator('.mobile-bottom-nav button').filter({ hasText: '单词' }).click()
  await mobile.getByRole('heading', { name: '单词档案馆' }).waitFor()
  assert.equal(await mobile.getByRole('button', { name: '暂停并返回' }).count(), 0)
  await mobile.getByRole('button', { name: /学习新词/u }).waitFor()
  assert.equal(await mobile.getByRole('button', { name: /学习新词/u }).isVisible(), true)
  await mobile.screenshot({ path: join(screenshotDir, 'mobile.png'), fullPage: false })
  await mobileContext.close()

  assert.deepEqual(consoleMessages, [])
})
