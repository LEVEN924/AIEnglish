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

if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is not configured in .env.local')
const { gradeSubmission } = await import('../server/grading.mjs')
const catalog = JSON.parse(readFileSync(join(root, 'content', 'lessons.json'), 'utf8'))
const lesson = catalog.entries[0]
const result = await gradeSubmission('translation', lesson, lesson.translation.referenceZh)
if (result.graderType !== 'deepseek') throw new Error('DeepSeek verification fell back to the local rubric')

console.log(JSON.stringify({
  ok: true,
  provider: result.graderType,
  model: result.modelVersion,
  score: result.score,
  dimensions: result.dimensions.length,
}, null, 2))
