import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { openAppDatabase } from './database.mjs'
import { gradeSubmission, gradingCapabilities } from './grading.mjs'
import {
  assessPronunciation,
  audioCapabilities,
  createSpeechManifest,
  resolveSpeechRequest,
  synthesizeSpeech,
  transcribeAudio,
} from './audio.mjs'

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
const loginFailures = new Map()
const loginWindowMs = 15 * 60 * 1000
const loginFailureLimit = 5

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(body))
}

function sendAudio(request, response, audio) {
  const total = audio.buffer.length
  const range = String(request.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/u)
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Type': audio.contentType,
    'X-Audio-Model': audio.model,
    'X-Audio-Provider': audio.provider,
    'X-Audio-Voice': audio.voice,
  }
  if (!range) {
    response.writeHead(200, { ...commonHeaders, 'Content-Length': total })
    response.end(audio.buffer)
    return
  }
  const suffixLength = !range[1] && range[2] ? Number(range[2]) : null
  const start = suffixLength === null ? Math.min(Number(range[1] || 0), total - 1) : Math.max(0, total - suffixLength)
  const end = suffixLength === null && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    response.writeHead(416, { 'Content-Range': `bytes */${total}` })
    response.end()
    return
  }
  const chunk = audio.buffer.subarray(start, end + 1)
  response.writeHead(206, {
    ...commonHeaders,
    'Content-Length': chunk.length,
    'Content-Range': `bytes ${start}-${end}/${total}`,
  })
  response.end(chunk)
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

async function readJsonBody(request, limit = 1_048_576) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error('Request body is too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function clientAddress(request) {
  return request.socket.remoteAddress ?? 'unknown'
}

function isLoginRateLimited(request) {
  const key = clientAddress(request)
  const now = Date.now()
  const attempts = (loginFailures.get(key) ?? []).filter((timestamp) => now - timestamp < loginWindowMs)
  loginFailures.set(key, attempts)
  return attempts.length >= loginFailureLimit
}

function recordLoginFailure(request) {
  const key = clientAddress(request)
  loginFailures.set(key, [...(loginFailures.get(key) ?? []), Date.now()])
}

