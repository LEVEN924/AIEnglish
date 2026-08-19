import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverEntry = join(root, 'server', 'app.mjs')

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('Unable to reserve a test port'))
        return
      }
      probe.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

async function waitForHealth(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early.\n${readLogs()}`)
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return
    } catch {
      // The server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }

  throw new Error(`Timed out waiting for the test server.\n${readLogs()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return

  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ])

  if (child.exitCode === null) child.kill('SIGKILL')
}

test('database-backed learning and grading APIs work together', { timeout: 20_000 }, async (context) => {
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const username = 'TEST_USER'
  const password = 'test-only-password'
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  let logs = ''

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_USER: username,
      APP_PASSWORD_SALT: salt.toString('hex'),
      APP_PASSWORD_HASH: passwordHash.toString('hex'),
      COOKIE_SECURE: 'false',
      AI_ENGLISH_DB_PATH: join(root, '.runtime', `api-test-${port}.sqlite`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })
  context.after(() => stopChild(child))

  await waitForHealth(baseUrl, child, () => logs)

  const healthResponse = await fetch(`${baseUrl}/api/health`)
  assert.equal(healthResponse.status, 200)
  assert.deepEqual(await healthResponse.json(), { ok: true, mode: 'production' })

  const anonymousSession = await fetch(`${baseUrl}/api/session`)
  assert.equal(anonymousSession.status, 200)
  assert.equal(await anonymousSession.json(), null)

  const rejectedLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'incorrect-password' }),
  })
  assert.equal(rejectedLogin.status, 401)

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.toLowerCase(), password }),
  })
  assert.equal(loginResponse.status, 200)
  assert.deepEqual(await loginResponse.json(), { user: username })

  const setCookie = loginResponse.headers.get('set-cookie')
  assert.match(setCookie ?? '', /ai_session=[^;]+/u)
  assert.match(setCookie ?? '', /HttpOnly/u)
  assert.match(setCookie ?? '', /SameSite=Lax/u)
  const cookie = setCookie.split(';', 1)[0]

  const authenticatedSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: cookie },
  })
  assert.equal(authenticatedSession.status, 200)
  assert.deepEqual(await authenticatedSession.json(), { user: username })

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } })
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.equal(bootstrap.database.engine, 'SQLite')
  assert.equal(bootstrap.database.lessonCount, 50)
  assert.equal(bootstrap.lessons.length, 50)
  assert.deepEqual(new Set(bootstrap.lessons.map((lesson) => lesson.difficulty.level)), new Set(['L1', 'L2', 'L3']))

  const lesson = bootstrap.lessons[0]
  const translationResponse = await fetch(`${baseUrl}/api/grade/translation`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, answer: lesson.translation.referenceZh }),
  })
  assert.equal(translationResponse.status, 200)
  const translation = await translationResponse.json()
  assert.equal(translation.graderType, 'local')
  assert.equal(translation.correct, true)
  assert.equal(translation.submissionVersion, 1)
  assert.ok(translation.score >= 80)

  const nextState = bootstrap.learningState
  nextState.records[lesson.id] = {
    ...nextState.records[lesson.id],
    completedSteps: ['guide', 'listening', 'translation'],
    listeningNotes: '测试理解',
    translationDraft: lesson.translation.referenceZh,
    translationScore: translation.score,
    translationFeedback: translation,
  }
  const stateResponse = await fetch(`${baseUrl}/api/learning-state`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  assert.equal(stateResponse.status, 200)
  const savedState = await stateResponse.json()
  assert.equal(savedState.records[lesson.id].translationScore, translation.score)

  const profileResponse = await fetch(`${baseUrl}/api/profile`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bootstrap.profile, targetExam: '雅思', preferredLevel: 'L3', dailyGoalMinutes: 30 }),
  })
  assert.equal(profileResponse.status, 200)
  assert.deepEqual(await profileResponse.json(), { ...bootstrap.profile, targetExam: '雅思', preferredLevel: 'L3', dailyGoalMinutes: 30 })

  const incorrectWritingResponse = await fetch(`${baseUrl}/api/grade/writing`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, answer: 'No.' }),
  })
  assert.equal(incorrectWritingResponse.status, 200)
  const incorrectWriting = await incorrectWritingResponse.json()
  assert.equal(incorrectWriting.correct, false)

  const reviewBootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } })
  const reviewBootstrap = await reviewBootstrapResponse.json()
  assert.equal(reviewBootstrap.reviewItems.length, 1)
  assert.ok(reviewBootstrap.reviewItems[0].reviewTaskId)
  const reviewResponse = await fetch(`${baseUrl}/api/review/${reviewBootstrap.reviewItems[0].reviewTaskId}/complete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(reviewResponse.status, 200)
  assert.deepEqual(await reviewResponse.json(), { ok: true })
  const completedReviewBootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.equal(completedReviewBootstrap.reviewItems.length, 0)

  const statsResponse = await fetch(`${baseUrl}/api/content/stats`, { headers: { Cookie: cookie } })
  const stats = await statsResponse.json()
  assert.equal(stats.lessons, 50)
  assert.equal(stats.sources, 50)
  assert.equal(stats.submissions, 2)

  const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(logoutResponse.status, 200)
  assert.deepEqual(await logoutResponse.json(), { ok: true })

  const expiredSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: cookie },
  })
  assert.equal(expiredSession.status, 200)
  assert.equal(await expiredSession.json(), null)
})
