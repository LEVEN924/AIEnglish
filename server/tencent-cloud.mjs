import { createHash, createHmac, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const audioCacheDirectory = join(root, 'data', 'audio-cache')
const contentType = 'application/json; charset=utf-8'

function configuredCredentials() {
  return {
    appId: String(process.env.TENCENTCLOUD_APP_ID ?? '').trim(),
    secretId: String(process.env.TENCENTCLOUD_SECRET_ID ?? '').trim(),
    secretKey: String(process.env.TENCENTCLOUD_SECRET_KEY ?? '').trim(),
    region: String(process.env.TENCENTCLOUD_REGION ?? 'ap-guangzhou').trim(),
  }
}

function requireCredentials({ requireAppId = false } = {}) {
  const credentials = configuredCredentials()
  if (!credentials.secretId || !credentials.secretKey || (requireAppId && !credentials.appId)) {
    const error = new Error(requireAppId
      ? '腾讯云语音尚未配置，请填写 AppID、SecretId 和 SecretKey。'
      : '腾讯云服务尚未配置，请填写 SecretId 和 SecretKey。')
    error.statusCode = 503
    throw error
  }
  return credentials
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function utcDate(timestamp) {
  return new Date(timestamp * 1_000).toISOString().slice(0, 10)
}

export function createTc3Headers({ service, host, action, version, payload, region = '', timestamp = Math.floor(Date.now() / 1_000), secretId, secretKey }) {
  const date = utcDate(timestamp)
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`
  const signedHeaders = 'content-type;host'
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join('\n')
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n')
  const secretDate = hmac(`TC3${secretKey}`, date)
  const secretService = hmac(secretDate, service)
  const secretSigning = hmac(secretService, 'tc3_request')
  const signature = hmac(secretSigning, stringToSign, 'hex')
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return {
    Authorization: authorization,
    'Content-Type': contentType,
    Host: host,
    'X-TC-Action': action,
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': version,
    ...(region ? { 'X-TC-Region': region } : {}),
  }
}

async function callTencentApi({ service, host, action, version, body, region = '' }) {
  const { secretId, secretKey } = requireCredentials()
  const payload = JSON.stringify(body)
  const headers = createTc3Headers({ service, host, action, version, payload, region, secretId, secretKey })
  const response = await fetch(`https://${host}`, {
    method: 'POST',
    headers,
    body: payload,
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`腾讯云 ${service.toUpperCase()} 返回 HTTP ${response.status}`)
  const data = await response.json()
  const result = data.Response ?? data
  if (result.Error) {
    const error = new Error(`腾讯云 ${result.Error.Code}：${result.Error.Message}`)
    error.providerCode = result.Error.Code
    throw error
  }
  return result
}

export function tencentCapabilities() {
  const credentials = configuredCredentials()
  const apiConfigured = Boolean(credentials.secretId && credentials.secretKey)
  const oralConfigured = Boolean(apiConfigured && credentials.appId)
  return {
    provider: 'tencent',
    cloudSpeech: apiConfigured,
    cloudTranscription: apiConfigured,
    oralAssessment: oralConfigured,
    cloudTranslation: apiConfigured,
    speechModel: 'tencent-text-to-voice',
    speechVoice: String(process.env.TENCENT_TTS_VOICE_TYPE ?? '101050'),
    transcriptionModel: String(process.env.TENCENT_ASR_ENGINE ?? '16k_en'),
    assessmentModel: 'tencent-soe-new-16k-en',
    assessmentStrictness: Number(process.env.TENCENT_SOE_SCORE_COEFF ?? 4),
  }
}

function englishWords(value) {
  return String(value).match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []
}

export function splitSpeechText(text, maximumCharacters = 440) {
  const sentences = String(text).match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [String(text)]
  const chunks = []
  let current = ''
  for (const rawSentence of sentences) {
    const sentence = rawSentence.replace(/\s+/gu, ' ').trim()
    if (!sentence) continue
    if (`${current} ${sentence}`.trim().length <= maximumCharacters) {
      current = `${current} ${sentence}`.trim()
      continue
    }
    if (current) chunks.push(current)
    if (sentence.length <= maximumCharacters) {
      current = sentence
      continue
    }
    const words = sentence.split(/\s+/u)
    current = ''
    for (const word of words) {
      if (`${current} ${word}`.trim().length > maximumCharacters) {
        if (current) chunks.push(current)
        current = word
      } else current = `${current} ${word}`.trim()
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function splitAssessmentReference(text, maximumWords = 118) {
  const sentences = String(text).match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [String(text)]
  const totalWords = englishWords(text).length
  if (totalWords <= maximumWords) return [String(text).replace(/\s+/gu, ' ').trim()].filter(Boolean)
  if (totalWords > maximumWords * 2) {
    const words = String(text).replace(/\s+/gu, ' ').trim().split(' ')
    const chunkCount = Math.ceil(totalWords / maximumWords)
    const chunkSize = Math.ceil(words.length / chunkCount)
    return Array.from({ length: chunkCount }, (_, index) => words.slice(index * chunkSize, (index + 1) * chunkSize).join(' ')).filter(Boolean)
  }
  const minimumFirstWords = totalWords - maximumWords
  const target = totalWords / 2
  let cumulative = 0
  let bestBoundary = null
  for (let index = 0; index < sentences.length - 1; index += 1) {
    cumulative += englishWords(sentences[index]).length
    if (cumulative >= minimumFirstWords && cumulative <= maximumWords) {
      if (!bestBoundary || Math.abs(cumulative - target) < Math.abs(bestBoundary.words - target)) {
        bestBoundary = { index: index + 1, words: cumulative }
      }
    }
  }
  if (bestBoundary) {
    return [sentences.slice(0, bestBoundary.index).join(' '), sentences.slice(bestBoundary.index).join(' ')]
      .map((chunk) => chunk.replace(/\s+/gu, ' ').trim())
      .filter(Boolean)
  }
  const words = String(text).replace(/\s+/gu, ' ').trim().split(' ')
  const boundary = Math.ceil(words.length / 2)
  return [words.slice(0, boundary).join(' '), words.slice(boundary).join(' ')]
}

function speedToTencent(rate) {
  const numeric = Number(rate) || 1
  if (numeric <= 0.8) return -1
  if (numeric >= 1.2) return 1
  return 0
}

export async function synthesizeTencentSpeech(text, { rate = 1, voiceType } = {}) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (!value) throw new Error('朗读文本不能为空')
  if (value.length > 500) throw new Error('单次腾讯云英文朗读文本不能超过500个字符')
  const voice = Number(voiceType ?? process.env.TENCENT_TTS_VOICE_TYPE ?? 101050)
  const speed = speedToTencent(rate)
  const cacheKey = sha256(JSON.stringify({ provider: 'tencent', action: 'TextToVoice', value, voice, speed }))
  const cachePath = join(audioCacheDirectory, `${cacheKey}.mp3`)
  try {
    return { buffer: await readFile(cachePath), contentType: 'audio/mpeg', provider: 'tencent', model: 'TextToVoice', voice: String(voice), cacheHit: true }
  } catch {
    // Generate and persist the immutable asset below.
  }
  const result = await callTencentApi({
    service: 'tts',
    host: 'tts.tencentcloudapi.com',
    action: 'TextToVoice',
    version: '2019-08-23',
    body: {
      Text: value,
      SessionId: randomUUID(),
      Volume: 0,
      Speed: speed,
      ModelType: Number(process.env.TENCENT_TTS_MODEL_TYPE ?? 1),
      VoiceType: voice,
      PrimaryLanguage: 2,
      SampleRate: 16000,
      Codec: 'mp3',
      EnableSubtitle: false,
    },
  })
  const buffer = Buffer.from(result.Audio ?? '', 'base64')
  if (!buffer.length) throw new Error('腾讯云语音合成未返回音频')
  await mkdir(audioCacheDirectory, { recursive: true })
  await writeFile(cachePath, buffer)
  return { buffer, contentType: 'audio/mpeg', provider: 'tencent', model: 'TextToVoice', voice: String(voice), cacheHit: false }
}

function decodeAudioDataUrl(dataUrl) {
  const match = String(dataUrl ?? '').match(/^data:([^;,]+)?;base64,([a-z0-9+/=]+)$/iu)
  if (!match) throw new Error('录音数据格式不正确')
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > 12 * 1024 * 1024) throw new Error('录音大小需在12MB以内')
  return { buffer, mimeType: match[1] || 'audio/wav' }
}

function voiceFormat(mimeType) {
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg-opus'
  return 'wav'
}

export async function transcribeTencentAudio({ dataUrl, language = 'en' }) {
  const { buffer, mimeType } = decodeAudioDataUrl(dataUrl)
  const model = language === 'en' ? String(process.env.TENCENT_ASR_ENGINE ?? '16k_en') : '16k_zh'
  const result = await callTencentApi({
    service: 'asr',
    host: 'asr.tencentcloudapi.com',
    action: 'SentenceRecognition',
    version: '2019-06-14',
    body: {
      EngSerViceType: model,
      SourceType: 1,
      VoiceFormat: voiceFormat(mimeType),
      Data: buffer.toString('base64'),
      DataLen: buffer.length,
      WordInfo: 2,
      FilterDirty: 0,
      FilterModal: 0,
      FilterPunc: 0,
      ConvertNumMode: 1,
    },
  })
  const transcript = String(result.Result ?? '').trim()
  if (!transcript) throw new Error('腾讯云语音识别没有返回文本')
  return {
    transcript,
    provider: 'tencent-asr',
    model,
    durationMs: Number(result.AudioDuration) || null,
    words: result.WordList ?? [],
    audioHash: sha256(buffer),
  }
}

export async function translateTencentText(text) {
  const value = String(text ?? '').trim()
  if (!value) throw new Error('翻译文本不能为空')
  const { region } = requireCredentials()
  const result = await callTencentApi({
    service: 'tmt',
    host: 'tmt.tencentcloudapi.com',
    action: 'TextTranslate',
    version: '2018-03-21',
    region,
    body: { SourceText: value, Source: 'en', Target: 'zh', ProjectId: 0 },
  })
  const translation = String(result.TargetText ?? '').trim()
  if (!translation) throw new Error('腾讯云机器翻译没有返回参考译文')
  return translation
}

function extractPcmFromWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('口语评测需要16kHz、16位、单声道 WAV 录音')
  }
  let offset = 12
  let format = null
  let pcm = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      }
    }
    if (chunkId === 'data') pcm = buffer.subarray(start, Math.min(start + chunkSize, buffer.length))
    offset = start + chunkSize + (chunkSize % 2)
  }
  if (!format || !pcm || format.audioFormat !== 1 || format.channels !== 1 || format.sampleRate !== 16000 || format.bitsPerSample !== 16) {
    throw new Error('录音转换失败：腾讯智聆要求16kHz、16位、单声道 PCM/WAV')
  }
  return pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm
}

