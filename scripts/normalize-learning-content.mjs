import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const catalogPath = join(root, 'content', 'lessons.json')
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))

const vocabularyDictionary = [
  ['evidence', '/ˈevɪdəns/', 'n.', '证据'],
  ['context', '/ˈkɑːntekst/', 'n.', '背景，语境'],
  ['compare', '/kəmˈper/', 'v.', '比较'],
  ['reader', '/ˈriːdər/', 'n.', '读者'],
  ['readers', '/ˈriːdərz/', 'n.', '读者（复数）'],
  ['pattern', '/ˈpætərn/', 'n.', '模式，规律'],
  ['detail', '/ˈdiːteɪl/', 'n.', '细节'],
  ['explanation', '/ˌekspləˈneɪʃn/', 'n.', '解释'],
  ['careful', '/ˈkerfl/', 'adj.', '仔细的，审慎的'],
  ['example', '/ɪɡˈzæmpl/', 'n.', '例子'],
  ['idea', '/aɪˈdiːə/', 'n.', '观点，想法'],
  ['central', '/ˈsentrəl/', 'adj.', '核心的'],
  ['balanced', '/ˈbælənst/', 'adj.', '均衡的，全面的'],
  ['process', '/ˈprɑːses/', 'n.', '过程'],
  ['modern', '/ˈmɑːdərn/', 'adj.', '现代的'],
  ['facts', '/fækts/', 'n.', '事实'],
  ['summary', '/ˈsʌməri/', 'n.', '总结'],
  ['change', '/tʃeɪndʒ/', 'n./v.', '变化；改变'],
  ['local', '/ˈloʊkl/', 'adj.', '当地的，局部的'],
  ['system', '/ˈsɪstəm/', 'n.', '系统'],
  ['cause', '/kɔːz/', 'n./v.', '原因；导致'],
  ['conditions', '/kənˈdɪʃnz/', 'n.', '条件，状况'],
  ['risk', '/rɪsk/', 'n.', '风险'],
  ['practical', '/ˈpræktɪkl/', 'adj.', '实际的，可行的'],
  ['information', '/ˌɪnfərˈmeɪʃn/', 'n.', '信息'],
  ['response', '/rɪˈspɑːns/', 'n.', '回应，应对'],
  ['support', '/səˈpɔːrt/', 'v./n.', '支持'],
  ['movement', '/ˈmuːvmənt/', 'n.', '运动，移动'],
  ['habit', '/ˈhæbɪt/', 'n.', '习惯'],
  ['health', '/helθ/', 'n.', '健康'],
  ['energy', '/ˈenərdʒi/', 'n.', '能量'],
  ['surface', '/ˈsɜːrfɪs/', 'n.', '表面'],
  ['material', '/məˈtɪriəl/', 'n.', '材料'],
  ['comparison', '/kəmˈpærɪsn/', 'n.', '比较'],
  ['reliable', '/rɪˈlaɪəbl/', 'adj.', '可靠的'],
  ['important', '/ɪmˈpɔːrtnt/', 'adj.', '重要的'],
  ['influence', '/ˈɪnfluəns/', 'n./v.', '影响'],
  ['relationship', '/rɪˈleɪʃnʃɪp/', 'n.', '关系'],
  ['available', '/əˈveɪləbl/', 'adj.', '可获得的'],
  ['understanding', '/ˌʌndərˈstændɪŋ/', 'n.', '理解'],
  ['development', '/dɪˈveləpmənt/', 'n.', '发展'],
  ['outcome', '/ˈaʊtkʌm/', 'n.', '结果'],
  ['structure', '/ˈstrʌktʃər/', 'n.', '结构'],
  ['function', '/ˈfʌŋkʃn/', 'n.', '功能'],
  ['conclusion', '/kənˈkluːʒn/', 'n.', '结论'],
  ['observation', '/ˌɑːbzərˈveɪʃn/', 'n.', '观察'],
  ['principle', '/ˈprɪnsəpl/', 'n.', '原则'],
  ['uncertainty', '/ʌnˈsɜːrtnti/', 'n.', '不确定性'],
  ['significant', '/sɪɡˈnɪfɪkənt/', 'adj.', '重要的，显著的'],
  ['consequence', '/ˈkɑːnsɪkwens/', 'n.', '后果，影响'],
  ['impact', '/ˈɪmpækt/', 'n.', '影响'],
  ['responsible', '/rɪˈspɑːnsəbl/', 'adj.', '负责任的'],
  ['resource', '/ˈriːsɔːrs/', 'n.', '资源'],
  ['distance', '/ˈdɪstəns/', 'n.', '距离'],
  ['wildlife', '/ˈwaɪldlaɪf/', 'n.', '野生动物'],
  ['respectful', '/rɪˈspektfl/', 'adj.', '尊重他人的'],
  ['protect', '/prəˈtekt/', 'v.', '保护'],
  ['visitors', '/ˈvɪzɪtərz/', 'n.', '访客，游客'],
]

function bodyTerms(body) {
  return new Set((String(body).toLowerCase().match(/[a-z]+(?:[-'][a-z]+)*/gu) ?? []))
}

function wordCount(value) {
  return String(value).match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu)?.length ?? 0
}

function normalizeLesson(lesson) {
  const originalTranslationPrompt = lesson.translation.legacyKeySentence ?? lesson.translation.prompt
  const body = lesson.body
  const terms = bodyTerms(body)
  const vocabulary = [...lesson.vocabulary]
  const existing = new Set(vocabulary.map((item) => item.term.toLowerCase()))
  for (const [term, ipa, part, meaning] of vocabularyDictionary) {
    if (vocabulary.length >= 5) break
    if (!terms.has(term) || existing.has(term)) continue
    vocabulary.push({ term, ipa, part, meaning, example: body.match(new RegExp(`[^.!?]*\\b${term}\\b[^.!?]*[.!?]?`, 'iu'))?.[0]?.trim() })
    existing.add(term)
  }
  if (vocabulary.length < 5) throw new Error(`${lesson.id} only has ${vocabulary.length} usable vocabulary items`)

  const isL1 = lesson.difficulty.level === 'L1'
  return {
    ...lesson,
    translation: {
      ...lesson.translation,
      prompt: body,
      gradingNotes: ['翻译完整自然段，不遗漏主要事实和逻辑关系。', '允许使用自然中文表达，不要求逐词对应。'],
      legacyKeySentence: originalTranslationPrompt,
    },
    speakingPrompt: body,
    writing: isL1 && !lesson.translation.legacyKeySentence ? {
      promptZh: lesson.translation.referenceZh,
      answers: [originalTranslationPrompt],
      hint: '先写清主语和动作，再检查一般现在时、冠词及介词。',
    } : lesson.writing,
    vocabulary: vocabulary.slice(0, 10),
  }
}

const entries = catalog.entries.map(normalizeLesson)
const nextCatalog = {
  ...catalog,
  version: Math.max(4, Number(catalog.version) + 1),
  normalizedAt: new Date().toISOString(),
  entries,
}

await writeFile(catalogPath, `${JSON.stringify(nextCatalog, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({
  catalog: catalogPath,
  lessons: entries.length,
  vocabulary: {
    minimum: Math.min(...entries.map((lesson) => lesson.vocabulary.length)),
    maximum: Math.max(...entries.map((lesson) => lesson.vocabulary.length)),
  },
  l1WritingExample: entries.find((lesson) => lesson.difficulty.level === 'L1')?.writing,
}, null, 2))
