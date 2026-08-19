import type { BootstrapData, GradingFeedback, LearningProfile, LearningState, Session } from '../types'

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

export function getBootstrap(): Promise<BootstrapData> {
  return request<BootstrapData>('/api/bootstrap')
}

export function saveLearningState(state: LearningState): Promise<LearningState> {
  return request<LearningState>('/api/learning-state', {
    method: 'PUT',
    body: JSON.stringify(state),
  })
}

export function saveLearningProfile(profile: LearningProfile): Promise<LearningProfile> {
  return request<LearningProfile>('/api/profile', {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function gradeAnswer(
  type: 'translation' | 'speaking' | 'writing',
  lessonId: string,
  answer: string,
): Promise<GradingFeedback & { score: number; correct: boolean }> {
  return request(`/api/grade/${type}`, {
    method: 'POST',
    body: JSON.stringify({ lessonId, answer }),
  })
}

export function completeReview(reviewTaskId: number): Promise<{ ok: boolean }> {
  return request(`/api/review/${reviewTaskId}/complete`, { method: 'POST', body: '{}' })
}