function buildSoeParameters(referenceText, voiceId) {
  const { appId, secretId, secretKey } = requireCredentials({ requireAppId: true })
  const timestamp = Math.floor(Date.now() / 1_000)
  const parameters = {
    eval_mode: 2,
    expired: timestamp + 3_600,
    nonce: Math.floor(100_000_000 + Math.random() * 899_999_999),
    rec_mode: 0,
    ref_text: referenceText,
    score_coeff: Math.min(4, Math.max(1, Number(process.env.TENCENT_SOE_SCORE_COEFF ?? 4))),
    secretid: secretId,
    sentence_info_enabled: 1,
    server_engine_type: '16k_en',
    text_mode: 0,
    timestamp,
    voice_format: 0,
    voice_id: voiceId,
  }
  const query = Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join('&')
  const unsigned = `soe.cloud.tencent.com/soe/api/${appId}?${query}`
  const signature = createHmac('sha1', secretKey).update(unsigned).digest('base64')
  const encodedQuery = new URLSearchParams({ ...parameters, signature }).toString()
  return `wss://soe.cloud.tencent.com/soe/api/${appId}?${encodedQuery}`
}

export function createSoeWebSocketUrl(referenceText, voiceId = randomUUID()) {
  return buildSoeParameters(referenceText, voiceId)
}

