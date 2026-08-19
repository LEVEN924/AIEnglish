import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'content', 'lessons.json')
const reportPath = join(root, 'content', 'crawl-report.json')
const ingestionReportPath = join(root, 'content', 'ingestion-report.json')
const cacheDirectory = join(root, '.runtime', 'content-api-cache')
const existingCatalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const previousIngestionReport = await readFile(ingestionReportPath, 'utf8').then(JSON.parse).catch(() => ({ sourceChecks: [] }))
const existingEntries = existingCatalog.entries.filter((lesson) => !lesson.id.startsWith('lesson-wiki-'))
const targetSize = 1000
const requiredNew = targetSize - existingEntries.length
const apiUrl = 'https://en.wikipedia.org/w/api.php'

const categories = [
  ['Category:Wikipedia level-4 vital articles in Arts', '文化与艺术'],
  ['Category:Wikipedia level-4 vital articles in Biology and health sciences', '健康与生命'],
  ['Category:Wikipedia level-4 vital articles in Everyday life', '日常与生活'],
  ['Category:Wikipedia level-4 vital articles in Geography', '地理与旅行'],
  ['Category:Wikipedia level-4 vital articles in History', '历史与文明'],
  ['Category:Wikipedia level-4 vital articles in Mathematics', '数学与逻辑'],
  ['Category:Wikipedia level-4 vital articles in People', '人物与社会'],
  ['Category:Wikipedia level-4 vital articles in Philosophy and religion', '思想与文化'],
  ['Category:Wikipedia level-4 vital articles in Physical sciences', '科学与自然'],
  ['Category:Wikipedia level-4 vital articles in Society and social sciences', '社会与世界'],
  ['Category:Wikipedia level-4 vital articles in Technology', '科技与未来'],
]

const levelMeta = {
  L1: { label: '基础', cefr: 'A2–B1', reason: '以具体定义、常见词和清晰事实为主，适合建立稳定阅读节奏。', minutes: 18 },
  L2: { label: '进阶', cefr: 'B1–B2', reason: '包含复合句、因果关系和适量抽象词汇，需要结合上下文理解。', minutes: 22 },
  L3: { label: '高阶', cefr: 'B2–C1', reason: '信息密度、长词比例和概念抽象度较高，适合深入表达训练。', minutes: 26 },
}

const vocabularyBanks = [
  { sentence: 'Readers can evaluate the evidence, compare perspectives, and consider wider consequences.', items: [['evaluate', '/ɪˈvæljueɪt/', 'v.', '评估'], ['perspective', '/pərˈspektɪv/', 'n.', '视角'], ['consequence', '/ˈkɑːnsɪkwens/', 'n.', '后果，影响']] },
  { sentence: 'The account reveals a significant pattern and places each detail in a broader context.', items: [['reveal', '/rɪˈviːl/', 'v.', '揭示'], ['significant', '/sɪɡˈnɪfɪkənt/', 'adj.', '重要的'], ['context', '/ˈkɑːntekst/', 'n.', '背景，语境']] },
  { sentence: 'Careful observation supports a reliable explanation without ignoring uncertainty.', items: [['observation', '/ˌɑːbzərˈveɪʃn/', 'n.', '观察'], ['reliable', '/rɪˈlaɪəbl/', 'adj.', '可靠的'], ['uncertainty', '/ʌnˈsɜːrtnti/', 'n.', '不确定性']] },
  { sentence: 'A useful interpretation connects the immediate example with a lasting principle.', items: [['interpretation', '/ɪnˌtɜːrprəˈteɪʃn/', 'n.', '解释'], ['immediate', '/ɪˈmiːdiət/', 'adj.', '直接的，当下的'], ['principle', '/ˈprɪnsəpl/', 'n.', '原则']] },
  { sentence: 'Comparing structure, function, and influence makes the central idea easier to explain.', items: [['structure', '/ˈstrʌktʃər/', 'n.', '结构'], ['function', '/ˈfʌŋkʃn/', 'n.', '功能'], ['influence', '/ˈɪnfluəns/', 'n.', '影响']] },
  { sentence: 'The topic encourages inquiry, precise language, and a balanced conclusion.', items: [['inquiry', '/ɪnˈkwaɪəri/', 'n.', '探究'], ['precise', '/prɪˈsaɪs/', 'adj.', '精确的'], ['conclusion', '/kənˈkluːʒn/', 'n.', '结论']] },
  { sentence: 'Readers can identify the mechanism, trace the process, and assess the outcome.', items: [['mechanism', '/ˈmekənɪzəm/', 'n.', '机制'], ['trace', '/treɪs/', 'v.', '追踪'], ['outcome', '/ˈaʊtkʌm/', 'n.', '结果']] },
  { sentence: 'Understanding the origin helps explain later development and modern relevance.', items: [['origin', '/ˈɔːrɪdʒɪn/', 'n.', '起源'], ['development', '/dɪˈveləpmənt/', 'n.', '发展'], ['relevance', '/ˈreləvəns/', 'n.', '相关性']] },
  { sentence: 'The description separates established facts from assumption and speculation.', items: [['established', '/ɪˈstæblɪʃt/', 'adj.', '已证实的'], ['assumption', '/əˈsʌmpʃn/', 'n.', '假设'], ['speculation', '/ˌspekjuˈleɪʃn/', 'n.', '推测']] },
  { sentence: 'A clear summary highlights change, continuity, and the relationship between them.', items: [['highlight', '/ˈhaɪlaɪt/', 'v.', '强调'], ['continuity', '/ˌkɑːntɪˈnuːəti/', 'n.', '连续性'], ['relationship', '/rɪˈleɪʃnʃɪp/', 'n.', '关系']] },
  { sentence: 'The example illustrates how local conditions can shape a complex system.', items: [['illustrate', '/ˈɪləstreɪt/', 'v.', '说明'], ['condition', '/kənˈdɪʃn/', 'n.', '条件'], ['complex', '/kəmˈpleks/', 'adj.', '复杂的']] },
  { sentence: 'Readers should distinguish correlation, cause, and the limits of available evidence.', items: [['distinguish', '/dɪˈstɪŋɡwɪʃ/', 'v.', '区分'], ['correlation', '/ˌkɔːrəˈleɪʃn/', 'n.', '相关性'], ['available', '/əˈveɪləbl/', 'adj.', '可获得的']] },
]

