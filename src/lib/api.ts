import type { Session } from '../types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : '请求失败，请稍后再试')
  }
  return data as T
}

export function getSession(): Promise<Session | null> {
  return request<Session | null>('/api/session')
}

export function login(username: string, password: string): Promise<Session> {
  return request<Session>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/api/logout', { method: 'POST', body: '{}' })
}
