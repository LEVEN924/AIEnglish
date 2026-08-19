import {
  ArrowRight,
  BookOpen,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  Clock3,
  ExternalLink,
  Headphones,
  LibraryBig,
  LockKeyhole,
  LogOut,
  Menu,
  MessageCircle,
  Mic,
  NotebookText,
  Pause,
  PenLine,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Square,
  UserRound,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { attemptReview, gradeAnswer, getBootstrap, getSession, login, logout, saveLearningProfile, saveLearningState, toggleVocabulary, transcribeRecording } from './lib/api'
import {
  completeStep,
  createLessonRecord,
  updateLessonRecord,
} from './lib/learning-state'
import {
  STEP_ORDER,
  type BootstrapData,
  type GradingFeedback,
  type LearningState,
  type LearningProfile,
  type Lesson,
  type LessonRecord,
  type PrimaryView,
  type ReviewItem,
  type SavedVocabulary,
  type Session,
  type StepId,
  type WeeklyReport,
} from './types'

const STEP_META: Array<{ id: StepId; label: string; icon: LucideIcon }> = [
  { id: 'guide', label: '导读', icon: BookOpen },
  { id: 'listening', label: '听力', icon: Headphones },
  { id: 'translation', label: '翻译', icon: MessageCircle },
  { id: 'speaking', label: '口语', icon: Mic },
  { id: 'writing', label: '写作', icon: PenLine },
  { id: 'summary', label: '总结', icon: CircleCheck },
]

const NAV_ITEMS: Array<{ id: PrimaryView; label: string; icon: LucideIcon }> = [
  { id: 'today', label: '今日', icon: BookOpen },
  { id: 'conversations', label: '对话', icon: MessageCircle },
  { id: 'review', label: '复盘', icon: NotebookText },
  { id: 'profile', label: '我的', icon: UserRound },
]

const WAVEFORM_BARS = Array.from({ length: 56 }, (_, index) =>
  Math.round(18 + Math.abs(Math.sin(index * 1.47) * 32) + (index % 5) * 4),
)

interface BrowserSpeechRecognition {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null
  onerror: (() => void) | null
  start: () => void
  stop: () => void
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    getSession()
      .then((nextSession) => {
        if (active) setSession(nextSession)
      })
      .catch(() => {
        if (active) setSession(null)
      })
    return () => {
      active = false
    }
  }, [])

  if (session === undefined) return <LoadingScreen />
  if (session === null) return <LoginScreen onAuthenticated={setSession} />

  return (
    <AuthenticatedWorkspace
      session={session}
      onLogout={async () => {
        await logout().catch(() => undefined)
        setSession(null)
      }}
    />
  )
}

function AuthenticatedWorkspace({ session, onLogout }: { session: Session; onLogout: () => Promise<void> }) {
  const [bootstrap, setBootstrap] = useState<BootstrapData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    getBootstrap()
      .then((data) => {
        if (active) setBootstrap(data)
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : '无法读取学习数据库')
      })
    return () => { active = false }
  }, [])

  if (error) {
    return (
      <main className="loading-screen" role="alert">
        <span className="brand-seal" aria-hidden="true">!</span>
        <p>{error}</p>
        <button className="double-border-button" type="button" onClick={() => window.location.reload()}><span>重新载入</span></button>
      </main>
    )
  }
  if (!bootstrap) return <LoadingScreen />

  return <LearningWorkspace session={session} bootstrap={bootstrap} onLogout={onLogout} />
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-live="polite">
      <span className="brand-seal" aria-hidden="true">I·A</span>
      <p>正在打开今日档案…</p>
    </main>
  )
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [username, setUsername] = useState('LEVEN')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      onAuthenticated(await login(username, password))
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="login-screen">
      <section className="login-editorial" aria-labelledby="login-title">
        <div className="login-brand">
          <div className="brand-lockup">
            <span className="brand-name">Ink &amp; Air</span>
            <span className="brand-subtitle">每日一课，英文会话</span>
          </div>
          <span className="edition-mark">PERSONAL ARCHIVE · 001</span>
        </div>

        <div className="login-copy">
          <p className="folio-number">01</p>
          <h1 id="login-title">把每天的一篇英语，<br />读成自己的档案。</h1>
          <p>听懂、翻译、开口、写下，再把错误收进下一次复习。</p>
        </div>

        <div className="archive-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>

      <section className="login-panel" aria-label="登录">
        <div className="login-ticket">
          <LockKeyhole size={21} strokeWidth={1.5} aria-hidden="true" />
          <div>
            <span>PRIVATE READING ROOM</span>
            <strong>私人阅览室</strong>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <label>
            <span>登录用户</span>
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            <span>密码</span>
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </label>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="double-border-button" type="submit" disabled={submitting || !username || !password}>
            <span>{submitting ? '核验中…' : '进入今日学习'}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </form>
        <p className="login-note">凭据仅由本机服务核验，密码不会写入浏览器存储。</p>
      </section>
    </main>
  )
}

