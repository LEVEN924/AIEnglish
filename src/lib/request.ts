import { lockSession, sessionScope } from './client-session'

export async function sessionFetch(url: string, init: RequestInit = {}, options: { auth?: boolean; timeout?: number } = {}) {
  const captured = sessionScope()
  const headers = new Headers(init.headers)
  if (!options.auth && captured.owner !== null) headers.set('X-Learning-User', String(captured.owner))
  const timeout = AbortSignal.timeout(options.timeout ?? 30_000)
  const signals = [timeout, ...(!options.auth ? [captured.signal] : []), ...(init.signal ? [init.signal] : [])]
  try {
    const response = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any(signals) })
    if (!options.auth) {
      captured.signal.throwIfAborted()
      if (response.status === 401) lockSession()
      else if (response.headers.get('X-Session-Mismatch') === '1') lockSession(false)
    }
    return response
  } catch (error) {
    if (timeout.aborted) throw new Error('请求超时，请检查网络后重试。')
    if (error instanceof TypeError) throw new Error('网络连接失败，请检查连接后重试。')
    throw error
  }
}

export async function request<T>(url: string, init: RequestInit = {}, options: { auth?: boolean; timeout?: number } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await sessionFetch(url, { ...init, headers }, options)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `请求失败（${response.status}），请稍后再试`)
  return data as T
}
