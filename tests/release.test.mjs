import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { chromium, firefox, webkit } from 'playwright-core'

test('release: account boundaries, recording privacy, narrow layouts and delayed preferences', { timeout: 180_000 }, async () => {
  const root = resolve('.')
  const output = await mkdtemp(join(process.env.QA_OUTPUT || tmpdir(), 'ai-english-release-'))
  const port = await new Promise((done) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => done(port)) }) })
  const base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/app.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: '', TRUST_PROXY: 'false', HTTPS_ENABLED: 'false', COOKIE_SECURE: 'false', APP_USER: '', APP_PASSWORD_SALT: '', APP_PASSWORD_HASH: '', TENCENTCLOUD_APP_ID: '', TENCENTCLOUD_SECRET_ID: '', TENCENTCLOUD_SECRET_KEY: '', AI_ENGLISH_DB_PATH: join(output, 'test.sqlite') } })
  let logs = '', browser
  child.stdout.on('data', (chunk) => { logs += chunk }); child.stderr.on('data', (chunk) => { logs += chunk })
  const engine = process.env.QA_BROWSER || 'edge'
  const results = { engine, scope: 'Windows browser engines and responsive viewports, not physical mobile devices; synthetic private recording, isolated DB', checks: [] }
  async function check(name, fn) { const details = await fn(); results.checks.push({ name, pass: true, ...details }); console.log('PASS ' + name) }
  const password = 'ReleaseCheck2026'
  const register = async (name) => {
    const response = await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password, confirmPassword: password }) })
    assert.equal(response.status, 200)
    return { ...(await response.json()), cookie: response.headers.get('set-cookie').split(';')[0] }
  }
  const api = async (user, path, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { Cookie: user.cookie, 'Content-Type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return response
  }
  const login = async (page, user) => { await page.getByLabel('登录用户').fill(user.user); await page.getByLabel('密码', { exact: true }).fill(password); await page.getByRole('button', { name: '进入今日学习', exact: true }).click(); await page.getByRole('heading', { name: '今日学习', exact: true }).waitFor() }
  const nav = async (page, name) => {
    if (await page.locator('.mobile-bottom-nav').isVisible()) return page.locator('.mobile-bottom-nav button').filter({ hasText: name }).click()
    if (await page.getByRole('button', { name: '打开导航' }).isVisible()) await page.getByRole('button', { name: '打开导航' }).click()
    await page.locator('.app-sidebar nav button').filter({ hasText: name }).click()
  }
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/health')).ok) break } catch {} if (child.exitCode !== null || i === 99) throw Error(logs); await new Promise((done) => setTimeout(done, 100)) }
    browser = await ({ edge: chromium, chrome: chromium, firefox, webkit }[engine]).launch({ headless: true, ...(engine === 'edge' ? { executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) })
    const a = await register('ReleaseAlice'), b = await register('ReleaseBob')
    await check('server rejects a stale account header, including logout', async () => {
      for (const [path, method] of [['/api/bootstrap', 'GET'], ['/api/learning-state', 'PUT'], ['/api/logout', 'POST']]) assert.equal((await api(b, path, method, method === 'GET' ? null : {}, { 'X-Learning-User': String(a.userId) })).status, 409)
      assert.equal((await api(b, '/api/bootstrap')).status, 200)
    })
    await check('offline logout stays locked after reload; drafts restore only to their owner', async () => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } })
      const page = await context.newPage(); await page.goto(base)
      await page.evaluate(() => localStorage.setItem('ink-air-pending-learning-state', JSON.stringify({ version: 2, currentLessonId: 'lesson-cdc-short-walk', records: {} })))
      await login(page, a)
      assert.ok(await page.evaluate(() => localStorage.getItem('ink-air-quarantined-legacy-draft-v1')))
      await page.getByRole('button', { name: '开始今天的听力' }).click(); await page.getByText('数据库已同步', { exact: true }).waitFor()
      await context.setOffline(true)
      const note = 'PRIVATE_ALICE_OFFLINE_DRAFT'
      await page.getByPlaceholder('用中文写下文章的主要意思…').fill(note)
      await page.getByText('离线暂存中', { exact: true }).waitFor()
      await nav(page, '我的'); await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('button', { name: '进入今日学习' }).waitFor()
      await context.setOffline(false); await page.reload(); await page.getByRole('button', { name: '进入今日学习' }).waitFor()
      await page.waitForFunction(async () => (await fetch('/api/session').then((r) => r.json())) === null)
      await login(page, b); await page.getByText('数据库已同步', { exact: true }).waitFor()
      const bob = await (await api(b, '/api/bootstrap')).json(); assert.ok(!JSON.stringify(bob.learningState).includes(note))
      await nav(page, '我的'); await page.getByRole('button', { name: '退出登录' }).click(); await login(page, a)
      assert.equal(await page.getByPlaceholder('用中文写下文章的主要意思…').inputValue(), note)
      const other = await context.newPage(); await other.goto(base); await other.getByRole('heading', { name: '今日学习', exact: true }).waitFor()
      await nav(page, '我的'); await page.getByRole('button', { name: '退出登录' }).click(); await other.getByRole('button', { name: '进入今日学习' }).waitFor()
      await login(page, b); assert.ok(await other.getByRole('button', { name: '进入今日学习' }).isVisible())
      await context.close()
    })
    await check('private recording is no-store, owner-bound, and never survives logout in service worker cache', async () => {
      const boot = await (await api(a, '/api/bootstrap')).json(), id = boot.currentLesson.id
      const wav = Buffer.alloc(32044); wav.write('RIFF'); wav.writeUInt32LE(32036, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40)
      // This too-short synthetic recording is saved, but never sent to Tencent for scoring.
      await api(a, '/api/audio/assess', 'POST', { lessonId: id, dataUrl: 'data:audio/wav;base64,' + wav.toString('base64'), durationSeconds: 1 })
      const updated = await (await api(a, '/api/bootstrap')).json(), path = updated.learningState.records[id].lastSpeakingRecording.url
      assert.equal((await api(b, path)).status, 403)
      const context = await browser.newContext({ serviceWorkers: 'allow' }), page = await context.newPage()
      await page.goto(base); await login(page, a)
      await page.evaluate(() => navigator.serviceWorker.ready)
      // Reproduce an upgrade from the old mixed public/private cache.
      await page.evaluate(async (path) => {
        for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister()
        await (await caches.open('ink-air-audio-v1')).put(path, new Response('old private waveform'))
      }, path)
      await page.reload(); await page.evaluate(() => navigator.serviceWorker.ready)
      await page.waitForFunction(async () => !(await caches.keys()).includes('ink-air-audio-v1'))
      const initial = await page.evaluate(async (path) => { const r = await fetch(path); return { status: r.status, cache: r.headers.get('cache-control'), bytes: (await r.arrayBuffer()).byteLength } }, path)
      assert.equal(initial.status, 200); assert.match(initial.cache, /no-store/u); assert.equal(initial.bytes, wav.length)
      await nav(page, '我的'); await page.getByRole('button', { name: '退出登录' }).click(); await page.getByRole('button', { name: '进入今日学习' }).waitFor()
      // Wait for the actual logout response, not just the locally locked UI.
      await page.waitForFunction(async () => (await fetch('/api/session').then((r) => r.json())) === null)
      assert.equal(await page.evaluate(async (path) => (await fetch(path)).status, path), 401)
      const leaked = await page.evaluate(async (path) => { for (const key of await caches.keys()) if (await (await caches.open(key)).match(path)) return true; return false }, path)
      assert.equal(leaked, false)
      await context.close(); return initial
    })
    await check('failed bookmarks show an error; retry succeeds and toast disappears', async () => {
      const user = await register('ReleaseBookmarks')
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } }), page = await context.newPage()
      const errors = []; page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(base); await login(page, user)
      const button = page.getByRole('button', { name: /^加入生词本/u }).first()
      await page.route('**/api/vocabulary/toggle', (route) => route.fulfill({ status: 503, json: { error: '收藏保存失败，请重试' } }))
      await button.click(); await page.getByRole('alert').filter({ hasText: '收藏保存失败，请重试' }).waitFor()
      await page.unroute('**/api/vocabulary/toggle')
      let calls = 0
      page.on('request', (request) => { if (request.url().endsWith('/api/vocabulary/toggle')) calls++ })
      await button.dblclick(); await page.getByRole('button', { name: /^移出生词本/u }).first().waitFor()
      assert.equal(calls, 1)
      await page.locator('.toast').waitFor({ state: 'visible' })
      await page.locator('.toast').waitFor({ state: 'hidden', timeout: 6000 })
      assert.deepEqual(errors, []); await context.close()
    })
    const c = await register('ReleaseLayout')
    const boot = await (await api(c, '/api/bootstrap')).json(), lessonId = 'lesson-cdc-short-walk'
    boot.learningState.currentLessonId = lessonId
    boot.learningState.records[lessonId] = { ...boot.learningState.records[lessonId], completedSteps: ['guide', 'listening', 'translation', 'speaking'], writingTasks: [{ draft: '', attempts: 0 }, { draft: '', attempts: 0 }], writingAttempts: 0 }
    assert.equal((await api(c, '/api/learning-state', 'PUT', boot.learningState)).status, 200)
    for (const width of [320, 360, 390, 430, 820, 1440]) await check('writing layout, spelling rejection and preference loading at ' + width, async () => {
      const context = await browser.newContext({ viewport: { width, height: width > 600 ? 1100 : 844 }, ...(engine !== 'firefox' ? { isMobile: width <= 900 } : {}), hasTouch: width <= 900, serviceWorkers: 'block' }), page = await context.newPage()
      await page.goto(base); await login(page, c)
      const task = page.locator('.writing-translation-task').first()
      if (!await task.locator('.grading-note').count()) { await page.getByLabel('译写一英文翻译').fill('i can walk for ten mini every day.'); await page.getByRole('button', { name: '提交译写一 · 第 1 次' }).click() }
      await page.getByText(/本题不判为正确/).waitFor()
      const dimensions = await task.locator('.grading-note').evaluate((el) => ({ card: el.getBoundingClientRect().width, details: el.querySelector('.grading-details').getBoundingClientRect().width, height: el.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth - innerWidth }))
      assert.ok(dimensions.details > dimensions.card * .75, JSON.stringify(dimensions)); assert.equal(dimensions.overflow, 0)
      await task.locator('.grading-note').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, `writing-${width}.png`) })
      let release
      const held = new Promise((done) => { release = done })
      await page.route('**/api/dictionary/overview', async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }) })
      await nav(page, '我的'); await page.getByRole('heading', { name: '背词偏好', exact: true }).waitFor()
      assert.equal(await page.getByLabel('新词上限').isDisabled(), true)
      release(); await page.waitForFunction(() => !document.querySelector('.preference-fields')?.disabled)
      await page.getByLabel('新词上限').selectOption('10'); await page.getByLabel('目标日期').fill('2027-01-15')
      const saved = page.waitForResponse((r) => r.url().includes('/api/dictionary/preferences'))
      await page.getByRole('button', { name: '保存背词设置' }).click(); assert.equal((await saved).status(), 200)
      assert.equal(await page.getByLabel('新词上限').inputValue(), '10')
      await nav(page, '单词'); await page.getByRole('textbox', { name: '查词', exact: true }).waitFor(); assert.equal(await page.getByRole('textbox', { name: '查词', exact: true }).count(), 1)
      if (width <= 900) assert.equal(await page.locator('.app-sidebar').getAttribute('inert'), '')
      await nav(page, '课程'); await page.getByRole('heading', { name: '课程库', exact: true }).waitFor()
      assert.equal(await page.locator('.archive-row:not(.archive-head)').count(), 40)
      await page.evaluate(() => { window.__qaClicks = []; document.addEventListener('click', (event) => window.__qaClicks.push({ tag: event.target.tagName, text: event.target.textContent.slice(0, 60), x: event.clientX, y: event.clientY }), true) })
      await page.getByRole('button', { name: /继续加载/u }).click()
      try { await page.waitForFunction(() => document.querySelectorAll('.archive-row:not(.archive-head)').length === 50, null, { timeout: 4000 }) }
      catch (error) {
        const details = await page.evaluate(() => ({ clicks: window.__qaClicks, count: document.querySelectorAll('.archive-row:not(.archive-head)').length, button: document.querySelector('.load-more-button')?.getBoundingClientRect().toJSON(), innerHeight, scrollY, viewport: visualViewport && { offset: visualViewport.offsetTop, height: visualViewport.height, scale: visualViewport.scale } }))
        console.log(JSON.stringify({ width, ...details })); await page.screenshot({ path: join(output, `load-more-failed-${width}.png`) }); throw error
      }
      await page.getByPlaceholder('标题、主题或来源').fill('A Short Walk Can Change Your Day')
      await page.waitForFunction(() => document.querySelectorAll('.archive-row:not(.archive-head)').length === 1)
      await page.locator('.archive-row:not(.archive-head) button').click()
      await page.waitForFunction(() => document.querySelector('.today-heading p')?.textContent.includes('A Short Walk Can Change Your Day'))
      await context.close(); return dimensions
    })
  } finally {
    await browser?.close(); child.kill()
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
    console.log('Evidence: ' + output)
  }
})
