import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { openAppDatabase } from './database.mjs'
import { gradeSubmission } from './grading.mjs'

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
const databasePath = resolve(root, process.env.AI_ENGLISH_DB_PATH ?? 'data/ai-english.sqlite')
const catalog = JSON.parse(readFileSync(join(root, 'content', 'lessons.json'), 'utf8'))
const appDatabase = openAppDatabase({
  databasePath,
  catalog,
  configuredUser,
  configuredSalt,
  configuredHash,
})
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
  const session = appDatabase.getSession(token)
  return session ? { token, ...session } : null
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 1_048_576) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function verifyCredentials(username, password) {
  const user = appDatabase.findUser(username)
  if (!user) return null

  try {
    const actual = scryptSync(String(password), Buffer.from(user.passwordSalt, 'hex'), 64)
    const expected = Buffer.from(user.passwordHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? user : null
  } catch {
    return null
  }
}

function requireSession(request, response) {
  const session = getSession(request)
  if (!session) sendJson(response, 401, { error: '请先登录' })
  return session
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
      const user = verifyCredentials(username, password)
      if (!user) {
        sendJson(response, 401, { error: '用户名或密码不正确' })
        return true
      }

      const token = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString()
      appDatabase.createSession(user.id, token, expiresAt)
      const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
      sendJson(response, 200, { user: user.username }, {
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
    if (session) appDatabase.deleteSession(session.token)
    sendJson(response, 200, { ok: true }, {
      'Set-Cookie': 'ai_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getBootstrap(session.userId))
    return true
  }

  if (request.method === 'PUT' && url.pathname === '/api/learning-state') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const state = await readJsonBody(request)
      sendJson(response, 200, appDatabase.saveLearningState(session.userId, state))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '学习进度格式不正确' })
    }
    return true
  }

  if (request.method === 'PUT' && url.pathname === '/api/profile') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const profile = await readJsonBody(request)
      sendJson(response, 200, appDatabase.saveProfile(session.userId, profile))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '学习档案格式不正确' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/content/stats') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getStats())
    return true
  }

  const gradingMatch = request.method === 'POST' && url.pathname.match(/^\/api\/grade\/(translation|speaking|writing)$/u)
  if (gradingMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { lessonId = '', answer = '' } = await readJsonBody(request)
      const lesson = appDatabase.getLessons().find((candidate) => candidate.id === lessonId)
      if (!lesson) {
        sendJson(response, 404, { error: '未找到对应学习内容' })
        return true
      }
      const result = await gradeSubmission(gradingMatch[1], lesson, answer)
      sendJson(response, 200, appDatabase.recordGrading(session.userId, lessonId, gradingMatch[1], answer, result))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '评分请求格式不正确' })
    }
    return true
  }

  const reviewMatch = request.method === 'POST' && url.pathname.match(/^\/api\/review\/(\d+)\/complete$/u)
  if (reviewMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.completeReview(session.userId, Number(reviewMatch[1])))
    } catch (error) {
      sendJson(response, 404, { error: error.message || '未找到复习任务' })
    }
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
}

function serveProduction(request, response) {
  const dist = join(root, 'dist')
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  const candidate = resolve(dist, relative || 'index.html')
  const isInsideDist = candidate === dist || candidate.startsWith(`${dist}${sep}`)
  const safeCandidate = isInsideDist && existsSync(candidate) ? candidate : join(dist, 'index.html')
  const file = existsSync(safeCandidate) && !safeCandidate.endsWith('/') ? safeCandidate : join(dist, 'index.html')

  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), geolocation=()',
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

server.on('close', () => appDatabase.close())
