import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { serveStatic, secureRequest, canonicalOrigin, redirectToSecure, securityHeaders, validateRequestOrigin } from './http-policy.mjs'
import { openAppDatabase } from './database.mjs'
import { gradeSubmission, gradingCapabilities } from './grading.mjs'
import {
  assessPronunciation,
  audioCapabilities,
  createSpeechManifest,
  resolveSpeechRequest,
  synthesizeFullArticleSpeech,
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
canonicalOrigin() // Reject invalid deployment configuration before accepting any traffic.

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
const scryptAsync = promisify(scrypt)

function sendJson(response, status, body, headers = {}) {
  const serialized = JSON.stringify(body)
  const acceptsGzip = /(?:^|,)\s*gzip\s*(?:,|$)/iu.test(String(response.req?.headers['accept-encoding'] ?? ''))
  const payload = acceptsGzip && serialized.length > 1_024 ? gzipSync(serialized, { level: 6 }) : Buffer.from(serialized)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    Vary: 'Accept-Encoding',
    ...(status === 503 ? { 'Retry-After': '5' } : {}),
    ...(acceptsGzip && serialized.length > 1_024 ? { 'Content-Encoding': 'gzip' } : {}),
    ...headers,
  })
  response.end(payload)
}

function sendAudio(request, response, audio) {
  const total = audio.buffer.length
  const range = String(request.headers.range ?? '').match(/^bytes=(\d*)-(\d*)$/u)
  const commonHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': audio.model === 'learner-recording' || request.method !== 'GET' ? 'no-store, private' : 'private, max-age=86400',
    'X-Audio-Cache-Scope': audio.model === 'learner-recording' || request.method !== 'GET' ? 'private' : 'public-speech',
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
  const start = suffixLength === null ? Number(range[1] || 0) : Math.max(0, total - suffixLength)
  const end = suffixLength === null && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= total || start > end || suffixLength === 0) {
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

function loginAttemptKey(request, username = '') {
  return `${clientAddress(request)}:${String(username).trim().toLocaleLowerCase()}`
}

function isLoginRateLimited(request, username) {
  const key = loginAttemptKey(request, username)
  const now = Date.now()
  const attempts = (loginFailures.get(key) ?? []).filter((timestamp) => now - timestamp < loginWindowMs)
  loginFailures.set(key, attempts)
  return attempts.length >= loginFailureLimit
}

function recordLoginFailure(request, username) {
  if (loginFailures.size > 10_000) {
    for (const [key, attempts] of loginFailures) if (!attempts.some((time) => Date.now() - time < loginWindowMs)) loginFailures.delete(key)
    if (loginFailures.size > 10_000) loginFailures.delete(loginFailures.keys().next().value)
  }
  const key = loginAttemptKey(request, username)
  loginFailures.set(key, [...(loginFailures.get(key) ?? []), Date.now()])
}

async function verifyCredentials(username, password) {
  const user = appDatabase.findUser(username)
  if (!user) return null

  try {
    const actual = await scryptAsync(String(password), Buffer.from(user.passwordSalt, 'hex'), 64)
    const expected = Buffer.from(user.passwordHash, 'hex')
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? user : null
  } catch {
    return null
  }
}

function validateRegistration(username, password) {
  const normalizedUsername = String(username ?? '').trim()
  const normalizedPassword = String(password ?? '')
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(normalizedUsername)) {
    throw new Error('用户名需为 3–32 个字母、数字、中文、下划线或连字符')
  }
  if (normalizedPassword.length < 8 || normalizedPassword.length > 128) {
    throw new Error('密码长度需为 8–128 个字符')
  }
  if (!/[A-Za-z]/u.test(normalizedPassword) || !/[0-9]/u.test(normalizedPassword)) {
    throw new Error('密码至少包含一个英文字母和一个数字')
  }
  return { username: normalizedUsername, password: normalizedPassword }
}

function createAuthenticatedSession(response, user) {
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString()
  appDatabase.createSession(user.id, token, expiresAt)
  const secure = secureRequest(response.req) || canonicalOrigin() || process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
  sendJson(response, 200, { user: user.username, userId: user.id }, {
    'Set-Cookie': `ai_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`,
  })
}

