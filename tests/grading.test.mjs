import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gradeSubmission, gradingCapabilities } from '../server/grading.mjs'
import {
  assessTencentPronunciation,
  createSoeWebSocketUrl,
  createTc3Headers,
  splitAssessmentReference,
  splitSpeechText,
  tencentCapabilities,
} from '../server/tencent-cloud.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const catalog = JSON.parse(await readFile(join(root, 'content', 'lessons.json'), 'utf8'))
const lesson = catalog.entries[0]

function preserveEnvironment(context, keys) {
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  context.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

test('Tencent TC3 and SOE-N signatures contain the required provider fields', (context) => {
  preserveEnvironment(context, ['TENCENTCLOUD_APP_ID', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'TENCENT_SOE_SCORE_COEFF'])
  process.env.TENCENTCLOUD_APP_ID = '1250000000'
  process.env.TENCENTCLOUD_SECRET_ID = 'test-secret-id'
  process.env.TENCENTCLOUD_SECRET_KEY = 'test-secret-key-never-sent'
  process.env.TENCENT_SOE_SCORE_COEFF = '4.0'

  const payload = JSON.stringify({ Text: 'Hello.' })
  const headers = createTc3Headers({
    service: 'tts',
    host: 'tts.tencentcloudapi.com',
    action: 'TextToVoice',
    version: '2019-08-23',
    payload,
    timestamp: 1_700_000_000,
    secretId: process.env.TENCENTCLOUD_SECRET_ID,
    secretKey: process.env.TENCENTCLOUD_SECRET_KEY,
  })
  assert.match(headers.Authorization, /^TC3-HMAC-SHA256 Credential=test-secret-id\//u)
  assert.equal(headers['X-TC-Action'], 'TextToVoice')
  assert.equal(headers.Host, 'tts.tencentcloudapi.com')

  const soeUrl = new URL(createSoeWebSocketUrl('This is a speaking test.', 'voice-test-id'))
  assert.equal(soeUrl.host, 'soe.cloud.tencent.com')
  assert.equal(soeUrl.searchParams.get('eval_mode'), '2')
  assert.equal(soeUrl.searchParams.get('score_coeff'), '4')
  assert.equal(soeUrl.searchParams.get('voice_id'), 'voice-test-id')
  assert.ok(soeUrl.searchParams.get('signature'))
  assert.equal(tencentCapabilities().oralAssessment, true)
})

test('Tencent audio text is split within TTS and SOE-N limits', () => {
  const longText = Array.from({ length: 40 }, (_, index) => `Sentence ${index + 1} explains a useful English learning idea.`).join(' ')
  const speechChunks = splitSpeechText(longText)
  const assessmentChunks = splitAssessmentReference(longText)
  assert.ok(speechChunks.length > 1)
  assert.ok(speechChunks.every((chunk) => chunk.length <= 440))
  assert.ok(assessmentChunks.length > 1)
  assert.ok(assessmentChunks.every((chunk) => (chunk.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []).length <= 118))
})

test('speaking text submissions are rejected because real audio is mandatory', async () => {
  await assert.rejects(() => gradeSubmission('speaking', lesson, lesson.body), /真实录音/u)
})

test('SOE-N rejects an acoustically valid but too-short WAV before provider submission', async () => {
  const pcm = Buffer.alloc(32_000)
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24)
  wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  pcm.copy(wav, 44)
  await assert.rejects(
    () => assessTencentPronunciation({ dataUrl: `data:audio/wav;base64,${wav.toString('base64')}`, referenceText: lesson.body }),
    /录音过短/u,
  )
})

test('writing uses strict article-related translation matching without a language-model provider', async (context) => {
  preserveEnvironment(context, ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'])
  delete process.env.TENCENTCLOUD_SECRET_ID
  delete process.env.TENCENTCLOUD_SECRET_KEY
  const result = await gradeSubmission('writing', lesson, lesson.writing.answers[0])
  assert.equal(result.correct, true)
  assert.equal(result.graderType, 'local')
  assert.equal(result.modelVersion, 'strict-article-translation-rubric-1')
  assert.equal(result.dimensions.reduce((total, dimension) => total + dimension.weight, 0), 100)

  const misspelled = await gradeSubmission('writing', lesson, 'i can walk for ten mini every day.')
  assert.equal(misspelled.correct, false)
  assert.ok(misspelled.score <= 74)
  assert.match(misspelled.improvements.join(' '), /“i” → “I”/u)
  assert.match(misspelled.improvements.join(' '), /“mini” → “minutes”/u)

  const secondTranslation = await gradeSubmission(
    'writing',
    lesson,
    lesson.writing.secondaryAnswers[0],
    { promptIndex: 1 },
  )
  assert.equal(secondTranslation.correct, true)
  assert.equal(secondTranslation.prompt, lesson.writing.secondaryPromptZh)
  assert.equal(secondTranslation.prompt, '我可以走楼梯。')
  assert.notEqual(secondTranslation.prompt, lesson.translation.referenceZh)
  assert.deepEqual(gradingCapabilities(), { provider: 'tencent-and-rules', enabled: true, model: 'rules-only' })
})

test('full-paragraph translation uses Tencent TMT reference and a deterministic rubric', async (context) => {
  const originalFetch = globalThis.fetch
  preserveEnvironment(context, ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'TENCENTCLOUD_REGION', 'TENCENT_TMT_ENABLED'])
  context.after(() => { globalThis.fetch = originalFetch })
  process.env.TENCENTCLOUD_SECRET_ID = 'test-secret-id'
  process.env.TENCENTCLOUD_SECRET_KEY = 'test-secret-key-never-sent'
  process.env.TENCENTCLOUD_REGION = 'ap-guangzhou'
  process.env.TENCENT_TMT_ENABLED = 'true'
  let capturedUrl = ''
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    capturedBody = JSON.parse(init.body)
    assert.match(String(init.headers.Authorization), /^TC3-HMAC-SHA256/u)
    assert.equal(init.headers['X-TC-Action'], 'TextTranslate')
    return new Response(JSON.stringify({ Response: { TargetText: '这是一段完整且自然的中文参考译文。', RequestId: 'test-request' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const result = await gradeSubmission('translation', lesson, '这是一段完整且自然的中文参考译文。')
  assert.equal(capturedUrl, 'https://tmt.tencentcloudapi.com')
  assert.equal(capturedBody.SourceText, lesson.body)
  assert.equal(result.graderType, 'tencent-tmt-rubric')
  assert.equal(result.correct, true)
  assert.equal(result.dimensions.reduce((total, dimension) => total + dimension.weight, 0), 100)
})
