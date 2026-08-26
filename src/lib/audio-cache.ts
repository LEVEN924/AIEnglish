import { request, sessionFetch } from './request'
import { sessionScope } from './client-session'
import { stopAllAudio } from './audio-session'

const resolvedAudio = new Map<string, { objectUrl: string; bytes: number }>()
const pendingAudio = new Map<string, Promise<string>>()
let availability: { at: number; result: Promise<boolean> } | null = null
let cacheBytes = 0
let active = 0
const queue: Array<{ priority: number; run: () => void }> = []

function pump() {
  queue.sort((a, b) => b.priority - a.priority)
  while (active < 2 && queue.length) queue.shift()?.run()
}
function schedule<T>(priority: number, task: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    queue.push({ priority, run: () => {
      active++
      void task().then(resolve, reject).finally(() => { active--; pump() })
    } })
    pump()
  })
}
export function resetAudioCache() {
  stopAllAudio()
  for (const item of resolvedAudio.values()) URL.revokeObjectURL(item.objectUrl)
  resolvedAudio.clear()
  pendingAudio.clear()
  availability = null
  cacheBytes = 0
}
export function peekAudio(url: string): string | undefined {
  const cached = resolvedAudio.get(url)
  if (cached) { resolvedAudio.delete(url); resolvedAudio.set(url, cached) }
  return cached?.objectUrl
}
export function warmAudio(url: string, priority = 0): Promise<string> {
  if (!/^\/api\/audio\/(?:article|speech|word)\?/u.test(url)) return Promise.reject(new Error('不允许缓存私人录音'))
  const cached = peekAudio(url)
  if (cached) return Promise.resolve(cached)
  const pending = pendingAudio.get(url)
  if (pending) return pending
  if (pendingAudio.size >= 64) return Promise.reject(new Error('音频正在排队，请稍后重试'))
  const { signal } = sessionScope()
  const job = schedule(priority, async () => {
    signal.throwIfAborted()
    if (!availability || Date.now() - availability.at > 30_000) {
      availability = { at: Date.now(), result: request<{ cloudSpeech: boolean }>('/api/capabilities').then((data) => data.cloudSpeech).catch((error) => { availability = null; throw error }) }
    }
    if (!await availability.result) throw new Error('腾讯云语音暂不可用，请联系管理员检查配置')
    signal.throwIfAborted()
    const response = await sessionFetch(url, { signal }, { timeout: 90_000 })
    if (!response.ok) {
      const details = await response.json().catch(() => ({}))
      throw new Error(details.error || '腾讯云音频加载失败，请点击重试')
    }
    const blob = await response.blob()
    signal.throwIfAborted()
    if (blob.size > 8 * 1024 * 1024) throw new Error('音频文件过大，请联系管理员检查语音服务')
    const objectUrl = URL.createObjectURL(blob)
    resolvedAudio.set(url, { objectUrl, bytes: blob.size })
    cacheBytes += blob.size
    while ((resolvedAudio.size > 48 || cacheBytes > 24 * 1024 * 1024) && resolvedAudio.size > 1) {
      const oldest = resolvedAudio.entries().next().value!
      resolvedAudio.delete(oldest[0]); cacheBytes -= oldest[1].bytes; URL.revokeObjectURL(oldest[1].objectUrl)
    }
    return objectUrl
  }).finally(() => { if (pendingAudio.get(url) === job) pendingAudio.delete(url) })
  pendingAudio.set(url, job)
  return job
}

export function audioPlaybackError(error: unknown, media?: HTMLMediaElement | null) {
  if (media?.error?.code === 4 || media?.error?.code === 3) return '当前浏览器无法解码音频，请更新浏览器或使用 Chrome / Edge 后重试。'
  if (error instanceof DOMException && error.name === 'NotAllowedError') return '浏览器阻止了播放，请再次点击播放按钮。'
  return error instanceof Error ? error.message : '音频播放失败，请检查网络后重试。'
}
