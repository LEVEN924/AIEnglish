import {
  ArrowLeft,
  BookMarked,
  Check,
  ChevronRight,
  Clock3,
  Flag,
  Headphones,
  Keyboard,
  LibraryBig,
  Lightbulb,
  Pause,
  Play,
  RotateCcw,
  Search,
  Target,
  TimerReset,
  Volume2,
} from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  getDictionaryEntry,
  getDictionaryOverview,
  getWordStudySession,
  saveWordPreference,
  searchDictionary,
  submitWordStudyAttempt,
  updateWordEntry,
  updateWordStudySession,
} from './lib/api'
import { audioPlaybackError, peekAudio, warmAudio } from './lib/audio-cache'
import { registerAudioSession, requestAudioPlayback } from './lib/audio-session'
import type { DictionaryEntry, DictionaryOverview, WordStudyItem, WordStudyMode, WordStudySession } from './types'

function entryAudioUrl(entryId: number) {
  return `/api/audio/word?entryId=${entryId}`
}

function WordSpeaker({ entry, label = '播放发音' }: { entry: DictionaryEntry; label?: string }) {
  const sessionId = useId()
  const url = entryAudioUrl(entry.id)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [ready, setReady] = useState(Boolean(peekAudio(url)))
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const lifetime = useRef(0)

  useEffect(() => {
    setReady(Boolean(peekAudio(url)))
    setLoading(false)
    setError('')
    return () => {
      lifetime.current++
      audioRef.current?.pause()
      audioRef.current = null
    }
  }, [url])

  useEffect(() => registerAudioSession(sessionId, () => audioRef.current?.pause()), [sessionId])

  async function toggle() {
    if (loading) return
    const generation = lifetime.current
    if (playing) {
      audioRef.current?.pause()
      return
    }
    try {
      setLoading(true)
      setError('')
      if (!requestAudioPlayback(sessionId)) return
      const source = peekAudio(url) ?? await warmAudio(url, 10)
      if (generation !== lifetime.current || !requestAudioPlayback(sessionId)) return
      const audio = audioRef.current ?? new Audio()
      audio.preload = 'auto'
      if (audio.src !== source) audio.src = source
      audio.onplay = () => setPlaying(true)
      audio.onpause = () => setPlaying(false)
      audio.onended = () => setPlaying(false)
      audioRef.current = audio
      setReady(true)
      await audio.play()
    } catch (failure) {
      setPlaying(false)
      setError(audioPlaybackError(failure, audioRef.current))
      audioRef.current = null
    } finally {
      setLoading(false)
    }
  }

  return (
    <button className={`word-speaker ${ready ? 'ready' : ''} ${error ? 'audio-error' : ''}`} disabled={loading} aria-busy={loading} type="button" onClick={() => void toggle()} aria-label={error ? `${error} 点击重试${label}` : label} title={error || (ready ? label : '点击加载腾讯云发音')}>
      {playing ? <Pause size={17} /> : loading ? <span className="audio-warm-dot" aria-hidden="true" /> : error ? <RotateCcw size={17} /> : <Volume2 size={17} />}
    </button>
  )
}

