import { lockSession, sessionScope } from './client-session'
import { createRequestSignal, throwIfAborted } from './request-signal'

export async function sessionRequest<T>(url: string, init: RequestInit, options: { auth?: boolean; timeout?: number }, readResponse: (response: Response) => Promise<T>): Promise<T> {
  const captured = sessionScope()
  const headers = new Headers(init.headers)
  if (!options.auth && captured.owner !== null) headers.set('X-Learning-User', String(captured.owner))
  const signals = [...(!options.auth ? [captured.signal] : []), ...(init.signal ? [init.signal] : [])]
  const pending = createRequestSignal(signals, options.timeout ?? 30_000)
  let response: Response | undefined
  try {
    throwIfAborted(pending.signal)
    response = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: pending.signal })
    throwIfAborted(pending.signal)
    // Keep cancellation and the timeout active until JSON/audio has finished loading.
    const data = await readResponse(response)
    throwIfAborted(pending.signal)
    return data
  } catch (error) {
    if (pending.timedOut()) throw new Error('请求超时，请检查网络后重试。')
    throwIfAborted(pending.signal)
    if (!response && error instanceof TypeError) throw new Error('网络连接失败，请检查连接后重试。')
    throw error
  } finally {
    pending.dispose()
    // A stale response must never sign out an account that replaced its sender.
    if (!options.auth && !captured.signal.aborted) {
      if (response?.status === 401) lockSession()
      else if (response?.headers.get('X-Session-Mismatch') === '1') lockSession(false)
    }
  }
}

export async function request<T>(url: string, init: RequestInit = {}, options: { auth?: boolean; timeout?: number } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  return sessionRequest(url, { ...init, headers }, options, async (response) => {
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `请求失败（${response.status}），请稍后再试`)
    return data as T
  })
}