function LearningWorkspace({
  session,
  bootstrap,
  onLogout,
}: {
  session: Session
  bootstrap: BootstrapData
  onLogout: () => Promise<void>
}) {
  const [view, setView] = useState<PrimaryView>('today')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [syncStatus, setSyncStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [profile, setProfile] = useState<LearningProfile>(bootstrap.profile)
  const [state, setState] = useState<LearningState>(bootstrap.learningState)
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>(bootstrap.reviewItems)
  const [vocabularyBook, setVocabularyBook] = useState<SavedVocabulary[]>(bootstrap.vocabularyBook)
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport>(bootstrap.weeklyReport)
  const lessons = bootstrap.lessons
  const lesson = lessons.find((candidate) => candidate.id === state.currentLessonId) ?? lessons[0]
  const record = state.records[lesson.id] ?? createLessonRecord()

  useEffect(() => {
    setSyncStatus('saving')
    const timer = window.setTimeout(() => {
      saveLearningState(state)
        .then(() => setSyncStatus('saved'))
        .catch(() => setSyncStatus('error'))
    }, 450)
    return () => window.clearTimeout(timer)
  }, [state])

  const updateCurrentRecord = useCallback((updater: (record: LessonRecord) => LessonRecord) => {
    setState((current) => updateLessonRecord(current, current.currentLessonId, updater))
  }, [])

  const finishStep = useCallback((step: StepId) => {
    setState((current) => completeStep(current, current.currentLessonId, step))
  }, [])

  function skipCurrentLesson() {
    setState((current) => {
      const currentIndex = lessons.findIndex((candidate) => candidate.id === current.currentLessonId)
      const withSkip = updateLessonRecord(current, current.currentLessonId, (currentRecord) => ({
        ...currentRecord,
        skipped: true,
      }))
      const candidates = [...lessons.slice(currentIndex + 1), ...lessons.slice(0, currentIndex)]
      const nextLesson = candidates.find((candidate) => !withSkip.records[candidate.id]?.skipped) ?? candidates[0]
      return {
        ...withSkip,
        currentLessonId: nextLesson.id,
        records: {
          ...withSkip.records,
          [nextLesson.id]: withSkip.records[nextLesson.id] ?? createLessonRecord(),
        },
      }
    })
    setNotice('已跳过本篇，下一篇档案已为你打开。')
    window.setTimeout(() => setNotice(''), 3200)
  }

  function navigate(nextView: PrimaryView) {
    setView(nextView)
    setMobileNavOpen(false)
    if (nextView === 'review') {
      getBootstrap().then((data) => {
        setReviewItems(data.reviewItems)
        setVocabularyBook(data.vocabularyBook)
        setWeeklyReport(data.weeklyReport)
      }).catch(() => undefined)
    }
  }

  return (
    <div className="app-shell">
      <AppSidebar
        activeView={view}
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onNavigate={navigate}
      />

      <div className="app-stage">
        <AppHeader
          onMenu={() => setMobileNavOpen((open) => !open)}
          user={session.user}
          syncStatus={syncStatus}
        />

        <main className="app-content">
          {view === 'today' ? (
            <TodayView
              lesson={lesson}
              lessonNumber={lessons.findIndex((candidate) => candidate.id === lesson.id) + 1}
              record={record}
              onRecordChange={updateCurrentRecord}
              onCompleteStep={finishStep}
              onSkip={skipCurrentLesson}
              savedVocabulary={vocabularyBook}
              onToggleVocabulary={async (term) => {
                const result = await toggleVocabulary(lesson.id, term)
                setVocabularyBook(result.vocabularyBook)
                setNotice(result.saved ? `“${term}”已收入生词本。` : `“${term}”已移出生词本。`)
              }}
            />
          ) : null}
          {view === 'conversations' ? (
            <ConversationsView
              lessons={lessons}
              state={state}
              onOpenLesson={(lessonId) => {
                setState((current) => ({
                  ...current,
                  currentLessonId: lessonId,
                  records: {
                    ...current.records,
                    [lessonId]: current.records[lessonId] ?? createLessonRecord(),
                  },
                }))
                setView('today')
              }}
            />
          ) : null}
          {view === 'review' ? (
            <ReviewView
              lessons={lessons}
              state={state}
              reviewItems={reviewItems}
              vocabularyBook={vocabularyBook}
              weeklyReport={weeklyReport}
              onAttempt={async (item, answer) => {
                if (!item.reviewTaskId) throw new Error('本条复习任务不可用')
                const result = await attemptReview(item.reviewTaskId, answer)
                const refreshed = await getBootstrap()
                setReviewItems(refreshed.reviewItems)
                setWeeklyReport(refreshed.weeklyReport)
                setNotice(result.correct ? `复习正确：${result.score} 分，熟练度 ${result.mastery}/3。` : `本次 ${result.score} 分，系统已安排明日重试。`)
                return result
              }}
            />
          ) : null}
          {view === 'profile' ? (
            <ProfileView
              user={session.user}
              state={state}
              lessons={lessons}
              profile={profile}
              databaseEngine={bootstrap.database.engine}
              onProfileChange={async (nextProfile) => {
                setProfile(nextProfile)
                try {
                  setProfile(await saveLearningProfile(nextProfile))
                  setNotice('学习档案已保存到数据库。')
                } catch {
                  setNotice('学习档案保存失败，请稍后重试。')
                }
              }}
              onLogout={onLogout}
            />
          ) : null}
        </main>
      </div>

      <MobileBottomNav activeView={view} onNavigate={navigate} />
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  )
}

function AppHeader({
  onMenu,
  user,
  syncStatus,
}: {
  onMenu: () => void
  user: string
  syncStatus: 'saved' | 'saving' | 'error'
}) {
  const formattedDate = useMemo(() => {
    const parts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    }).formatToParts(new Date())
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]))
    return `${byType.year}—${byType.month}—${byType.day}, ${byType.weekday}`
  }, [])

  return (
    <header className="app-header">
      <button className="icon-button menu-button" type="button" onClick={onMenu} aria-label="打开导航">
        <Menu size={21} />
      </button>
      <div className="brand-lockup compact">
        <span className="brand-name">Ink &amp; Air</span>
        <span className="brand-subtitle">每日一课，英文会话</span>
      </div>
      <div className="header-meta">
        <span className={`sync-state ${syncStatus}`}>{syncStatus === 'saved' ? '数据库已同步' : syncStatus === 'saving' ? '正在同步…' : '同步失败'}</span>
        <span>{formattedDate}</span>
        <span className="user-monogram" title={user}>{user.slice(0, 1)}</span>
      </div>
    </header>
  )
}

