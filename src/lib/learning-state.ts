import { LESSONS } from '../data/lessons'
import type { LearningState, LessonRecord, StepId } from '../types'

function now() {
  return new Date().toISOString()
}

export function createLessonRecord(): LessonRecord {
  const timestamp = now()
  return {
    completedSteps: [],
    skipped: false,
    startedAt: timestamp,
    updatedAt: timestamp,
    listeningNotes: '',
    translationDraft: '',
    writingDraft: '',
    writingAttempts: 0,
  }
}

export function createLearningState(): LearningState {
  return {
    version: 1,
    currentLessonId: LESSONS[0].id,
    records: { [LESSONS[0].id]: createLessonRecord() },
  }
}

export function loadLearningState(user: string): LearningState {
  const fallback = createLearningState()
  try {
    const raw = localStorage.getItem(`ai-english:learning:v1:${user}`)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as LearningState
    if (parsed.version !== 1 || !LESSONS.some((lesson) => lesson.id === parsed.currentLessonId)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

export function saveLearningState(user: string, state: LearningState) {
  localStorage.setItem(`ai-english:learning:v1:${user}`, JSON.stringify(state))
}

export function updateLessonRecord(
  state: LearningState,
  lessonId: string,
  updater: (record: LessonRecord) => LessonRecord,
): LearningState {
  const record = state.records[lessonId] ?? createLessonRecord()
  return {
    ...state,
    records: {
      ...state.records,
      [lessonId]: { ...updater(record), updatedAt: now() },
    },
  }
}

export function completeStep(state: LearningState, lessonId: string, step: StepId): LearningState {
  return updateLessonRecord(state, lessonId, (record) => ({
    ...record,
    completedSteps: record.completedSteps.includes(step)
      ? record.completedSteps
      : [...record.completedSteps, step],
  }))
}
