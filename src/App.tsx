import {
  ArrowRight,
  BookOpen,
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
import { CONTENT_TARGET, LESSONS, findLesson } from './data/lessons'
import { getSession, login, logout } from './lib/api'
import {
  completeStep,
  createLessonRecord,
  loadLearningState,
  saveLearningState,
  updateLessonRecord,
} from './lib/learning-state'
import {
  STEP_ORDER,
  type LearningState,
  type Lesson,
  type LessonRecord,
  type PrimaryView,
  type Session,
  type StepId,
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
    <LearningWorkspace
      session={session}
      onLogout={async () => {
        await logout().catch(() => undefined)
        setSession(null)
      }}
    />
  )
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

function LearningWorkspace({ session, onLogout }: { session: Session; onLogout: () => Promise<void> }) {
  const [view, setView] = useState<PrimaryView>('today')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [state, setState] = useState<LearningState>(() => loadLearningState(session.user))
  const lesson = findLesson(state.currentLessonId)
  const record = state.records[lesson.id] ?? createLessonRecord()

  useEffect(() => {
    saveLearningState(session.user, state)
  }, [session.user, state])

  const updateCurrentRecord = useCallback((updater: (record: LessonRecord) => LessonRecord) => {
    setState((current) => updateLessonRecord(current, current.currentLessonId, updater))
  }, [])

  const finishStep = useCallback((step: StepId) => {
    setState((current) => completeStep(current, current.currentLessonId, step))
  }, [])

  function skipCurrentLesson() {
    setState((current) => {
      const currentIndex = LESSONS.findIndex((candidate) => candidate.id === current.currentLessonId)
      const withSkip = updateLessonRecord(current, current.currentLessonId, (currentRecord) => ({
        ...currentRecord,
        skipped: true,
      }))
      const candidates = [...LESSONS.slice(currentIndex + 1), ...LESSONS.slice(0, currentIndex)]
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

  return (
    <div className="app-shell">
      <AppSidebar
        activeView={view}
        mobileOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onNavigate={(nextView) => {
          setView(nextView)
          setMobileNavOpen(false)
        }}
      />

      <div className="app-stage">
        <AppHeader
          onMenu={() => setMobileNavOpen((open) => !open)}
          user={session.user}
        />

        <main className="app-content">
          {view === 'today' ? (
            <TodayView
              lesson={lesson}
              record={record}
              onRecordChange={updateCurrentRecord}
              onCompleteStep={finishStep}
              onSkip={skipCurrentLesson}
            />
          ) : null}
          {view === 'conversations' ? (
            <ConversationsView
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
          {view === 'review' ? <ReviewView state={state} /> : null}
          {view === 'profile' ? (
            <ProfileView user={session.user} state={state} onLogout={onLogout} />
          ) : null}
        </main>
      </div>

      <MobileBottomNav activeView={view} onNavigate={setView} />
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  )
}

function AppHeader({ onMenu, user }: { onMenu: () => void; user: string }) {
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
  record,
  onRecordChange,
  onCompleteStep,
  onSkip,
}: {
  lesson: Lesson
  record: LessonRecord
  onRecordChange: (updater: (record: LessonRecord) => LessonRecord) => void
  onCompleteStep: (step: StepId) => void
  onSkip: () => void
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
        <div className="docket-number">NO. {String(LESSONS.indexOf(lesson) + 1).padStart(3, '0')}</div>
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
              completed={record.completedSteps.includes('speaking')}
              score={record.speakingScore}
              onComplete={(score) => {
                onRecordChange((current) => ({ ...current, speakingScore: score }))
                onCompleteStep('speaking')
              }}
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

        <LessonMarginalia lesson={lesson} />
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

  useEffect(() => () => window.speechSynthesis?.cancel(), [lesson.id])

  function togglePlayback() {
    if (!('speechSynthesis' in window)) return
    if (playing) {
      window.speechSynthesis.cancel()
      setPlaying(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(lesson.body)
    utterance.lang = 'en-US'
    utterance.rate = rate
    utterance.onend = () => setPlaying(false)
    utterance.onerror = () => setPlaying(false)
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
    setPlaying(true)
  }

  return (
    <div className="audio-block">
      <div className="audio-main">
        <button className="round-audio-button" type="button" onClick={togglePlayback} aria-label={playing ? '暂停' : '播放'}>
          {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
        </button>
        <div className={`waveform ${playing ? 'playing' : ''}`} aria-hidden="true">
          {WAVEFORM_BARS.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}
        </div>
      </div>
      <div className="audio-controls">
        <span><Volume2 size={15} /> 美式朗读</span>
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
        }} aria-label="重置音频">
          <RotateCcw size={15} />
        </button>
      </div>
      <button className="text-disclosure" type="button" onClick={() => setShowText((value) => !value)}>
        {showText ? '收起原文' : '展开原文'}
        {showText ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {showText ? <div className="article-text"><p>{lesson.body}</p></div> : null}
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

  function submitTranslation() {
    const contentWords = record.translationDraft.trim().split(/\s+/u).filter(Boolean).length
    const score = Math.min(94, 68 + contentWords * 3)
    onRecordChange((current) => ({ ...current, translationScore: score }))
    onComplete()
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
        <ActionButton onClick={submitTranslation} disabled={!record.translationDraft.trim()}>提交翻译</ActionButton>
      ) : (
        <div className="grading-note">
          <div className="score-seal"><strong>{record.translationScore}</strong><span>/ 100</span></div>
          <div>
            <span className="grading-label">参考译文</span>
            <p>{lesson.translation.referenceZh}</p>
            <ul>{lesson.translation.gradingNotes.map((note) => <li key={note}>{note}</li>)}</ul>
          </div>
        </div>
      )}
    </ThreadSection>
  )
}

function SpeakingSection({
  lesson,
  completed,
  score,
  onComplete,
}: {
  lesson: Lesson
  completed: boolean
  score?: number
  onComplete: (score: number) => void
}) {
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])

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
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return URL.createObjectURL(blob)
        })
        stream.getTracks().forEach((track) => track.stop())
      }
      recorder.start()
      setRecording(true)
    } catch {
      setError('无法使用麦克风。请允许权限，或使用练习模式继续。')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
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
          {audioUrl ? <ActionButton onClick={() => onComplete(8.2)}>提交口语</ActionButton> : null}
          {error ? (
            <div className="permission-fallback">
              <p role="alert">{error}</p>
              <button type="button" onClick={() => onComplete(7.4)}>使用练习模式继续</button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="speaking-result">
          <span className="score-seal small"><strong>{score?.toFixed(1)}</strong><span>/ 10</span></span>
          <p>节奏稳定，表达完整。下一次可进一步减少句中停顿。</p>
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

  function normalize(value: string) {
    return value.toLowerCase().replace(/[^a-z\s]/gu, '').replace(/\s+/gu, ' ').trim()
  }

  function submitWriting() {
    const correct = lesson.writing.answers.some((answer) => normalize(answer) === normalize(record.writingDraft))
    const nextAttempts = record.writingAttempts + 1
    onRecordChange((current) => ({
      ...current,
      writingAttempts: nextAttempts,
      writingCorrect: correct,
    }))
    if (correct || nextAttempts >= 2) onComplete()
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
        <ActionButton onClick={submitWriting} disabled={!record.writingDraft.trim()}>
          提交 · 第 {Math.min(record.writingAttempts + 1, 2)} 次
        </ActionButton>
      ) : null}
      {showHint ? <p className="inline-hint"><strong>提示：</strong>{lesson.writing.hint}</p> : null}
      {showAnswer ? (
        <div className="grading-note compact-note">
          <div><span className="grading-label">参考表达</span><p>{lesson.writing.answers[0]}</p></div>
        </div>
      ) : null}
      {record.writingCorrect ? <p className="success-note"><Check size={16} /> 表达准确，已收入今日掌握句型。</p> : null}
    </ThreadSection>
  )
}

function SummarySection({ lesson, record, onComplete }: { lesson: Lesson; record: LessonRecord; onComplete: () => void }) {
  const completed = record.completedSteps.includes('summary')
  const translation = record.translationScore ?? 80
  const speaking = Math.round((record.speakingScore ?? 7.5) * 10)
  const writing = record.writingCorrect ? 92 : 76
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

function LessonMarginalia({ lesson }: { lesson: Lesson }) {
  return (
    <aside className="marginalia" aria-label="词汇与来源">
      <section>
        <header><span>词汇与原文</span><small>VOCABULARY</small></header>
        <div className="vocabulary-list">
          {lesson.vocabulary.map((item) => (
            <article key={item.term}>
              <strong>{item.term}</strong>
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

function ConversationsView({ state, onOpenLesson }: { state: LearningState; onOpenLesson: (id: string) => void }) {
  return (
    <ArchivePage title="对话档案" english="CONVERSATION INDEX" description="五篇种子内容已入库；完成、进行中和跳过状态会保存在本机。">
      <div className="archive-table" role="table" aria-label="内容库">
        <div className="archive-row archive-head" role="row">
          <span>编号</span><span>内容</span><span>难度</span><span>状态</span><span />
        </div>
        {LESSONS.map((lesson, index) => {
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

function ReviewView({ state }: { state: LearningState }) {
  const activeRecords = Object.entries(state.records).filter(([, record]) => record.completedSteps.length > 0)
  return (
    <ArchivePage title="复盘簿" english="REVIEW LEDGER" description="从已经发生的翻译、写作和口语练习中提取复盘线索。">
      {activeRecords.length ? (
        <div className="review-grid">
          {activeRecords.map(([lessonId, record]) => {
            const lesson = findLesson(lessonId)
            return (
              <article key={lessonId} className="review-sheet">
                <span>{lesson.difficulty.level} · {lesson.topic}</span>
                <h2>{lesson.title}</h2>
                <dl>
                  <div><dt>翻译</dt><dd>{record.translationScore ? `${record.translationScore} 分` : '待完成'}</dd></div>
                  <div><dt>口语</dt><dd>{record.speakingScore ? `${record.speakingScore.toFixed(1)} 分` : '待完成'}</dd></div>
                  <div><dt>写作</dt><dd>{record.writingAttempts ? `${record.writingAttempts} 次作答` : '待完成'}</dd></div>
                </dl>
                <p>{lesson.vocabulary.map((word) => word.term).join(' · ')}</p>
              </article>
            )
          })}
        </div>
      ) : (
        <EmptyArchive icon={NotebookText} title="还没有复盘记录" copy="完成第一篇的翻译、口语或写作后，错误与重点词会出现在这里。" />
      )}
    </ArchivePage>
  )
}

function ProfileView({ user, state, onLogout }: { user: string; state: LearningState; onLogout: () => Promise<void> }) {
  const completed = Object.values(state.records).filter((record) => record.completedSteps.includes('summary')).length
  return (
    <ArchivePage title="我的档案" english="READER PROFILE" description="个人 MVP 的学习偏好与内容库状态。">
      <div className="profile-sheet">
        <div className="profile-monogram">{user.slice(0, 1)}</div>
        <div className="profile-identity"><span>登录用户</span><strong>{user}</strong><small>PERSONAL READER · 001</small></div>
        <dl>
          <div><dt>当前目标</dt><dd>六级 / 雅思 6.5</dd></div>
          <div><dt>默认难度</dt><dd>L2 进阶</dd></div>
          <div><dt>种子内容</dt><dd>{LESSONS.length} / {CONTENT_TARGET}</dd></div>
          <div><dt>完成档案</dt><dd>{completed}</dd></div>
        </dl>
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
