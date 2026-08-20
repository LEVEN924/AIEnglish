import type { AppCapabilities, AudioManifest, BootstrapData, GradingFeedback, LearningProfile, LearningState, SavedVocabulary, Session, WeeklyReport } from '../types'

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
  type: 'translation' | 'writing',
  lessonId: string,
  answer: string,
  audioMetadata?: Record<string, unknown>,
): Promise<GradingFeedback & { score: number; correct: boolean }> {
  return request(`/api/grade/${type}`, {
    method: 'POST',
    body: JSON.stringify({ lessonId, answer, audioMetadata }),
  })
}

export function getAudioManifest(lessonId: string, rate: number): Promise<AudioManifest> {
  return request<AudioManifest>(`/api/audio/manifest?lessonId=${encodeURIComponent(lessonId)}&rate=${encodeURIComponent(rate)}`)
}

export function assessRecording(
  lessonId: string,
  dataUrl: string,
  durationSeconds: number,
): Promise<GradingFeedback & { score: number; correct: boolean }> {
  return request('/api/audio/assess', {
    method: 'POST',
    body: JSON.stringify({ lessonId, dataUrl, durationSeconds }),
  })
}

export function getCapabilities(): Promise<AppCapabilities> {
  return request<AppCapabilities>('/api/capabilities')
}

export function transcribeRecording(dataUrl: string): Promise<{ transcript: string; provider: string; model: string }> {
  return request('/api/audio/transcribe', {
    method: 'POST',
    body: JSON.stringify({ dataUrl, language: 'en' }),
  })
}

export function toggleVocabulary(lessonId: string, term: string): Promise<{ saved: boolean; vocabularyBook: SavedVocabulary[] }> {
  return request('/api/vocabulary/toggle', {
    method: 'POST',
    body: JSON.stringify({ lessonId, term }),
  })
}

export function attemptReview(reviewTaskId: number, answer: string): Promise<{ correct: boolean; score: number; mastery: number; nextDueAt: string | null; reference: string }> {
  return request(`/api/review/${reviewTaskId}/attempt`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  })
}

export function getWeeklyReport(): Promise<WeeklyReport> {
  return request<WeeklyReport>('/api/report/weekly')
}

export function completeReview(reviewTaskId: number): Promise<{ ok: boolean }> {
  return request(`/api/review/${reviewTaskId}/complete`, { method: 'POST', body: '{}' })
}
