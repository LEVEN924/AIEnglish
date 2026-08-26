import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { test } from 'node:test'

const signalSource = stripTypeScriptTypes(await readFile(new URL('../src/lib/request-signal.ts', import.meta.url), 'utf8'))
const signalHelpers = await import(`data:text/javascript;base64,${Buffer.from(signalSource).toString('base64')}`)
const requestSource = stripTypeScriptTypes(await readFile(new URL('../src/lib/request.ts', import.meta.url), 'utf8'))
  .replace(/^import .+$/gmu, '').replace(/\bexport /gu, '')

function harness(fetch, controller = new AbortController()) {
  const locks = []
  const make = new Function('sessionScope', 'lockSession', 'createRequestSignal', 'throwIfAborted', 'fetch', 'AbortSignal', `${requestSource}\nreturn { request, sessionRequest }`)
  // Chrome 91/115 and pre-17.4 Safari lack one or more of these static APIs.
  const api = make(() => ({ owner: 7, signal: controller.signal }), (...args) => locks.push(args), signalHelpers.createRequestSignal, signalHelpers.throwIfAborted, fetch, {})
  return { ...api, locks, controller }
}

function blockedBody(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('login and authenticated JSON/audio work without modern AbortSignal methods', async (context) => {
  const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted')
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', { configurable: true, value: undefined })
  context.after(() => Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', original))
  let calls = 0
  const api = harness(async (url, init) => {
    calls++
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.signal.aborted, false)
    if (url === '/api/login') {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers.has('X-Learning-User'), false)
      assert.equal(init.headers.get('Content-Type'), 'application/json')
      return Response.json({ userId: 7 })
    }
    assert.equal(init.headers.get('X-Learning-User'), '7')
    return url === '/audio' ? new Response('audio-bytes') : Response.json({ loaded: true })
  })
  assert.deepEqual(await api.request('/api/login', { method: 'POST', body: '{}' }, { auth: true }), { userId: 7 })
  assert.deepEqual(await api.request('/api/bootstrap'), { loaded: true })
  const blob = await api.sessionRequest('/audio', {}, {}, response => response.blob())
  assert.equal(await blob.text(), 'audio-bytes')
  assert.equal(calls, 3)
  assert.deepEqual(api.locks, [])
})

test('request timeout covers body consumption after response headers', async () => {
  const api = harness(async (_, init) => ({ ok: true, headers: new Headers(), json: () => blockedBody(init.signal) }))
  await assert.rejects(api.request('/slow-body', {}, { timeout: 15 }), /请求超时/u)
})

test('account changes cancel loading JSON/audio and cannot lock the replacement account', async () => {
  for (const kind of ['json', 'audio', 'stale-401']) {
    let bodyStarted
    const started = new Promise(resolve => { bodyStarted = resolve })
    const api = harness(async () => ({
      ok: kind !== 'stale-401', status: kind === 'stale-401' ? 401 : 200, headers: new Headers(),
      json: async () => { bodyStarted(); await new Promise(resolve => setTimeout(resolve, 5)); return { fromOldAccount: true } },
    }))
    const pending = kind === 'audio'
      ? api.sessionRequest('/audio', {}, {}, async response => response.json())
      : api.request('/api/bootstrap')
    await started
    api.controller.abort()
    await assert.rejects(pending, error => error.name === 'AbortError')
    assert.deepEqual(api.locks, [])
  }
})

test('caller aborts are respected and a pre-aborted request never reaches the network', async () => {
  let calls = 0
  const api = harness(async (_, init) => { calls++; return blockedBody(init.signal) })
  const caller = new AbortController()
  const pending = api.request('/search', { signal: caller.signal })
  caller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  await assert.rejects(api.request('/search', { signal: caller.signal }), error => error.name === 'AbortError')
  assert.equal(calls, 1)
})

test('401/session mismatch lock only their sender and auth errors retain server feedback', async () => {
  for (const [status, headers, expected] of [[401, {}, [[]]], [409, { 'X-Session-Mismatch': '1' }, [[false]]]]) {
    const api = harness(async () => Response.json({ error: '请重新登录' }, { status, headers }))
    await assert.rejects(api.request('/private'), /请重新登录/u)
    assert.deepEqual(api.locks, expected)
    api.locks.length = 0
    await assert.rejects(api.request('/api/login', {}, { auth: true }), /请重新登录/u)
    assert.deepEqual(api.locks, [])
  }
})

test('only fetch failures report a network error, without retrying a POST', async () => {
  let calls = 0
  const api = harness(async () => { calls++; throw new TypeError('Failed to fetch') })
  await assert.rejects(api.request('/api/login', { method: 'POST', body: '{}' }, { auth: true }), /网络连接失败/u)
  assert.equal(calls, 1)
  const loaded = harness(async () => Response.json({ ok: true }))
  await assert.rejects(loaded.sessionRequest('/api/bootstrap', {}, {}, async () => { throw new TypeError('reader bug') }), /reader bug/u)
})

test('composed signals deduplicate and release listeners/timers after completion and abort', async (context) => {
  const source = new AbortController()
  const add = context.mock.method(source.signal, 'addEventListener')
  const remove = context.mock.method(source.signal, 'removeEventListener')
  const pending = signalHelpers.createRequestSignal([source.signal, source.signal], 10)
  assert.equal(add.mock.callCount(), 1)
  pending.dispose()
  assert.equal(remove.mock.callCount(), 1)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pending.signal.aborted, false)
  assert.equal(pending.timedOut(), false)
  const canceled = signalHelpers.createRequestSignal([source.signal], 1000)
  source.abort()
  assert.equal(canceled.signal.aborted, true)
  assert.equal(remove.mock.callCount(), 2)
})