function AppSidebar({
  activeView,
  mobileOpen,
  onClose,
  onNavigate,
}: {
  activeView: PrimaryView
  mobileOpen: boolean
  onClose: () => void
  onNavigate: (view: PrimaryView) => void
}) {
  return (
    <>
      <button
        className={`sidebar-scrim ${mobileOpen ? 'visible' : ''}`}
        type="button"
        onClick={onClose}
        aria-label="关闭导航"
      />
      <aside className={`app-sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="brand-name">Ink &amp; Air</span>
          <span>每日一课，英文会话</span>
          <button className="icon-button sidebar-close" type="button" onClick={onClose} aria-label="关闭导航">
            <X size={20} />
          </button>
        </div>
        <nav aria-label="主要导航">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={activeView === item.id ? 'active' : ''}
                type="button"
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={21} strokeWidth={1.45} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <p className="sidebar-folio">PRIVATE EDITION<br />VOL. 01 / 2026</p>
      </aside>
    </>
  )
}

function MobileBottomNav({ activeView, onNavigate }: { activeView: PrimaryView; onNavigate: (view: PrimaryView) => void }) {
  return (
    <nav className="mobile-bottom-nav" aria-label="手机主要导航">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            className={activeView === item.id ? 'active' : ''}
            type="button"
            onClick={() => onNavigate(item.id)}
          >
            <Icon size={20} strokeWidth={1.5} />
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function TodayView({
  lesson,
  lessonNumber,
  record,
  onRecordChange,
  onCompleteStep,
  onSkip,
  savedVocabulary,
  onToggleVocabulary,
}: {
  lesson: Lesson
  lessonNumber: number
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onCompleteStep: (step: StepId) => void
  onSkip: () => void
  savedVocabulary: SavedVocabulary[]
  onToggleVocabulary: (term: string) => Promise<void>
}) {
  const [dialogueOpen, setDialogueOpen] = useState(false)
  const completedCount = record.completedSteps.length
  const currentIndex = STEP_ORDER.findIndex((step) => !record.completedSteps.includes(step))
  const activeIndex = currentIndex === -1 ? STEP_ORDER.length - 1 : currentIndex

  function isVisible(step: StepId) {
    return STEP_ORDER.indexOf(step) <= activeIndex
  }

  return (
    <div className="today-page">
      <section className="today-heading">
        <div>
          <div className="heading-line">
            <h1>今日学习</h1>
            <span>DAILY ENGLISH ARCHIVE</span>
          </div>
          <p>
            学习中 <i aria-hidden="true" /> {lesson.title}
          </p>
        </div>
        <div className="heading-actions">
          <button
            className="skip-button"
            type="button"
            aria-expanded={dialogueOpen}
            onClick={() => setDialogueOpen((open) => !open)}
          >
            <LibraryBig size={16} aria-hidden="true" />
            全部对话
          </button>
          <button className="skip-button" type="button" onClick={onSkip}>
            <SkipForward size={17} aria-hidden="true" />
            跳过本篇
          </button>
          {dialogueOpen ? (
            <div className="dialogue-popover" role="dialog" aria-label="全部对话">
              <header><span>今日对话目录</span><small>{completedCount} / 6 已完成</small></header>
              {STEP_META.map((step, index) => {
                const available = index <= activeIndex
                return (
                  <button
                    key={step.id}
                    type="button"
                    disabled={!available}
                    onClick={() => {
                      document.getElementById(`step-${step.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      setDialogueOpen(false)
                    }}
                  >
                    <span>{index + 1}</span>
                    {step.label}
                    <small>{record.completedSteps.includes(step.id) ? '已完成' : index === activeIndex ? '进行中' : '未开始'}</small>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </section>

      <StepTicketRail completed={record.completedSteps} activeIndex={activeIndex} />

      <section className="lesson-docket" aria-label="今日文章信息">
        <div className="docket-number">NO. {String(lessonNumber).padStart(3, '0')}</div>
        <div>
          <span>{lesson.topic}</span>
          <strong>{lesson.titleZh}</strong>
        </div>
        <div>
          <span>难度</span>
          <strong>{lesson.difficulty.level} · {lesson.difficulty.label}</strong>
        </div>
        <div>
          <span>预计用时</span>
          <strong>{lesson.estimatedMinutes} MIN</strong>
        </div>
        <div className="docket-progress">
          <span>进度</span>
          <strong>{completedCount} / 6</strong>
        </div>
      </section>

      <div className="learning-layout">
        <div className="conversation-stream">
          <ThreadSection id="guide" label="今日导读" tone="green" completed={record.completedSteps.includes('guide')}>
            <p className="coach-copy">{lesson.guideZh}</p>
            <p className="coach-copy muted">今天的核心问题：{lesson.keyIdeaZh}</p>
            {!record.completedSteps.includes('guide') ? (
              <ActionButton onClick={() => onCompleteStep('guide')}>开始今天的听力</ActionButton>
            ) : null}
          </ThreadSection>

          {isVisible('listening') ? (
            <ThreadSection id="listening" label="听力" tone="gold" completed={record.completedSteps.includes('listening')}>
              <p className="section-instruction">先听，再写下你理解的意思。需要时可以展开原文。</p>
              <AudioReader lesson={lesson} />
              <label className="field-block">
                <span>你的理解</span>
                <textarea
                  value={record.listeningNotes}
                  onChange={(event) => onRecordChange((current) => ({ ...current, listeningNotes: event.target.value }))}
                  placeholder="用中文写下文章的主要意思…"
                  rows={4}
                />
              </label>
              {!record.completedSteps.includes('listening') ? (
                <ActionButton
                  onClick={() => onCompleteStep('listening')}
                  disabled={!record.listeningNotes.trim()}
                >
                  保存理解并进入翻译
                </ActionButton>
              ) : null}
            </ThreadSection>
          ) : null}

          {isVisible('translation') ? (
            <TranslationSection
              lesson={lesson}
              record={record}
              onRecordChange={onRecordChange}
              onComplete={() => onCompleteStep('translation')}
            />
          ) : null}

          {isVisible('speaking') ? (
            <SpeakingSection
              lesson={lesson}
              record={record}
              onRecordChange={onRecordChange}
              onComplete={() => onCompleteStep('speaking')}
            />
          ) : null}

          {isVisible('writing') ? (
            <WritingSection
              lesson={lesson}
              record={record}
              onRecordChange={onRecordChange}
              onComplete={() => onCompleteStep('writing')}
            />
          ) : null}

          {isVisible('summary') ? (
            <SummarySection
              lesson={lesson}
              record={record}
              onComplete={() => onCompleteStep('summary')}
            />
          ) : null}
        </div>

        <LessonMarginalia lesson={lesson} savedVocabulary={savedVocabulary} onToggleVocabulary={onToggleVocabulary} />
      </div>
    </div>
  )
}

