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
  Trash2,
  UserRound,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useId,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { assessRecording, attemptReview, getAudioManifest, getBootstrap, getLesson, getSession, gradeAnswer, login, logout, register, restartLesson, saveLearningProfile, saveLearningState, toggleVocabulary, updateReviewItem, updateVocabularyItem } from './lib/api'
import { convertRecordingToTencentWav, preferredRecordingOptions } from './lib/audio'
import { audioPlaybackError, peekAudio, resetAudioCache, warmAudio } from './lib/audio-cache'
import { clearPendingState, readPendingState, stagePendingState } from './lib/client-session'
import { beginRecordingSession, endRecordingSession, registerAudioSession, requestAudioPlayback } from './lib/audio-session'
import {
  completeStep,
  createLessonRecord,
  updateLessonRecord,
} from './lib/learning-state'
import { WordLearningPreferences, WordWeeklyReportPanel } from './WordLearningPanels'
import {
  STEP_ORDER,
  type BootstrapData,
  type GradingFeedback,
  type LearningState,
  type LearningProfile,
  type Lesson,
  type LessonSummary,
  type LessonRecord,
  type PrimaryView,
  type ReviewItem,
  type SavedVocabulary,
  type Session,
  type StepId,
  type WeeklyReport,
  type WritingTaskState,
} from './types'

const DictionaryView = lazy(() => import('./DictionaryView'))

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
  { id: 'dictionary', label: '单词', icon: LibraryBig },
  { id: 'conversations', label: '课程', icon: MessageCircle },
  { id: 'review', label: '复盘', icon: NotebookText },
  { id: 'profile', label: '我的', icon: UserRound },
]

const WAVEFORM_BARS = Array.from({ length: 56 }, (_, index) =>
  Math.round(18 + Math.abs(Math.sin(index * 1.47) * 32) + (index % 5) * 4),
)