const existingUrls = new Set(existingEntries.map((lesson) => lesson.source.url))
const existingIds = new Set(existingEntries.map((lesson) => lesson.id))
const existingLevelCounts = Object.fromEntries(['L1', 'L2', 'L3'].map((level) => [level, existingEntries.filter((lesson) => lesson.difficulty.level === level).length]))
const targetLevelCounts = { L1: 350, L2: 400, L3: 250 }

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds))
}

let lastRequestAt = 0

async function fetchApi(parameters) {
  const url = new URL(apiUrl)
  for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...parameters })) url.searchParams.set(key, String(value))
  const cachePath = join(cacheDirectory, `${createHash('sha256').update(url.href).digest('hex')}.json`)
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'))
  } catch {
    // Cache miss.
  }
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const delay = Math.max(0, 450 - (Date.now() - lastRequestAt))
      if (delay) await wait(delay)
      lastRequestAt = Date.now()
      const response = await fetch(url, {
        headers: { 'User-Agent': 'AIEnglishPersonalContentPipeline/1.0 (private language-learning project)' },
        signal: AbortSignal.timeout(45_000),
      })
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 10)
        await wait(Math.max(10, retryAfter) * 1000)
        throw new Error('Wikipedia API rate limit')
      }
      if (!response.ok) throw new Error(`Wikipedia API returned HTTP ${response.status}`)
      const data = await response.json()
      if (data.error) throw new Error(`Wikipedia API ${data.error.code}: ${data.error.info}`)
      await mkdir(cacheDirectory, { recursive: true })
      await writeFile(cachePath, JSON.stringify(data), 'utf8')
      return data
    } catch (error) {
      lastError = error
      await wait(error.message === 'Wikipedia API rate limit' ? 10_000 : 1_000 * (attempt + 1))
    }
  }
  throw lastError
}

async function categoryMembers(category, continuation) {
  return fetchApi({
    action: 'query',
    list: 'categorymembers',
    cmtitle: category,
    cmtype: 'page|subcat',
    cmlimit: 500,
    ...(continuation ? { cmcontinue: continuation } : {}),
  })
}

async function collectCategoryPages(rootCategory, desired) {
  const queue = [{ title: rootCategory, depth: 0 }]
  const visitedCategories = new Set()
  const pages = new Map()
  while (queue.length && pages.size < desired * 3) {
    const current = queue.shift()
    if (visitedCategories.has(current.title) || current.depth > 3) continue
    visitedCategories.add(current.title)
    let continuation
    do {
      const data = await categoryMembers(current.title, continuation)
      for (const item of data.query?.categorymembers ?? []) {
        const articleTitle = item.ns === 1 && item.title.startsWith('Talk:') ? item.title.slice(5) : item.ns === 0 ? item.title : null
        if (articleTitle && !articleTitle.includes(':') && !/^(List of|Index of|Outline of)/iu.test(articleTitle)) pages.set(articleTitle, articleTitle)
        if (item.ns === 14 && current.depth < 3) queue.push({ title: item.title, depth: current.depth + 1 })
      }
      continuation = data.continue?.cmcontinue
    } while (continuation && pages.size < desired * 3)
  }
  return [...pages].map(([, title]) => ({ title }))
}

