export const STEP_ORDER = ['guide', 'listening', 'translation', 'speaking', 'writing', 'summary'] as const

export type StepId = (typeof STEP_ORDER)[number]
export type DifficultyLevel = 'L1' | 'L2' | 'L3'

export interface VocabularyItem {
  term: string
  ipa: string
  part: string
  meaning: string
  example?: string | null
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
    legacyKeySentence?: string
  }
  speakingPrompt: string
  writing: {
    promptZh: string
    answers: string[]
    hint: string
    secondaryPromptZh: string
    secondaryAnswers: string[]
    secondaryHint: string
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

export interface LessonSummary {
  id: string
  slug: string
  title: string
  titleZh: string
  topic: string
  difficulty: Pick<Lesson['difficulty'], 'level' | 'label' | 'cefr'>
  estimatedMinutes: number
  source: Pick<Lesson['source'], 'publisher'>
  quality: Pick<Lesson['quality'], 'total'>
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
  lastSpeakingRecording?: {
    url: string
    durationSeconds: number
    createdAt: string
  }
  writingDraft: string
  writingAttempts: number
  writingCorrect?: boolean
  writingFeedback?: GradingFeedback
  writingTasks?: WritingTaskState[]
}

export interface WritingTaskState {
  draft: string
  attempts: number
  correct?: boolean
  feedback?: GradingFeedback
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
  prompt?: string
  referenceScope?: 'full' | 'excerpt'
  graderType?: 'local' | 'tencent-tmt-rubric' | 'tencent-soe'
  submissionVersion?: number
  acousticAssessment?: boolean
  wordsPerMinute?: number
  transcript?: string
  words?: Array<{
    segment: number
    word: string
    referenceWord: string
    accuracy: number
    fluency: number
    matchTag: number
    phones?: Array<{ phone: string; referencePhone: string; accuracy: number }>
  }>
  providerScores?: {
    suggested: number
    accuracy: number
    fluency: number
    completion: number
  }
  referenceSegments?: number
  audioDurationSeconds?: number
  segments?: Array<{
    index: number
    source: string
    answer: string
    reference: string
    score: number
  }>
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
  streakDays?: number
  estimatedMinutes?: number
  skillAverages?: {
    translation: number
    speaking: number
    writing: number
  }
  weakestSkill?: 'translation' | 'speaking' | 'writing' | null
  insight?: string
  nextAction?: string
  days: Array<{
    learningDate: string
    totalScore: number
    translationScore: number
    speakingScore: number
    writingScore: number
  }>
}

export interface AppCapabilities {
  provider: string
  cloudTranscription: boolean
  cloudSpeech: boolean
  oralAssessment: boolean
  cloudTranslation: boolean
  aiGrading: boolean
  gradingProvider: string
  gradingModel: string
  transcriptionModel: string
  speechModel: string
  speechVoice: string
  assessmentModel: string
  assessmentStrictness: number
  speechHealthy?: boolean | null
  speechCheckedAt?: string | null
}

export interface AudioManifest {
  provider: string
  available: boolean
  baseRate: number
  article: { text: string; url: string }
  vocabulary: Array<{ term: string; url: string }>
}

export interface BootstrapData {
  lessonCatalog: LessonSummary[]
  currentLesson: Lesson
  learningState: LearningState
  profile: LearningProfile
  reviewItems: ReviewItem[]
  vocabularyBook: SavedVocabulary[]
  weeklyReport: WeeklyReport
  database: {
    engine: string
    lessonCount: number
    dictionaryCount?: number
  }
}

export interface Session {
  user: string
  userId: number
}

export interface WordListSummary {
  id: string
  name: string
  shortName: string
  description: string
  edition: string
  sourceKind: string
  entryCount: number
  studyEnabled: boolean
  learnedCount: number
  masteredCount: number
  dueCount: number
  availableNew: number
}

export interface WordStudyPlan {
  dueBacklog: number
  plannedDue: number
  plannedNew: number
  estimatedMinutes: number
  dailyGoalMinutes: number
  newLimit: number
  daysToTarget: number | null
  recommendedNew: number
}

export interface DictionaryOverview {
  totalCount: number
  phraseCount: number
  cachedAudioCount: number
  learnedCount: number
  masteredCount: number
  dueCount: number
  activeListId: string | null
  dailyNew: number
  dailyGoalMinutes: number
  targetDate: string
  targetExam: string
  recommendedListId: string
  plan: WordStudyPlan
  currentArticle: { id: string; title: string; titleZh: string; wordCount: number } | null
  activeSession: {
    id: string
    listId: string
    shortName: string
    status: 'active' | 'paused'
    completedCount: number
    totalCount: number
    updatedAt: string
  } | null
  lists: WordListSummary[]
}

export interface DictionaryEntry {
  id: number
  headword: string
  normalized: string
  entryType: 'word' | 'phrase'
  ipa: string
  partOfSpeech: string
  meaningZh: string
  definitionEn: string
  roots: string
  memoryNote: string
  exampleEn: string | null
  exampleZh: string | null
  forms: Record<string, string>
  sourceSummary: string
  frequencyRank: number | null
  audioStatus: 'pending' | 'ready' | 'failed'
  progressState: 'new' | 'learning' | 'review' | 'mastered' | 'suspended'
  dueAt: string | null
  repetitions: number
  stability: number
  difficulty: number
  lapses: number
  lastReviewedAt: string | null
  lists?: Array<{ id: string; shortName: string; name: string; itemOrder: number; detail: { cefr?: string } }>
}

export type WordStudyMode = 'meaning' | 'spelling' | 'cloze' | 'listening'

export interface WordStudyItem {
  key: string
  phase: 'review' | 'new' | 'retry'
  attempt: number
  mode: WordStudyMode
  prompt: string
  choices: string[]
  acceptedAnswers: string[]
  hint: string
  entry: DictionaryEntry
}

export interface WordStudySummary {
  reviewed: number
  accuracy: number
  firstPassAccuracy: number
  lapses: number
  hints: number
  newLearned: number
  durationMinutes: number
  nextDueAt: string | null
  weakWords: Array<{ id: number; headword: string; meaningZh: string }>
  modeStats: Record<string, { attempts: number; correct: number }>
}

export interface WordStudySession {
  id: string
  list: { id: string; name: string; shortName: string }
  scope: 'review' | 'new' | 'mixed'
  status: 'active' | 'paused' | 'completed'
  resumed: boolean
  dueCount: number
  newCount: number
  totalCount: number
  currentIndex: number
  remainingCount: number
  estimatedMinutes: number
  items: WordStudyItem[]
  summary: WordStudySummary | null
}

export interface WordStudyAttemptResult {
  correct: boolean
  expectedText: string
  requeued: boolean
  rating: 'again' | 'hard' | 'good' | 'easy'
  nextDueAt: string
  intervalDays: number
  objectiveScore: number
  session: WordStudySession
  overview: DictionaryOverview
}

export interface WordWeeklyReport {
  periodStart: string
  periodEnd: string
  attempts: number
  accuracy: number
  activeRecallAccuracy: number
  averageResponseSeconds: number
  hints: number
  lapses: number
  newLearned: number
  reviewDebt: number
  pronunciationAttempts: number
  pronunciationAverage: number
  modeAccuracy: Record<string, { attempts: number; correct: number; accuracy: number }>
  weakWords: Array<{ id: number; headword: string; meaningZh: string; attempts: number; errors: number }>
  days: Array<{ date: string; attempts: number; correct: number; accuracy: number }>
}

export type PrimaryView = 'today' | 'dictionary' | 'conversations' | 'review' | 'profile'