function normalizeSoeResult(result) {
  if (!result) return null
  if (typeof result === 'object') return result
  try { return JSON.parse(result) } catch { return null }
}

function streamAssessment(pcm, referenceText, segmentIndex) {
  const voiceId = `${randomUUID()}-${segmentIndex}`
  const url = buildSoeParameters(referenceText, voiceId)
  const durationMs = pcm.length / 32
  const timeoutMs = Math.max(45_000, durationMs + 45_000)
  return new Promise((resolveAssessment, rejectAssessment) => {
    const socket = new WebSocket(url)
    let timer = null
    let sendTimer = null
    let started = false
    let lastResult = null
    let settled = false

    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (sendTimer) clearInterval(sendTimer)
      try { socket.close() } catch { /* Already closed. */ }
      if (error) rejectAssessment(error)
      else resolveAssessment(value)
    }

    timer = setTimeout(() => finish(new Error('腾讯智聆口语评测超时，请检查网络后重试')), timeoutMs)
    socket.addEventListener('error', () => finish(new Error('无法连接腾讯智聆口语评测服务')))
    socket.addEventListener('close', () => {
      if (!settled && !lastResult) finish(new Error('腾讯智聆口语评测连接提前关闭'))
    })
    socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (Number(message.code) !== 0) {
        finish(new Error(`腾讯智聆 ${message.code}：${message.message || '评测失败'}`))
        return
      }
      const normalized = normalizeSoeResult(message.result)
      if (normalized) lastResult = normalized
      if (!started && message.message === 'success') {
        started = true
        let offset = 0
        const chunkBytes = 1_280
        sendTimer = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return
          if (offset >= pcm.length) {
            clearInterval(sendTimer)
            sendTimer = null
            socket.send(JSON.stringify({ type: 'end' }))
            return
          }
          const end = Math.min(offset + chunkBytes, pcm.length)
          socket.send(pcm.subarray(offset, end))
          offset = end
        }, 40)
      }
      if (Number(message.final) === 1) {
        if (!lastResult) finish(new Error('腾讯智聆没有返回可用的评测结果'))
        else finish(null, lastResult)
      }
    })
  })
}

