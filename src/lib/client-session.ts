import type { LearningState, Session } from '../types'

const ACCOUNT_KEY = 'ink-air-account-v1'
const LOCK_KEY = 'ink-air-signed-out-v1'
const LEGACY_KEY = 'ink-air-pending-learning-state'
const LOGOUT_KEY = 'ink-air-pending-logout-v1'
let owner: number | null = null
let scope = new AbortController()
let locallyLocked = false

function read(key: string) { try { return localStorage.getItem(key) } catch { return null } }
function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); return true } catch { return false }
}
function quarantineLegacyDraft() {
  const draft = read(LEGACY_KEY)
  if (!draft) return
  const archiveKey = 'ink-air-quarantined-legacy-draft-v1'
  const archived = read(archiveKey)
  // Retain an ownerless draft for manual recovery, but never load it into a learner's state.
  // If storage is full or another draft is already archived, leave the old key untouched.
  if (archived === draft || (archived === null && write(archiveKey, draft))) write(LEGACY_KEY, null)
}
export function isSessionLocked() { return locallyLocked || read(LOCK_KEY) === '1' }
export function queueLogout(userId: number | null) { if (userId !== null) write(LOGOUT_KEY, String(userId)) }
export function queuedLogout() { const value = Number(read(LOGOUT_KEY)); return Number.isSafeInteger(value) && value > 0 ? value : null }
export function clearQueuedLogout(userId: number) { if (queuedLogout() === userId) write(LOGOUT_KEY, null) }
export function sessionScope() { return { owner, signal: scope.signal } }
export function activateSession(session: Session, explicit = false) {
  if (!Number.isSafeInteger(session.userId) || session.userId <= 0) throw new Error('服务已更新，请重启 AIEnglish 服务后重新登录')
  if (!explicit && isSessionLocked()) return false
  if (owner !== session.userId) { scope.abort(); scope = new AbortController() }
  owner = session.userId
  locallyLocked = false
  write(LOCK_KEY, null)
  quarantineLegacyDraft()
  write(ACCOUNT_KEY, String(owner))
  return true
}
export function lockSession(broadcast = true) {
  locallyLocked = true
  scope.abort()
  scope = new AbortController()
  owner = null
  if (broadcast) write(LOCK_KEY, '1')
  window.dispatchEvent(new Event('ink-air-session-ended'))
}
window.addEventListener('storage', (event) => {
  if ((event.key === LOCK_KEY && event.newValue === '1') ||
      (event.key === ACCOUNT_KEY && owner !== null && event.newValue !== String(owner))) lockSession(false)
})

const pendingKey = (userId: number) => `ink-air-pending-v3:${userId}`
export function readPendingState(userId: number): LearningState | null {
  quarantineLegacyDraft()
  try {
    const envelope = JSON.parse(read(pendingKey(userId)) ?? 'null')
    return envelope?.version === 3 && envelope.owner === userId && envelope.state?.version === 2 &&
      typeof envelope.state.currentLessonId === 'string' && envelope.state.records && typeof envelope.state.records === 'object'
      ? envelope.state : null
  } catch { return null }
}
export function stagePendingState(userId: number, state: LearningState) {
  return write(pendingKey(userId), JSON.stringify({ version: 3, owner: userId, state }))
}
export function clearPendingState(userId: number, state: LearningState) {
  const pending = readPendingState(userId)
  if (pending && JSON.stringify(pending) === JSON.stringify(state)) write(pendingKey(userId), null)
}
