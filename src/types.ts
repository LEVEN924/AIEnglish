export const STEP_ORDER = ['guide', 'listening', 'translation', 'speaking', 'writing', 'summary'] as const

export type StepId = (typeof STEP_ORDER)[number]
export type DifficultyLevel = 'L1' | 'L2' | 'L3'

export interface VocabularyItem {
  term: string
  ipa: string
  part: string
  meaning: string
}

export interface Lesson {
  id: string
  slug: string
  title: string
  titleZh: string
  topic: string
  difficulty: {
    level: DifficultyLevel
    label: string
    cefr: string
    reason: string
  }
  estimatedMinutes: number
  body: string
  guideZh: string
  keyIdeaZh: string
  translation: {
    prompt: string
    referenceZh: string
    gradingNotes: string[]
  }
  speakingPrompt: string
  writing: {
    promptZh: string
    answers: string[]
    hint: string
  }
  vocabulary: VocabularyItem[]
  source: {
    publisher: string
    title: string
    url: string
    publishedAt: string
    updatedAt?: string
    accessedAt: string
    adaptation: string
    rightsNote: string
  }
  quality: {
    sourceReliability: number
    languageAuthenticity: number
    learningValue: number
    topicValue: number
    factualAccuracy: number
    durability: number
    total: number
  }
}

export interface LessonRecord {
  completedSteps: StepId[]
  skipped: boolean
  startedAt: string
  updatedAt: string
  listeningNotes: string
  translationDraft: string
  translationScore?: number
  speakingScore?: number
  writingDraft: string
  writingAttempts: number
  writingCorrect?: boolean
}

export interface LearningState {
  version: 1
  currentLessonId: string
  records: Record<string, LessonRecord>
}

export interface Session {
  user: string
}

export type PrimaryView = 'today' | 'conversations' | 'review' | 'profile'