function percent(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) return 0
  return Math.min(100, numeric <= 1 ? numeric * 100 : numeric)
}

function wordDetails(results) {
  return results.flatMap((result, segmentIndex) => (result.Words ?? []).map((word) => ({
    segment: segmentIndex + 1,
    word: String(word.Word ?? ''),
    referenceWord: String(word.ReferenceWord ?? word.Word ?? ''),
    accuracy: percent(word.PronAccuracy),
    fluency: percent(word.PronFluency),
    matchTag: Number(word.MatchTag ?? word.Tag ?? 0),
    phones: (word.PhoneInfos ?? word.PhoneInfo ?? []).map((phone) => ({
      phone: String(phone.Phone ?? ''),
      referencePhone: String(phone.ReferencePhone ?? ''),
      accuracy: percent(phone.PronAccuracy),
    })),
  }))).filter((word) => word.word || word.referenceWord)
}

function transcriptFromWords(words) {
  const spoken = words.filter((word) => word.matchTag !== 2 && word.word && word.word !== '*').map((word) => word.word)
  return spoken.join(' ').replace(/\s+([,.!?;:])/gu, '$1').trim()
}

function quietBoundary(pcm, expectedOffset, previousOffset, remainingSegments) {
  const bytesPerSecond = 32_000
  const windowBytes = 3_200
  const searchRadius = Math.min(bytesPerSecond * 4, Math.floor(pcm.length * 0.12))
  const minimum = Math.max(previousOffset + bytesPerSecond * 2, expectedOffset - searchRadius)
  const maximum = Math.min(pcm.length - remainingSegments * bytesPerSecond * 2, expectedOffset + searchRadius)
  if (maximum <= minimum) return Math.max(previousOffset + 2, expectedOffset - (expectedOffset % 2))
  let bestOffset = expectedOffset - (expectedOffset % 2)
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let offset = minimum - (minimum % 2); offset <= maximum; offset += 640) {
    const start = Math.max(0, offset - Math.floor(windowBytes / 2))
    const end = Math.min(pcm.length, start + windowBytes)
    let energy = 0
    let samples = 0
    for (let sample = start - (start % 2); sample + 1 < end; sample += 2) {
      energy += Math.abs(pcm.readInt16LE(sample))
      samples += 1
    }
    const average = energy / Math.max(samples, 1)
    const distancePenalty = Math.abs(offset - expectedOffset) / Math.max(searchRadius, 1) * 400
    const score = average + distancePenalty
    if (score < bestEnergy) {
      bestEnergy = score
      bestOffset = offset
    }
  }
  return bestOffset
}