function formatMediaTime(value: number) {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function isCuratedLesson(lesson: Pick<Lesson, 'id'>) {
  return !lesson.id.startsWith('lesson-wiki-')
}

function chooseNextLesson(candidates: LessonSummary[], state: LearningState, profile: LearningProfile) {
  if (!candidates.length) throw new Error('课程库为空')
  const available = candidates.filter((candidate) => {
    const nextRecord = state.records[candidate.id]
    return !nextRecord?.skipped && !nextRecord?.completedSteps.includes('summary')
  })
  const pool = available.length ? available : candidates.filter((candidate) => !state.records[candidate.id]?.skipped)
  let best: LessonSummary = pool[0] ?? candidates[0]
  let bestScore = Number.NEGATIVE_INFINITY
  for (const candidate of pool) {
    const interestMatch = profile.interests.some((interest) => candidate.topic.includes(interest) || candidate.titleZh.includes(interest))
    const score = (candidate.difficulty.level === profile.preferredLevel ? 100 : 0)
      + (isCuratedLesson(candidate) ? 30 : 0)
      + (interestMatch ? 20 : 0)
      + (candidate.estimatedMinutes <= profile.dailyGoalMinutes ? 5 : 0)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)

  useEffect(() => {
    let active = true
    const endSession = () => { resetAudioCache(); setSession(null) }
    window.addEventListener('ink-air-session-ended', endSession)
    getSession()
      .then((nextSession) => {
        if (active) setSession(nextSession)
      })
      .catch(() => {
        if (active) setSession(null)
      })
    return () => {
      active = false
      window.removeEventListener('ink-air-session-ended', endSession)
    }
  }, [])

  if (session === undefined) return <LoadingScreen />
  if (session === null) return <LoginScreen onAuthenticated={setSession} />

  return (
    <AuthenticatedWorkspace
      key={session.userId}
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
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('LEVEN')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      onAuthenticated(mode === 'login'
        ? await login(username, password)
        : await register(username, password, confirmPassword))
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

      <section className="login-panel" aria-label={mode === 'login' ? '登录' : '注册'}>
        <div className="login-ticket">
          <LockKeyhole size={21} strokeWidth={1.5} aria-hidden="true" />
          <div>
            <span>PRIVATE READING ROOM</span>
            <strong>私人阅览室</strong>
          </div>
        </div>
        <div className="auth-mode-switch" role="tablist" aria-label="账号操作">
          <button className={mode === 'login' ? 'active' : ''} role="tab" aria-selected={mode === 'login'} type="button" onClick={() => { setMode('login'); setError(''); setConfirmPassword('') }}>登录</button>
          <button className={mode === 'register' ? 'active' : ''} role="tab" aria-selected={mode === 'register'} type="button" onClick={() => { setMode('register'); setUsername(''); setPassword(''); setError('') }}>注册新账号</button>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <label>
            <span>{mode === 'login' ? '登录用户' : '用户名'}</span>
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
              autoFocus={mode === 'login'}
            />
          </label>
          {mode === 'register' ? (
            <label>
              <span>确认密码</span>
              <input
                autoComplete="new-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
              <small>密码至少 8 位，并同时包含英文字母和数字。</small>
            </label>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <button className="double-border-button" type="submit" disabled={submitting || !username || !password || (mode === 'register' && !confirmPassword)}>
            <span>{submitting ? (mode === 'login' ? '核验中…' : '正在建立档案…') : mode === 'login' ? '进入今日学习' : '注册并开始学习'}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </form>
        <p className="login-note">账号保存在本机数据库中；密码经过加盐哈希处理，不会写入浏览器存储。</p>
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
  const [wordStudyActive, setWordStudyActive] = useState(false)
  const [notice, setNotice] = useState('')
  const [undoAction, setUndoAction] = useState<null | (() => Promise<void>)>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const [syncStatus, setSyncStatus] = useState<'saved' | 'saving' | 'error' | 'offline'>('saved')
  const [online, setOnline] = useState(() => navigator.onLine)
  const [syncRetry, setSyncRetry] = useState(0)
  const [profile, setProfile] = useState<LearningProfile>(bootstrap.profile)
  const lastSavedState = useRef(JSON.stringify(bootstrap.learningState))
  const [state, setState] = useState<LearningState>(() => {
    try {
      const pending = readPendingState(session.userId)
      return pending?.version === 2 && bootstrap.lessonCatalog.some((lesson) => lesson.id === pending.currentLessonId)
        ? pending
        : bootstrap.learningState
    } catch {
      return bootstrap.learningState
    }
  })
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>(bootstrap.reviewItems)
  const [vocabularyBook, setVocabularyBook] = useState<SavedVocabulary[]>(bootstrap.vocabularyBook)
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport>(bootstrap.weeklyReport)
  const [lesson, setLesson] = useState<Lesson>(bootstrap.currentLesson)
  const lessons = bootstrap.lessonCatalog
  const record = state.records[lesson.id] ?? createLessonRecord()

  const showNotice = useCallback((message: string, undo: null | (() => Promise<void>) = null) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    setNotice(message)
    setUndoAction(() => undo)
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice('')
      setUndoAction(null)
    }, undo ? 7_000 : 3_200)
  }, [])

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
  }, [])

  useEffect(() => {
    if (lesson.id === state.currentLessonId) return
    let active = true
    void getLesson(state.currentLessonId)
      .then((nextLesson) => { if (active) setLesson(nextLesson) })
      .catch((error) => { if (active) showNotice(error instanceof Error ? error.message : '课程加载失败，请重试。') })
    return () => { active = false }
  }, [lesson.id, showNotice, state.currentLessonId])

  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateOnlineStatus)
    window.addEventListener('offline', updateOnlineStatus)
    return () => {
      window.removeEventListener('online', updateOnlineStatus)
      window.removeEventListener('offline', updateOnlineStatus)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let retryTimer: number | undefined
    const serialized = JSON.stringify(state)
    if (serialized === lastSavedState.current) { setSyncStatus('saved'); return }
    const staged = stagePendingState(session.userId, state)
    if (!online) {
      setSyncStatus(staged ? 'offline' : 'error')
      return
    }
    setSyncStatus('saving')
    const timer = window.setTimeout(() => {
      saveLearningState(state, controller.signal)
        .then(() => {
          if (controller.signal.aborted) return
          lastSavedState.current = serialized
          clearPendingState(session.userId, state)
          setSyncStatus('saved')
        })
        .catch(() => {
          if (controller.signal.aborted) return
          setSyncStatus('error')
          retryTimer = window.setTimeout(() => setSyncRetry((value) => value + 1), 15_000)
        })
    }, 450)
    return () => { controller.abort(); window.clearTimeout(timer); window.clearTimeout(retryTimer) }
  }, [online, state, session.userId, syncRetry])

  const updateCurrentRecord = useCallback((updater: (record: LessonRecord) => LessonRecord) => {
    setState((current) => updateLessonRecord(current, current.currentLessonId, updater))
  }, [])

  const finishStep = useCallback((step: StepId) => {
    setState((current) => completeStep(current, current.currentLessonId, step))
  }, [])

  async function skipCurrentLesson() {
    const currentIndex = lessons.findIndex((candidate) => candidate.id === state.currentLessonId)
    const withSkip = updateLessonRecord(state, state.currentLessonId, (currentRecord) => ({
      ...currentRecord,
      skipped: true,
    }))
    const candidates = [...lessons.slice(currentIndex + 1), ...lessons.slice(0, currentIndex)]
    const nextSummary = chooseNextLesson(candidates, withSkip, profile)
    try {
      const nextLesson = await getLesson(nextSummary.id)
      setLesson(nextLesson)
      setState({
        ...withSkip,
        currentLessonId: nextLesson.id,
        records: {
          ...withSkip.records,
          [nextLesson.id]: withSkip.records[nextLesson.id] ?? createLessonRecord(),
        },
      })
      showNotice('已跳过本篇，下一篇档案已为你打开。')
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '下一篇课程加载失败，请重试。')
    }
  }

  async function openLesson(lessonId: string, message = '') {
    try {
      const nextLesson = await getLesson(lessonId)
      setLesson(nextLesson)
      setState((current) => ({
        ...current,
        currentLessonId: lessonId,
        records: {
          ...current.records,
          [lessonId]: current.records[lessonId] ?? createLessonRecord(),
        },
      }))
      setView('today')
      if (message) showNotice(message)
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '课程加载失败，请重试。')
    }
  }

  async function openNextLesson() {
    const currentIndex = lessons.findIndex((candidate) => candidate.id === state.currentLessonId)
    const candidates = [...lessons.slice(currentIndex + 1), ...lessons.slice(0, currentIndex)]
    const nextLesson = chooseNextLesson(candidates, state, profile)
    await openLesson(nextLesson.id, '下一篇学习档案已打开。')
  }

  async function restartCurrentLesson() {
    const confirmed = window.confirm('重新开始会清空本轮六步进度，但历史提交、评分和错题仍会保留。是否继续？')
    if (!confirmed) return
    try {
      setState(await restartLesson(lesson.id))
      setView('today')
      showNotice('已建立新的学习轮次，历史记录仍然保留。')
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '重新学习失败，请稍后重试。')
    }
  }

  function navigate(nextView: PrimaryView) {
    setView(nextView)
    setMobileNavOpen(false)
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
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
              onSkip={() => void skipCurrentLesson()}
              onRestart={() => void restartCurrentLesson()}
              onNext={() => void openNextLesson()}
              savedVocabulary={vocabularyBook}
              onToggleVocabulary={async (term) => {
                const result = await toggleVocabulary(lesson.id, term)
                setVocabularyBook(result.vocabularyBook)
                showNotice(result.saved ? `“${term}”已收入生词本。` : `“${term}”已移出生词本。`)
              }}
              profile={profile}
              weeklyReport={weeklyReport}
            />
          ) : null}
          {view === 'dictionary' ? (
            <Suspense fallback={<LoadingScreen />}><DictionaryView onStudyActiveChange={setWordStudyActive} /></Suspense>
          ) : null}
          {view === 'conversations' ? (
            <ConversationsView
              lessons={lessons}
              state={state}
              onOpenLesson={(lessonId) => void openLesson(lessonId)}
            />
          ) : null}
          {view === 'review' ? (
            <ReviewView
              lessons={lessons}
              state={state}
              reviewItems={reviewItems}
              vocabularyBook={vocabularyBook}
              weeklyReport={weeklyReport}
              onReviewAction={async (item, action) => {
                const result = await updateReviewItem(item.id, action)
                setReviewItems(result.reviewItems)
                if (action === 'delete') {
                  showNotice('错题已从复盘簿移除。', async () => {
                    const restored = await updateReviewItem(item.id, 'restore')
                    setReviewItems(restored.reviewItems)
                    showNotice('错题已恢复。')
                  })
                } else showNotice(action === 'snooze' ? '已跳过今天，明天再复习这道题。' : '已标记为掌握。')
              }}
              onVocabularyAction={async (item, action) => {
                const result = await updateVocabularyItem(item.lessonId, item.term, action)
                setVocabularyBook(result.vocabularyBook)
                if (action === 'delete') {
                  showNotice(`“${item.term}”已移出生词本。`, async () => {
                    const restored = await updateVocabularyItem(item.lessonId, item.term, 'restore')
                    setVocabularyBook(restored.vocabularyBook)
                    showNotice(`“${item.term}”已恢复。`)
                  })
                } else showNotice(action === 'snooze' ? `“${item.term}”已跳过今天。` : `“${item.term}”已标记为掌握。`)
              }}
              onAttempt={async (item, answer) => {
                if (!item.reviewTaskId) throw new Error('本条复习任务不可用')
                const result = await attemptReview(item.reviewTaskId, answer)
                const refreshed = await getBootstrap()
                setReviewItems(refreshed.reviewItems)
                setWeeklyReport(refreshed.weeklyReport)
                showNotice(result.correct ? `复习正确：${result.score} 分，熟练度 ${result.mastery}/3。` : `本次 ${result.score} 分，系统已安排明日重试。`)
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
              weeklyReport={weeklyReport}
              onProfileChange={async (nextProfile) => {
                setProfile(nextProfile)
                try {
                  setProfile(await saveLearningProfile(nextProfile))
                  showNotice('学习档案已保存到数据库。')
                } catch {
                  showNotice('学习档案保存失败，请稍后重试。')
                }
              }}
              onLogout={onLogout}
            />
          ) : null}
        </main>
      </div>

      {!wordStudyActive ? <MobileBottomNav activeView={view} onNavigate={navigate} /> : null}
      {notice ? <div className="toast" role="status"><span>{notice}</span>{undoAction ? <button type="button" onClick={() => { const action = undoAction; setUndoAction(null); void action().catch((error) => showNotice(error instanceof Error ? error.message : '撤销失败，请稍后重试')) }}><RotateCcw size={14} /> 撤销</button> : null}</div> : null}
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
  syncStatus: 'saved' | 'saving' | 'error' | 'offline'
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
        <span className={`sync-state ${syncStatus}`}>{syncStatus === 'saved' ? '数据库已同步' : syncStatus === 'saving' ? '正在同步…' : syncStatus === 'offline' ? '离线暂存中' : '同步失败'}</span>
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
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 900px)').matches)
  const sidebarRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)')
    const update = () => setMobile(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!mobile || !mobileOpen) return
    const previous = document.activeElement as HTMLElement | null
    const buttons = () => Array.from(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    buttons()[0]?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const items = buttons()
      const first = items[0], last = items.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [mobile, mobileOpen])
  return (
    <>
      <button
        className={`sidebar-scrim ${mobileOpen ? 'visible' : ''}`}
        type="button"
        onClick={onClose}
        aria-label="关闭导航"
        tabIndex={-1}
      />
      <aside ref={sidebarRef} inert={mobile && !mobileOpen} aria-hidden={mobile && !mobileOpen ? true : undefined} className={`app-sidebar ${mobileOpen ? 'open' : ''}`}>
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
  onRestart,
  onNext,
  savedVocabulary,
  onToggleVocabulary,
  profile,
  weeklyReport,
}: {
  lesson: Lesson
  lessonNumber: number
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onCompleteStep: (step: StepId) => void
  onSkip: () => void
  onRestart: () => void
  onNext: () => void
  savedVocabulary: SavedVocabulary[]
  onToggleVocabulary: (term: string) => Promise<void>
  profile: LearningProfile
  weeklyReport: WeeklyReport
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
            课程目录
          </button>
          {completedCount > 0 || record.skipped ? (
            <button className="skip-button" type="button" onClick={onRestart}>
              <RotateCcw size={16} aria-hidden="true" />
              {record.completedSteps.includes('summary') || record.skipped ? '重学本篇' : '重新开始'}
            </button>
          ) : null}
          {record.completedSteps.includes('summary') || record.skipped ? (
            <button className="skip-button" type="button" onClick={onNext}>
              <SkipForward size={17} aria-hidden="true" />
              下一篇
            </button>
          ) : (
            <button className="skip-button" type="button" onClick={onSkip}>
              <SkipForward size={17} aria-hidden="true" />
              跳过本篇
            </button>
          )}
          {dialogueOpen ? (
            <div className="dialogue-popover" role="dialog" aria-label="课程步骤">
              <header><span>今日学习步骤</span><small>{completedCount} / 6 已完成</small></header>
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

      <section className="daily-plan-strip" aria-label="今日自适应学习计划">
        <div><span>今日计划</span><strong>{profile.dailyGoalMinutes} 分钟 · {profile.preferredLevel}</strong></div>
        <p>{profile.interests.length ? `优先主题：${profile.interests.join('、')}` : '系统优先推荐与你当前等级匹配的精选课程。'}</p>
        <span>连续学习 {weeklyReport.streakDays ?? 0} 天</span>
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
              weeklyReport={weeklyReport}
              onComplete={() => onCompleteStep('summary')}
              onNext={onNext}
              onRestart={onRestart}
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
  const [collapsed, setCollapsed] = useState(completed)
  useEffect(() => setCollapsed(completed), [completed])
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
      <div className="thread-body" hidden={collapsed}>{children}</div>
    </section>
  )
}

function AudioReader({ lesson }: { lesson: Lesson }) {
  const sessionId = useId()
  const [rate, setRate] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [showText, setShowText] = useState(false)
  const [loading, setLoading] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [manifest, setManifest] = useState<Awaited<ReturnType<typeof getAudioManifest>> | null>(null)
  const [error, setError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => registerAudioSession(sessionId, () => audioRef.current?.pause()), [sessionId])

  useEffect(() => {
    let active = true
    setError('')
    setManifest(null)
    setCurrentTime(0)
    setDuration(0)
    setPlaying(false)
    void getAudioManifest(lesson.id)
      .then((result) => { if (active) setManifest(result) })
      .catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : '无法读取腾讯云音频清单') })
    return () => {
      active = false
      audioRef.current?.pause()
      audioRef.current?.removeAttribute('src')
    }
  }, [lesson.id])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = rate
    audio.preservesPitch = true
  }, [rate, manifest?.article.url])

  async function togglePlayback() {
    const audio = audioRef.current
    if (!audio || !manifest || loading) return
    if (!audio.paused) {
      audio.pause()
      return
    }
    setError('')
    setLoading(true)
    if (!requestAudioPlayback(sessionId)) {
      setLoading(false)
      setError('口语录音进行中，听力已保持暂停。结束录音后即可继续播放。')
      return
    }
    try {
      const source = peekAudio(manifest.article.url) || await warmAudio(manifest.article.url, 10)
      if (audioRef.current !== audio) return
      if (!requestAudioPlayback(sessionId)) { setLoading(false); return }
      if (audio.src !== source) {
        audio.src = source
        audio.load()
      }
      await audio.play()
    } catch (requestError) {
      setPlaying(false)
      setLoading(false)
      setError(audioPlaybackError(requestError, audio))
    }
  }

  function seekBy(offset: number) {
    const audio = audioRef.current
    if (!audio) return
    audio.currentTime = Math.min(Math.max(audio.currentTime + offset, 0), duration || audio.duration || 0)
    setCurrentTime(audio.currentTime)
  }

  const progress = duration ? currentTime / duration : 0

  return (
    <div className="audio-block">
      <div className="audio-main">
        <button className="round-audio-button" type="button" onClick={() => void togglePlayback()} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
        </button>
        <div className={`waveform ${playing ? 'playing' : ''}`} aria-hidden="true">
          {WAVEFORM_BARS.map((height, index) => <i className={index / WAVEFORM_BARS.length <= progress ? 'played' : ''} key={index} style={{ height: `${height}%` }} />)}
        </div>
      </div>
      <div className="audio-timeline">
        <span>{formatMediaTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(currentTime, duration || 0)}
          aria-label="听力播放位置"
          disabled={!duration}
          onChange={(event) => {
            const nextTime = Number(event.target.value)
            if (audioRef.current) audioRef.current.currentTime = nextTime
            setCurrentTime(nextTime)
          }}
        />
        <span>{formatMediaTime(duration)}</span>
      </div>
      <div className="audio-controls">
        <span><Volume2 size={15} /> {loading ? '完整音频加载中…' : '腾讯云完整英文朗读'}</span>
        <button type="button" onClick={() => seekBy(-10)} aria-label="后退10秒" disabled={!duration}><SkipBack size={15} /></button>
        <button type="button" onClick={() => seekBy(10)} aria-label="前进10秒" disabled={!duration}><SkipForward size={15} /></button>
        <div className="rate-controls" aria-label="朗读速度">
          {[0.75, 1, 1.25].map((option) => (
            <button
              key={option}
              className={rate === option ? 'active' : ''}
              type="button"
              onClick={() => {
                setRate(option)
              }}
            >
              {option}×
            </button>
          ))}
        </div>
        <button type="button" onClick={() => {
          audioRef.current?.pause()
          if (audioRef.current) audioRef.current.currentTime = 0
          setCurrentTime(0)
        }} aria-label="重置音频">
          <RotateCcw size={15} />
        </button>
      </div>
      <audio
        className="cloud-audio-element"
        ref={audioRef}
        preload="none"
        playsInline
        onLoadedMetadata={(event) => {
          event.currentTarget.playbackRate = rate
          event.currentTarget.preservesPitch = true
          setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)
          setLoading(false)
        }}
        onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onPlay={() => { setPlaying(true); setLoading(false) }}
        onPause={() => setPlaying(false)}
        onError={() => { setLoading(false); setError(audioPlaybackError(null, audioRef.current)) }}
        onEnded={() => { setPlaying(false); setCurrentTime(duration) }}
      />
      {manifest ? <p className="audio-provider-note">腾讯云自然语速完整音频 · 其他速度由播放器实时调节 · 已启用服务端缓存</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="text-disclosure" type="button" onClick={() => setShowText((value) => !value)}>
        {showText ? '收起原文' : '展开原文'}
        {showText ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {showText ? <div className="article-text paragraph-text"><p>{lesson.body}</p></div> : null}
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
      if (result.correct) onComplete()
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '翻译评分失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThreadSection id="translation" label="翻译" tone="wine" completed={completed}>
      <p className="section-instruction">把听力中完全相同的原文自然、准确地译成中文。</p>
      <blockquote className="translation-prompt paragraph-prompt">{lesson.body}</blockquote>
      <label className="field-block">
        <span>你的翻译</span>
        <textarea
          value={record.translationDraft}
          onChange={(event) => onRecordChange((current) => ({ ...current, translationDraft: event.target.value }))}
          placeholder="写下整段中文翻译…"
          rows={8}
          readOnly={completed}
        />
      </label>
      {!completed ? (
        <div className="translation-actions">
          <ActionButton onClick={() => void submitTranslation()} disabled={!record.translationDraft.trim() || submitting}>{submitting ? '正在批改…' : record.translationFeedback ? '根据反馈再次提交' : '提交翻译'}</ActionButton>
          {record.translationFeedback && !record.translationFeedback.correct ? <button className="skip-button" type="button" onClick={onComplete}>暂时继续，稍后复盘</button> : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      {record.translationFeedback ? (
        <div className="grading-note">
          <div className="score-seal"><strong>{record.translationScore}</strong><span>/ 100</span></div>
          <GradingDetails feedback={record.translationFeedback} fallbackReference={lesson.translation.referenceZh} fallbackNotes={lesson.translation.gradingNotes} />
        </div>
      ) : null}
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
  const sessionId = useId()
  const completed = record.completedSteps.includes('speaking')
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [error, setError] = useState('')
  const [assessmentStatus, setAssessmentStatus] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const playbackRef = useRef<HTMLAudioElement | null>(null)
  const previousPlaybackRef = useRef<HTMLAudioElement | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioBlobRef = useRef<Blob | null>(null)
  const recordingStartedAtRef = useRef(0)
  const durationSecondsRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => registerAudioSession(sessionId, () => {
    playbackRef.current?.pause()
    previousPlaybackRef.current?.pause()
  }), [sessionId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (recorderRef.current) { recorderRef.current.onstop = null; recorderRef.current.ondataavailable = null; if (recorderRef.current.state !== 'inactive') recorderRef.current.stop() }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      for (const audio of [playbackRef.current, previousPlaybackRef.current]) { audio?.pause(); audio?.removeAttribute('src') }
      audioBlobRef.current = null
      endRecordingSession(sessionId)
    }
  }, [sessionId])

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  function clearPendingRecording() {
    playbackRef.current?.pause()
    audioBlobRef.current = null
    durationSecondsRef.current = 0
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return ''
    })
    setAssessmentStatus('')
    setError('')
  }

  async function startRecording() {
    setError('')
    setAssessmentStatus('正在暂停其他音频并准备麦克风…')
    try {
      if (!window.isSecureContext) throw new Error('手机麦克风必须通过 HTTPS 安全地址访问，请使用一键脚本显示的 Mobile secure 地址。')
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持网页录音，请升级 Chrome、Edge 或 Safari。')
      beginRecordingSession(sessionId)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); endRecordingSession(sessionId); return }
      clearPendingRecording()
      const recorder = new MediaRecorder(stream, preferredRecordingOptions())
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
        streamRef.current = null
        recorderRef.current = null
        endRecordingSession(sessionId)
        setAssessmentStatus(`真实录音已就绪 · ${Math.round(durationSecondsRef.current)} 秒。回听确认后提交腾讯智聆评测。`)
      }
      recordingStartedAtRef.current = Date.now()
      recorder.start()
      setRecording(true)
      setAssessmentStatus('录音中 · 听力与其他发音已自动暂停。请照着原文完整朗读。')
    } catch (requestError) {
      endRecordingSession(sessionId)
      setError(requestError instanceof Error ? requestError.message : '无法使用麦克风，请检查浏览器权限和 HTTPS 地址。')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function submitSpeaking() {
    const sourceBlob = audioBlobRef.current
    if (!sourceBlob) {
      setError('必须先完成真实录音，不能通过文字代替口语评测。')
      return
    }
    if (durationSecondsRef.current < 8) {
      setError('录音过短，请完整复述原文后再提交。')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      setAssessmentStatus('正在转换为腾讯智聆要求的 16kHz 单声道录音…')
      const converted = await convertRecordingToTencentWav(sourceBlob)
      setAssessmentStatus('腾讯智聆正在进行逐词发音、流利度和完整度评测，请保持页面开启…')
      const result = await assessRecording(lesson.id, converted.dataUrl, converted.durationSeconds)
      onRecordChange((current) => ({
        ...current,
        speakingScore: result.score,
        speakingTranscript: result.transcript,
        speakingFeedback: result,
        lastSpeakingRecording: result.lastSpeakingRecording ?? current.lastSpeakingRecording,
      }))
      playbackRef.current?.pause()
      audioBlobRef.current = null
      durationSecondsRef.current = 0
      setAudioUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous)
        return ''
      })
      if (result.correct) onComplete()
      else setError('本次未达到70分或完整度不足75%，请根据腾讯逐词反馈重新录音。')
      setAssessmentStatus('腾讯智聆评测完成。')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '腾讯智聆口语评测失败')
      setAssessmentStatus('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ThreadSection id="speaking" label="口语" tone="blue" completed={completed}>
      <p className="section-instruction">请照着下方原文完整朗读。开始录音时，系统会自动暂停听力和其他发音，避免声音互相干扰。</p>
      <blockquote className="translation-prompt paragraph-prompt">{lesson.body}</blockquote>
      <div className="recorder-panel">
        <div className="recording-actions" aria-label="口语录音操作">
          <button
            className={`record-button ${recording ? 'recording' : ''}`}
            type="button"
            onClick={recording ? stopRecording : startRecording}
            disabled={submitting}
          >
            {recording ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
            {recording ? '结束录音' : audioUrl ? '重新录音' : completed ? '再次录音' : '开始录音'}
          </button>
          {audioUrl && !recording ? <button className="secondary-record-button" type="button" onClick={clearPendingRecording} disabled={submitting}><X size={15} /> 放弃本次录音</button> : null}
        </div>
        {audioUrl ? (
          <div className="recording-review">
            <div><strong>本次录音</strong><span>{Math.round(durationSecondsRef.current)} 秒 · 可先回听，再决定是否提交</span></div>
            <audio ref={playbackRef} className="recording-playback" src={audioUrl} controls preload="metadata" onPlay={(event) => { if (!requestAudioPlayback(sessionId)) event.currentTarget.pause() }} />
          </div>
        ) : null}
        {record.lastSpeakingRecording ? (
          <div className="recording-review previous-recording">
            <div>
              <strong>上一次录音</strong>
              <span>{Math.round(record.lastSpeakingRecording.durationSeconds)} 秒 · {record.lastSpeakingRecording.createdAt.slice(0, 16).replace('T', ' ')}</span>
            </div>
            <audio
              ref={previousPlaybackRef}
              className="recording-playback"
              src={record.lastSpeakingRecording.url}
              controls
              preload="metadata"
              onPlay={(event) => { if (!requestAudioPlayback(sessionId)) event.currentTarget.pause() }}
            />
          </div>
        ) : null}
        {assessmentStatus ? <p className="transcription-status" role="status">{assessmentStatus}</p> : null}
        <div className="assessment-contract">
          <span><LockKeyhole size={15} /> 仅接受真实录音</span>
          <span>成人严格度 4.0</span>
          <span>精准度 · 流利度 · 完整度 · 音素</span>
        </div>
        <ActionButton onClick={() => void submitSpeaking()} disabled={!audioBlobRef.current || recording || submitting}>{submitting ? '腾讯智聆评测中…' : record.speakingFeedback ? '重新提交腾讯评测' : '提交真实录音评测'}</ActionButton>
        {error ? (
          <div className="permission-fallback">
            <p role="alert">{error}</p>
          </div>
        ) : null}
      </div>
      {record.speakingFeedback ? (
        <div className="speaking-result">
          <span className="score-seal small"><strong>{record.speakingScore?.toFixed(0)}</strong><span>/ 100</span></span>
          <GradingDetails feedback={record.speakingFeedback} fallbackReference={lesson.body} />
        </div>
      ) : null}
    </ThreadSection>
  )
}

