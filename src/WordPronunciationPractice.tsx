import { Mic, Square, Volume2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { assessWordPronunciation } from './lib/api'
import { convertRecordingToTencentWav, preferredRecordingOptions } from './lib/audio'
import { beginRecordingSession, endRecordingSession, registerAudioSession, requestAudioPlayback } from './lib/audio-session'
import type { DictionaryEntry, GradingFeedback } from './types'

interface WordPronunciationPracticeProps {
  available: boolean
  entry: DictionaryEntry
  studySessionId: string
}

export default function WordPronunciationPractice({ available, entry, studySessionId }: WordPronunciationPracticeProps) {
  const audioSessionId = useId()
  const [recording, setRecording] = useState(false)
  const [audioUrl, setAudioUrl] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<(GradingFeedback & { score: number; correct: boolean }) | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const playbackRef = useRef<HTMLAudioElement | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioBlobRef = useRef<Blob | null>(null)

  useEffect(() => registerAudioSession(audioSessionId, () => playbackRef.current?.pause()), [audioSessionId])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    endRecordingSession(audioSessionId)
  }, [audioSessionId])

  useEffect(() => {
    setResult(null)
    setError('')
    setStatus('')
    audioBlobRef.current = null
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return ''
    })
  }, [entry.id])

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl)
  }, [audioUrl])

  function clearRecording() {
    playbackRef.current?.pause()
    audioBlobRef.current = null
    setAudioUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous)
      return ''
    })
    setStatus('')
    setError('')
  }

  async function startRecording() {
    setError('')
    setResult(null)
    try {
      if (!window.isSecureContext) throw new Error('麦克风需要 HTTPS 安全地址；本机 localhost 可直接使用。')
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持网页录音。')
      beginRecordingSession(audioSessionId)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      clearRecording()
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
        setAudioUrl((previous) => {
          if (previous) URL.revokeObjectURL(previous)
          return URL.createObjectURL(blob)
        })
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null
        endRecordingSession(audioSessionId)
        setStatus('录音已就绪，可以回听或提交发音评测。')
      }
      recorder.start()
      setRecording(true)
      setStatus(`录音中，请读：${entry.headword}`)
    } catch (recordingError) {
      endRecordingSession(audioSessionId)
      setError(recordingError instanceof Error ? recordingError.message : '无法使用麦克风。')
    }
  }

  function stopRecording() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function submitRecording() {
    const blob = audioBlobRef.current
    if (!blob) return
    setSubmitting(true)
    setError('')
    setStatus('正在分析重音、准确度和音素…')
    try {
      const converted = await convertRecordingToTencentWav(blob)
      const nextResult = await assessWordPronunciation(entry.id, studySessionId, converted.dataUrl)
      setResult(nextResult)
      setStatus('发音评测完成。')
    } catch (assessmentError) {
      setError(assessmentError instanceof Error ? assessmentError.message : '单词发音评测失败。')
      setStatus('')
    } finally {
      setSubmitting(false)
    }
  }

  if (!available) return <p className="word-pronunciation-unavailable">云端发音评测未配置；仍可使用词卡发音进行跟读。</p>

  return (
    <section className="word-pronunciation" aria-label={`${entry.headword} 发音练习`}>
      <header><span>发音迁移</span><strong>跟读这个词</strong></header>
      <div className="word-pronunciation-actions">
        <button type="button" className={recording ? 'recording' : ''} onClick={recording ? stopRecording : startRecording} disabled={submitting}>
          {recording ? <Square size={15} fill="currentColor" /> : <Mic size={17} />}
          {recording ? '结束录音' : audioUrl ? '重新录音' : '开始录音'}
        </button>
        {audioUrl && !recording ? <button type="button" onClick={clearRecording} disabled={submitting}><X size={15} /> 清除</button> : null}
      </div>
      {audioUrl ? (
        <div className="word-recording-review">
          <Volume2 size={16} />
          <audio ref={playbackRef} controls src={audioUrl} onPlay={(event) => { if (!requestAudioPlayback(audioSessionId)) event.currentTarget.pause() }} />
          <button type="button" onClick={() => void submitRecording()} disabled={submitting}>{submitting ? '评测中…' : '提交评测'}</button>
        </div>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert" className="word-pronunciation-error">{error}</p> : null}
      {result ? (
        <div className="word-pronunciation-result">
          <strong>{Math.round(result.score)}<small>/100</small></strong>
          <p>{result.summary}</p>
          {result.words?.[0]?.phones?.length ? <div>{result.words[0].phones.slice(0, 8).map((phone, index) => <span key={`${phone.phone}-${index}`}>{phone.referencePhone || phone.phone} · {Math.round(phone.accuracy)}</span>)}</div> : null}
        </div>
      ) : null}
    </section>
  )
}