function StepTicketRail({ completed, activeIndex }: { completed: StepId[]; activeIndex: number }) {
  return (
    <div className="step-ticket-wrap">
      <ol className="step-ticket-rail" aria-label="今日学习六步进度">
        {STEP_META.map((step, index) => {
          const isDone = completed.includes(step.id)
          const isCurrent = index === activeIndex && !isDone
          const status = isDone ? '已完成' : isCurrent ? '进行中' : '未开始'
          return (
            <li key={step.id}>
              <button
                type="button"
                className={`${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                disabled={!isDone && !isCurrent}
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => document.getElementById(`step-${step.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <span className="ticket-number">{index + 1}</span>
                <span className="ticket-label">{step.label}</span>
                <small>{status}</small>
                {isDone ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : null}
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ThreadSection({
  id,
  label,
  tone,
  completed,
  children,
}: {
  id: StepId
  label: string
  tone: 'green' | 'gold' | 'wine' | 'blue'
  completed: boolean
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section id={`step-${id}`} className={`thread-section tone-${tone}`}>
      <div className="timeline-dot" aria-hidden="true" />
      <header className="thread-header">
        <div>
          <span className="coach-stamp">COACH</span>
          <h2>{label}</h2>
          {completed ? <span className="complete-word">已完成</span> : <span className="active-word">进行中</span>}
        </div>
        <button type="button" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? '展开' : '收起'}
          {collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
      </header>
      {!collapsed ? <div className="thread-body">{children}</div> : null}
    </section>
  )
}

function AudioReader({ lesson }: { lesson: Lesson }) {
  const [rate, setRate] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [showText, setShowText] = useState(false)
  const [sentenceIndex, setSentenceIndex] = useState(0)
  const sentences = useMemo(
    () => (lesson.body.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [lesson.body]).map((sentence) => sentence.trim()).filter(Boolean),
    [lesson.body],
  )

  useEffect(() => () => window.speechSynthesis?.cancel(), [lesson.id])

  function speakFrom(index: number) {
    if (!('speechSynthesis' in window)) return
    const safeIndex = Math.min(Math.max(index, 0), sentences.length - 1)
    const utterance = new SpeechSynthesisUtterance(sentences[safeIndex])
    utterance.lang = 'en-US'
    utterance.rate = rate
    utterance.onend = () => {
      if (safeIndex < sentences.length - 1) speakFrom(safeIndex + 1)
      else setPlaying(false)
    }
    utterance.onerror = () => setPlaying(false)
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    setSentenceIndex(safeIndex)
    setPlaying(true)
  }

  function togglePlayback() {
    if (playing) {
      window.speechSynthesis.cancel()
      setPlaying(false)
      return
    }
    speakFrom(sentenceIndex)
  }

  function moveSentence(offset: number) {
    const nextIndex = Math.min(Math.max(sentenceIndex + offset, 0), sentences.length - 1)
    setSentenceIndex(nextIndex)
    if (playing) speakFrom(nextIndex)
  }

  return (
    <div className="audio-block">
      <div className="audio-main">
        <button className="round-audio-button" type="button" onClick={togglePlayback} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
        </button>
        <div className={`waveform ${playing ? 'playing' : ''}`} aria-hidden="true">
          {WAVEFORM_BARS.map((height, index) => <i className={index / WAVEFORM_BARS.length <= (sentenceIndex + 1) / sentences.length ? 'played' : ''} key={index} style={{ height: `${height}%` }} />)}
        </div>
      </div>
      <div className="audio-controls">
        <span><Volume2 size={15} /> 美式朗读</span>
        <button type="button" onClick={() => moveSentence(-1)} aria-label="上一句" disabled={sentenceIndex === 0}><SkipBack size={15} /></button>
        <button type="button" onClick={() => moveSentence(1)} aria-label="下一句" disabled={sentenceIndex === sentences.length - 1}><SkipForward size={15} /></button>
        <div className="rate-controls" aria-label="朗读速度">
          {[0.75, 1, 1.25].map((option) => (
            <button
              key={option}
              className={rate === option ? 'active' : ''}
              type="button"
              onClick={() => {
                setRate(option)
                if (playing) {
                  window.speechSynthesis.cancel()
                  setPlaying(false)
                }
              }}
            >
              {option}×
            </button>
          ))}
        </div>
        <button type="button" onClick={() => {
          window.speechSynthesis?.cancel()
          setPlaying(false)
          setSentenceIndex(0)
        }} aria-label="重置音频">
          <RotateCcw size={15} />
        </button>
      </div>
      <button className="text-disclosure" type="button" onClick={() => setShowText((value) => !value)}>
        {showText ? '收起原文' : '展开原文'}
        {showText ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {showText ? <div className="article-text sentence-list">{sentences.map((sentence, index) => <button className={index === sentenceIndex ? 'active' : ''} key={`${lesson.id}-${index}`} type="button" onClick={() => speakFrom(index)}><span>{String(index + 1).padStart(2, '0')}</span>{sentence}</button>)}</div> : null}
    </div>
  )
}

function TranslationSection({
  lesson,
  record,
  onRecordChange,
  onComplete,
}: {
  lesson: Lesson
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onComplete: () => void
}) {
  const completed = record.completedSteps.includes('translation')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submitTranslation() {
    setSubmitting(true)
    setError('')
    try {
      const result = await gradeAnswer('translation', lesson.id, record.translationDraft)
      onRecordChange((current) => ({ ...current, translationScore: result.score, translationFeedback: result }))
      onComplete()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '翻译评分失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThreadSection id="translation" label="翻译" tone="wine" completed={completed}>
      <p className="section-instruction">把下面这句话译成自然、准确的中文。</p>
      <blockquote className="translation-prompt">{lesson.translation.prompt}</blockquote>
      <label className="field-block">
        <span>你的翻译</span>
        <textarea
          value={record.translationDraft}
          onChange={(event) => onRecordChange((current) => ({ ...current, translationDraft: event.target.value }))}
          placeholder="写下你的中文翻译…"
          rows={4}
          readOnly={completed}
        />
      </label>
      {!completed ? (
        <>
          <ActionButton onClick={() => void submitTranslation()} disabled={!record.translationDraft.trim() || submitting}>{submitting ? '正在批改…' : '提交翻译'}</ActionButton>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </>
      ) : (
        <div className="grading-note">
          <div className="score-seal"><strong>{record.translationScore}</strong><span>/ 100</span></div>
          <GradingDetails feedback={record.translationFeedback} fallbackReference={lesson.translation.referenceZh} fallbackNotes={lesson.translation.gradingNotes} />
        </div>
      )}
    </ThreadSection>
  )
}

function SpeakingSection({
  lesson,
  record,
  onRecordChange,
  onComplete,
}: {
  lesson: Lesson
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onComplete: () => void
}) {
  const completed = record.completedSteps.includes('speaking')
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [error, setError] = useState('')
  const [transcriptionStatus, setTranscriptionStatus] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioBlobRef = useRef<Blob | null>(null)
  const recordingStartedAtRef = useRef(0)
  const durationSecondsRef = useRef(0)
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null)
  const recognizedTextRef = useRef('')

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  async function startRecording() {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        audioBlobRef.current = blob
        durationSecondsRef.current = Math.max(1, (Date.now() - recordingStartedAtRef.current) / 1_000)
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return URL.createObjectURL(blob)
        })
        stream.getTracks().forEach((track) => track.stop())
        recognitionRef.current?.stop()
        if (recognizedTextRef.current.trim()) {
          onRecordChange((current) => ({ ...current, speakingTranscript: recognizedTextRef.current.trim() }))
          setTranscriptionStatus('已用浏览器语音识别生成文本，请校对后提交。')
          return
        }
        setTranscriptionStatus('正在尝试云端转写…')
        void blobToDataUrl(blob)
          .then((dataUrl) => transcribeRecording(dataUrl))
          .then((result) => {
            onRecordChange((current) => ({ ...current, speakingTranscript: result.transcript }))
            setTranscriptionStatus(`已由 ${result.model} 自动转写，请校对后提交。`)
          })
          .catch((requestError) => setTranscriptionStatus(requestError instanceof Error ? requestError.message : '自动转写不可用，请手动填写口述文本。'))
      }
      const SpeechRecognitionConstructor = (window as typeof window & {
        SpeechRecognition?: new () => BrowserSpeechRecognition
        webkitSpeechRecognition?: new () => BrowserSpeechRecognition
      }).SpeechRecognition ?? (window as typeof window & { webkitSpeechRecognition?: new () => BrowserSpeechRecognition }).webkitSpeechRecognition
      recognizedTextRef.current = ''
      if (SpeechRecognitionConstructor) {
        const recognition = new SpeechRecognitionConstructor()
        recognition.continuous = true
        recognition.interimResults = true
        recognition.lang = 'en-US'
        recognition.onresult = (event) => {
          const text = Array.from(event.results).map((result) => result[0].transcript).join(' ')
          recognizedTextRef.current = text
          onRecordChange((current) => ({ ...current, speakingTranscript: text }))
        }
        recognition.onerror = () => { recognitionRef.current = null }
        recognitionRef.current = recognition
        try { recognition.start() } catch { recognitionRef.current = null }
      }
      recordingStartedAtRef.current = Date.now()
      recorder.start()
      setRecording(true)
    } catch {
      setError('无法使用麦克风。手机通过局域网 HTTP 访问时可直接在下方填写口述文本完成评分。')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function submitSpeaking() {
    setSubmitting(true)
    setError('')
    try {
      const result = await gradeAnswer('speaking', lesson.id, record.speakingTranscript ?? '', {
        durationSeconds: durationSecondsRef.current || undefined,
        mimeType: audioBlobRef.current?.type,
        audioCaptured: Boolean(audioBlobRef.current),
        transcriptionProvider: recognizedTextRef.current ? 'browser-speech-recognition' : 'manual-or-openai',
      })
      onRecordChange((current) => ({ ...current, speakingScore: result.score, speakingFeedback: result }))
      if (result.correct) onComplete()
      else setError('本次低于 6 分，请根据反馈补充表达后重新提交。')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '口语评分失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThreadSection id="speaking" label="口语" tone="blue" completed={completed}>
      <p className="section-instruction">先朗读文章中的关键句，再用 20–40 秒回答：</p>
      <blockquote className="translation-prompt">{lesson.speakingPrompt}</blockquote>
      {!completed ? (
        <div className="recorder-panel">
          <button
            className={`record-button ${recording ? 'recording' : ''}`}
            type="button"
            onClick={recording ? stopRecording : startRecording}
          >
            {recording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
            {recording ? '结束录音' : '开始录音'}
          </button>
          {audioUrl ? <audio className="recording-playback" src={audioUrl} controls /> : null}
          {transcriptionStatus ? <p className="transcription-status" role="status">{transcriptionStatus}</p> : null}
          <label className="field-block transcript-field">
            <span>口述文本 · 用于内容、语法与流畅度线索评分</span>
            <textarea
              value={record.speakingTranscript ?? ''}
              onChange={(event) => onRecordChange((current) => ({ ...current, speakingTranscript: event.target.value }))}
              placeholder="输入或粘贴你刚才说的英文；建议 3–4 个完整句子…"
              rows={4}
            />
          </label>
          <ActionButton onClick={() => void submitSpeaking()} disabled={!(record.speakingTranscript ?? '').trim() || submitting}>{submitting ? '正在评分…' : '提交口语'}</ActionButton>
          {error ? (
            <div className="permission-fallback">
              <p role="alert">{error}</p>
            </div>
          ) : null}
          {record.speakingFeedback && !record.speakingFeedback.correct ? <div className="grading-note compact-note"><GradingDetails feedback={record.speakingFeedback} fallbackReference={lesson.speakingPrompt} /></div> : null}
        </div>
      ) : (
        <div className="speaking-result">
          <span className="score-seal small"><strong>{record.speakingScore?.toFixed(1)}</strong><span>/ 10</span></span>
          <GradingDetails feedback={record.speakingFeedback} fallbackReference={lesson.speakingPrompt} />
        </div>
      )}
    </ThreadSection>
  )
}

function WritingSection({
  lesson,
  record,
  onRecordChange,
  onComplete,
}: {
  lesson: Lesson
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onComplete: () => void
}) {
  const completed = record.completedSteps.includes('writing')
  const showHint = record.writingAttempts === 1 && !record.writingCorrect
  const showAnswer = record.writingAttempts >= 2 && !record.writingCorrect
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function submitWriting() {
    setSubmitting(true)
    setError('')
    try {
      const result = await gradeAnswer('writing', lesson.id, record.writingDraft)
      const nextAttempts = record.writingAttempts + 1
      onRecordChange((current) => ({
        ...current,
        writingAttempts: nextAttempts,
        writingCorrect: result.correct,
        writingFeedback: result,
      }))
      if (result.correct || nextAttempts >= 2) onComplete()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '写作评分失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThreadSection id="writing" label="写作" tone="gold" completed={completed}>
      <p className="section-instruction">把中文写成自然英文。你有两次机会。</p>
      <blockquote className="translation-prompt chinese">{lesson.writing.promptZh}</blockquote>
      <label className="field-block">
        <span>你的英文</span>
        <textarea
          value={record.writingDraft}
          onChange={(event) => onRecordChange((current) => ({ ...current, writingDraft: event.target.value }))}
          placeholder="Write your sentence in English…"
          rows={3}
          readOnly={completed}
        />
      </label>
      {!completed ? (
        <ActionButton onClick={() => void submitWriting()} disabled={!record.writingDraft.trim() || submitting}>
          {submitting ? '正在批改…' : `提交 · 第 ${Math.min(record.writingAttempts + 1, 2)} 次`}
        </ActionButton>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {showHint ? <p className="inline-hint"><strong>提示：</strong>{lesson.writing.hint}</p> : null}
      {showAnswer ? (
        <div className="grading-note compact-note">
          <div><span className="grading-label">参考表达</span><p>{lesson.writing.answers[0]}</p></div>
        </div>
      ) : null}
      {record.writingCorrect ? <p className="success-note"><Check size={16} /> 表达准确，已收入今日掌握句型。</p> : null}
      {record.writingFeedback ? <div className="grading-note compact-note"><GradingDetails feedback={record.writingFeedback} fallbackReference={lesson.writing.answers[0]} /></div> : null}
    </ThreadSection>
  )
}

function SummarySection({ lesson, record, onComplete }: { lesson: Lesson; record: LessonRecord; onComplete: () => void }) {
  const completed = record.completedSteps.includes('summary')
  const translation = record.translationScore ?? 80
  const speaking = Math.round((record.speakingScore ?? 7.5) * 10)
  const writing = Math.round(record.writingFeedback?.score ?? (record.writingCorrect ? 92 : 76))
  const total = Math.round(translation * 0.4 + speaking * 0.35 + writing * 0.25)

  return (
    <ThreadSection id="summary" label="今日总结" tone="green" completed={completed}>
      <div className="summary-layout">
        <div className="summary-score">
          <span>今日综合分</span>
          <strong>{total}</strong>
          <small>{lesson.topic}</small>
        </div>
        <dl className="score-breakdown">
          <div><dt>翻译</dt><dd>{translation}</dd></div>
          <div><dt>口语</dt><dd>{speaking}</dd></div>
          <div><dt>写作</dt><dd>{writing}</dd></div>
        </dl>
        <div className="summary-copy">
          <span>今日掌握</span>
          <p>{lesson.keyIdeaZh}</p>
          <p>重点词汇：{lesson.vocabulary.map((item) => item.term).join(' · ')}</p>
        </div>
      </div>
      {!completed ? <ActionButton onClick={onComplete}>完成今日学习</ActionButton> : <p className="success-note"><Check size={16} /> 今日档案已归档。</p>}
    </ThreadSection>
  )
}

function GradingDetails({
  feedback,
  fallbackReference,
  fallbackNotes = [],
}: {
  feedback?: GradingFeedback
  fallbackReference: string
  fallbackNotes?: string[]
}) {
  return (
    <div className="grading-details">
      <span className="grading-label">{feedback?.graderType === 'deepseek' ? 'DeepSeek 结构化批改' : feedback?.graderType === 'openai' ? 'OpenAI 结构化批改' : '量表批改'}{feedback?.submissionVersion ? ` · 第 ${feedback.submissionVersion} 版` : ''}</span>
      <p>{feedback?.summary ?? '已按本课量表完成批改。'}</p>
      {feedback?.dimensions?.length ? (
        <dl className="grading-dimensions">
          {feedback.dimensions.map((dimension) => <div key={dimension.label}><dt>{dimension.label} · {dimension.weight}%</dt><dd>{dimension.score}</dd></div>)}
        </dl>
      ) : null}
      <span className="grading-label">参考表达</span>
      <p>{feedback?.reference ?? fallbackReference}</p>
      <ul>
        {(feedback?.improvements?.length ? feedback.improvements : fallbackNotes).map((note) => <li key={note}>{note}</li>)}
      </ul>
    </div>
  )
}

function LessonMarginalia({
  lesson,
  savedVocabulary,
  onToggleVocabulary,
}: {
  lesson: Lesson
  savedVocabulary: SavedVocabulary[]
  onToggleVocabulary: (term: string) => Promise<void>
}) {
  const savedTerms = new Set(savedVocabulary.filter((item) => item.lessonId === lesson.id).map((item) => item.term.toLowerCase()))
  return (
    <aside className="marginalia" aria-label="词汇与来源">
      <section>
        <header><span>词汇与原文</span><small>VOCABULARY</small></header>
        <div className="vocabulary-list">
          {lesson.vocabulary.map((item) => (
            <article key={item.term}>
              <div className="vocabulary-heading">
                <strong>{item.term}</strong>
                <button
                  type="button"
                  aria-label={savedTerms.has(item.term.toLowerCase()) ? `移出生词本 ${item.term}` : `加入生词本 ${item.term}`}
                  onClick={() => void onToggleVocabulary(item.term)}
                >
                  {savedTerms.has(item.term.toLowerCase()) ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
                </button>
              </div>
              <span>{item.ipa}</span>
              <p>{item.part} {item.meaning}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="source-card">
        <header><span>来源批注</span><small>SOURCE NOTE</small></header>
        <strong>{lesson.source.publisher}</strong>
        <p>{lesson.source.title}</p>
        <p>采集于 {lesson.source.accessedAt}</p>
        <a href={lesson.source.url} target="_blank" rel="noreferrer">
          查看原始来源 <ExternalLink size={13} />
        </a>
      </section>
      <section className="quality-card">
        <span>编辑质量分</span>
        <strong>{lesson.quality.total}</strong>
        <small>/ 100 · 已审核</small>
      </section>
    </aside>
  )
}

function ActionButton({ children, onClick, disabled = false }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button className="double-border-button thread-action" type="button" onClick={onClick} disabled={disabled}>
      <span>{children}</span>
      <ArrowRight size={17} />
    </button>
  )
}

function ConversationsView({
  lessons,
  state,
  onOpenLesson,
}: {
  lessons: Lesson[]
  state: LearningState
  onOpenLesson: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<'ALL' | 'L1' | 'L2' | 'L3'>('ALL')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleLessons = lessons.filter((lesson) => {
    const matchesLevel = level === 'ALL' || lesson.difficulty.level === level
    const matchesQuery = !normalizedQuery || [lesson.title, lesson.titleZh, lesson.topic, lesson.source.publisher]
      .some((value) => value.toLowerCase().includes(normalizedQuery))
    return matchesLevel && matchesQuery
  })

  return (
    <ArchivePage title="对话档案" english="CONVERSATION INDEX" description={`${lessons.length} 篇精选内容已存入数据库；电脑与手机共享学习状态。`}>
      <div className="archive-toolbar">
        <label><span>检索内容</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="标题、主题或来源" /></label>
        <div className="archive-filters" aria-label="难度筛选">
          {(['ALL', 'L1', 'L2', 'L3'] as const).map((option) => (
            <button className={level === option ? 'active' : ''} key={option} type="button" onClick={() => setLevel(option)}>{option === 'ALL' ? '全部' : option}</button>
          ))}
        </div>
        <span>{visibleLessons.length} 篇</span>
      </div>
      <div className="archive-table" role="table" aria-label="内容库">
        <div className="archive-row archive-head" role="row">
          <span>编号</span><span>内容</span><span>难度</span><span>状态</span><span />
        </div>
        {visibleLessons.map((lesson) => {
          const index = lessons.findIndex((candidate) => candidate.id === lesson.id)
          const record = state.records[lesson.id]
          const status = record?.skipped
            ? '已跳过'
            : record?.completedSteps.includes('summary')
              ? '已完成'
              : record
                ? `学习中 · ${record.completedSteps.length}/6`
                : '未开始'
          return (
            <div className="archive-row" role="row" key={lesson.id}>
              <span>{String(index + 1).padStart(3, '0')}</span>
              <span><strong>{lesson.title}</strong><small>{lesson.titleZh} · {lesson.topic}</small></span>
              <span>{lesson.difficulty.level}<small>{lesson.difficulty.cefr}</small></span>
              <span>{status}</span>
              <button type="button" onClick={() => onOpenLesson(lesson.id)}>打开 <ArrowRight size={14} /></button>
            </div>
          )
        })}
      </div>
    </ArchivePage>
  )
}

function ReviewView({ reviewItems, vocabularyBook, weeklyReport, onAttempt }: {
  lessons: Lesson[]
  state: LearningState
  reviewItems: ReviewItem[]
  vocabularyBook: SavedVocabulary[]
  weeklyReport: WeeklyReport
  onAttempt: (item: ReviewItem, answer: string) => Promise<{ correct: boolean; score: number; mastery: number; reference: string }>
}) {
  const [tab, setTab] = useState<'errors' | 'vocabulary' | 'weekly'>('errors')
  return (
    <ArchivePage title="复盘簿" english="REVIEW LEDGER" description="错题主动回忆、生词归档和最近七天学习报告都保存在数据库中。">
      <div className="review-tabs" role="tablist" aria-label="复盘分类">
        <button className={tab === 'errors' ? 'active' : ''} type="button" onClick={() => setTab('errors')}>错题复习 · {reviewItems.length}</button>
        <button className={tab === 'vocabulary' ? 'active' : ''} type="button" onClick={() => setTab('vocabulary')}>生词本 · {vocabularyBook.length}</button>
        <button className={tab === 'weekly' ? 'active' : ''} type="button" onClick={() => setTab('weekly')}>本周报告</button>
      </div>
      {tab === 'errors' && reviewItems.length ? (
        <section className="review-errors" aria-label="数据库错题">
          <header><strong>待复习错题</strong><span>{reviewItems.length} 项</span></header>
          {reviewItems.map((item) => <ReviewAttemptCard key={`${item.id}-${item.reviewTaskId}`} item={item} onAttempt={onAttempt} />)}
        </section>
      ) : tab === 'errors' ? <EmptyArchive icon={NotebookText} title="还没有复盘记录" copy="提交一次未达标的翻译、口语或写作后，系统会自动安排复习。" /> : null}
      {tab === 'vocabulary' ? (
        vocabularyBook.length ? <div className="vocabulary-ledger">
          {vocabularyBook.map((item) => <article key={`${item.lessonId}-${item.term}`}><BookmarkCheck size={17} /><div><strong>{item.term}</strong><span>{item.ipa} · {item.part}</span><p>{item.meaning}</p></div><small>熟练度 {item.mastery}/3</small></article>)}
        </div> : <EmptyArchive icon={Bookmark} title="生词本还是空的" copy="在今日文章右侧点击书签图标，词汇会同步到这里。" />
      ) : null}
      {tab === 'weekly' ? <section className="weekly-report">
        <header><span>{weeklyReport.periodStart} — {weeklyReport.periodEnd}</span><strong>七日学习报告</strong></header>
        <dl>
          <div><dt>完成课程</dt><dd>{weeklyReport.completedLessons}</dd></div>
          <div><dt>课程均分</dt><dd>{weeklyReport.averageScore || '—'}</dd></div>
          <div><dt>复习次数</dt><dd>{weeklyReport.reviewAttempts}</dd></div>
          <div><dt>复习均分</dt><dd>{weeklyReport.reviewAverage || '—'}</dd></div>
        </dl>
        {weeklyReport.days.length ? <div className="weekly-days">{weeklyReport.days.map((day) => <div key={day.learningDate}><span>{day.learningDate.slice(5)}</span><i style={{ height: `${Math.max(8, day.totalScore)}%` }} /><strong>{day.totalScore}</strong></div>)}</div> : <p>本周完成课程后，这里会生成趋势档案。</p>}
      </section> : null}
    </ArchivePage>
  )
}

function ReviewAttemptCard({ item, onAttempt }: { item: ReviewItem; onAttempt: (item: ReviewItem, answer: string) => Promise<{ correct: boolean; score: number; mastery: number; reference: string }> }) {
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<{ correct: boolean; score: number; mastery: number; reference: string } | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return <article>
    <span>{item.errorType} · {item.titleZh} · 熟练度 {item.mastery}/3</span>
    <p>{item.prompt}</p>
    <label className="review-answer"><span>不看答案，重新作答</span><textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>
    {!result && item.reviewTaskId ? <button type="button" disabled={!answer.trim() || submitting} onClick={() => {
      setSubmitting(true)
      setError('')
      void onAttempt(item, answer).then(setResult).catch((requestError) => setError(requestError instanceof Error ? requestError.message : '提交失败')).finally(() => setSubmitting(false))
    }}><Check size={14} /> {submitting ? '正在核对…' : '提交复习'}</button> : null}
    {result ? <div className={`review-result ${result.correct ? 'correct' : 'retry'}`}><strong>{result.score} 分 · {result.correct ? '回答正确' : '需要重试'}</strong><p>参考：{result.reference}</p><small>当前熟练度 {result.mastery}/3</small></div> : null}
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </article>
}

function ProfileView({
  user,
  state,
  lessons,
  profile,
  databaseEngine,
  onProfileChange,
  onLogout,
}: {
  user: string
  state: LearningState
  lessons: Lesson[]
  profile: LearningProfile
  databaseEngine: string
  onProfileChange: (profile: LearningProfile) => Promise<void>
  onLogout: () => Promise<void>
}) {
  const completed = Object.values(state.records).filter((record) => record.completedSteps.includes('summary')).length
  const [draft, setDraft] = useState(profile)
  return (
    <ArchivePage title="我的档案" english="READER PROFILE" description="学习偏好、数据库状态与跨设备同步设置。">
      <div className="profile-sheet">
        <div className="profile-monogram">{user.slice(0, 1)}</div>
        <div className="profile-identity"><span>登录用户</span><strong>{user}</strong><small>PERSONAL READER · 001</small></div>
        <dl>
          <div><dt>当前目标</dt><dd>{profile.targetExam}</dd></div>
          <div><dt>默认难度</dt><dd>{profile.preferredLevel}</dd></div>
          <div><dt>数据库内容</dt><dd>{lessons.length} 篇 · {databaseEngine}</dd></div>
          <div><dt>完成档案</dt><dd>{completed}</dd></div>
        </dl>
        <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void onProfileChange(draft) }}>
          <label><span>学习目标</span><input value={draft.targetExam} onChange={(event) => setDraft((current) => ({ ...current, targetExam: event.target.value }))} /></label>
          <label><span>默认难度</span><select value={draft.preferredLevel} onChange={(event) => setDraft((current) => ({ ...current, preferredLevel: event.target.value as LearningProfile['preferredLevel'] }))}><option value="L1">L1 基础</option><option value="L2">L2 进阶</option><option value="L3">L3 高阶</option></select></label>
          <label><span>每日分钟</span><input type="number" min="5" max="120" value={draft.dailyGoalMinutes} onChange={(event) => setDraft((current) => ({ ...current, dailyGoalMinutes: Number(event.target.value) }))} /></label>
          <button className="double-border-button" type="submit"><span>保存学习档案</span><ArrowRight size={16} /></button>
        </form>
        <button className="logout-button" type="button" onClick={onLogout}><LogOut size={17} /> 退出登录</button>
      </div>
    </ArchivePage>
  )
}

function ArchivePage({ title, english, description, children }: { title: string; english: string; description: string; children: ReactNode }) {
  return (
    <div className="archive-page">
      <header className="archive-page-header">
        <div className="heading-line"><h1>{title}</h1><span>{english}</span></div>
        <p>{description}</p>
      </header>
      {children}
    </div>
  )
}

function EmptyArchive({ icon: Icon, title, copy }: { icon: LucideIcon; title: string; copy: string }) {
  return (
    <div className="empty-archive">
      <Icon size={31} strokeWidth={1.25} />
      <h2>{title}</h2>
      <p>{copy}</p>
    </div>
  )
}

export default App