function requireSession(request, response) {
  const session = getSession(request)
  if (!session) sendJson(response, 401, { error: '请先登录' })
  else if (request.headers['x-learning-user'] && request.headers['x-learning-user'] !== String(session.userId)) {
    sendJson(response, 409, { error: '账号已切换，请重新登录后继续' }, { 'X-Session-Mismatch': '1' })
    return null
  }
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

  if (request.method === 'GET' && url.pathname === '/api/ready') {
    const checks = { database: appDatabase.getSchemaVersion() >= 9, staticBuild: isDev || existsSync(join(root, 'dist', 'index.html')), tencentSpeech: Boolean(audioCapabilities().cloudSpeech), secureOrigin: Boolean(canonicalOrigin()) }
    const ready = Object.values(checks).every(Boolean)
    sendJson(response, ready ? 200 : 503, { ready, checks })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    const session = getSession(request)
    sendJson(response, 200, session ? { user: session.user, userId: session.userId } : null)
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    try {
      const { username = '', password = '' } = await readJsonBody(request)
      if (isLoginRateLimited(request, username)) {
        sendJson(response, 429, { error: '登录失败次数过多，请 15 分钟后再试' }, { 'Retry-After': '900' })
        return true
      }
      const user = await verifyCredentials(username, password)
      if (!user) {
        recordLoginFailure(request, username)
        sendJson(response, 401, { error: '用户名或密码不正确' })
        return true
      }

      loginFailures.delete(loginAttemptKey(request, username))

      createAuthenticatedSession(response, user)
      return true
    } catch {
      sendJson(response, 400, { error: '登录请求格式不正确' })
      return true
    }
  }


  if (request.method === 'POST' && url.pathname === '/api/register') {
    try {
      const body = await readJsonBody(request)
      const credentials = validateRegistration(body.username, body.password)
      if (isLoginRateLimited(request, credentials.username)) {
        sendJson(response, 429, { error: '请求次数过多，请 15 分钟后再试' }, { 'Retry-After': '900' })
        return true
      }
      if (String(body.confirmPassword ?? '') !== credentials.password) {
        sendJson(response, 400, { error: '两次输入的密码不一致' })
        return true
      }
      const salt = randomBytes(16)
      const passwordHash = await scryptAsync(credentials.password, salt, 64)
      const user = appDatabase.createUser(credentials.username, salt.toString('hex'), passwordHash.toString('hex'))
      loginFailures.delete(loginAttemptKey(request, credentials.username))
      createAuthenticatedSession(response, user)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '注册失败'
      sendJson(response, message === '用户名已被使用' ? 409 : 400, { error: message })
      return true
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/logout') {
    const session = getSession(request)
    if (session && request.headers['x-learning-user'] && request.headers['x-learning-user'] !== String(session.userId)) {
      sendJson(response, 409, { error: '账号已切换，旧退出请求已忽略' })
      return true
    }
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

  if (request.method === 'GET' && url.pathname.startsWith('/api/lessons/')) {
    const session = requireSession(request, response)
    if (!session) return true
    const lesson = appDatabase.getLesson(decodeURIComponent(url.pathname.slice('/api/lessons/'.length)))
    if (!lesson) sendJson(response, 404, { error: '未找到课程' })
    else sendJson(response, 200, lesson)
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/capabilities') {
    const session = requireSession(request, response)
    if (!session) return true
    const grading = gradingCapabilities()
    sendJson(response, 200, { ...audioCapabilities(), aiGrading: false, gradingProvider: grading.provider, gradingModel: grading.model })
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/dictionary/overview') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getDictionaryOverview(session.userId))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/dictionary/report/weekly') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getWordWeeklyReport(session.userId))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/dictionary/search') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.searchDictionary(session.userId, url.searchParams.get('q'), url.searchParams.get('limit')))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/dictionary/study/active') {
    const session = requireSession(request, response)
    if (!session) return true
    sendJson(response, 200, appDatabase.getActiveWordStudySession(session.userId))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/dictionary/study') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.getWordStudySession(
        session.userId,
        url.searchParams.get('listId'),
        url.searchParams.get('scope'),
      ))
    } catch (error) {
      sendJson(response, 404, { error: error.message || '词书不存在' })
    }
    return true
  }

  const dictionaryStudyAttemptMatch = request.method === 'POST' && url.pathname.match(/^\/api\/dictionary\/study\/([^/]+)\/attempt$/u)
  if (dictionaryStudyAttemptMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const result = appDatabase.submitWordStudyAttempt(session.userId, dictionaryStudyAttemptMatch[1], await readJsonBody(request))
      sendJson(response, 200, { ...result, overview: appDatabase.getDictionaryOverview(session.userId) })
    } catch (error) {
      sendJson(response, 400, { error: error.message || '单词作答保存失败' })
    }
    return true
  }

  const dictionaryStudyActionMatch = request.method === 'POST' && url.pathname.match(/^\/api\/dictionary\/study\/([^/]+)\/action$/u)
  if (dictionaryStudyActionMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.updateWordStudySession(session.userId, dictionaryStudyActionMatch[1], await readJsonBody(request)))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '学习会话更新失败' })
    }
    return true
  }

  if (request.method === 'POST' && url.pathname === '/api/dictionary/preferences') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.saveWordPreference(session.userId, await readJsonBody(request)))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '词书设置保存失败' })
    }
    return true
  }

  const dictionaryEntryMatch = request.method === 'GET' && url.pathname.match(/^\/api\/dictionary\/entries\/(\d+)$/u)
  if (dictionaryEntryMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.getDictionaryEntry(session.userId, Number(dictionaryEntryMatch[1])))
    } catch (error) {
      sendJson(response, 404, { error: error.message || '未找到该词条' })
    }
    return true
  }

  const dictionaryActionMatch = request.method === 'POST' && url.pathname.match(/^\/api\/dictionary\/entries\/(\d+)\/action$/u)
  if (dictionaryActionMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { action = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.updateWordEntry(session.userId, Number(dictionaryActionMatch[1]), action))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '单词状态更新失败' })
    }
    return true
  }

  const dictionaryReviewMatch = request.method === 'POST' && url.pathname.match(/^\/api\/dictionary\/entries\/(\d+)\/review$/u)
  if (dictionaryReviewMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { rating = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.reviewWord(session.userId, Number(dictionaryReviewMatch[1]), rating))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '复习结果保存失败' })
    }
    return true
  }

  const dictionaryPronunciationMatch = request.method === 'POST' && url.pathname.match(/^\/api\/dictionary\/entries\/(\d+)\/pronunciation$/u)
  if (dictionaryPronunciationMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const body = await readJsonBody(request, 8 * 1024 * 1024)
      const entry = appDatabase.getDictionaryEntry(session.userId, Number(dictionaryPronunciationMatch[1]))
      const result = await assessPronunciation({ dataUrl: body.dataUrl, referenceText: entry.headword })
      sendJson(response, 200, appDatabase.recordWordPronunciation(session.userId, entry.id, body.sessionId, result))
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '单词口语评测失败' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/word') {
    const session = requireSession(request, response)
    if (!session) return true
    const entryId = Number(url.searchParams.get('entryId'))
    try {
      const entry = appDatabase.getDictionaryEntry(session.userId, entryId)
      const audio = await synthesizeSpeech({ text: entry.headword, rate: 1 })
      const key = createHash('sha256').update(`${entry.normalized}:${audio.voice}`).digest('hex')
      appDatabase.markDictionaryAudio(entry.id, { key, voice: audio.voice })
      sendAudio(request, response, audio)
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '单词发音生成失败' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/manifest') {
    const session = requireSession(request, response)
    if (!session) return true
    const lesson = appDatabase.getLesson(url.searchParams.get('lessonId'))
    if (!lesson) {
      sendJson(response, 404, { error: '未找到对应学习内容' })
      return true
    }
    sendJson(response, 200, createSpeechManifest(lesson))
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/article') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const lesson = appDatabase.getLesson(url.searchParams.get('lessonId'))
      if (!lesson) throw new Error('未找到对应学习内容')
      sendAudio(request, response, await synthesizeFullArticleSpeech(lesson))
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '完整听力生成失败' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/recording') {
    const session = requireSession(request, response)
    if (!session) return true
    if (url.searchParams.has('userId') && url.searchParams.get('userId') !== String(session.userId)) {
      sendJson(response, 403, { error: '这段录音属于另一个账号' })
      return true
    }
    try {
      const recording = appDatabase.getSpeakingRecording(session.userId, url.searchParams.get('lessonId'))
      if (!recording) {
        sendJson(response, 404, { error: '还没有可回听的口语录音' })
        return true
      }
      sendAudio(request, response, {
        buffer: recording.buffer,
        contentType: recording.mimeType,
        model: 'learner-recording',
        provider: 'local',
        voice: 'learner',
      })
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, { error: error.message || '读取口语录音失败' })
    }
    return true
  }

  if (request.method === 'GET' && url.pathname === '/api/audio/speech') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const lesson = appDatabase.getLesson(url.searchParams.get('lessonId'))
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
      const lesson = appDatabase.getLesson(body.lessonId)
      if (!lesson) {
        sendJson(response, 404, { error: '未找到对应学习内容' })
        return true
      }
      const lastSpeakingRecording = appDatabase.saveSpeakingRecording(
        session.userId,
        lesson.id,
        body.dataUrl,
        body.durationSeconds,
      )
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
      sendJson(response, 200, { ...saved, lastSpeakingRecording })
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

  if (request.method === 'POST' && url.pathname === '/api/vocabulary/action') {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { lessonId = '', term = '', action = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.updateVocabulary(session.userId, lessonId, term, action))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '生词操作失败' })
    }
    return true
  }

  const restartLessonMatch = request.method === 'POST' && url.pathname.match(/^\/api\/lessons\/([^/]+)\/restart$/u)
  if (restartLessonMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      sendJson(response, 200, appDatabase.restartLesson(session.userId, decodeURIComponent(restartLessonMatch[1])))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '重新学习失败' })
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
      const lesson = appDatabase.getLesson(lessonId)
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

  const reviewActionMatch = request.method === 'POST' && url.pathname.match(/^\/api\/review-items\/(\d+)\/action$/u)
  if (reviewActionMatch) {
    const session = requireSession(request, response)
    if (!session) return true
    try {
      const { action = '' } = await readJsonBody(request)
      sendJson(response, 200, appDatabase.updateReviewItem(session.userId, Number(reviewActionMatch[1]), action))
    } catch (error) {
      sendJson(response, 400, { error: error.message || '错题操作失败' })
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
  return serveStatic(request, response, join(root, 'dist'), mimeTypes)
}

let vite
if (isDev) {
  const { createServer: createViteServer } = await import('vite')
  const hmrPort = Number(process.env.VITE_HMR_PORT ?? (20_000 + (port % 20_000)))
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { port: hmrPort, clientPort: hmrPort } },
    appType: 'spa',
  })
}

