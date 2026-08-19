import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gradeSubmission, gradingCapabilities } from '../server/grading.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

test('DeepSeek V4 Flash uses JSON chat completions and validated rubric dimensions', async (context) => {
  const originalFetch = globalThis.fetch
  const originalEnvironment = {
    AI_PROVIDER: process.env.AI_PROVIDER,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  }
  context.after(() => {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  process.env.AI_PROVIDER = 'deepseek'
  process.env.DEEPSEEK_API_KEY = 'test-key-never-sent'
  process.env.DEEPSEEK_MODEL = 'deepseek-v4-flash'
  process.env.DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
  let capturedUrl = ''
  let capturedBody
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    capturedBody = JSON.parse(init.body)
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            score: 92,
            correct: true,
            summary: '关键信息完整，表达自然。',
            strengths: ['核心含义准确。'],
            improvements: ['可进一步调整语序。'],
            dimensions: [
              { label: '信息准确度', score: 94, weight: 40 },
              { label: '完整度', score: 92, weight: 20 },
              { label: '语法和逻辑', score: 91, weight: 15 },
              { label: '词义与语境', score: 92, weight: 15 },
              { label: '中文自然度', score: 89, weight: 10 },
            ],
            reference: '参考译文',
          }),
        },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }

  const catalog = JSON.parse(await readFile(join(root, 'content', 'lessons.json'), 'utf8'))
  const lesson = catalog.entries[0]
  const result = await gradeSubmission('translation', lesson, lesson.translation.referenceZh)
  assert.equal(capturedUrl, 'https://api.deepseek.com/chat/completions')
  assert.equal(capturedBody.model, 'deepseek-v4-flash')
  assert.deepEqual(capturedBody.response_format, { type: 'json_object' })
  assert.deepEqual(capturedBody.thinking, { type: 'disabled' })
  assert.equal(result.graderType, 'deepseek')
  assert.equal(result.modelVersion, 'deepseek-v4-flash')
  assert.equal(result.dimensions.reduce((total, dimension) => total + dimension.weight, 0), 100)
  assert.deepEqual(gradingCapabilities(), { provider: 'deepseek', enabled: true, model: 'deepseek-v4-flash' })
})