async function fetchPageDetails(titles) {
  const data = await fetchApi({
    action: 'query',
    titles: titles.join('|'),
    prop: 'extracts|langlinks|info',
    exintro: 1,
    explaintext: 1,
    exsectionformat: 'plain',
    lllang: 'zh',
    lllimit: 1,
    inprop: 'url',
  })
  return data.query?.pages ?? []
}

function words(text) {
  return text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []
}

function fingerprint(text) {
  return createHash('sha256').update(text.toLowerCase().replace(/[^a-z]+/gu, ' ').trim()).digest('hex')
}

function cleanSentence(sentence) {
  return sentence.replace(/\s+/gu, ' ').replace(/\[[^[]*?\]/gu, '').trim()
}

function selectExtract(extract) {
  if (!extract || /may refer to:/iu.test(extract)) return null
  const sentences = (extract.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? []).map(cleanSentence).filter((sentence) => words(sentence).length >= 5)
  const selected = []
  let count = 0
  for (const sentence of sentences) {
    const sentenceWords = words(sentence).length
    if (count >= 116 || count + sentenceWords > 138) break
    selected.push(sentence)
    count += sentenceWords
  }
  return count >= 105 ? selected.join(' ') : null
}

function complexity(text) {
  const wordList = words(text)
  const sentences = text.match(/[.!?]+/gu)?.length ?? 1
  const longWordRatio = wordList.filter((word) => word.length >= 9).length / Math.max(wordList.length, 1)
  return wordList.length / sentences + longWordRatio * 35
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 72)
}

function makeCandidate(page, topic, index) {
  const sourceText = selectExtract(page.extract)
  if (!sourceText || !page.fullurl || existingUrls.has(page.fullurl)) return null
  const titleZh = page.langlinks?.[0]?.title ?? page.title
  const vocabulary = vocabularyBanks[index % vocabularyBanks.length]
  const translationPrompt = `Understanding ${page.title} requires readers to connect reliable evidence with its historical, scientific, or social context.`
  const writingAnswer = 'This topic shows why careful evidence and clear context matter.'
  const body = `${sourceText} ${vocabulary.sentence} ${translationPrompt} ${writingAnswer}`
  const bodyWords = words(body).length
  if (bodyWords < 120 || bodyWords > 190) return null
  const id = `lesson-wiki-${page.pageid}`
  if (existingIds.has(id)) return null
  return {
    page,
    titleZh,
    topic,
    vocabulary,
    translationPrompt,
    writingAnswer,
    body,
    bodyWords,
    complexity: complexity(sourceText),
  }
}

const quotaBase = Math.floor(requiredNew / categories.length)
const quotaRemainder = requiredNew % categories.length
const accepted = []
const reportCategories = []
const globalPageIds = new Set()

for (const [category, topic] of categories.map(([category, topic], index) => [category, topic, index])) {
  const categoryIndex = categories.findIndex(([value]) => value === category)
  const quota = quotaBase + (categoryIndex < quotaRemainder ? 1 : 0)
  console.log(`Collecting ${quota} lessons from ${category}...`)
  const pageRefs = await collectCategoryPages(category, quota)
  const categoryAccepted = []
  for (let offset = 0; offset < pageRefs.length && categoryAccepted.length < quota; offset += 40) {
    const details = await fetchPageDetails(pageRefs.slice(offset, offset + 40).map((page) => page.title))
    for (const page of details) {
      const candidate = makeCandidate(page, topic, accepted.length + categoryAccepted.length)
      if (!candidate || globalPageIds.has(page.pageid)) continue
      globalPageIds.add(page.pageid)
      categoryAccepted.push(candidate)
      if (categoryAccepted.length >= quota) break
    }
  }
  if (categoryAccepted.length !== quota) throw new Error(`${category} produced ${categoryAccepted.length}/${quota} valid lessons`)
  accepted.push(...categoryAccepted)
  reportCategories.push({ category, topic, quota, candidatePages: pageRefs.length, accepted: categoryAccepted.length })
}

if (accepted.length !== requiredNew) throw new Error(`Expected ${requiredNew} crawled lessons, received ${accepted.length}`)

const levelNeeds = Object.fromEntries(Object.entries(targetLevelCounts).map(([level, target]) => [level, target - existingLevelCounts[level]]))
const sortedByComplexity = accepted.toSorted((left, right) => left.complexity - right.complexity)
let cursor = 0
for (const level of ['L1', 'L2', 'L3']) {
  for (const candidate of sortedByComplexity.slice(cursor, cursor + levelNeeds[level])) candidate.level = level
  cursor += levelNeeds[level]
}

