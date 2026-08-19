import { createHash } from 'node:crypto'

function decodeDataUrl(dataUrl, fallbackMimeType = 'audio/webm') {
  const match = String(dataUrl ?? '').match(/^data:([^;,]+)?;base64,([a-z0-9+/=]+)$/iu)
  if (!match) throw new Error('录音数据格式不正确')
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > 8 * 1024 * 1024) throw new Error('录音大小需在 8MB 以内')
  return { buffer, mimeType: match[1] || fallbackMimeType }
}

function extensionFor(mimeType) {
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('wav')) return 'wav'
  return 'webm'
}

export function audioCapabilities() {
  return {
    cloudTranscription: Boolean(process.env.OPENAI_API_KEY),
    cloudSpeech: Boolean(process.env.OPENAI_API_KEY),
    transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe',
    speechModel: process.env.OPENAI_TTS_MODEL ?? 'tts-1',
    speechVoice: process.env.OPENAI_TTS_VOICE ?? 'alloy',
  }
}

export async function transcribeAudio({ dataUrl, language = 'en' }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const error = new Error('云端转写未配置；已保留浏览器语音识别和手动文本降级。')
    error.statusCode = 503
    throw error
  }

  const { buffer, mimeType } = decodeDataUrl(dataUrl)
  const model = process.env.OPENAI_TRANSCRIBE_MODEL ?? 'gpt-4o-transcribe'
  const form = new FormData()
  form.append('model', model)
  form.append('language', String(language).slice(0, 8))
  form.append('response_format', 'json')
  form.append('file', new Blob([buffer], { type: mimeType }), `recording.${extensionFor(mimeType)}`)
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`语音转写服务返回 HTTP ${response.status}`)
  const result = await response.json()
  if (!String(result.text ?? '').trim()) throw new Error('语音转写没有返回文本')
  return {
    transcript: String(result.text).trim(),
    provider: 'openai',
    model,
    audioHash: createHash('sha256').update(buffer).digest('hex'),
  }
}

export async function synthesizeSpeech({ text, voice, speed }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const error = new Error('云端朗读未配置；请使用浏览器内置美式朗读。')
    error.statusCode = 503
    throw error
  }
  const model = process.env.OPENAI_TTS_MODEL ?? 'tts-1'
  const selectedVoice = voice || process.env.OPENAI_TTS_VOICE || 'alloy'
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      voice: selectedVoice,
      input: String(text ?? '').slice(0, 4_000),
      response_format: 'mp3',
      speed: Math.min(4, Math.max(0.25, Number(speed) || 1)),
    }),
    signal: AbortSignal.timeout(45_000),
  })
  if (!response.ok) throw new Error(`语音合成服务返回 HTTP ${response.status}`)
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'audio/mpeg',
    model,
    voice: selectedVoice,
  }
}
