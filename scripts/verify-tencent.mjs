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

const speech = await synthesizeTencentSpeech('AI English Tencent Cloud voice check.')
console.log(JSON.stringify({
  ok: true,
  mode: 'live-tts',
  provider: speech.provider,
  model: speech.model,
  voice: speech.voice,
  bytes: speech.buffer.length,
  cacheHit: speech.cacheHit,
  oralAssessmentConfigured: capabilities.oralAssessment,
  soeSignature: 'generated',
}, null, 2))