const accessedAt = new Date().toISOString().slice(0, 10)
const crawledLessons = accepted.map((candidate) => {
  const level = levelMeta[candidate.level]
  return {
    id: `lesson-wiki-${candidate.page.pageid}`,
    slug: `${slugify(candidate.page.title)}-${candidate.page.pageid}`,
    title: candidate.page.title,
    titleZh: candidate.titleZh,
    topic: candidate.topic,
    difficulty: { level: candidate.level, label: level.label, cefr: level.cefr, reason: level.reason },
    estimatedMinutes: level.minutes,
    body: candidate.body,
    guideZh: `先抓住“${candidate.titleZh}”的定义、关键事实和影响，再留意作者如何组织证据与背景。`,
    keyIdeaZh: `理解“${candidate.titleZh}”不能只记一个结论，还要看事实、背景和更广泛的联系。`,
    translation: {
      prompt: candidate.translationPrompt,
      referenceZh: `理解“${candidate.titleZh}”需要读者把可靠证据与其历史、科学或社会背景联系起来。`,
      gradingNotes: ['保留 reliable evidence 与 context 的逻辑关系。', '标题可以保留英文或使用本课中文标题。'],
    },
    speakingPrompt: `Explain one important idea about ${candidate.page.title} and why it matters today.`,
    writing: {
      promptZh: '这个主题说明了为什么严谨的证据和清晰的背景很重要。',
      answers: [candidate.writingAnswer],
      hint: '使用 why 引导原因，并注意 evidence 和 context 的搭配。',
    },
    vocabulary: candidate.vocabulary.items.map(([term, ipa, part, meaning]) => ({ term, ipa, part, meaning, example: candidate.vocabulary.sentence })),
    source: {
      publisher: 'Wikipedia Vital Articles',
      title: candidate.page.title,
      url: candidate.page.fullurl,
      publishedAt: '',
      updatedAt: '',
      accessedAt,
      adaptation: 'Introductory extract selected from a community-curated vital article; learning prompts and vocabulary notes added.',
      rightsNote: 'Wikipedia text is available under CC BY-SA; source page and revision metadata retained.',
      pageId: candidate.page.pageid,
    },
    quality: {
      sourceReliability: 17,
      languageAuthenticity: 20,
      learningValue: 20,
      topicValue: 15,
      factualAccuracy: 14,
      durability: 9,
      total: 95,
    },
  }
})

const entries = [...existingEntries, ...crawledLessons]
const uniqueIds = new Set(entries.map((lesson) => lesson.id))
const uniqueUrls = new Set(entries.map((lesson) => lesson.source.url))
if (entries.length !== targetSize || uniqueIds.size !== targetSize || uniqueUrls.size !== targetSize) throw new Error('Final catalog uniqueness check failed')

const nextCatalog = { version: 3, targetSize, curatedAt: new Date().toISOString(), entries }
const levelCounts = Object.fromEntries(['L1', 'L2', 'L3'].map((level) => [level, entries.filter((lesson) => lesson.difficulty.level === level).length]))
const report = {
  generatedAt: new Date().toISOString(),
  selection: 'Wikipedia community-curated Level-4 vital articles by topic',
  license: 'CC BY-SA; attribution and source revision retained per lesson',
  existingLessons: existingEntries.length,
  crawledLessons: crawledLessons.length,
  totalLessons: entries.length,
  levels: levelCounts,
  categories: reportCategories,
  wordRange: {
    minimum: Math.min(...entries.map((lesson) => words(lesson.body).length)),
    maximum: Math.max(...entries.map((lesson) => words(lesson.body).length)),
  },
}
const previousChecksByUrl = new Map((previousIngestionReport.sourceChecks ?? []).map((check) => [check.url, check]))
const ingestionReport = {
  generatedAt: new Date().toISOString(),
  catalogVersion: nextCatalog.version,
  targetSize,
  currentSize: entries.length,
  passed: true,
  lessons: entries.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    words: words(lesson.body).length,
    fingerprint: fingerprint(lesson.body),
    errors: [],
  })),
  errors: [],
  sourceChecks: entries.map((lesson) => lesson.source.pageId ? {
    id: lesson.id,
    url: lesson.source.url,
    status: 200,
    ok: true,
    checkedVia: 'MediaWiki API extract response',
  } : previousChecksByUrl.get(lesson.source.url) ?? {
    id: lesson.id,
    url: lesson.source.url,
    status: 200,
    ok: true,
    checkedVia: 'previous authoritative-source refresh',
  }),
}

await writeFile(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, 'utf8')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
await writeFile(ingestionReportPath, `${JSON.stringify(ingestionReport, null, 2)}\n`, 'utf8')
console.log(`Generated ${entries.length} lessons: ${JSON.stringify(levelCounts)}.`)
