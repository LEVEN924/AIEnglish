import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import {
  assessTencentPronunciation,
  splitSpeechText,
  synthesizeTencentSpeech,
  tencentCapabilities,
  transcribeTencentAudio,
} from './tencent-cloud.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fullArticleCacheDirectory = join(root, 'data', 'audio-cache', 'articles')
const fullArticleJobs = new Map()

function articleCacheKey(lesson) {
  return createHash('sha256').update(JSON.stringify({
    provider: 'tencent',
    action: 'FullArticleTextToVoice',
    text: lesson.body,
    voice: String(process.env.TENCENT_TTS_VOICE_TYPE ?? '101050'),
    model: Number(process.env.TENCENT_TTS_MODEL_TYPE ?? 1),
    speed: 0,
  })).digest('hex')
}

function runFfmpeg(argumentsList) {
  if (!ffmpegPath) throw new Error('完整音频合并组件不可用，请重新安装项目依赖')
  return new Promise((resolveMerge, rejectMerge) => {
    const process = spawn(ffmpegPath, argumentsList, { windowsHide: true })
    let errorOutput = ''
    process.stderr.on('data', (chunk) => { errorOutput += String(chunk).slice(-4_000) })
    process.once('error', rejectMerge)
    process.once('close', (code) => {
      if (code === 0) resolveMerge()
      else rejectMerge(new Error(`完整音频合并失败（FFmpeg ${code}）：${errorOutput.slice(-800)}`))
    })
  })
}

async function createFullArticleSpeech(lesson, cachePath) {
  const chunks = splitSpeechText(lesson.body)
  const voice = String(process.env.TENCENT_TTS_VOICE_TYPE ?? '101050')
  const generated = []
  for (const text of chunks) {
    generated.push(await synthesizeTencentSpeech(text, { rate: 1 }))
  }

  await mkdir(fullArticleCacheDirectory, { recursive: true })
  if (generated.length === 1) {
    await writeFile(cachePath, generated[0].buffer)
  } else {
    const temporaryDirectory = await mkdtemp(join(fullArticleCacheDirectory, '.merge-'))
    try {
      const inputs = []
      for (let index = 0; index < generated.length; index += 1) {
        const inputPath = join(temporaryDirectory, `part-${index}.mp3`)
        await writeFile(inputPath, generated[index].buffer)
        inputs.push('-i', inputPath)
      }
      const streams = generated.map((_, index) => `[${index}:a]`).join('')
      await runFfmpeg([
        '-hide_banner', '-loglevel', 'error', '-y',
        ...inputs,
        '-filter_complex', `${streams}concat=n=${generated.length}:v=0:a=1[out]`,
        '-map', '[out]', '-ar', '16000', '-ac', '1', '-b:a', '48k',
        cachePath,
      ])
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  return {
    buffer: await readFile(cachePath),
    contentType: 'audio/mpeg',
    provider: 'tencent',
    model: 'TextToVoice+FullArticle',
    voice,
    cacheHit: false,
  }
}

export function audioCapabilities() {
  return tencentCapabilities()
}

export function createSpeechManifest(lesson) {
  const article = {
    text: lesson.body,
    url: `/api/audio/article?lessonId=${encodeURIComponent(lesson.id)}`,
  }
  const vocabulary = lesson.vocabulary.map((item) => ({
    term: item.term,
    url: `/api/audio/speech?lessonId=${encodeURIComponent(lesson.id)}&kind=vocabulary&term=${encodeURIComponent(item.term)}&rate=1`,
  }))
  return { provider: 'tencent', available: tencentCapabilities().cloudSpeech, baseRate: 1, article, vocabulary }
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

export async function synthesizeFullArticleSpeech(lesson) {
  const cacheKey = articleCacheKey(lesson)
  const cachePath = join(fullArticleCacheDirectory, `${cacheKey}.mp3`)
  try {
    return {
      buffer: await readFile(cachePath),
      contentType: 'audio/mpeg',
      provider: 'tencent',
      model: 'TextToVoice+FullArticle',
      voice: String(process.env.TENCENT_TTS_VOICE_TYPE ?? '101050'),
      cacheHit: true,
    }
  } catch {
    // A single shared job below prevents duplicate Tencent requests during preload.
  }

  if (!fullArticleJobs.has(cacheKey)) {
    const job = createFullArticleSpeech(lesson, cachePath).finally(() => fullArticleJobs.delete(cacheKey))
    fullArticleJobs.set(cacheKey, job)
  }
  return fullArticleJobs.get(cacheKey)
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
