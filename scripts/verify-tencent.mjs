import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const environmentPath = join(root, '.env.local')
if (existsSync(environmentPath)) {
  for (const raw of readFileSync(environmentPath, 'utf8').split(/\r?\n/u)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    if (!(key in process.env)) process.env[key] = line.slice(separator + 1).trim()
  }
}

const required = ['TENCENTCLOUD_APP_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY']
const missing = required.filter((key) => !String(process.env[key] ?? '').trim())
if (missing.length) throw new Error(`腾讯云配置不完整，请在 .env.local 填写：${missing.join('、')}`)

const { createSoeWebSocketUrl, synthesizeTencentSpeech, tencentCapabilities } = await import('../server/tencent-cloud.mjs')
const capabilities = tencentCapabilities()
const assessmentUrl = createSoeWebSocketUrl('English speaking assessment check.', 'ai-english-config-check')
if (!assessmentUrl.startsWith('wss://soe.cloud.tencent.com/soe/api/')) throw new Error('SOE-N 签名地址生成失败')

if (process.argv.includes('--config-only')) {
  console.log(JSON.stringify({ ok: true, mode: 'config-only', ...capabilities, soeSignature: 'generated' }, null, 2))
  process.exit(0)
}

const requestedText = process.argv.find((argument) => argument.startsWith('--text='))?.slice('--text='.length)
const requestedRuns = Number(process.argv.find((argument) => argument.startsWith('--runs='))?.slice('--runs='.length) ?? 1)
const runs = Math.min(10, Math.max(1, Number.isFinite(requestedRuns) ? Math.floor(requestedRuns) : 1))
const results = []
for (let index = 0; index < runs; index += 1) {
  const marker = `${Date.now()}-${index + 1}`
  const text = `${(requestedText || 'AI English Tencent Cloud voice stability check.').slice(0, 420)} Test ${marker}.`
  const startedAt = performance.now()
  const speech = await synthesizeTencentSpeech(text)
  if (speech.provider !== 'tencent' || speech.buffer.length < 500) throw new Error(`第 ${index + 1} 次腾讯云语音返回无效`)
  results.push({
    run: index + 1,
    provider: speech.provider,
    model: speech.model,
    voice: speech.voice,
    bytes: speech.buffer.length,
    cacheHit: speech.cacheHit,
    durationMs: Math.round(performance.now() - startedAt),
  })
}
console.log(JSON.stringify({
  ok: true,
  mode: 'live-tts-stability',
  runs,
  results,
  oralAssessmentConfigured: capabilities.oralAssessment,
  soeSignature: 'generated',
}, null, 2))
