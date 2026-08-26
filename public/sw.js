const CACHE_NAME = 'ink-air-shell-v5'
const AUDIO_CACHE_NAME = 'ink-air-public-speech-v2'
const APP_SHELL = ['/', '/manifest.webmanifest', '/icon.svg']
const PUBLIC_SPEECH = new Set(['/api/audio/article', '/api/audio/speech', '/api/audio/word'])
const MAX_AUDIO_ENTRIES = 48
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
let cacheWrites = Promise.resolve()

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('ink-air-') && ![CACHE_NAME, AUDIO_CACHE_NAME].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()))
})

async function cacheSpeech(request, response) {
  const cache = await caches.open(AUDIO_CACHE_NAME)
  const bytes = Number(response.headers.get('Content-Length'))
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 4 * 1024 * 1024) return
  await cache.put(request, response)
  const keys = await cache.keys()
  let total = 0
  let retained = 0
  for (const key of keys.reverse()) {
    const item = await cache.match(key)
    const size = Number(item?.headers.get('Content-Length') ?? MAX_AUDIO_BYTES)
    total += size
    retained++
    if (total > MAX_AUDIO_BYTES || retained > MAX_AUDIO_ENTRIES) await cache.delete(key)
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/api/audio/recording') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
    return
  }
  if (PUBLIC_SPEECH.has(url.pathname) && !event.request.headers.has('range')) {
    const result = (async () => {
      const cache = await caches.open(AUDIO_CACHE_NAME)
      const cached = await cache.match(event.request)
      if (cached) return { response: cached }
      const response = await fetch(event.request)
      return { response, copy: response.status === 200 && response.headers.get('X-Audio-Cache-Scope') === 'public-speech' ? response.clone() : null }
    })()
    event.respondWith(result.then(({ response }) => response))
    event.waitUntil(result.then(({ copy }) => {
      if (copy) cacheWrites = cacheWrites.catch(() => {}).then(() => cacheSpeech(event.request, copy))
      return cacheWrites
    }).catch(() => {}))
    return
  }
  if (url.pathname.startsWith('/api/')) return
  const result = fetch(event.request)
  event.respondWith(result.catch(async () => {
    const cached = await caches.match(event.request)
    return cached ?? (event.request.mode === 'navigate' ? await caches.match('/') : null) ?? Response.error()
  }))
  event.waitUntil(result.then(async (response) => {
    if (response.ok && (APP_SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/'))) {
      const cache = await caches.open(CACHE_NAME)
      await cache.put(event.request, response.clone())
      const keys = await cache.keys()
      for (const key of keys.slice(0, Math.max(0, keys.length - 40))) await cache.delete(key)
    }
  }).catch(() => {}))
})
