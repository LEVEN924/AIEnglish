import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'content', 'lessons.json')
const reportPath = join(root, 'content', 'ingestion-report.json')
const shouldFetch = process.argv.includes('--fetch')
const quiet = process.argv.includes('--quiet')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
let previousReport = null
try { previousReport = JSON.parse(await readFile(reportPath, 'utf8')) } catch { /* The first validation has no prior report. */ }

function wordCount(text) {
  return text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu)?.length ?? 0
}

function fingerprint(text) {
  return createHash('sha256')
    .update(text.toLowerCase().replace(/[^a-z]+/gu, ' ').trim())
    .digest('hex')
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)
  return match?.[1]
    ?.replace(/<[^>]+>/gu, '')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim() ?? null
}

function validateLesson(lesson, seenUrls, seenFingerprints) {
  const errors = []
  const words = wordCount(lesson.body)
  const hash = fingerprint(lesson.body)

  if (words < 120 || words > 220) errors.push(`body must contain 120–220 words; found ${words}`)
  if (!['L1', 'L2', 'L3'].includes(lesson.difficulty?.level)) errors.push('difficulty must be L1, L2, or L3')
  if ((lesson.quality?.total ?? 0) < 80) errors.push('quality score must be at least 80')
  if (!lesson.source?.url?.startsWith('https://')) errors.push('source URL must use HTTPS')
  if (seenUrls.has(lesson.source?.url)) errors.push('source URL is duplicated')
  if (seenFingerprints.has(hash)) errors.push('content fingerprint is duplicated')
  if ((lesson.vocabulary?.length ?? 0) < 5 || lesson.vocabulary.length > 10) errors.push('five to ten vocabulary items are required')
  if (lesson.translation?.prompt !== lesson.body) errors.push('translation prompt must use the complete article body')
  if (lesson.speakingPrompt !== lesson.body) errors.push('speaking reference must use the complete article body')
  if (!lesson.translation?.prompt || !lesson.translation?.referenceZh) errors.push('translation task is incomplete')
  if (!lesson.writing?.promptZh || (lesson.writing?.answers?.length ?? 0) < 1) errors.push('writing task is incomplete')

  seenUrls.add(lesson.source?.url)
  seenFingerprints.add(hash)
  return { id: lesson.id, title: lesson.title, words, fingerprint: hash, errors }
}

const seenUrls = new Set()
const seenFingerprints = new Set()
const lessons = catalog.entries.map((lesson) => validateLesson(lesson, seenUrls, seenFingerprints))
const errors = lessons.flatMap((lesson) => lesson.errors.map((error) => `${lesson.id}: ${error}`))

const report = {
  generatedAt: new Date().toISOString(),
  catalogVersion: catalog.version,
  targetSize: catalog.targetSize,
  currentSize: catalog.entries.length,
  passed: errors.length === 0,
  lessons,
  errors,
  sourceChecks: shouldFetch ? [] : (previousReport?.sourceChecks ?? []),
}

if (shouldFetch) {
  report.sourceChecks = await Promise.all(catalog.entries.map(async (lesson) => {
    const startedAt = Date.now()
    try {
      const response = await fetch(lesson.source.url, {
        headers: { 'User-Agent': 'AIEnglishPersonalContentPipeline/0.1 (+local learning project)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      })
      const html = await response.text()
      return {
        id: lesson.id,
        url: lesson.source.url,
        status: response.status,
        ok: response.ok,
        title: extractTitle(html),
        bytes: Buffer.byteLength(html),
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        id: lesson.id,
        url: lesson.source.url,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      }
    }
  }))

  if (report.sourceChecks.some((check) => !check.ok)) {
    report.passed = false
    report.errors.push('One or more source URLs could not be verified.')
  }
}

await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`Validated ${report.currentSize}/${report.targetSize} lessons.`)
if (!quiet) for (const lesson of lessons) console.log(`${lesson.errors.length ? 'FAIL' : 'PASS'} ${lesson.id} (${lesson.words} words)`)
if (shouldFetch) {
  for (const check of report.sourceChecks.filter((item) => !quiet || !item.ok)) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.url}${check.status ? ` [${check.status}]` : ''}`)
  }
}
console.log(`Result: ${lessons.filter((lesson) => lesson.errors.length === 0).length}/${lessons.length} lesson records passed; ${errors.length} validation errors.`)

if (!report.passed) {
  for (const error of report.errors) console.error(error)
  process.exitCode = 1
}