function validateRequestOrigin(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method ?? 'GET')) return true
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
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

  if (!validateRequestOrigin(request)) {
    sendJson(response, 403, { error: '请求来源不受信任' })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, mode: isDev ? 'development' : 'production', schemaVersion: appDatabase.getSchemaVersion() })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    const session = getSession(request)
    sendJson(response, 200, session ? { user: session.user } : null)
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    try {
      if (isLoginRateLimited(request)) {
        sendJson(response, 429, { error: '登录失败次数过多，请 15 分钟后再试' }, { 'Retry-After': '900' })
        return true
      }
      const { username = '', password = '' } = await readJsonBody(request)
      const user = verifyCredentials(username, password)
      if (!user) {
        recordLoginFailure(request)
        sendJson(response, 401, { error: '用户名或密码不正确' })
        return true
      }

      loginFailures.delete(clientAddress(request))

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

  if (request.method === 'GET' && url.pathname === '/api/capabilities') {
    const session = requireSession(request, response)
    if (!session) return true
    const grading = gradingCapabilities()
    sendJson(response, 200, { ...audioCapabilities(), aiGrading: false, gradingProvider: grading.provider, gradingModel: grading.model })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/manifest') {
    const session = requireSession(request, response)
    if (!session) return true
    const lesson = appDatabase.getLessons().find((candidate) => candidate.id === url.searchParams.get('lessonId'))
    if (!lesson) {
      sendJson(response, 404, { error: '未找到对应学习内容' })
      return true
    }
    sendJson(response, 200, createSpeechManifest(lesson, url.searchParams.get('rate')))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/speech') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const lesson = appDatabase.getLessons().find((candidate) => candidate.id === url.searchParams.get('lessonId'))
      if (!lesson) throw new Error('未找到对应学习内容')
      const speechRequest = resolveSpeechRequest(lesson, {
        kind: url.searchParams.get('kind'),
        part: url.searchParams.get('part'),
        term: url.searchParams.get('term'),
        rate: url.searchParams.get('rate'),
      })
      sendAudio(request, response, await synthesizeSpeech(speechRequest))
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '腾讯云语音合成失败' })
    }
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/audio/transcribe') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const body = await readJsonBody(request, 12 * 1024 * 1024)
      sendJson(response, 200, await transcribeAudio(body))
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '语音转写失败' })
    }
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/audio/speech') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const body = await readJsonBody(request)
      sendAudio(request, response, await synthesizeSpeech(body))
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '语音合成失败' })
    }
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/audio/assess') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const body = await readJsonBody(request, 18 * 1024 * 1024)
      const lesson = appDatabase.getLessons().find((candidate) => candidate.id === body.lessonId)
      if (!lesson) {
        sendJson(response, 404, { error: '未找到对应学习内容' })
        return true
      }
      const result = await assessPronunciation({ dataUrl: body.dataUrl, referenceText: lesson.body })
      const saved = appDatabase.recordGrading(
        session.userId,
        lesson.id,
        'speaking',
        result.transcript || '[腾讯智聆真实录音]',
        result,
        {
          durationSeconds: result.audioDurationSeconds,
          audioCaptured: true,
          transcriptionProvider: 'tencent-soe',
          acousticAssessment: true,
          audioHash: result.audioHash,
        },
      )
      sendJson(response, 200, saved)
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '腾讯智聆口语评测失败' })
    }
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

  if (request.method === 'POST' && url.pathname === '/api/vocabulary/toggle') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { lessonId = '', term = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.toggleVocabulary(session.userId, lessonId, term))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '生词本更新失败' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/report/weekly') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getWeeklyReport(session.userId))
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
      const { lessonId = '', answer = '', audioMetadata = null } = await readJsonBody(request)
      const lesson = appDatabase.getLessons().find((candidate) => candidate.id === lessonId)
      if (!lesson) {
        sendJson(response, 404, { error: '未找到对应学习内容' })
        return true
      }
      const result = await gradeSubmission(gradingMatch[1], lesson, answer, audioMetadata)
      sendJson(response, 200, appDatabase.recordGrading(session.userId, lessonId, gradingMatch[1], answer, result, audioMetadata))
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

  const reviewAttemptMatch = request.method === 'POST' && url.pathname.match(/^\/api\/review\/(\d+)\/attempt$/u)
  if (reviewAttemptMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { answer = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.attemptReview(session.userId, Number(reviewAttemptMatch[1]), answer))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '复习提交失败' })
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
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
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

const requestHandler = async (request, response) => {
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
}

const httpsKeyPath = process.env.HTTPS_KEY_PATH
  ? resolve(root, process.env.HTTPS_KEY_PATH)
  : join(root, '.runtime', 'https', 'server-key.pem')
const httpsCertPath = process.env.HTTPS_CERT_PATH
  ? resolve(root, process.env.HTTPS_CERT_PATH)
  : join(root, '.runtime', 'https', 'server-cert.pem')
const useHttps = process.env.HTTPS_ENABLED !== 'false' && existsSync(httpsKeyPath) && existsSync(httpsCertPath)
const httpsPort = Number(process.env.HTTPS_PORT ?? 4174)
const server = createServer(requestHandler)
const secureServer = useHttps
  ? createSecureServer({ key: readFileSync(httpsKeyPath), cert: readFileSync(httpsCertPath) }, requestHandler)
  : null

server.listen(port, '0.0.0.0', () => {
  console.log(`AI English is running on HTTP at port ${port}`)
})

secureServer?.listen(httpsPort, '0.0.0.0', () => {
  console.log(`AI English secure access is running on HTTPS at port ${httpsPort}`)
})

process.on('exit', () => appDatabase.close())
