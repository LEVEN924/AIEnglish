import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const isDev = process.argv.includes('--dev')

function loadLocalEnvironment() {
  const envPath = join(root, '.env.local')
  if (!existsSync(envPath)) return

  const entries = readFileSync(envPath, 'utf8').split(/\r?\n/u)
  for (const entry of entries) {
    const line = entry.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadLocalEnvironment()

const port = Number(process.env.PORT ?? 4173)
const configuredUser = process.env.APP_USER ?? ''
const configuredSalt = process.env.APP_PASSWORD_SALT ?? ''
const configuredHash = process.env.APP_PASSWORD_HASH ?? ''
const sessions = new Map()
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function parseCookies(request) {
  const cookies = new Map()
  for (const pair of (request.headers.cookie ?? '').split(';')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    cookies.set(pair.slice(0, separator).trim(), decodeURIComponent(pair.slice(separator + 1)))
  }
  return cookies
}

function getSession(request) {
  const token = parseCookies(request).get('ai_session')
  if (!token) return null
  const session = sessions.get(token)
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  return { token, ...session }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function verifyCredentials(username, password) {
  if (!configuredUser || !configuredSalt || !configuredHash) return false
  if (String(username).toUpperCase() !== configuredUser.toUpperCase()) return false

  try {
    const actual = scryptSync(String(password), Buffer.from(configuredSalt, 'hex'), 64)
    const expected = Buffer.from(configuredHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

async function handleApi(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  if (!url.pathname.startsWith('/api/')) return false

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, mode: isDev ? 'development' : 'production' })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    const session = getSession(request)
    sendJson(response, 200, session ? { user: session.user } : null)
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    try {
      const { username = '', password = '' } = await readJsonBody(request)
      if (!verifyCredentials(username, password)) {
        sendJson(response, 401, { error: '用户名或密码不正确' })
        return true
      }

      const token = randomBytes(32).toString('base64url')
      sessions.set(token, { user: configuredUser, expiresAt: Date.now() + sessionLifetimeMs })
      const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
      sendJson(response, 200, { user: configuredUser }, {
        'Set-Cookie': `ai_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`,
      })
      return true
    } catch {
      sendJson(response, 400, { error: '登录请求格式不正确' })
      return true
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const session = getSession(request)
    if (session) sessions.delete(session.token)
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': 'ai_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    })
    return true
  }

  sendJson(response, 404, { error: 'NOT_FOUND' })
  return true
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function serveProduction(request, response) {
  const dist = join(root, 'dist')
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  const candidate = resolve(dist, relative || 'index.html')
  const safeCandidate = candidate.startsWith(dist) && existsSync(candidate) ? candidate : join(dist, 'index.html')
  const file = existsSync(safeCandidate) && !safeCandidate.endsWith('/') ? safeCandidate : join(dist, 'index.html')

  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  })
  createReadStream(file).pipe(response)
}

let vite
if (isDev) {
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: 'spa',
  })
}

const server = createServer(async (request, response) => {
  try {
    if (await handleApi(request, response)) return
    if (vite) {
      vite.middlewares(request, response, () => sendJson(response, 404, { error: 'NOT_FOUND' }))
      return
    }
    serveProduction(request, response)
  } catch (error) {
    console.error(error)
    if (!response.headersSent) sendJson(response, 500, { error: 'INTERNAL_ERROR' })
    else response.end()
  }
})

server.listen(port, '0.0.0.0', () => {
  console.log(`AI English is running on all network interfaces at port ${port}`)
})
