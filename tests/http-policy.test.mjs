import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acceptedEncoding, canonicalOrigin, secureRequest, redirectToSecure, serveStatic } from '../server/http-policy.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

test('compression honors encoding quality and exclusions', () => {
  assert.equal(acceptedEncoding('gzip, br'), 'br')
  assert.equal(acceptedEncoding('br;q=0, gzip;q=1'), 'gzip')
  assert.equal(acceptedEncoding('gzip;q=0, br;q=0'), 'identity')
  assert.equal(acceptedEncoding('gzip;q=0.2, br;q=0.1'), 'gzip')
})
test('production redirects use only the canonical HTTPS origin and trust only local proxy headers', () => {
  const oldOrigin = process.env.PUBLIC_ORIGIN, oldTrust = process.env.TRUST_PROXY
  try {
    process.env.PUBLIC_ORIGIN = 'https://learn.example.com'; process.env.TRUST_PROXY = 'true'
    assert.equal(canonicalOrigin(), 'https://learn.example.com')
    assert.equal(secureRequest({ socket: { remoteAddress: '8.8.8.8' }, headers: { 'x-forwarded-proto': 'https' } }), false)
    assert.equal(secureRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } }), true)
    let status, headers
    redirectToSecure({ url: '//attacker.example/login?x=1', socket: { remoteAddress: '8.8.8.8' }, headers: { host: 'attacker.example' } }, { writeHead: (s, h) => { status = s; headers = h }, end() {} }, false, 4174)
    assert.equal(status, 308); assert.equal(headers.Location, 'https://learn.example.com/login?x=1')
    process.env.PUBLIC_ORIGIN = 'http://learn.example.com'; assert.throws(canonicalOrigin)
  } finally {
    if (oldOrigin === undefined) delete process.env.PUBLIC_ORIGIN; else process.env.PUBLIC_ORIGIN = oldOrigin
    if (oldTrust === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = oldTrust
  }
})

test('static delivery compresses, revalidates, handles HEAD and rejects missing assets', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-english-static-'))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<h1>fixture</h1>')
  await writeFile(join(dir, 'assets', 'app-12345678.js'), '/* compressible */\n'.repeat(1000))
  const server = createServer((req, res) => { void serveStatic(req, res, dir, { '.html': 'text/html', '.js': 'text/javascript' }).catch(() => { res.writeHead(500); res.end() }) })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  context.after(() => new Promise((done) => server.close(done)))
  const base = `http://127.0.0.1:${server.address().port}`
  const response = await fetch(base + '/assets/app-12345678.js', { headers: { 'Accept-Encoding': 'gzip' } })
  assert.equal(response.headers.get('content-encoding'), 'gzip'); assert.match(response.headers.get('cache-control'), /immutable/u)
  assert.ok(Number(response.headers.get('content-length')) < 1000); await response.arrayBuffer()
  const cached = await fetch(base + '/assets/app-12345678.js', { headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': response.headers.get('etag') } })
  assert.equal(cached.status, 304)
  const head = await fetch(base + '/assets/app-12345678.js', { method: 'HEAD' }); assert.equal((await head.arrayBuffer()).byteLength, 0)
  assert.equal((await fetch(base + '/assets/missing.js')).status, 404)
  assert.equal((await fetch(base + '/learning')).status, 200)
})
