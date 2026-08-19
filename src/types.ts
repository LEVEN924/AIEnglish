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
  translationFeedback?: GradingFeedback
  speakingScore?: number
  speakingTranscript?: string
  speakingFeedback?: GradingFeedback
  writingDraft: string
  writingAttempts: number
  writingCorrect?: boolean
  writingFeedback?: GradingFeedback
}

export interface LearningState {
  version: 2
  currentLessonId: string
  records: Record<string, LessonRecord>
}

export interface GradingFeedback {
  score?: number
  correct?: boolean
  summary: string
  strengths: string[]
  improvements: string[]
  dimensions: Array<{ label: string; score: number; weight: number }>
  reference?: string
  graderType?: 'local' | 'openai' | 'deepseek'
  submissionVersion?: number
  acousticAssessment?: boolean
  wordsPerMinute?: number
}

export interface LearningProfile {
  targetExam: string
  preferredLevel: DifficultyLevel
  dailyGoalMinutes: number
  interests: string[]
  reminderTime: string | null
}

export interface ReviewItem {
  id: number
  reviewTaskId?: number
  lessonId: string
  errorType: string
  prompt: string
  userAnswer: string
  correction: string
  explanation: string
  mastery: number
  dueAt?: string
  title: string
  titleZh: string
}

export interface SavedVocabulary extends VocabularyItem {
  lessonId: string
  example?: string | null
  mastery: number
  reviewDueAt?: string | null
  createdAt: string
}

export interface WeeklyReport {
  periodStart: string
  periodEnd: string
  completedLessons: number
  averageScore: number
  reviewAttempts: number
  reviewAverage: number
  days: Array<{
    learningDate: string
    totalScore: number
    translationScore: number
    speakingScore: number
    writingScore: number
  }>
}

export interface AppCapabilities {
  cloudTranscription: boolean
  cloudSpeech: boolean
  aiGrading: boolean
  gradingProvider: string
  gradingModel: string
  transcriptionModel: string
  speechModel: string
  speechVoice: string
}

export interface BootstrapData {
  lessons: Lesson[]
  learningState: LearningState
  profile: LearningProfile
  reviewItems: ReviewItem[]
  vocabularyBook: SavedVocabulary[]
  weeklyReport: WeeklyReport
  database: {
    engine: string
    lessonCount: number
  }
}

export interface Session {
  user: string
}

export type PrimaryView = 'today' | 'conversations' | 'review' | 'profile'
