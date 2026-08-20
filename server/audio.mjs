import {
  assessTencentPronunciation,
  splitSpeechText,
  synthesizeTencentSpeech,
  tencentCapabilities,
  transcribeTencentAudio,
} from './tencent-cloud.mjs'

export function audioCapabilities() {
  return tencentCapabilities()
}

export function createSpeechManifest(lesson, rate = 1) {
  const normalizedRate = [0.75, 1, 1.25].includes(Number(rate)) ? Number(rate) : 1
  const article = splitSpeechText(lesson.body).map((text, index) => ({
    index,
    text,
    url: `/api/audio/speech?lessonId=${encodeURIComponent(lesson.id)}&kind=article&part=${index}&rate=${normalizedRate}`,
  }))
  const vocabulary = lesson.vocabulary.map((item) => ({
    term: item.term,
    url: `/api/audio/speech?lessonId=${encodeURIComponent(lesson.id)}&kind=vocabulary&term=${encodeURIComponent(item.term)}&rate=1`,
  }))
  return { provider: 'tencent', rate: normalizedRate, article, vocabulary }
}

export function resolveSpeechRequest(lesson, { kind = 'article', part = 0, term = '', rate = 1 }) {
  if (kind === 'vocabulary') {
    const item = lesson.vocabulary.find((candidate) => candidate.term.toLowerCase() === String(term).toLowerCase())
    if (!item) throw new Error('未找到对应重点词')
    return { text: item.term, rate: 1 }
  }
  const chunks = splitSpeechText(lesson.body)
  const index = Math.max(0, Number(part) || 0)
  if (!chunks[index]) throw new Error('未找到对应朗读分段')
  return { text: chunks[index], rate }
}

export async function synthesizeSpeech(request) {
  return synthesizeTencentSpeech(request.text, request)
}

export async function transcribeAudio(request) {
  return transcribeTencentAudio(request)
}

export async function assessPronunciation(request) {
  return assessTencentPronunciation(request)
}
