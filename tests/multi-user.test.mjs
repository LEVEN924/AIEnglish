import assert from 'node:assert/strict'
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
      probe.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}

async function waitForHealth(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Multi-user server exited early.\n${readLogs()}`)
    try {
      if ((await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return
    } catch { /* server is still starting */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for multi-user server.\n${readLogs()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return
  child.kill()
  await Promise.race([once(child, 'exit'), new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
}

const userCount = Math.min(50, Math.max(2, Number(process.env.AI_ENGLISH_TEST_USERS) || 8))
test(`${userCount} concurrent learners stay responsive and keep progress isolated`, { timeout: 60_000 }, async (context) => {
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  let logs = ''
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_USER: '',
      APP_PASSWORD_SALT: '',
      APP_PASSWORD_HASH: '',
      COOKIE_SECURE: 'false',
      HTTPS_ENABLED: 'false',
      TENCENTCLOUD_APP_ID: '',
      TENCENTCLOUD_SECRET_ID: '',
      TENCENTCLOUD_SECRET_KEY: '',
      AI_ENGLISH_DB_PATH: join(root, '.runtime', `multi-user-test-${port}.sqlite`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })
  context.after(() => stopChild(child))
  await waitForHealth(baseUrl, child, () => logs)

  const learners = Array.from({ length: userCount }, (_, index) => ({
    username: `CONCURRENT_${port}_${index}`,
    password: `Stable-pass-${index}-2026`,
  }))
  const healthStartedAt = performance.now()
  const healthDuringRegistration = fetch(`${baseUrl}/api/health`)
  const registrations = await Promise.all(learners.map((learner) => fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...learner, confirmPassword: learner.password }),
  })))
  const healthResponse = await healthDuringRegistration
  assert.equal(healthResponse.status, 200)
  assert.ok(performance.now() - healthStartedAt < 5_000, 'health endpoint should stay responsive while passwords are hashed')
  assert.deepEqual(registrations.map((response) => response.status), Array(userCount).fill(200))
  const cookies = registrations.map(cookieFrom)
  assert.ok(cookies.every(Boolean))

  const bootstraps = await Promise.all(cookies.map((cookie) => fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json())))
  assert.ok(bootstraps.every((bootstrap) => bootstrap.lessonCatalog.length === 1000))
  assert.ok(bootstraps.every((bootstrap) => bootstrap.currentLesson.id === bootstrap.learningState.currentLessonId))
  assert.ok(bootstraps.every((bootstrap) => bootstrap.vocabularyBook.length === 0))

  const overviews = await Promise.all(cookies.map((cookie) => fetch(`${baseUrl}/api/dictionary/overview`, { headers: { Cookie: cookie } }).then((response) => response.json())))
  const selectableLists = overviews[0].lists.filter((list) => list.studyEnabled).slice(0, 2)
  assert.ok(selectableLists.length >= 1)
  await Promise.all(cookies.map((cookie, index) => fetch(`${baseUrl}/api/dictionary/preferences`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeListId: selectableLists[index % selectableLists.length].id, dailyNew: Math.min(50, 5 + index), dailyGoalMinutes: 10 + index }),
  })))

  await Promise.all(cookies.map((cookie, index) => {
    if (index % 2) return Promise.resolve()
    const lesson = bootstraps[index].currentLesson
    return fetch(`${baseUrl}/api/vocabulary/toggle`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lessonId: lesson.id, term: lesson.vocabulary[0].term }),
    }).then((response) => assert.equal(response.status, 200))
  }))

  await Promise.all(cookies.map((cookie, index) => {
    const bootstrap = bootstraps[index]
    const lessonId = bootstrap.currentLesson.id
    const nextState = structuredClone(bootstrap.learningState)
    nextState.records[lessonId] = { ...nextState.records[lessonId], listeningNotes: `private-note-${index}` }
    return fetch(`${baseUrl}/api/learning-state`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(nextState),
    }).then((response) => assert.equal(response.status, 200))
  }))

  const verification = await Promise.all(cookies.map(async (cookie) => {
    const [bootstrap, overview] = await Promise.all([
      fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json()),
      fetch(`${baseUrl}/api/dictionary/overview`, { headers: { Cookie: cookie } }).then((response) => response.json()),
    ])
    return { bootstrap, overview }
  }))
  verification.forEach(({ bootstrap, overview }, index) => {
    assert.equal(bootstrap.learningState.records[bootstrap.currentLesson.id].listeningNotes, `private-note-${index}`)
    assert.equal(bootstrap.vocabularyBook.length, index % 2 === 0 ? 1 : 0)
    assert.equal(overview.activeListId, selectableLists[index % selectableLists.length].id)
    assert.equal(overview.dailyNew, Math.min(50, 5 + index))
    assert.equal(overview.dailyGoalMinutes, 10 + index)
  })

  // Repeated reads exercise WAL/busy-timeout behavior without leaking one learner's state to another.
  const latencies = []
  const repeatedReads = await Promise.all(Array.from({ length: 5 }, () => cookies.map(async (cookie) => {
    const started = performance.now()
    const response = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } })
    await response.arrayBuffer()
    latencies.push(Math.round(performance.now() - started))
    return response
  })).flat())
  assert.ok(repeatedReads.every((response) => response.status === 200))
  latencies.sort((a, b) => a - b)
  context.diagnostic(JSON.stringify({ users: userCount, readRequests: latencies.length, failures: repeatedReads.filter((r) => r.status !== 200).length, p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.ceil(latencies.length * .95) - 1], maxMs: latencies.at(-1) }))
})