function EntryDetails({ entry, onChanged }: { entry: DictionaryEntry; onChanged: (entry: DictionaryEntry, overview: DictionaryOverview) => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const forms = Object.entries(entry.forms).filter(([, value]) => value).slice(0, 8)
  const englishSenses = entry.definitionEn.split(/;\s*/u).map((sense) => sense.trim()).filter(Boolean)
  const chineseSenses = entry.meaningZh.split(/[；;]/u).map((sense) => sense.trim()).filter(Boolean)
  async function action(nextAction: 'add' | 'suspend' | 'master' | 'reset' | 'remove') {
    if (pending) return
    setPending(true); setError('')
    try { const result = await updateWordEntry(entry.id, nextAction); onChanged(result.entry, result.overview) }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
    finally { setPending(false) }
  }
  return (
    <article className="dictionary-entry-sheet">
      <header>
        <div>
          <span className="dictionary-kicker">{entry.entryType === 'phrase' ? 'PHRASE FILE' : 'WORD FILE'} · #{String(entry.id).padStart(5, '0')}</span>
          <h2>{entry.headword} <WordSpeaker entry={entry} /></h2>
          <p className="entry-phonetics">{entry.ipa ? `/ ${entry.ipa} /` : '音标整理中'} <em>{entry.partOfSpeech}</em></p>
        </div>
        <span className={`word-state-stamp ${entry.progressState}`}>{entry.progressState === 'new' ? '未学习' : entry.progressState === 'learning' ? '学习中' : entry.progressState === 'review' ? '待复习' : entry.progressState === 'mastered' ? '已掌握' : '已跳过'}</span>
      </header>
      <section className="entry-definition-grid">
        <div><span>中文释义 · {entry.partOfSpeech || '词性待整理'}</span>{chineseSenses.length ? <ol>{chineseSenses.map((sense) => <li key={sense}>{sense}</li>)}</ol> : <strong>暂无中文释义</strong>}</div>
        <div><span>English definitions</span>{englishSenses.length ? <ol>{englishSenses.map((sense) => <li key={sense}>{sense}</li>)}</ol> : <p>Definition is being curated.</p>}</div>
      </section>
      <div className="entry-level-meta">
        {entry.frequencyRank ? <span>词频排名 #{entry.frequencyRank.toLocaleString()}</span> : <span>词频待整理</span>}
        {entry.lists?.map((list) => list.detail.cefr).find(Boolean) ? <span>CEFR {entry.lists?.map((list) => list.detail.cefr).find(Boolean)}</span> : null}
      </div>
      {entry.roots || entry.memoryNote ? (
        <section className="entry-notes">
          {entry.roots ? <p><span>词根 / 联想</span>{entry.roots}</p> : null}
          {entry.memoryNote ? <p><span>用法档案</span>{entry.memoryNote}</p> : null}
        </section>
      ) : null}
      {entry.exampleEn ? <blockquote><p>{entry.exampleEn}</p>{entry.exampleZh ? <footer>{entry.exampleZh}</footer> : null}</blockquote> : null}
      {forms.length ? <div className="entry-forms"><span>词形</span>{forms.map(([key, value]) => <i key={key}>{key} · {value}</i>)}</div> : null}
      {entry.lists?.length ? <div className="entry-sources"><span>收录于</span>{entry.lists.map((list) => <i key={list.id}>{list.shortName}{list.detail.cefr ? ` · ${list.detail.cefr}` : ''}</i>)}</div> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer className="entry-actions" inert={pending} aria-busy={pending}>
        {entry.progressState === 'new' ? <button type="button" onClick={() => void action('add')}><BookMarked size={16} /> 加入背词</button> : null}
        {entry.progressState !== 'mastered' ? <button type="button" onClick={() => void action('master')}><Check size={16} /> 标记掌握</button> : <button type="button" onClick={() => void action('reset')}>重新学习</button>}
        {entry.progressState !== 'suspended' ? <button type="button" onClick={() => void action('suspend')}>跳过此词</button> : <button type="button" onClick={() => void action('reset')}>恢复此词</button>}
        {entry.progressState !== 'new' ? <button type="button" onClick={() => void action('remove')}>移出生词</button> : null}
      </footer>
    </article>
  )
}

const WORD_MODE_LABELS: Record<WordStudyMode, string> = {
  meaning: '词义辨认',
  spelling: '中译英拼写',
  cloze: '例句挖空',
  listening: '听音拼写',
}

function normalizeStudyAnswer(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/[’`]/gu, "'").replace(/[^a-z0-9'\-\s\u3400-\u9fff]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function firstChineseSense(entry: DictionaryEntry) {
  return entry.meaningZh.split(/[；;]/u).map((item) => item.trim()).find(Boolean) || entry.definitionEn
}

function formatNextReview(nextDueAt: string) {
  const minutes = Math.max(1, Math.round((new Date(nextDueAt).getTime() - Date.now()) / 60_000))
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} 小时后`
  return `${Math.round(hours / 24)} 天后`
}

function StudyPrompt({ item, answer, checked, onAnswer }: { item: WordStudyItem; answer: string; checked: boolean; onAnswer: (answer: string) => void }) {
  if (item.mode === 'meaning') {
    return (
      <div className="meaning-choice-grid" role="radiogroup" aria-label="选择核心义项">
        {item.choices.map((choice, index) => (
          <button key={choice} type="button" role="radio" aria-checked={answer === choice} className={answer === choice ? 'selected' : ''} onClick={() => onAnswer(choice)} disabled={checked}>
            <span>{String.fromCharCode(65 + index)}</span>{choice}
          </button>
        ))}
      </div>
    )
  }
  return (
    <label className="study-answer-input">
      <span>{item.mode === 'cloze' ? '填入句中缺失的词' : '输入英文答案'}</span>
      <input value={answer} onChange={(event) => onAnswer(event.target.value)} disabled={checked} autoCapitalize="none" autoComplete="off" spellCheck={false} placeholder="Type your answer…" />
    </label>
  )
}

function StudyDesk({
  session,
  onExit,
  onOverview,
}: {
  session: WordStudySession
  onExit: () => void
  onOverview: (overview: DictionaryOverview) => void
}) {
  const [currentSession, setCurrentSession] = useState(session)
  const [answer, setAnswer] = useState('')
  const [checked, setChecked] = useState(false)
  const [hintCount, setHintCount] = useState(0)
  const [diagnosticMode, setDiagnosticMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState(session.resumed ? '已恢复到上次停下的位置。' : '')
  const item = currentSession.items[currentSession.currentIndex]
  const activeItem = useMemo(() => {
    if (!item || !diagnosticMode) return item
    const forms = Object.values(item.entry.forms).flatMap((value) => String(value).split(/[,;/|]/u)).map((value) => value.trim()).filter(Boolean)
    return {
      ...item,
      mode: 'spelling' as const,
      prompt: firstChineseSense(item.entry),
      acceptedAnswers: [item.entry.headword, ...forms],
      hint: `${item.entry.headword.slice(0, 1)}${' ·'.repeat(Math.max(0, Math.min(12, item.entry.headword.length - 1)))} · ${item.entry.headword.length} 个字符`,
    }
  }, [diagnosticMode, item])
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const startedAtRef = useRef(Date.now())
  const normalizedAnswer = normalizeStudyAnswer(answer)
  const correct = Boolean(activeItem && normalizedAnswer && activeItem.acceptedAnswers.some((candidate) => normalizeStudyAnswer(candidate) === normalizedAnswer))

  useEffect(() => {
    setAnswer('')
    setChecked(false)
    setHintCount(0)
    setDiagnosticMode(false)
    startedAtRef.current = Date.now()
    if (!item) return
    void warmAudio(entryAudioUrl(item.entry.id), 10).catch(() => undefined)
    const nextItem = currentSession.items[currentSession.currentIndex + 1]
    if (nextItem) void warmAudio(entryAudioUrl(nextItem.entry.id), 5).catch(() => undefined)
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      headingRef.current?.focus({ preventScroll: true })
    })
  }, [item?.key])

  const commitRating = useCallback(async (rating: 'again' | 'hard' | 'good' | 'easy') => {
    if (!item || submitting) return
    setSubmitting(true)
    try {
      const result = await submitWordStudyAttempt(currentSession.id, {
        itemKey: item.key,
        entryId: item.entry.id,
        mode: activeItem?.mode ?? item.mode,
        answer,
        rating,
        responseMs: Date.now() - startedAtRef.current,
        hintCount,
        diagnosticKnown: diagnosticMode,
      })
      setMessage(`${result.correct ? '回答已记录' : '已加入本轮重学队列'} · 下次复习 ${formatNextReview(result.nextDueAt)}`)
      setCurrentSession(result.session)
      onOverview(result.overview)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '作答保存失败。')
    } finally {
      setSubmitting(false)
    }
  }, [activeItem?.mode, answer, currentSession.id, diagnosticMode, hintCount, item, onOverview, submitting])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!checked || submitting) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const ratingByKey = correct ? { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' } as const : { '1': 'again' } as const
      const rating = ratingByKey[event.key as keyof typeof ratingByKey]
      if (rating) void commitRating(rating)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [checked, commitRating, correct, submitting])

  async function pauseSession() {
    if (submitting) return
    setSubmitting(true)
    try { await updateWordStudySession(currentSession.id, 'pause'); onExit() }
    catch (error) { setMessage(error instanceof Error ? error.message : '暂停失败，请重试') }
    finally { setSubmitting(false) }
  }

  async function skipWord() {
    if (!item || submitting) return
    setSubmitting(true)
    try {
      const nextSession = await updateWordStudySession(currentSession.id, 'skip', item.entry.id)
      setCurrentSession(nextSession)
      setMessage(`${item.entry.headword} 已暂停学习，可在词条页恢复。`)
      onOverview(await getDictionaryOverview())
    } catch (error) { setMessage(error instanceof Error ? error.message : '跳过失败，请重试') }
    finally { setSubmitting(false) }
  }

  async function reportWord() {
    if (!item || submitting) return
    setSubmitting(true)
    try { await updateWordStudySession(currentSession.id, 'report', item.entry.id); setMessage('词条问题已记录，后续会进入内容质量检查。') }
    catch (error) { setMessage(error instanceof Error ? error.message : '反馈失败，请重试') }
    finally { setSubmitting(false) }
  }

  if (!item || currentSession.status === 'completed') {
    const summary = currentSession.summary
    return (
      <section className="study-complete-card">
        <span className="brand-seal"><Check size={24} /></span>
        <p className="dictionary-kicker">SESSION FILED</p>
        <h2>本轮学习完成</h2>
        {summary ? (
          <>
            <div className="word-session-summary">
              <div><strong>{summary.firstPassAccuracy}%</strong><span>首次主动回忆</span></div>
              <div><strong>{summary.accuracy}%</strong><span>全部作答正确率</span></div>
              <div><strong>{summary.newLearned}</strong><span>新学词</span></div>
              <div><strong>{summary.durationMinutes} 分</strong><span>本轮用时</span></div>
            </div>
            <p>遗忘重练 {summary.lapses} 次 · 使用提示 {summary.hints} 次{summary.nextDueAt ? ` · 下次复习 ${formatNextReview(summary.nextDueAt)}` : ''}</p>
            {summary.weakWords.length ? <div className="weak-word-list"><span>本轮薄弱词</span>{summary.weakWords.map((word) => <i key={word.id}>{word.headword} · {word.meaningZh}</i>)}</div> : <p className="success-note">本轮没有遗留薄弱词。</p>}
          </>
        ) : <p>当前没有到期词或可加入的新词。</p>}
        <button className="double-border-button" type="button" onClick={onExit}><span>返回单词</span></button>
      </section>
    )
  }

  const task = activeItem ?? item
  const entry = task.entry
  const progress = currentSession.totalCount ? Math.min(100, (currentSession.currentIndex / currentSession.totalCount) * 100) : 0
  return (
    <section className="study-desk" aria-label="背单词">
      <header className="study-sticky-header">
        <button className="quiet-link" type="button" disabled={submitting} onClick={() => void pauseSession()}><ArrowLeft size={16} /> 暂停并返回</button>
        <span>{currentSession.list.shortName} · {currentSession.scope === 'review' ? '复习旧词' : currentSession.scope === 'new' ? '学习新词' : '混合学习'} · {currentSession.currentIndex + 1}/{currentSession.totalCount}</span>
      </header>
      <div className="study-progress" aria-label={`学习进度 ${Math.round(progress)}%`}><span style={{ width: `${progress}%` }} /></div>
      <p className="study-live-status" role="status" aria-live="polite">{message}</p>
      <article className={`study-word-card objective ${checked ? 'revealed' : ''}`}>
        <div className="study-card-meta">
          <span>{task.phase === 'review' ? '到期复习' : task.phase === 'retry' ? `本轮重练 ${task.attempt}` : diagnosticMode ? '熟词快测' : '新词学习'}</span>
          <strong>{WORD_MODE_LABELS[task.mode]}</strong>
        </div>
        {task.mode === 'listening' ? (
          <div className="listening-word-prompt"><Headphones size={24} /><WordSpeaker entry={entry} label="播放听写发音" /><p>先听音，再拼写</p></div>
        ) : task.mode === 'meaning' ? (
          <><h1 ref={headingRef} tabIndex={-1}>{entry.headword} <WordSpeaker entry={entry} /></h1><p className="entry-phonetics">{entry.ipa ? `/ ${entry.ipa} /` : ''} <em>{entry.partOfSpeech}</em></p></>
        ) : (
          <><p className="study-production-prompt">{task.prompt}</p>{task.mode === 'cloze' && entry.exampleZh ? <small className="cloze-translation">{entry.exampleZh}</small> : null}</>
        )}
        {task.mode !== 'meaning' && task.mode !== 'listening' ? null : <p className="study-question">{task.prompt}</p>}
        {!checked && task.phase === 'new' && item.mode === 'meaning' ? <button className="diagnostic-toggle" type="button" onClick={() => { setAnswer(''); setHintCount(0); setDiagnosticMode((value) => !value) }}>{diagnosticMode ? '返回正常学习' : '这个词早已会？做拼写快测'}</button> : null}
        <form className="study-response-form" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) setChecked(true) }}>
          <StudyPrompt item={task} answer={answer} checked={checked} onAnswer={setAnswer} />
          {!checked ? (
            <div className="study-response-actions">
              <button type="button" onClick={() => setHintCount((count) => count + 1)}><Lightbulb size={16} /> 提示{hintCount ? ` ${hintCount}` : ''}</button>
              <button type="button" onClick={() => { setAnswer(''); setChecked(true) }}>暂时不会</button>
              <button className="check-answer-button" type="submit" disabled={!answer.trim()}><Check size={16} /> 检查答案</button>
            </div>
          ) : null}
        </form>
        {!checked && hintCount > 0 ? <p className="study-hint" role="status"><Lightbulb size={15} /> {task.hint}</p> : null}
        {checked ? (
          <div className={`study-answer ${correct ? 'correct' : 'incorrect'}`}>
            <div className="answer-verdict"><strong>{correct ? '回答正确' : '这次还没想起'}</strong><span>标准答案：{task.acceptedAnswers[0]}</span></div>
            <h2>{entry.headword} <WordSpeaker entry={entry} /></h2>
            <p className="study-answer-phonetics">{entry.ipa ? `/ ${entry.ipa} /` : '音标暂缺'} {entry.partOfSpeech ? <em>{entry.partOfSpeech}</em> : null}</p>
            <p className="core-sense"><span>核心义项</span>{firstChineseSense(entry)}</p>
            {entry.roots ? <p><span>词根 / 联想</span>{entry.roots}</p> : null}
            {entry.exampleEn ? <blockquote>{entry.exampleEn}{entry.exampleZh ? <footer>{entry.exampleZh}</footer> : null}</blockquote> : null}
            {correct && diagnosticMode ? <button className="retry-later-button mastered" type="button" disabled={submitting} onClick={() => void commitRating('easy')}><Check size={17} /> 快测通过，标记为已掌握</button> : correct ? (
              <div className="rating-grid" aria-label="回忆质量">
                <button type="button" disabled={submitting} onClick={() => void commitRating('again')}><strong>1 · 猜中的</strong><span>加入重练</span></button>
                <button type="button" disabled={submitting} onClick={() => void commitRating('hard')}><strong>2 · 想起但吃力</strong><span>缩短间隔</span></button>
                <button type="button" disabled={submitting} onClick={() => void commitRating('good')}><strong>3 · 准确想起</strong><span>正常间隔</span></button>
                <button type="button" disabled={submitting} onClick={() => void commitRating('easy')}><strong>4 · 快速准确</strong><span>延长间隔</span></button>
              </div>
            ) : <button className="retry-later-button" type="button" disabled={submitting} onClick={() => void commitRating('again')}><TimerReset size={17} /> 加入本轮重学队列</button>}
          </div>
        ) : null}
        <footer className="study-card-actions" inert={submitting} aria-busy={submitting}>
          <button type="button" onClick={() => void skipWord()}>跳过此词</button>
          <button type="button" onClick={() => void reportWord()}><Flag size={14} /> 词条有误</button>
          <span><Keyboard size={14} /> 作答后可按 1—4</span>
        </footer>
      </article>
    </section>
  )
}

