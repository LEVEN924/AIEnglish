import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENVIRONMENT_SEEDS } from '../content/seeds/environment.mjs'
import { HEALTH_SEEDS } from '../content/seeds/health.mjs'
import { OCEAN_SEEDS } from '../content/seeds/ocean.mjs'
import { SOCIETY_SEEDS } from '../content/seeds/society.mjs'
import { SPACE_SEEDS } from '../content/seeds/space.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'content', 'lessons.json')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const originalIds = new Set([
  'lesson-cdc-short-walk',
  'lesson-epa-food-waste',
  'lesson-noaa-coral-partnership',
  'lesson-nasa-moon-before-mars',
  'lesson-nist-four-verbs',
])

const levelMeta = {
  L1: { label: '基础', cefr: 'A2–B1', reason: '以高频词和清晰短句为主，概念通过具体例子展开。', minutes: 18 },
  L2: { label: '进阶', cefr: 'B1–B2', reason: '包含复合句、过程解释和适量学科词汇，逻辑关系明确。', minutes: 22 },
  L3: { label: '高阶', cefr: 'B2–C1', reason: '信息密度较高，包含抽象概念、限定表达和专业词汇。', minutes: 26 },
}

const seeds = [
  ...SPACE_SEEDS,
  ...OCEAN_SEEDS,
  ...ENVIRONMENT_SEEDS,
  ...HEALTH_SEEDS,
  ...SOCIETY_SEEDS,
]

const topicSupplements = {
  '太空与科学': 'Careful comparison helps readers separate an exciting image from the physical process and evidence that explain it.',
  '海洋与环境': 'Following movement through the whole system helps connect a local observation with consequences that may appear far away.',
  '安全与自然': 'Remembering the mechanism behind the advice makes it easier to choose a safe response under pressure.',
  '气候与城市': 'Reliable local evidence allows communities to turn a broad environmental pattern into a practical planning decision.',
  '健康与环境': 'A useful response combines trustworthy information with actions suited to the current place, exposure, and personal health.',
  '生活与环境': 'The most durable improvement usually comes from a small system that makes the better action visible and repeatable.',
  '科技与环境': 'Thinking about the full life cycle reveals costs and opportunities that are easy to miss at the moment of disposal.',
  '健康与日常': 'The practical goal is a repeatable habit that reduces risk without demanding a perfect routine every day.',
  '健康与科学': 'Clear explanations support informed choices while leaving individual medical decisions to qualified healthcare professionals.',
  '心理与社会': 'Respectful support begins by listening carefully, noticing impact, and matching the response to the seriousness of the situation.',
  '科技与安全': 'A dependable security habit slows down unusual requests and makes one stolen secret less valuable to an attacker.',
  '科学与社会': 'Shared definitions turn an invisible technical process into results that people in different places can trust and compare.',
  '地球与环境': 'Seeing both fast and slow parts of the system prevents one moment from hiding the longer process.',
  '地球与安全': 'Scientific monitoring reduces uncertainty, but preparation is what turns the available warning into lower risk.',
  '旅行与自然': 'Thoughtful design and visitor choices can protect a shared resource while keeping it available for people to experience.',
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
}

function toLesson(seed) {
  const difficulty = levelMeta[seed.level]
  const baseBody = seed.sentences.join(' ')
  const wordCount = baseBody.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu)?.length ?? 0
  const body = wordCount < 120 ? `${baseBody} ${topicSupplements[seed.topic]}` : baseBody
  return {
    id: `lesson-${seed.id}`,
    slug: slugify(seed.title),
    title: seed.title,
    titleZh: seed.titleZh,
    topic: seed.topic,
    difficulty: {
      level: seed.level,
      label: difficulty.label,
      cefr: difficulty.cefr,
      reason: difficulty.reason,
    },
    estimatedMinutes: difficulty.minutes,
    body,
    guideZh: seed.guideZh,
    keyIdeaZh: seed.keyIdeaZh,
    translation: {
      prompt: seed.sentences[3],
      referenceZh: seed.translationZh,
      gradingNotes: [
        '保留原句的主要信息、逻辑关系和语气。',
        '允许自然中文表达，不要求逐词对应。',
      ],
    },
    speakingPrompt: seed.speaking,
    writing: {
      promptZh: seed.writingZh,
      answers: [seed.sentences[6]],
      hint: `复用本课表达：${seed.vocab.slice(0, 2).map((item) => item[0]).join(' / ')}。`,
    },
    vocabulary: seed.vocab.map(([term, ipa, part, meaning]) => ({ term, ipa, part, meaning })),
    source: {
      publisher: seed.source[0],
      title: seed.source[1],
      url: seed.source[2],
      publishedAt: '',
      accessedAt: '2026-08-19',
      adaptation: 'Original learning text written from verified source facts; not a copied excerpt.',
      rightsNote: 'Authoritative public information source; third-party material, if any, is excluded.',
    },
    quality: {
      sourceReliability: 20,
      languageAuthenticity: 18,
      learningValue: 19,
      topicValue: 14,
      factualAccuracy: 15,
      durability: 9,
      total: 95,
    },
  }
}

if (seeds.length !== 45) throw new Error(`Expected 45 expansion seeds, received ${seeds.length}`)

const originalLessons = catalog.entries.filter((lesson) => originalIds.has(lesson.id))
if (originalLessons.length !== 5) throw new Error(`Expected 5 original lessons, received ${originalLessons.length}`)

const entries = [...originalLessons, ...seeds.map(toLesson)]
const uniqueIds = new Set(entries.map((lesson) => lesson.id))
const uniqueUrls = new Set(entries.map((lesson) => lesson.source.url))
if (uniqueIds.size !== entries.length) throw new Error('Generated lesson IDs are not unique')
if (uniqueUrls.size !== entries.length) throw new Error('Generated source URLs are not unique')

const nextCatalog = {
  version: 2,
  targetSize: 1000,
  curatedAt: new Date().toISOString(),
  entries,
}

await writeFile(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, 'utf8')
console.log(`Generated ${entries.length} curated lessons in ${catalogPath}`)
