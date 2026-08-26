import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep, extname } from 'node:path'
import { networkInterfaces } from 'node:os'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { brotliCompress, gzip, constants } from 'node:zlib'

const br = promisify(brotliCompress)
const gz = promisify(gzip)
const files = new Map()
const building = new Map()
let cachedBytes = 0
const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
export function canonicalOrigin() {
  if (!process.env.PUBLIC_ORIGIN) return null
  const url = new URL(process.env.PUBLIC_ORIGIN)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path')
  return url.origin
}
export function secureRequest(request) {
  return Boolean(request.socket.encrypted || (process.env.TRUST_PROXY === 'true' && loopback(request.socket.remoteAddress) && request.headers['x-forwarded-proto'] === 'https'))
}
export function redirectToSecure(request, response, localTls, httpsPort) {
  if (secureRequest(request) || request.url === '/api/health') return false
  const origin = canonicalOrigin()
  if (!origin && (!localTls || loopback(request.socket.remoteAddress))) return false
  let target = origin
  if (!target) {
    const host = new URL('http://' + request.headers.host).hostname
    const allowed = new Set(['localhost', '127.0.0.1', ...Object.values(networkInterfaces()).flat().filter(Boolean).map((item) => item.address)])
    if (!allowed.has(host)) { response.writeHead(400); response.end('Invalid host'); return true }
    target = 'https://' + host + ':' + httpsPort
  }
  // Append only an origin-relative path: never accept a protocol-relative redirect.
  const path = new URL(request.url, 'http://local.invalid')
  response.writeHead(308, { Location: target + path.pathname + path.search, 'Cache-Control': 'no-store' })
  response.end()
  return true
}
export function securityHeaders(request) {
  return {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
    ...(secureRequest(request) && canonicalOrigin() ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  }
}
export function acceptedEncoding(header = '') {
  const values = new Map(String(header).split(',').map((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    const quality = params.find((param) => param.trim().startsWith('q='))
    const q = quality ? Number(quality.trim().slice(2)) : 1
    return [name, Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0]
  }))
  const choices = ['br', 'gzip'].map((encoding) => [encoding, values.get(encoding) ?? values.get('*') ?? 0]).filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1])
  return choices[0]?.[0] ?? 'identity'
}
export async function serveStatic(request, response, dist, mimeTypes) {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return }
  let pathname
  try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname) } catch { response.writeHead(400); response.end(); return }
  let file = resolve(dist, '.' + pathname)
  if (!file.startsWith(dist + sep) && file !== dist) { response.writeHead(403); response.end(); return }
  let info = await stat(file).catch(() => null)
  if (!info?.isFile()) {
    if (extname(pathname) || pathname.startsWith('/assets/')) { response.writeHead(404); response.end('Not found'); return }
    file = resolve(dist, 'index.html'); info = await stat(file)
  }
  const contentType = mimeTypes[extname(file)] ?? 'application/octet-stream'
  const compressible = /(?:javascript|text\/|json|svg)/u.test(contentType) && info.size > 1024 && info.size < 4 * 1024 * 1024
  const encoding = compressible ? acceptedEncoding(request.headers['accept-encoding']) : 'identity'
  const key = file + ':' + info.mtimeMs + ':' + info.size + ':' + encoding
  let item = files.get(key)
  if (!item && info.size < 4 * 1024 * 1024) {
    if (!building.has(key)) building.set(key, (async () => {
      const raw = await readFile(file)
      const body = encoding === 'br' ? await br(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : encoding === 'gzip' ? await gz(raw) : raw
      const result = { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' }
      files.set(key, result); cachedBytes += body.length
      while (cachedBytes > 16 * 1024 * 1024 || files.size > 64) { const oldest = files.entries().next().value; files.delete(oldest[0]); cachedBytes -= oldest[1].body.length }
      return result
    })().finally(() => building.delete(key)))
    item = await building.get(key)
  }
  const etag = item?.etag ?? 'W/"' + info.size + '-' + info.mtimeMs + '"'
  const headers = {
    'Content-Type': contentType, 'Content-Length': item?.body.length ?? info.size,
    'Cache-Control': /[/\\]assets[/\\].+-[\w-]{8,}\./u.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache',
    ETag: etag, Vary: 'Accept-Encoding', ...(encoding !== 'identity' ? { 'Content-Encoding': encoding } : {}),
  }
  if (String(request.headers['if-none-match'] ?? '').split(/,\s*/u).some((value) => value === etag || value === '*')) {
    delete headers['Content-Length']; response.writeHead(304, headers); response.end(); return
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') response.end()
  else if (item) response.end(item.body)
  else createReadStream(file).on('error', () => response.destroy()).pipe(response)
}