function splitPcmForReferences(pcm, references) {
  if (references.length === 1) return [pcm]
  const weights = references.map((reference) => englishWords(reference).length)
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const boundaries = []
  let cumulative = 0
  let previous = 0
  for (let index = 0; index < references.length - 1; index += 1) {
    cumulative += weights[index]
    const expected = Math.floor((pcm.length * cumulative) / total / 2) * 2
    const boundary = quietBoundary(pcm, expected, previous, references.length - index - 1)
    boundaries.push(boundary)
    previous = boundary
  }
  return references.map((_, index) => pcm.subarray(boundaries[index - 1] ?? 0, boundaries[index] ?? pcm.length))
}

export async function assessTencentPronunciation({ dataUrl, referenceText }) {
  const { buffer } = decodeAudioDataUrl(dataUrl)
  const pcm = extractPcmFromWav(buffer)
  const audioDurationSeconds = pcm.length / 32_000
  if (audioDurationSeconds < 8) throw new Error('录音过短，请完整复述原文后再提交。')
  if (audioDurationSeconds > 300) throw new Error('单次口语录音不能超过5分钟')
  const references = splitAssessmentReference(referenceText)
  if (!references.length) throw new Error('口语评测原文不能为空')
  const pcmSegments = splitPcmForReferences(pcm, references)
  const results = await Promise.all(references.map((reference, index) => streamAssessment(pcmSegments[index], reference, index)))
  const weights = references.map((reference) => englishWords(reference).length)
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1
  const weighted = (field) => results.reduce((sum, result, index) => sum + percent(result[field]) * weights[index], 0) / totalWeight
  const score = Math.round(weighted('SuggestedScore'))
  const accuracy = Math.round(weighted('PronAccuracy'))
  const fluency = Math.round(weighted('PronFluency'))
  const completion = Math.round(weighted('PronCompletion'))
  const words = wordDetails(results)
  const problemWords = words.filter((word) => word.matchTag !== 0 || word.accuracy < 70).sort((left, right) => left.accuracy - right.accuracy).slice(0, 12)
  const transcript = transcriptFromWords(words)
  const improvements = []
  if (completion < 85) improvements.push('完整度不足，请按原文顺序补回遗漏或错读的词。')
  if (accuracy < 80) improvements.push('发音精准度需要提高，优先重练下方标出的低分词和音素。')
  if (fluency < 80) improvements.push('流利度需要提高，注意意群停顿、连读、弱读和稳定节奏。')
  if (!improvements.length) improvements.push('整体表现良好，可继续模仿原音的重音和语调。')
  return {
    score,
    correct: score >= 70 && completion >= 75,
    summary: score >= 88 ? '腾讯智聆评测显示复述准确、完整且流畅。' : score >= 70 ? '复述已达到要求，仍有部分发音或完整度可以提升。' : '本次未达到提交标准，请根据逐词结果重新录音。',
    strengths: [accuracy >= 80 ? '发音精准度达到良好水平。' : '已完成一段可评测的真实录音。', fluency >= 80 ? '语流和节奏较稳定。' : '腾讯云已识别出可继续改进的具体位置。'],
    improvements,
    dimensions: [
      { label: '发音精准度', score: accuracy, weight: 45 },
      { label: '流利度与韵律', score: fluency, weight: 25 },
      { label: '原文完整度', score: completion, weight: 30 },
    ],
    reference: String(referenceText),
    transcript,
    words: problemWords,
    graderType: 'tencent-soe',
    modelVersion: 'soe-new-16k-en',
    acousticAssessment: true,
    providerScores: { suggested: score, accuracy, fluency, completion },
    referenceSegments: references.length,
    audioHash: sha256(buffer),
    audioDurationSeconds,
  }
}
