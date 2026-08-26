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

const l1WritingOverrides = new Map([
  ['lesson-cdc-short-walk', ['我每天可以步行十分钟。', ['I can walk for ten minutes every day.', 'I can walk ten minutes every day.', 'I can take a ten-minute walk every day.']]],
  ['lesson-epa-food-waste', ['我可以规划饮食，减少食物浪费。', ['I can plan meals and waste less food.', 'I can plan my meals and waste less food.']]],
  ['lesson-nasa-earth-atmosphere', ['地球的大气层帮助保护生命。', ["Earth's atmosphere helps protect life.", 'The atmosphere helps protect life on Earth.']]],
  ['lesson-noaa-ocean-blue', ['水会吸收一部分颜色的光。', ['Water absorbs some colors of light.', 'Water can absorb some colors of light.']]],
  ['lesson-noaa-rip-current', ['我可以在水中保持冷静。', ['I can stay calm in the water.', 'I can remain calm in the water.']]],
  ['lesson-noaa-weather-climate', ['天气和气候并不相同。', ['Weather and climate are different.', 'Weather is different from climate.']]],
  ['lesson-epa-water-saving', ['我可以在家少用一些水。', ['I can use less water at home.', 'I can save water at home.']]],
  ['lesson-epa-home-compost', ['食物残渣可以变成有用的堆肥。', ['Food scraps can become useful compost.', 'Food scraps can make useful compost.']]],
  ['lesson-cdc-sleep-routine', ['安静的房间可以帮助我入睡。', ['A quiet room can help me sleep.', 'A calm room can help me sleep.']]],
  ['lesson-cdc-clean-hands', ['我用肥皂洗手。', ['I wash my hands with soap.', 'I use soap to wash my hands.']]],
  ['lesson-cdc-food-safety', ['干净的食物有助于保护人们。', ['Clean food helps keep people safe.', 'Safe food helps protect people.']]],
  ['lesson-cdc-sun-safety', ['我可以在阳光下戴帽子。', ['I can wear a hat in sunlight.', 'I can wear a hat in the sun.']]],
  ['lesson-nist-strong-passwords', ['我使用一个又长又独特的密码。', ['I use a long and unique password.', 'My password is long and unique.']]],
  ['lesson-wiki-324', ['奥斯卡奖表彰优秀电影。', ['The Academy Awards honor films.', 'The Oscars honor good films.']]],
  ['lesson-wiki-30543', ['阿尔罕布拉宫位于西班牙。', ['The Alhambra is in Spain.', 'You can find Alhambra in Spain.']]],
])

const secondaryWritingOverrides = new Map([
  ['lesson-cdc-short-walk', ['我可以走楼梯。', ['I can take the stairs.']]],
  ['lesson-epa-food-waste', ['我可以先查看冰箱。', ['I can check the refrigerator first.']]],
  ['lesson-nasa-earth-atmosphere', ['海洋覆盖地球大部分表面。', ["Oceans cover most of Earth's surface."]]],
  ['lesson-noaa-ocean-blue', ['蓝光更容易回到我们的眼睛。', ['Blue light reaches our eyes more easily.']]],
  ['lesson-noaa-rip-current', ['离岸流会把人带离岸边。', ['A rip current can carry people away from shore.']]],
  ['lesson-noaa-weather-climate', ['天气描述我们身边的短期状况。', ['Weather describes short-term conditions around us.']]],
  ['lesson-epa-water-saving', ['漏水每天都会浪费水。', ['Leaks can waste water every day.']]],
  ['lesson-epa-home-compost', ['空气和水分帮助材料分解。', ['Air and moisture help materials break down.']]],
  ['lesson-cdc-sleep-routine', ['规律的时间表有助于睡眠。', ['A regular schedule can support better sleep.']]],
  ['lesson-cdc-clean-hands', ['我洗手大约二十秒。', ['I wash my hands for about twenty seconds.']]],
  ['lesson-cdc-food-safety', ['我把生肉和其他食物分开。', ['I keep raw meat separate from other food.']]],
  ['lesson-cdc-sun-safety', ['防晒霜可以保护暴露的皮肤。', ['Sunscreen can protect exposed skin.']]],
  ['lesson-nist-strong-passwords', ['每个重要账户都需要不同的密码。', ['Every important account needs a unique password.']]],
])

const l1WritingBanks = {
  daily: [
    ['我可以每天养成一个好习惯。', ['I can build one good habit every day.', 'I can form one good habit every day.']],
    ['我可以每天做一会儿运动。', ['I can exercise for a short time every day.', 'I can do some exercise every day.']],
    ['我可以每天做出更健康的选择。', ['I can make healthier choices every day.', 'I can choose healthier things every day.']],
    ['我可以慢慢改变一个习惯。', ['I can change one habit slowly.', 'I can slowly change one habit.']],
  ],
  nature: [
    ['我们可以一起保护自然。', ['We can protect nature together.', 'We can all protect nature.']],
    ['我今天可以少用一些塑料。', ['I can use less plastic today.', 'I can use less plastic.']],
    ['清洁的水对每个人都很重要。', ['Clean water is important for everyone.', 'Everyone needs safe and clean water.']],
    ['我们应该保持这个地方干净。', ['We should keep this place clean.', 'We can keep this place clean.']],
  ],
  science: [
    ['科学帮助我们理解世界。', ['Science helps us understand the world.', 'Science can help us understand the world.']],
    ['我今天可以学习一个新事实。', ['I can learn one new fact today.', 'I can learn a new fact today.']],
    ['我们可以认真检验一个想法。', ['We can test an idea carefully.', 'We can carefully test an idea.']],
    ['科技可以解决简单的问题。', ['Technology can solve simple problems.', 'Technology helps solve simple problems.']],
  ],
  society: [
    ['人们可以从过去学习。', ['People can learn from the past.', 'We can learn from the past.']],
    ['文化可以连接不同的人。', ['Culture can connect different people.', 'Culture brings different people together.']],
    ['我可以尊重不同的想法。', ['I can respect different ideas.', 'I can respect other ideas.']],
    ['每个地方都有自己的故事。', ['Every place has its own story.', 'Each place has its own story.']],
  ],
}

