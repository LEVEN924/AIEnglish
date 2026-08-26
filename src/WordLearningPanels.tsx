import { BookMarked, Check, Clock3, Headphones, Save, Target, TimerReset, TrendingUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { getDictionaryOverview, getWordWeeklyReport, saveWordPreference } from './lib/api'
import type { DictionaryOverview, WordWeeklyReport } from './types'

const MINIMUM_TARGET_DATE = new Date().toISOString().slice(0, 10)

export function WordLearningPreferences() {
  const [overview, setOverview] = useState<DictionaryOverview | null>(null)
  const [activeListId, setActiveListId] = useState('')
  const [dailyNew, setDailyNew] = useState(20)
  const [dailyGoalMinutes, setDailyGoalMinutes] = useState(15)
  const [targetDate, setTargetDate] = useState('')
  const [status, setStatus] = useState('正在读取背词设置…')
  const [saving, setSaving] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    setLoading(true)
    void getDictionaryOverview(controller.signal).then((data) => {
      if (!active) return
      setOverview(data)
      setActiveListId(data.activeListId ?? data.lists.find((list) => list.studyEnabled)?.id ?? '')
      setDailyNew(data.dailyNew)
      setDailyGoalMinutes(data.dailyGoalMinutes)
      setTargetDate(data.targetDate)
      setStatus('')
    }).catch((error) => {
      if (active) setStatus(error instanceof Error ? error.message : '背词设置读取失败')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false; controller.abort() }
  }, [loadAttempt])

  const studyLists = useMemo(() => overview?.lists.filter((list) => list.studyEnabled) ?? [], [overview])
  const selectedList = useMemo(() => studyLists.find((list) => list.id === activeListId) ?? null, [activeListId, studyLists])

  async function saveSettings() {
    if (!activeListId || saving || !overview) return
    setSaving(true)
    setStatus('正在保存背词设置…')
    try {
      const nextOverview = await saveWordPreference(activeListId, dailyNew, dailyGoalMinutes, targetDate)
      setOverview(nextOverview)
      setStatus(`已保存 · 当前词书：${nextOverview.lists.find((list) => list.id === activeListId)?.shortName ?? '已选择词书'}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '背词设置保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="profile-word-settings" aria-label="背词偏好" aria-busy={loading || saving}>
      <header>
        <div><span>WORD LEARNING</span><h2>背词偏好</h2></div>
        <p>选择词书，并设置每天用于背词的时间与新词上限。</p>
      </header>

      <fieldset className="preference-fields" disabled={!overview || loading || saving}>
      {overview?.currentArticle ? (
        <button className="profile-article-wordbook" type="button" onClick={() => setActiveListId('article-vocabulary')}>
          <BookMarked size={19} />
          <span><small>当前文章重点词</small><strong>{overview.currentArticle.titleZh}</strong><em>{overview.currentArticle.wordCount} 个重点词</em></span>
          {activeListId === 'article-vocabulary' ? <Check size={18} /> : null}
        </button>
      ) : null}

      {overview ? (
        <div className="wordbook-grid profile-wordbook-grid">
          {studyLists.map((list) => (
            <button key={list.id} className={activeListId === list.id ? 'selected' : ''} type="button" onClick={() => setActiveListId(list.id)}>
              <span className="book-spine">{list.shortName}</span>
              <span className="book-copy">
                <em>{list.edition}{overview.recommendedListId === list.id ? ` · ${overview.targetExam || '当前课程'}推荐` : ''}</em>
                <strong>{list.name}</strong>
                <small>{list.description}</small>
                <b>{list.entryCount.toLocaleString()} 条 · 已学 {list.learnedCount.toLocaleString()} · 掌握 {list.masteredCount.toLocaleString()}</b>
                <i><span style={{ width: `${list.entryCount ? Math.min(100, (list.masteredCount / list.entryCount) * 100) : 0}%` }} /></i>
              </span>
              {activeListId === list.id ? <Check size={18} /> : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="profile-word-controls">
        <label><span><Clock3 size={15} /> 今日时间</span><select value={dailyGoalMinutes} onChange={(event) => setDailyGoalMinutes(Number(event.target.value))}><option value={5}>5 分钟</option><option value={10}>10 分钟</option><option value={15}>15 分钟</option><option value={20}>20 分钟</option><option value={30}>30 分钟</option><option value={45}>45 分钟</option></select></label>
        <label><span><BookMarked size={15} /> 新词上限</span><select value={dailyNew} onChange={(event) => setDailyNew(Number(event.target.value))}><option value={5}>5 个</option><option value={10}>10 个</option><option value={20}>20 个</option><option value={30}>30 个</option><option value={50}>50 个</option></select></label>
        <label><span><Target size={15} /> 目标日期</span><input type="date" value={targetDate} min={MINIMUM_TARGET_DATE} onChange={(event) => setTargetDate(event.target.value)} /></label>
        <button className="double-border-button" type="button" disabled={saving || !selectedList} onClick={() => void saveSettings()}><span><Save size={16} /> {saving ? '保存中…' : '保存背词设置'}</span></button>
      </div>
      </fieldset>
      {status ? <p className="profile-word-status" role="status">{status}</p> : null}
      {!overview && !loading ? <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>重新读取设置</button> : null}
    </section>
  )
}

export function WordWeeklyReportPanel() {
  const [report, setReport] = useState<WordWeeklyReport | null>(null)
  const [status, setStatus] = useState('正在生成七日词汇报告…')

  useEffect(() => {
    let active = true
    void getWordWeeklyReport().then((data) => {
      if (!active) return
      setReport(data)
      setStatus('')
    }).catch((error) => {
      if (active) setStatus(error instanceof Error ? error.message : '七日词汇报告读取失败')
    })
    return () => { active = false }
  }, [])

  return (
    <section className="word-weekly-report review-word-report" aria-label="七日词汇报告">
      <header><div><span>WORD RETENTION</span><h2>七日词汇报告</h2></div><p>{report ? `${report.periodStart} — ${report.periodEnd}` : '最近七天'}</p></header>
      <div className="word-report-metrics">
        <div><TrendingUp size={18} /><strong>{report?.activeRecallAccuracy ?? 0}%</strong><span>主动回忆保持率</span></div>
        <div><Check size={18} /><strong>{report?.accuracy ?? 0}%</strong><span>全部题型正确率</span></div>
        <div><TimerReset size={18} /><strong>{report?.reviewDebt ?? 0}</strong><span>当前复习债务</span></div>
        <div><Headphones size={18} /><strong>{report?.pronunciationAverage || '—'}</strong><span>发音平均分</span></div>
      </div>
      {report?.weakWords.length ? <div className="weekly-weak-words"><span>本周需要再见面的词</span>{report.weakWords.map((word) => <i key={word.id}>{word.headword}<small>{word.errors} 次错误</small></i>)}</div> : null}
      {status ? <p className="dictionary-status" role="status">{status}</p> : report?.attempts === 0 ? <p className="dictionary-status">完成背词后，这里会显示例句填空、听写、主动回忆和发音趋势。</p> : null}
    </section>
  )
}