function writingExercises(lesson: Lesson) {
  return [
    {
      label: '译写一',
      prompt: lesson.writing.promptZh,
      hint: lesson.writing.hint,
    },
    {
      label: '译写二',
      prompt: lesson.writing.secondaryPromptZh || lesson.translation.referenceZh,
      hint: lesson.writing.secondaryHint || '这句话与本篇文章直接相关，请注意单词、词形和语序。',
    },
  ]
}

function normalizedWritingTasks(record: LessonRecord): [WritingTaskState, WritingTaskState] {
  const stored = Array.isArray(record.writingTasks) ? record.writingTasks : []
  return [
    stored[0] ?? {
      draft: record.writingDraft,
      attempts: record.writingAttempts,
      ...(typeof record.writingCorrect === 'boolean' ? { correct: record.writingCorrect } : {}),
      ...(record.writingFeedback ? { feedback: record.writingFeedback } : {}),
    },
    stored[1] ?? { draft: '', attempts: 0 },
  ]
}

function writingTasksForLesson(record: LessonRecord, lesson: Lesson): [WritingTaskState, WritingTaskState] {
  const exercises = writingExercises(lesson)
  return normalizedWritingTasks(record).map((task, index) => (
    task.feedback?.prompt && task.feedback.prompt !== exercises[index].prompt
      ? { draft: '', attempts: 0 }
      : task
  )) as [WritingTaskState, WritingTaskState]
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
  const exercises = writingExercises(lesson)
  const tasks = writingTasksForLesson(record, lesson)
  const [submittingIndex, setSubmittingIndex] = useState<number | null>(null)
  const [errors, setErrors] = useState<Record<number, string>>({})

  function updateWritingDraft(index: number, draft: string) {
    onRecordChange((current) => {
      const nextTasks = writingTasksForLesson(current, lesson).map((task, taskIndex) => taskIndex === index ? { ...task, draft } : task)
      return {
        ...current,
        writingTasks: nextTasks,
        ...(index === 0 ? { writingDraft: draft } : {}),
      }
    })
  }

  async function submitWriting(index: number) {
    const task = tasks[index]
    setSubmittingIndex(index)
    setErrors((current) => ({ ...current, [index]: '' }))
    try {
      const result = await gradeAnswer('writing', lesson.id, task.draft, { promptIndex: index })
      const nextTask = { ...task, attempts: task.attempts + 1, correct: result.correct, feedback: result }
      const projectedTasks = tasks.map((currentTask, taskIndex) => taskIndex === index ? nextTask : currentTask)
      onRecordChange((current) => ({
        ...current,
        writingTasks: writingTasksForLesson(current, lesson).map((currentTask, taskIndex) => taskIndex === index ? nextTask : currentTask),
        writingDraft: index === 0 ? nextTask.draft : current.writingDraft,
        writingAttempts: projectedTasks.reduce((total, currentTask) => total + currentTask.attempts, 0),
        writingCorrect: projectedTasks.every((currentTask) => Boolean(currentTask.correct)),
        writingFeedback: result,
      }))
      if (projectedTasks.every((currentTask) => currentTask.correct || currentTask.attempts >= 2)) onComplete()
    } catch (requestError) {
      setErrors((current) => ({ ...current, [index]: requestError instanceof Error ? requestError.message : '写作评分失败' }))
    } finally {
      setSubmittingIndex(null)
    }
  }

  return (
    <ThreadSection id="writing" label="写作" tone="gold" completed={completed}>
      <p className="section-instruction">连续完成两条与本篇文章相关的中译英。系统会严格核对单词、词形、大小写和句子结构，每题有两次机会。</p>
      <p className="writing-context"><BookOpen size={15} /> 两条译写均围绕本篇文章主题：{lesson.titleZh}</p>
      <div className="writing-translation-list">
        {exercises.map((exercise, index) => {
          const task = tasks[index]
          const taskDone = Boolean(task.correct) || task.attempts >= 2
          const showHint = task.attempts === 1 && !task.correct
          const showAnswer = task.attempts >= 2 && !task.correct
          return (
            <article className={`writing-translation-task ${task.correct ? 'correct' : taskDone ? 'finished' : ''}`} key={exercise.label}>
              <header>
                <span>{exercise.label} · {index + 1}/2</span>
                <strong>{task.correct ? '单词与句式正确' : taskDone ? '已完成 · 建议复盘' : `剩余 ${Math.max(0, 2 - task.attempts)} 次`}</strong>
              </header>
              <blockquote>{exercise.prompt}</blockquote>
              <label className="field-block">
                <span>你的英文翻译</span>
                <textarea
                  aria-label={`${exercise.label}英文翻译`}
                  value={task.draft}
                  onChange={(event) => updateWritingDraft(index, event.target.value)}
                  placeholder="Write the complete English sentence…"
                  rows={3}
                  readOnly={completed || taskDone}
                />
              </label>
              {!completed && !taskDone ? (
                <ActionButton onClick={() => void submitWriting(index)} disabled={!task.draft.trim() || submittingIndex !== null}>
                  {submittingIndex === index ? '正在逐词核对…' : `提交${exercise.label} · 第 ${task.attempts + 1} 次`}
                </ActionButton>
              ) : null}
              {errors[index] ? <p className="form-error" role="alert">{errors[index]}</p> : null}
              {showHint ? <p className="inline-hint"><strong>提示：</strong>{exercise.hint}</p> : null}
              {showAnswer ? <div className="grading-note compact-note"><div><span className="grading-label">参考表达</span><p>{task.feedback?.reference}</p></div></div> : null}
              {task.correct ? <p className="success-note"><Check size={16} /> 单词、词形和句式均已核对正确。</p> : null}
              {task.feedback ? <div className="grading-note compact-note"><GradingDetails feedback={task.feedback} fallbackReference={task.feedback.reference ?? ''} /></div> : null}
            </article>
          )
        })}
      </div>
    </ThreadSection>
  )
}