function stableIndex(value, size) {
  return [...String(value)].reduce((sum, character) => sum + character.codePointAt(0), 0) % size
}

function createL1Writing(lesson) {
  const override = l1WritingOverrides.get(lesson.id)
  let template = override
  if (!template) {
    const topic = lesson.topic
    const group = /环境|海洋|地球|气候|自然|旅行/u.test(topic)
      ? 'nature'
      : /科学|太空|数学|科技|逻辑/u.test(topic)
        ? 'science'
        : /文化|历史|人物|社会|世界|文明|思想|艺术|地理/u.test(topic)
          ? 'society'
          : 'daily'
    template = l1WritingBanks[group][stableIndex(lesson.id, l1WritingBanks[group].length)]
  }
  return {
    promptZh: template[0],
    answers: template[1],
    hint: '先写主语，再用一般现在时、be 动词或 can 写一个简单动作。',
  }
}

function compactEnglishTitle(title) {
  const words = String(title).replace(/\([^)]*\)/gu, '').match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? ['this', 'topic']
  return words.slice(0, 3).join(' ')
}

function createArticleWriting(lesson) {
  if (!lesson.id.startsWith('lesson-wiki-')) return lesson.difficulty.level === 'L1' ? createL1Writing(lesson) : lesson.writing
  const shortTitle = compactEnglishTitle(lesson.title)
  const displayTitle = lesson.titleZh || lesson.title
  if (lesson.difficulty.level === 'L1') {
    return {
      promptZh: `这篇文章向读者介绍了“${displayTitle}”。`,
      answers: [`This article introduces ${shortTitle} to readers.`],
      hint: '先写 This article，再用 introduces 写出当前文章的主题。',
    }
  }
  if (lesson.difficulty.level === 'L2') {
    return {
      promptZh: `这篇文章解释了“${displayTitle}”及其重要背景。`,
      answers: [`The article explains ${shortTitle} and its important context.`],
      hint: '使用 explains...and... 连接文章主题与背景。',
    }
  }
  return {
    promptZh: `理解“${displayTitle}”需要把文中的证据与更广泛的背景联系起来。`,
    answers: [`Understanding ${shortTitle} requires connecting its evidence with broader context.`],
    hint: '使用 Understanding...requires... 表达理解当前主题所需要的条件。',
  }
}

function createSecondaryWriting(lesson) {
  const override = secondaryWritingOverrides.get(lesson.id)
  if (override) {
    return {
      secondaryPromptZh: override[0],
      secondaryAnswers: override[1],
      secondaryHint: '保持与第一题相同的短句难度，练习文章中的另一个要点。',
    }
  }

  const shortTitle = compactEnglishTitle(lesson.title)
  const displayTitle = lesson.titleZh || lesson.title
  if (lesson.difficulty.level === 'L1') {
    return {
      secondaryPromptZh: `我们可以了解“${displayTitle}”。`,
      secondaryAnswers: [`We can learn about ${shortTitle}.`],
      secondaryHint: '使用 We can learn about... 写一个不含从句的短句。',
    }
  }
  if (lesson.difficulty.level === 'L2') {
    return {
      secondaryPromptZh: `读者可以比较关于“${displayTitle}”的关键观点。`,
      secondaryAnswers: [`Readers can compare key ideas about ${shortTitle}.`],
      secondaryHint: '使用 Readers can compare... 表达对文章关键观点的比较。',
    }
  }
  return {
    secondaryPromptZh: `读者可以评估关于“${displayTitle}”的核心论点。`,
    secondaryAnswers: [`Readers can evaluate the main claim about ${shortTitle}.`],
    secondaryHint: '使用 evaluate the main claim 表达对文章核心论点的评估。',
  }
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

  const primaryWriting = createArticleWriting(lesson)
  return {
    ...lesson,
    translation: {
      ...lesson.translation,
      prompt: body,
      gradingNotes: ['翻译完整自然段，不遗漏主要事实和逻辑关系。', '允许使用自然中文表达，不要求逐词对应。'],
      legacyKeySentence: originalTranslationPrompt,
    },
    speakingPrompt: body,
    writing: {
      ...primaryWriting,
      ...createSecondaryWriting(lesson),
    },
    vocabulary: vocabulary.slice(0, 10),
  }
}

const entries = catalog.entries.map(normalizeLesson)
const invalidL1Writing = entries.filter((lesson) => lesson.difficulty.level === 'L1').flatMap((lesson) => {
  const invalidAnswers = [...lesson.writing.answers, ...lesson.writing.secondaryAnswers].filter((answer) => {
    const words = wordCount(answer)
    return words < 5 || words > 9 || /\b(?:although|because|which|while|unless|whereas)\b/iu.test(answer)
  })
  return invalidAnswers.map((answer) => ({ lessonId: lesson.id, answer, words: wordCount(answer) }))
})
if (invalidL1Writing.length) throw new Error(`L1 writing validation failed: ${JSON.stringify(invalidL1Writing.slice(0, 12))}`)
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
  l1WritingValidation: { lessons: entries.filter((lesson) => lesson.difficulty.level === 'L1').length, invalid: invalidL1Writing.length },
}, null, 2))
