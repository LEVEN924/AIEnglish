import type { LearningState, Lesson, LessonRecord, StepId } from '../types'

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
    writingTasks: [
      { draft: '', attempts: 0 },
      { draft: '', attempts: 0 },
    ],
  }
}

export function createLearningState(lessons: Lesson[]): LearningState {
  const firstLessonId = lessons[0]?.id ?? ''
  return {
    version: 2,
    currentLessonId: firstLessonId,
    records: firstLessonId ? { [firstLessonId]: createLessonRecord() } : {},
  }
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