function SummarySection({ lesson, record, weeklyReport, onComplete, onNext, onRestart }: { lesson: Lesson; record: LessonRecord; weeklyReport: WeeklyReport; onComplete: () => void; onNext: () => void; onRestart: () => void }) {
  const completed = record.completedSteps.includes('summary')
  const translation = record.translationScore ?? 80
  const speaking = Math.round(record.speakingScore ?? 75)
  const writingTaskScores = writingTasksForLesson(record, lesson).map((task) => task.feedback?.score).filter((score): score is number => Number.isFinite(score))
  const writing = writingTaskScores.length
    ? Math.round(writingTaskScores.reduce((total, score) => total + score, 0) / writingTaskScores.length)
    : Math.round(record.writingFeedback?.score ?? (record.writingCorrect ? 92 : 76))
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
        <div className="summary-next-action">
          <span>下一步建议</span>
          <p>{weeklyReport.nextAction ?? '明天先复习本课错题，再进入与你当前等级匹配的新文章。'}</p>
          <small>预计下次先复盘 3–5 分钟</small>
        </div>
      </div>
      {!completed ? <ActionButton onClick={onComplete}>完成今日学习</ActionButton> : (
        <div className="summary-actions">
          <p className="success-note"><Check size={16} /> 今日档案已归档。</p>
          <button className="skip-button" type="button" onClick={onRestart}><RotateCcw size={15} /> 重学本篇</button>
          <ActionButton onClick={onNext}>进入下一篇</ActionButton>
        </div>
      )}
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
      <span className="grading-label">{feedback?.graderType === 'tencent-soe' ? '腾讯智聆真实录音评测' : feedback?.graderType === 'tencent-tmt-rubric' ? '腾讯云全文翻译参考 · 量表批改' : '规则量表批改'}{feedback?.submissionVersion ? ` · 第 ${feedback.submissionVersion} 版` : ''}</span>
      <p>{feedback?.summary ?? '已按本课量表完成批改。'}</p>
      {feedback?.dimensions?.length ? (
        <dl className="grading-dimensions">
          {feedback.dimensions.map((dimension) => <div key={dimension.label}><dt>{dimension.label} · {dimension.weight}%</dt><dd>{dimension.score}</dd></div>)}
        </dl>
      ) : null}
      <span className="grading-label">{feedback?.referenceScope === 'excerpt' ? '编辑参考片段' : '参考表达'}</span>
      <p>{feedback?.reference ?? fallbackReference}</p>
      {feedback?.transcript ? <><span className="grading-label">腾讯云识别文本</span><p>{feedback.transcript}</p></> : null}
      {feedback?.segments?.length ? (
        <div className="segment-feedback">
          <span className="grading-label">逐句对照</span>
          {feedback.segments.map((segment) => (
            <article key={segment.index}>
              <header><span>句 {segment.index + 1}</span><strong>{segment.score} 分</strong></header>
              <p><b>原文</b>{segment.source}</p>
              <p><b>你的表达</b>{segment.answer || '未覆盖'}</p>
              <p><b>参考</b>{segment.reference || '参考译文暂不可用'}</p>
            </article>
          ))}
        </div>
      ) : null}
      {feedback?.words?.length ? (
        <div>
          <span className="grading-label">需要重练的词</span>
          <div className="word-assessment-list">
            {feedback.words.map((word, index) => (
              <span key={`${word.segment}-${word.referenceWord}-${index}`}>
                <strong>{word.referenceWord || word.word}</strong>
                <small>{Math.round(word.accuracy)}分{word.matchTag === 2 ? ' · 遗漏' : word.matchTag === 3 ? ' · 错读' : ''}</small>
              </span>
            ))}
          </div>
        </div>
      ) : null}
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
                <div className="vocabulary-actions">
                  <VocabularySpeaker lessonId={lesson.id} term={item.term} />
                  <AsyncActionButton
                    aria-label={savedTerms.has(item.term.toLowerCase()) ? `移出生词本 ${item.term}` : `加入生词本 ${item.term}`}
                    onAction={() => onToggleVocabulary(item.term)}
                  >
                    {savedTerms.has(item.term.toLowerCase()) ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
                  </AsyncActionButton>
                </div>
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
        <span>{isCuratedLesson(lesson) ? '编辑质量分' : '拓展内容结构分'}</span>
        <strong>{lesson.quality.total}</strong>
        <small>/ 100 · {isCuratedLesson(lesson) ? '精选课程已审核' : '自动整理，建议结合原始来源'}</small>
      </section>
    </aside>
  )
}