const requestHandler = async (request, response) => {
  const requestId = randomBytes(8).toString('hex')
  const started = performance.now()
  response.setHeader('X-Request-Id', requestId)
  if (!isDev) for (const [name, value] of Object.entries(securityHeaders(request))) response.setHeader(name, value)
  response.on('finish', () => {
    const durationMs = Math.round(performance.now() - started)
    if (durationMs >= 1000 || response.statusCode >= 500) console.warn(JSON.stringify({ event: 'request', requestId, method: request.method, path: String(request.url).split('?')[0], status: response.statusCode, durationMs }))
  })
  try {
    if (redirectToSecure(request, response, useHttps, httpsPort)) return
    if (await handleApi(request, response)) return
    if (vite) {
      vite.middlewares(request, response, () => sendJson(response, 404, { error: 'NOT_FOUND' }))
      return
    }
    await serveProduction(request, response)
  } catch (error) {
    console.error(JSON.stringify({ event: 'request-error', requestId, type: error?.name ?? 'Error' }))
    if (!response.headersSent) sendJson(response, 500, { error: '服务暂时异常，请重试', requestId })
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

const bindHost = process.env.BIND_HOST || (canonicalOrigin() ? '127.0.0.1' : '0.0.0.0')
server.requestTimeout = 120_000
server.headersTimeout = 30_000
server.listen(port, bindHost, () => {
  console.log(`AI English is running on HTTP at port ${port}`)
})

secureServer?.listen(httpsPort, bindHost, () => {
  console.log(`AI English secure access is running on HTTPS at port ${httpsPort}`)
})

process.on('exit', () => appDatabase.close())
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  const timer = setTimeout(() => process.exit(0), 10_000)
  timer.unref()
  Promise.all([new Promise((done) => server.close(done)), secureServer ? new Promise((done) => secureServer.close(done)) : Promise.resolve(), vite?.close()]).then(() => process.exit(0))
})
