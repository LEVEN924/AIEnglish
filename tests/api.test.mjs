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

test('health, login, session, and logout APIs work together', { timeout: 20_000 }, async (context) => {
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const username = 'TEST_USER'
  const password = 'test-only-password'
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  let logs = ''

  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_USER: username,
      APP_PASSWORD_SALT: salt.toString('hex'),
      APP_PASSWORD_HASH: passwordHash.toString('hex'),
      COOKIE_SECURE: 'false',
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
