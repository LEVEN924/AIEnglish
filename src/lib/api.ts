import type { AppCapabilities, AudioManifest, BootstrapData, DictionaryEntry, DictionaryOverview, GradingFeedback, LearningProfile, LearningState, Lesson, SavedVocabulary, Session, WeeklyReport, WordStudyAttemptResult, WordStudyMode, WordStudySession, WordWeeklyReport } from '../types'

import { request } from './request'
import { activateSession, clearQueuedLogout, isSessionLocked, lockSession, queuedLogout, queueLogout, sessionScope } from './client-session'
let pendingLogout: Promise<{ ok: boolean }> = Promise.resolve({ ok: true })
let logoutInFlight = false
function flushLogout(): Promise<{ ok: boolean }> {
  if (logoutInFlight) return pendingLogout
  const owner = queuedLogout()
  if (owner === null || !navigator.onLine) return Promise.resolve({ ok: false })
  logoutInFlight = true
  pendingLogout = request<{ ok: boolean }>('/api/logout', { method: 'POST', body: '{}', headers: { 'X-Learning-User': String(owner) } }, { auth: true, timeout: 5000 })
    .then((result) => { clearQueuedLogout(owner); return result })
    .finally(() => { logoutInFlight = false })
  return pendingLogout
}
window.addEventListener('online', () => { void flushLogout().catch(() => undefined) })

export async function getSession(): Promise<Session | null> {
  if (isSessionLocked()) { void flushLogout().catch(() => undefined); return null }
  const session = await request<Session | null>('/api/session', {}, { auth: true })
  return session && activateSession(session) ? session : null
}

export async function login(username: string, password: string): Promise<Session> {
  await flushLogout().catch(() => undefined)
  const session = await request<Session>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, { auth: true })
  activateSession(session, true)
  const oldOwner = queuedLogout(); if (oldOwner !== null) clearQueuedLogout(oldOwner)
  return session
}

export async function register(username: string, password: string, confirmPassword: string): Promise<Session> {
  await flushLogout().catch(() => undefined)
  const session = await request<Session>('/api/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, confirmPassword }),
  }, { auth: true })
  activateSession(session, true)
  const oldOwner = queuedLogout(); if (oldOwner !== null) clearQueuedLogout(oldOwner)
  return session
}

export async function logout(): Promise<{ ok: boolean }> {
  const { owner } = sessionScope()
  queueLogout(owner)
  lockSession()
  return flushLogout()
}

export function getBootstrap(): Promise<BootstrapData> {
  return request<BootstrapData>('/api/bootstrap')
}

export function getLesson(lessonId: string): Promise<Lesson> {
  return request<Lesson>(`/api/lessons/${encodeURIComponent(lessonId)}`)
}

export function saveLearningState(state: LearningState, signal?: AbortSignal): Promise<LearningState> {
  return request<LearningState>('/api/learning-state', {
    method: 'PUT',
    body: JSON.stringify(state),
    signal,
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

export function getAudioManifest(lessonId: string): Promise<AudioManifest> {
  return request<AudioManifest>(`/api/audio/manifest?lessonId=${encodeURIComponent(lessonId)}`)
}

export function assessRecording(
  lessonId: string,
  dataUrl: string,
  durationSeconds: number,
): Promise<GradingFeedback & {
  score: number
  correct: boolean
  lastSpeakingRecording?: { url: string; durationSeconds: number; createdAt: string }
}> {
  return request('/api/audio/assess', {
    method: 'POST',
    body: JSON.stringify({ lessonId, dataUrl, durationSeconds }),
  // SOE-N streams audio in real time (up to 5 minutes). Allow upload and final scoring too.
  }, { timeout: 420_000 })
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

export function updateVocabularyItem(
  lessonId: string,
  term: string,
  action: 'snooze' | 'master' | 'delete' | 'restore',
): Promise<{ action: string; vocabularyBook: SavedVocabulary[] }> {
  return request('/api/vocabulary/action', {
    method: 'POST',
    body: JSON.stringify({ lessonId, term, action }),
  })
}

export function updateReviewItem(
  errorItemId: number,
  action: 'snooze' | 'master' | 'delete' | 'restore',
): Promise<{ action: string; reviewItems: import('../types').ReviewItem[] }> {
  return request(`/api/review-items/${errorItemId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

export function restartLesson(lessonId: string): Promise<LearningState> {
  return request(`/api/lessons/${encodeURIComponent(lessonId)}/restart`, { method: 'POST', body: '{}' })
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

export function getDictionaryOverview(signal?: AbortSignal): Promise<DictionaryOverview> {
  return request('/api/dictionary/overview', { signal })
}

export function searchDictionary(query: string, signal?: AbortSignal): Promise<{ query: string; entries: DictionaryEntry[] }> {
  return request(`/api/dictionary/search?q=${encodeURIComponent(query)}`, { signal })
}

export function getDictionaryEntry(entryId: number): Promise<DictionaryEntry> {
  return request(`/api/dictionary/entries/${entryId}`)
}

export function getWordStudySession(listId: string, scope: 'review' | 'new'): Promise<WordStudySession> {
  const query = new URLSearchParams({ listId, scope })
  return request(`/api/dictionary/study?${query.toString()}`)
}

export function getActiveWordStudySession(): Promise<WordStudySession | null> {
  return request('/api/dictionary/study/active')
}

export function saveWordPreference(activeListId: string, dailyNew: number, dailyGoalMinutes: number, targetDate: string): Promise<DictionaryOverview> {
  return request('/api/dictionary/preferences', {
    method: 'POST',
    body: JSON.stringify({ activeListId, dailyNew, dailyGoalMinutes, targetDate }),
  })
}

export function submitWordStudyAttempt(
  sessionId: string,
  payload: {
    itemKey: string
    entryId: number
    mode: WordStudyMode
    answer: string
    rating: 'again' | 'hard' | 'good' | 'easy'
    responseMs: number
    hintCount: number
    diagnosticKnown?: boolean
  },
): Promise<WordStudyAttemptResult> {
  return request(`/api/dictionary/study/${encodeURIComponent(sessionId)}/attempt`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateWordStudySession(
  sessionId: string,
  action: 'pause' | 'skip' | 'report',
  entryId?: number,
): Promise<WordStudySession> {
  return request(`/api/dictionary/study/${encodeURIComponent(sessionId)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action, entryId }),
  })
}

export function getWordWeeklyReport(): Promise<WordWeeklyReport> {
  return request('/api/dictionary/report/weekly')
}

export function assessWordPronunciation(
  entryId: number,
  sessionId: string,
  dataUrl: string,
): Promise<GradingFeedback & { score: number; correct: boolean }> {
  return request(`/api/dictionary/entries/${entryId}/pronunciation`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, dataUrl }),
  })
}

export function updateWordEntry(
  entryId: number,
  action: 'add' | 'suspend' | 'master' | 'reset' | 'remove' | 'report',
): Promise<{ action: string; entry: DictionaryEntry; overview: DictionaryOverview }> {
  return request(`/api/dictionary/entries/${entryId}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  })
}

export function reviewWordEntry(
  entryId: number,
  rating: 'again' | 'hard' | 'good' | 'easy',
): Promise<{ rating: string; nextDueAt: string; entry: DictionaryEntry; overview: DictionaryOverview }> {
  return request(`/api/dictionary/entries/${entryId}/review`, {
    method: 'POST',
    body: JSON.stringify({ rating }),
  })
}