function VocabularySpeaker({ lessonId, term }: { lessonId: string; term: string }) {
  const sessionId = useId()
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(Boolean(peekAudio(`/api/audio/speech?lessonId=${encodeURIComponent(lessonId)}&kind=vocabulary&term=${encodeURIComponent(term)}&rate=1`)))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const lifetime = useRef(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const url = `/api/audio/speech?lessonId=${encodeURIComponent(lessonId)}&kind=vocabulary&term=${encodeURIComponent(term)}&rate=1`

  useEffect(() => registerAudioSession(sessionId, () => audioRef.current?.pause()), [sessionId])

  async function toggle() {
    if (loading) return
    const generation = lifetime.current
    try {
      setError('')
      if (!audioRef.current) {
        setLoading(true)
        const source = peekAudio(url) ?? await warmAudio(url, 10)
        if (generation !== lifetime.current) return
        const audio = new Audio(source)
        audio.preload = 'auto'
        audio.onplay = () => setPlaying(true)
        audio.onended = () => setPlaying(false)
        audio.onpause = () => setPlaying(false)
        audio.onerror = () => { setPlaying(false); setError(audioPlaybackError(null, audio)) }
        audioRef.current = audio
        setReady(true)
      }
      if (playing) audioRef.current.pause()
      else {
        if (!requestAudioPlayback(sessionId)) return
        await audioRef.current.play()
      }
    } catch (failure) {
      setError(audioPlaybackError(failure, audioRef.current))
      setPlaying(false)
      audioRef.current = null
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setReady(Boolean(peekAudio(url)))
    setError('')
    setLoading(false)
    return () => {
      lifetime.current++
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [url])

  return (
    <button className={error ? 'audio-error' : ''} type="button" disabled={loading} aria-busy={loading} onClick={() => void toggle()} aria-label={`${error ? '重试' : '播放'}读音 ${term}`} title={error || (ready ? '播放腾讯云读音' : '点击加载腾讯云读音')}>
      {playing ? <Pause size={16} /> : loading ? <span className="audio-warm-dot" aria-hidden="true" /> : error ? <RotateCcw size={16} /> : <Volume2 size={16} />}
    </button>
  )
}

function AsyncActionButton({ children, onAction, className, 'aria-label': label }: { children: ReactNode; onAction: () => Promise<void>; className?: string; 'aria-label'?: string }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  const errorId = useId()
  async function run() {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try { await onAction() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请检查网络后重试') }
    finally { busy.current = false; setPending(false) }
  }
  return <><button type="button" className={className} aria-label={label} disabled={pending} aria-busy={pending} aria-describedby={error ? errorId : undefined} onClick={() => void run()}>{children}</button>{error ? <span className="action-error" id={errorId} role="alert">{error}</span> : null}</>
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
  lessons: LessonSummary[]
  state: LearningState
  onOpenLesson: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [level, setLevel] = useState<'ALL' | 'L1' | 'L2' | 'L3'>('ALL')
  const [catalogType, setCatalogType] = useState<'curated' | 'extension' | 'all'>('curated')
  const [visibleCount, setVisibleCount] = useState(40)
  const normalizedQuery = useDeferredValue(query.trim().toLowerCase())
  const lessonNumbers = useMemo(() => new Map(lessons.map((lesson, index) => [lesson.id, index + 1])), [lessons])
  const visibleLessons = useMemo(() => lessons.filter((lesson) => {
    const matchesLevel = level === 'ALL' || lesson.difficulty.level === level
    const matchesCatalog = catalogType === 'all' || (catalogType === 'curated' ? isCuratedLesson(lesson) : !isCuratedLesson(lesson))
    const matchesQuery = !normalizedQuery || [lesson.title, lesson.titleZh, lesson.topic, lesson.source.publisher]
      .some((value) => value.toLowerCase().includes(normalizedQuery))
    return matchesLevel && matchesCatalog && matchesQuery
  }), [catalogType, lessons, level, normalizedQuery])
  const renderedLessons = visibleLessons.slice(0, visibleCount)

  return (
    <ArchivePage title="课程库" english="COURSE INDEX" description={`${lessons.filter(isCuratedLesson).length} 篇精选课程与 ${lessons.filter((lesson) => !isCuratedLesson(lesson)).length} 篇拓展阅读已存入数据库。`}>
      <div className="archive-toolbar">
        <label><span>检索内容</span><input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(40) }} placeholder="标题、主题或来源" /></label>
        <div className="archive-filters" aria-label="难度筛选">
          {(['ALL', 'L1', 'L2', 'L3'] as const).map((option) => (
            <button className={level === option ? 'active' : ''} key={option} type="button" onClick={() => { setLevel(option); setVisibleCount(40) }}>{option === 'ALL' ? '全部' : option}</button>
          ))}
        </div>
        <div className="archive-filters catalog-filters" aria-label="内容类型">
          <button className={catalogType === 'curated' ? 'active' : ''} type="button" onClick={() => { setCatalogType('curated'); setVisibleCount(40) }}>精选课程</button>
          <button className={catalogType === 'extension' ? 'active' : ''} type="button" onClick={() => { setCatalogType('extension'); setVisibleCount(40) }}>拓展阅读</button>
          <button className={catalogType === 'all' ? 'active' : ''} type="button" onClick={() => { setCatalogType('all'); setVisibleCount(40) }}>全部</button>
        </div>
        <span>{visibleLessons.length} 篇</span>
      </div>
      <div className="archive-table" role="table" aria-label="内容库">
        <div className="archive-row archive-head" role="row">
          <span>编号</span><span>内容</span><span>难度</span><span>状态</span><span />
        </div>
        {renderedLessons.map((lesson) => {
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
              <span>{String(lessonNumbers.get(lesson.id) ?? 0).padStart(3, '0')}</span>
              <span><strong>{lesson.title}</strong><small>{lesson.titleZh} · {lesson.topic} · {isCuratedLesson(lesson) ? '精选' : '拓展'}</small></span>
              <span>{lesson.difficulty.level}<small>{lesson.difficulty.cefr}</small></span>
              <span>{status}</span>
              <button type="button" onClick={() => onOpenLesson(lesson.id)}>打开 <ArrowRight size={14} /></button>
            </div>
          )
        })}
      </div>
      {renderedLessons.length < visibleLessons.length ? <button className="load-more-button" type="button" onClick={() => setVisibleCount((count) => count + 40)}>继续加载 · 已显示 {renderedLessons.length}/{visibleLessons.length}</button> : null}
    </ArchivePage>
  )
}

function ReviewView({ reviewItems, vocabularyBook, weeklyReport, onAttempt, onReviewAction, onVocabularyAction }: {
  lessons: LessonSummary[]
  state: LearningState
  reviewItems: ReviewItem[]
  vocabularyBook: SavedVocabulary[]
  weeklyReport: WeeklyReport
  onAttempt: (item: ReviewItem, answer: string) => Promise<{ correct: boolean; score: number; mastery: number; reference: string }>
  onReviewAction: (item: ReviewItem, action: 'snooze' | 'master' | 'delete') => Promise<void>
  onVocabularyAction: (item: SavedVocabulary, action: 'snooze' | 'master' | 'delete') => Promise<void>
}) {
  const [tab, setTab] = useState<'errors' | 'vocabulary' | 'weekly'>('errors')
  const dueReviewItems = useMemo(() => reviewItems.filter((item) => !item.dueAt || new Date(item.dueAt).getTime() <= Date.now()), [reviewItems])
  const plannedReviewItems = useMemo(() => reviewItems.filter((item) => item.dueAt && new Date(item.dueAt).getTime() > Date.now()), [reviewItems])
  return (
    <ArchivePage title="复盘簿" english="REVIEW LEDGER" description="错题主动回忆、生词归档和最近七天学习报告都保存在数据库中。">
      <div className="review-tabs" role="tablist" aria-label="复盘分类">
        <button className={tab === 'errors' ? 'active' : ''} type="button" onClick={() => setTab('errors')}>错题复习 · {reviewItems.length}</button>
        <button className={tab === 'vocabulary' ? 'active' : ''} type="button" onClick={() => setTab('vocabulary')}>生词本 · {vocabularyBook.length}</button>
        <button className={tab === 'weekly' ? 'active' : ''} type="button" onClick={() => setTab('weekly')}>本周报告</button>
      </div>
      {tab === 'errors' && reviewItems.length ? (
        <div className="review-groups">
          <section className="review-errors" aria-label="今日到期错题">
            <header><strong>今日到期</strong><span>{dueReviewItems.length} 项</span></header>
            {dueReviewItems.length ? dueReviewItems.map((item) => <ReviewAttemptCard key={`${item.id}-${item.reviewTaskId}`} item={item} onAttempt={onAttempt} onAction={onReviewAction} />) : <p className="review-empty-line">今天没有到期错题，可以直接开始新课程。</p>}
          </section>
          {plannedReviewItems.length ? <section className="review-errors planned" aria-label="未来复习计划">
            <header><strong>未来计划</strong><span>{plannedReviewItems.length} 项</span></header>
            {plannedReviewItems.map((item) => <ReviewAttemptCard key={`${item.id}-${item.reviewTaskId}`} item={item} onAttempt={onAttempt} onAction={onReviewAction} />)}
          </section> : null}
        </div>
      ) : tab === 'errors' ? <EmptyArchive icon={NotebookText} title="还没有复盘记录" copy="提交一次未达标的翻译、口语或写作后，系统会自动安排复习。" /> : null}
      {tab === 'vocabulary' ? (
        vocabularyBook.length ? <div className="vocabulary-ledger">
          {vocabularyBook.map((item) => <article key={`${item.lessonId}-${item.term}`}>
            <BookmarkCheck size={17} />
            <div><strong>{item.term}</strong><span>{item.ipa} · {item.part}</span><p>{item.meaning}</p><small>{item.mastery >= 3 ? '已掌握' : item.reviewDueAt ? `下次复习 ${item.reviewDueAt.slice(0, 10)}` : `熟练度 ${item.mastery}/3`}</small></div>
            <div className="ledger-actions">
              <VocabularySpeaker lessonId={item.lessonId} term={item.term} />
              <AsyncActionButton onAction={() => onVocabularyAction(item, 'snooze')}>跳过今天</AsyncActionButton>
              <AsyncActionButton onAction={() => onVocabularyAction(item, 'master')}>标记掌握</AsyncActionButton>
              <AsyncActionButton className="danger-action" onAction={() => onVocabularyAction(item, 'delete')}><Trash2 size={13} /> 删除</AsyncActionButton>
            </div>
          </article>)}
        </div> : <EmptyArchive icon={Bookmark} title="生词本还是空的" copy="在今日文章右侧点击书签图标，词汇会同步到这里。" />
      ) : null}
      {tab === 'weekly' ? <>
        <section className="weekly-report">
          <header><span>{weeklyReport.periodStart} — {weeklyReport.periodEnd}</span><strong>七日学习报告</strong></header>
          <dl>
            <div><dt>完成课程</dt><dd>{weeklyReport.completedLessons}</dd></div>
            <div><dt>课程均分</dt><dd>{weeklyReport.averageScore || '—'}</dd></div>
            <div><dt>复习次数</dt><dd>{weeklyReport.reviewAttempts}</dd></div>
            <div><dt>复习均分</dt><dd>{weeklyReport.reviewAverage || '—'}</dd></div>
            <div><dt>连续学习</dt><dd>{weeklyReport.streakDays ?? 0} 天</dd></div>
            <div><dt>学习时间</dt><dd>{weeklyReport.estimatedMinutes ?? 0} 分钟</dd></div>
          </dl>
          {weeklyReport.skillAverages ? <div className="skill-trends" aria-label="技能均分">
            <div><span>翻译</span><strong>{weeklyReport.skillAverages.translation || '—'}</strong></div>
            <div><span>口语</span><strong>{weeklyReport.skillAverages.speaking || '—'}</strong></div>
            <div><span>写作</span><strong>{weeklyReport.skillAverages.writing || '—'}</strong></div>
          </div> : null}
          {weeklyReport.days.length ? <div className="weekly-days">{weeklyReport.days.map((day) => <div key={day.learningDate}><span>{day.learningDate.slice(5)}</span><i style={{ height: `${Math.max(8, day.totalScore)}%` }} /><strong>{day.totalScore}</strong></div>)}</div> : <p>本周完成课程后，这里会生成趋势档案。</p>}
          <div className="weekly-guidance"><strong>本周洞察</strong><p>{weeklyReport.insight}</p><strong>下一步</strong><p>{weeklyReport.nextAction}</p></div>
        </section>
        <WordWeeklyReportPanel />
      </> : null}
    </ArchivePage>
  )
}

function ReviewAttemptCard({ item, onAttempt, onAction }: { item: ReviewItem; onAttempt: (item: ReviewItem, answer: string) => Promise<{ correct: boolean; score: number; mastery: number; reference: string }>; onAction: (item: ReviewItem, action: 'snooze' | 'master' | 'delete') => Promise<void> }) {
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<{ correct: boolean; score: number; mastery: number; reference: string } | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionPending, setActionPending] = useState(false)
  function runAction(action: 'snooze' | 'master' | 'delete') {
    setActionPending(true)
    setError('')
    void onAction(item, action).catch((requestError) => setError(requestError instanceof Error ? requestError.message : '操作失败')).finally(() => setActionPending(false))
  }
  const errorLabel = item.errorType === 'translation' ? '翻译' : item.errorType === 'speaking' ? '口语' : item.errorType === 'writing' ? '写作' : item.errorType
  return <article>
    <span>{errorLabel} · {item.titleZh} · 熟练度 {item.mastery}/3{item.dueAt ? ` · ${new Date(item.dueAt).getTime() <= Date.now() ? '今日到期' : `计划 ${item.dueAt.slice(0, 10)}`}` : ''}</span>
    <p>{item.prompt}</p>
    <label className="review-answer"><span>不看答案，重新作答</span><textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} /></label>
    <div className="review-card-actions">
      {!result && item.reviewTaskId ? <button type="button" disabled={!answer.trim() || submitting || actionPending} onClick={() => {
        setSubmitting(true)
        setError('')
        void onAttempt(item, answer).then(setResult).catch((requestError) => setError(requestError instanceof Error ? requestError.message : '提交失败')).finally(() => setSubmitting(false))
      }}><Check size={14} /> {submitting ? '正在核对…' : '提交复习'}</button> : null}
      <button type="button" disabled={actionPending} onClick={() => runAction('snooze')}>跳过今天</button>
      <button type="button" disabled={actionPending} onClick={() => runAction('master')}>标记掌握</button>
      <button type="button" disabled={actionPending} className="danger-action" onClick={() => runAction('delete')}><Trash2 size={13} /> 删除</button>
    </div>
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
  weeklyReport,
  onProfileChange,
  onLogout,
}: {
  user: string
  state: LearningState
  lessons: LessonSummary[]
  profile: LearningProfile
  databaseEngine: string
  weeklyReport: WeeklyReport
  onProfileChange: (profile: LearningProfile) => Promise<void>
  onLogout: () => Promise<void>
}) {
  const completed = Object.values(state.records).filter((record) => record.completedSteps.includes('summary')).length
  const [draft, setDraft] = useState(profile)
  const topicOptions = useMemo(() => [...new Set(lessons.filter(isCuratedLesson).map((lesson) => lesson.topic))].slice(0, 12), [lessons])
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
          <div><dt>连续学习</dt><dd>{weeklyReport.streakDays ?? 0} 天</dd></div>
          <div><dt>七日投入</dt><dd>{weeklyReport.estimatedMinutes ?? 0} 分钟</dd></div>
        </dl>
        <form className="profile-form" onSubmit={(event) => { event.preventDefault(); void onProfileChange(draft) }}>
          <label><span>学习目标</span><input value={draft.targetExam} onChange={(event) => setDraft((current) => ({ ...current, targetExam: event.target.value }))} /></label>
          <label><span>默认难度</span><select value={draft.preferredLevel} onChange={(event) => setDraft((current) => ({ ...current, preferredLevel: event.target.value as LearningProfile['preferredLevel'] }))}><option value="L1">L1 基础</option><option value="L2">L2 进阶</option><option value="L3">L3 高阶</option></select></label>
          <label><span>每日分钟</span><input type="number" min="5" max="120" value={draft.dailyGoalMinutes} onChange={(event) => setDraft((current) => ({ ...current, dailyGoalMinutes: Number(event.target.value) }))} /></label>
          <fieldset className="interest-picker">
            <legend>感兴趣的主题</legend>
            <div>{topicOptions.map((topic) => {
              const selected = draft.interests.includes(topic)
              return <label key={topic} className={selected ? 'selected' : ''}><input type="checkbox" checked={selected} onChange={() => setDraft((current) => ({ ...current, interests: selected ? current.interests.filter((item) => item !== topic) : [...current.interests, topic] }))} /><span>{topic}</span></label>
            })}</div>
          </fieldset>
          <button className="double-border-button" type="submit"><span>保存学习档案</span><ArrowRight size={16} /></button>
        </form>
        <WordLearningPreferences />
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