export default function DictionaryView({ onStudyActiveChange }: { onStudyActiveChange?: (active: boolean) => void }) {
  const [overview, setOverview] = useState<DictionaryOverview | null>(null)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [results, setResults] = useState<DictionaryEntry[]>([])
  const [selected, setSelected] = useState<DictionaryEntry | null>(null)
  const [session, setSession] = useState<WordStudySession | null>(null)
  const [activeListId, setActiveListId] = useState('')
  const [dailyNew, setDailyNew] = useState(20)
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(15)
  const [targetDate, setTargetDate] = useState('')
  const [status, setStatus] = useState('正在翻阅词库…')
  const [switchingList, setSwitchingList] = useState(false)
  const [startingStudy, setStartingStudy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const selectedIdRef = useRef<number | null>(null)
  const statusTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { window.clearTimeout(statusTimer.current); selectedIdRef.current = null }, [])

  useEffect(() => {
    let active = true
    getDictionaryOverview().then((data) => {
      if (!active) return
      setOverview(data)
      setActiveListId(data.activeListId ?? data.lists.find((list) => list.studyEnabled)?.id ?? '')
      setDailyNew(data.dailyNew)
      setDailyGoalMinutes(data.dailyGoalMinutes)
      setTargetDate(data.targetDate)
      setStatus('')
    }).catch((error) => { if (active) setStatus(error instanceof Error ? error.message : '词库读取失败') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    onStudyActiveChange?.(Boolean(session && session.status !== 'completed'))
    return () => onStudyActiveChange?.(false)
  }, [onStudyActiveChange, session?.id, session?.status])

  useEffect(() => {
    if (!deferredQuery.trim()) {
      setResults([])
      setSearching(false)
      setSearchError('')
      return
    }
    let active = true
    const controller = new AbortController()
    setSearching(true)
    setSearchError('')
    const timer = window.setTimeout(() => {
      searchDictionary(deferredQuery, controller.signal).then((data) => {
        if (active) setResults(data.entries)
      }).catch((error) => { if (active) { setResults([]); setSearchError(error instanceof Error ? error.message : '查词失败，请重试') } })
        .finally(() => { if (active) setSearching(false) })
    }, 180)
    return () => { active = false; controller.abort(); window.clearTimeout(timer) }
  }, [deferredQuery])

  const studyLists = useMemo(() => overview?.lists.filter((list) => list.studyEnabled) ?? [], [overview])
  const selectedList = useMemo(() => studyLists.find((list) => list.id === activeListId) ?? null, [activeListId, studyLists])
  const studyPlan = useMemo(() => {
    const dueBacklog = selectedList?.dueCount ?? 0
    const dueLimit = Math.min(40, Math.max(5, Math.floor((dailyGoalMinutes * 60) / 14)))
    const plannedDue = Math.min(dueBacklog, dueLimit)
    const secondsLeft = Math.max(0, dailyGoalMinutes * 60 - plannedDue * 14)
    const plannedNew = Math.min(selectedList?.availableNew ?? 0, dailyNew, Math.floor(secondsLeft / 25))
    const estimatedMinutes = Math.max(plannedDue + plannedNew > 0 ? 1 : 0, Math.ceil((plannedDue * 14 + plannedNew * 25) / 60))
    const targetTime = targetDate ? new Date(`${targetDate}T23:59:59`).getTime() : Number.NaN
    const daysToTarget = Number.isFinite(targetTime) ? Math.max(1, Math.ceil((targetTime - Date.now()) / 86_400_000)) : null
    const recommendedNew = daysToTarget ? Math.min(50, Math.ceil((selectedList?.availableNew ?? 0) / daysToTarget)) : plannedNew
    return { dueBacklog, plannedDue, plannedNew, estimatedMinutes, daysToTarget, recommendedNew }
  }, [dailyGoalMinutes, dailyNew, selectedList?.availableNew, selectedList?.dueCount, targetDate])

  async function selectEntry(entry: DictionaryEntry) {
    selectedIdRef.current = entry.id
    setSelected(entry)
    setResults([])
    try { const detail = await getDictionaryEntry(entry.id); if (selectedIdRef.current === entry.id) setSelected(detail) } catch { /* keep search summary */ }
  }

  async function startStudy(scope: 'review' | 'new') {
    if (!activeListId || startingStudy || switchingList) return
    window.clearTimeout(statusTimer.current)
    setStartingStudy(true)
    setStatus('正在整理今日词卡…')
    try {
      const nextOverview = await saveWordPreference(activeListId, dailyNew, dailyGoalMinutes, targetDate)
      setOverview(nextOverview)
      setSession(await getWordStudySession(activeListId, scope))
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
      setStatus('')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '无法开始背词')
    } finally {
      setStartingStudy(false)
    }
  }

  async function switchWordList(nextListId: string) {
    if (!nextListId || nextListId === activeListId || switchingList || startingStudy) return
    window.clearTimeout(statusTimer.current)
    const previousListId = activeListId
    setActiveListId(nextListId)
    setSwitchingList(true)
    setStatus('正在切换词书…')
    try {
      const nextOverview = await saveWordPreference(nextListId, dailyNew, dailyGoalMinutes, targetDate)
      setOverview(nextOverview)
      const nextList = nextOverview.lists.find((list) => list.id === nextListId)
      setStatus(`已切换到：${nextList?.shortName ?? '新词书'}`)
      statusTimer.current = window.setTimeout(() => setStatus(''), 2_400)
    } catch (error) {
      setActiveListId(previousListId)
      setStatus(error instanceof Error ? error.message : '词书切换失败，请重试')
    } finally {
      setSwitchingList(false)
    }
  }

  async function exitStudy() {
    setSession(null)
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
    try { setOverview(await getDictionaryOverview()) } catch (error) { setStatus(error instanceof Error ? error.message : '学习已暂存，词库更新失败，请重新进入单词页') }
  }

  if (session) return <StudyDesk session={session} onExit={() => void exitStudy()} onOverview={setOverview} />

  return (
    <div className="dictionary-view">
      <section className="dictionary-masthead">
        <div>
          <p className="folio-number">LEXICON</p>
          <span className="dictionary-kicker">PERSONAL WORD ARCHIVE · VOL. 01</span>
          <h1>单词档案馆</h1>
          <p>查词、听音并开始今日背词；学习记录保存在本机数据库。</p>
        </div>
        <LibraryBig size={78} strokeWidth={0.8} aria-hidden="true" />
      </section>

      <section className="dictionary-stats" aria-label="词库统计">
        <div><strong>{overview?.totalCount.toLocaleString() ?? '—'}</strong><span>查词总库</span></div>
        <div><strong>{overview?.phraseCount.toLocaleString() ?? '—'}</strong><span>词组 / 搭配</span></div>
        <div><strong>{overview?.dueCount ?? '—'}</strong><span>今日待复习</span></div>
        <div><strong>{overview?.masteredCount ?? '—'}</strong><span>已掌握</span></div>
      </section>

      <section className="dictionary-search-panel">
        <label htmlFor="dictionary-search"><Search size={20} /><span>查词</span></label>
        <input id="dictionary-search" aria-label="查词" aria-busy={searching} value={query} onChange={(event) => { setQuery(event.target.value); setSearching(Boolean(event.target.value.trim())) }} placeholder="输入英文、词组或中文释义…" autoComplete="off" />
        {searching ? <p className="search-empty" role="status">正在查词…</p> : searchError ? <p className="search-empty" role="alert">{searchError}</p> : results.length ? (
          <div className="dictionary-search-results">
            {results.map((entry) => (
              <button key={entry.id} type="button" onClick={() => void selectEntry(entry)}>
                <span><strong>{entry.headword}</strong><em>{entry.ipa} · {entry.partOfSpeech}</em></span>
                <span>{entry.meaningZh || entry.definitionEn}</span>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
        ) : query.trim() && selected?.normalized !== query.trim().toLowerCase() ? <p className="search-empty">未找到匹配词条，请检查拼写。</p> : null}
      </section>

      {selected ? <EntryDetails key={selected.id} entry={selected} onChanged={(entry, nextOverview) => { setSelected(entry); setOverview(nextOverview) }} /> : null}

      <section className="word-start-section" aria-label="开始今日背词">
        <header className="section-heading-row"><div><span>01 / TODAY'S WORDS</span><h2>今日背词</h2></div><p>可在这里切换词书；时间与新词上限在“我的 → 背词偏好”中调整。</p></header>
        <div className="word-start-card">
          <div className="word-start-book">
            <BookMarked size={22} />
            <span>当前词书</span>
            <label className="word-book-switch">
              <span className="sr-only">切换背词词书</span>
              <select aria-label="切换背词词书" value={activeListId} disabled={switchingList || startingStudy || !studyLists.length} onChange={(event) => void switchWordList(event.target.value)}>
                {studyLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select>
            </label>
            <small>到期 {studyPlan.plannedDue} · 新词 {studyPlan.plannedNew} · 预计 {studyPlan.estimatedMinutes} 分钟</small>
          </div>
          <div className="word-start-summary" aria-label="今日词汇学习计划">
            <span><Target size={16} /> 先复习到期词</span>
            <span><Clock3 size={16} /> 今日 {dailyGoalMinutes} 分钟</span>
            {targetDate ? <span>目标 {targetDate}</span> : null}
          </div>
          <div className="word-start-options" aria-label="选择背词方式">
            <button className="word-start-option review" type="button" onClick={() => void startStudy('review')} disabled={startingStudy || switchingList || !activeListId || studyPlan.plannedDue === 0}>
              <span><TimerReset size={20} /> REVIEW</span>
              <strong>{studyPlan.plannedDue ? '复习旧词' : '今日已复习完成'}</strong>
              <small>{studyPlan.plannedDue} 个到期词 · 约 {Math.max(studyPlan.plannedDue ? 1 : 0, Math.ceil(studyPlan.plannedDue * 14 / 60))} 分钟</small>
            </button>
            <button className="word-start-option new" type="button" onClick={() => void startStudy('new')} disabled={startingStudy || switchingList || !activeListId || studyPlan.plannedNew === 0}>
              <span><Play size={20} /> NEW WORDS</span>
              <strong>{studyPlan.plannedNew ? '学习新词' : '暂无可学新词'}</strong>
              <small>{studyPlan.plannedNew} 个新词 · 约 {Math.max(studyPlan.plannedNew ? 1 : 0, Math.ceil(studyPlan.plannedNew * 25 / 60))} 分钟</small>
            </button>
          </div>
        </div>
      </section>
      {status ? <p className="dictionary-status" role="status">{status}</p> : null}
    </div>
  )
}
