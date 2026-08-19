function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value, digits = 0) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function normalizeEnglish(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9'\s]/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function normalizeChinese(value) {
  return [...String(value)].filter((character) => /[\p{Script=Han}a-z0-9]/iu.test(character)).join('').toLowerCase()
}

function ngrams(value, size = 2) {
  if (value.length <= size) return value ? [value] : []
  return Array.from({ length: value.length - size + 1 }, (_, index) => value.slice(index, index + size))
}

function diceCoefficient(left, right) {
  const leftParts = ngrams(left)
  const rightParts = ngrams(right)
  if (!leftParts.length || !rightParts.length) return 0
  const counts = new Map()
  for (const part of leftParts) counts.set(part, (counts.get(part) ?? 0) + 1)
  let matches = 0
  for (const part of rightParts) {
    const count = counts.get(part) ?? 0
    if (count > 0) {
      matches += 1
      counts.set(part, count - 1)
    }
  }
  return (2 * matches) / (leftParts.length + rightParts.length)
}

function tokenF1(left, right) {
  const leftTokens = normalizeEnglish(left).split(' ').filter(Boolean)
  const rightTokens = normalizeEnglish(right).split(' ').filter(Boolean)
  if (!leftTokens.length || !rightTokens.length) return 0
  const rightCounts = new Map()
  for (const token of rightTokens) rightCounts.set(token, (rightCounts.get(token) ?? 0) + 1)
  let matches = 0
  for (const token of leftTokens) {
    const count = rightCounts.get(token) ?? 0
    if (count > 0) {
      matches += 1
      rightCounts.set(token, count - 1)
    }
  }
  const precision = matches / leftTokens.length
  const recall = matches / rightTokens.length
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0
}

function gradeTranslationLocally(lesson, answer) {
  const normalizedAnswer = normalizeChinese(answer)
  const normalizedReference = normalizeChinese(lesson.translation.referenceZh)
  const similarity = diceCoefficient(normalizedAnswer, normalizedReference)
  const lengthRatio = clamp(normalizedAnswer.length / Math.max(normalizedReference.length, 1), 0, 1)
  const accuracy = round(clamp(38 + similarity * 58, 0, 100))
  const completeness = round(clamp(32 + lengthRatio * 68, 0, 100))
  const logic = round(clamp(50 + similarity * 45, 0, 100))
  const context = round(clamp(42 + similarity * 52, 0, 100))
  const naturalness = round(clamp(58 + Math.min(normalizedAnswer.length, 30), 0, 96))
  const score = round(accuracy * 0.4 + completeness * 0.2 + logic * 0.15 + context * 0.15 + naturalness * 0.1)
  return {
    score,
    correct: score >= 75,
    summary: score >= 85 ? '信息完整，中文表达自然。' : score >= 70 ? '核心意思基本到位，仍可补足细节或逻辑关系。' : '目前与原句关键信息仍有明显偏差，建议对照参考译文重写。',
    strengths: [lengthRatio >= 0.8 ? '主要信息覆盖较完整。' : '已经抓住了部分核心信息。'],
    improvements: similarity >= 0.62 ? ['进一步调整中文语序，让表达更自然。'] : ['核对主语、动作和因果/转折关系，避免遗漏关键词。'],
    dimensions: [
      { label: '信息准确度', score: accuracy, weight: 40 },
      { label: '完整度', score: completeness, weight: 20 },
      { label: '语法和逻辑', score: logic, weight: 15 },
      { label: '词义与语境', score: context, weight: 15 },
      { label: '中文自然度', score: naturalness, weight: 10 },
    ],
    reference: lesson.translation.referenceZh,
    graderType: 'local',
    modelVersion: 'local-rubric-2',
  }
}

function gradeWritingLocally(lesson, answer) {
  const similarities = lesson.writing.answers.map((reference) => ({
    reference,
    score: Math.max(tokenF1(answer, reference), diceCoefficient(normalizeEnglish(answer), normalizeEnglish(reference))),
  })).sort((left, right) => right.score - left.score)
  const best = similarities[0]
  const grammar = round(clamp(35 + best.score * 65, 0, 100))
  const vocabulary = round(clamp(45 + best.score * 55, 0, 100))
  const completeness = round(clamp(30 + tokenF1(answer, best.reference) * 70, 0, 100))
  const score = round(grammar * 0.45 + vocabulary * 0.25 + completeness * 0.3)
  return {
    score,
    correct: score >= 82,
    summary: score >= 90 ? '表达准确自然，可以直接使用。' : score >= 82 ? '意思和结构正确，只有轻微表达差异。' : '表达尚未完全匹配题意，请根据提示再试一次。',
    strengths: [best.score >= 0.65 ? '句子核心结构正确。' : '已经使用了与题意相关的词汇。'],
    improvements: best.score >= 0.65 ? ['检查冠词、介词和动词形式。'] : ['先还原题目中的主语、谓语和关键信息。'],
    dimensions: [
      { label: '语法准确度', score: grammar, weight: 45 },
      { label: '词汇与表达', score: vocabulary, weight: 25 },
      { label: '信息完整度', score: completeness, weight: 30 },
    ],
    reference: best.reference,
    graderType: 'local',
    modelVersion: 'local-rubric-2',
  }
}

function gradeSpeakingLocally(lesson, transcript) {
  const normalized = normalizeEnglish(transcript)
  const words = normalized.split(' ').filter(Boolean)
  const promptKeywords = normalizeEnglish(`${lesson.speakingPrompt} ${lesson.keyIdeaZh}`)
    .split(' ').filter((word) => word.length > 4)
  const keywordCoverage = promptKeywords.length
    ? promptKeywords.filter((word) => normalized.includes(word)).length / promptKeywords.length
    : 0.5
  const lengthScore = clamp(words.length / 42, 0, 1)
  const diversity = words.length ? new Set(words).size / words.length : 0
  const fillerCount = words.filter((word) => ['um', 'uh', 'like', 'actually'].includes(word)).length
  const fillerRatio = words.length ? fillerCount / words.length : 1
  const pronunciation = round(clamp(4.5 + keywordCoverage * 4 + lengthScore, 0, 10), 1)
  const fluency = round(clamp(3.8 + lengthScore * 4.5 + (1 - fillerRatio) * 1.2, 0, 10), 1)
  const intonation = round(clamp(4.8 + lengthScore * 3.2, 0, 10), 1)
  const grammar = round(clamp(4.2 + diversity * 3 + lengthScore * 1.5, 0, 10), 1)
  const vocabulary = round(clamp(4 + diversity * 4 + keywordCoverage * 1.5, 0, 10), 1)
  const score = round(pronunciation * 0.3 + fluency * 0.25 + intonation * 0.15 + grammar * 0.15 + vocabulary * 0.15, 1)
  return {
    score,
    correct: score >= 6,
    summary: score >= 8 ? '表达完整，词汇覆盖和流畅度良好。' : score >= 6 ? '已经达到本轮要求，可继续增加细节和连贯性。' : '有效表达过短或偏离主题，需要补充后重新提交。',
    strengths: [words.length >= 20 ? '回答具有可评估的完整长度。' : '已经开始围绕题目组织表达。'],
    improvements: words.length < 20 ? ['至少说出 3–4 个完整句子，并加入一个理由或例子。'] : ['减少填充词，用连接词组织观点。'],
    dimensions: [
      { label: '内容与发音线索', score: pronunciation, weight: 30 },
      { label: '流利度和停顿', score: fluency, weight: 25 },
      { label: '重音与语调', score: intonation, weight: 15 },
      { label: '语法准确度', score: grammar, weight: 15 },
      { label: '词汇与表达', score: vocabulary, weight: 15 },
    ],
    reference: lesson.speakingPrompt,
    graderType: 'local',
    modelVersion: 'local-rubric-2',
  }
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    score: { type: 'number' },
    correct: { type: 'boolean' },
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    improvements: { type: 'array', items: { type: 'string' } },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, score: { type: 'number' }, weight: { type: 'number' } },
        required: ['label', 'score', 'weight'],
      },
    },
    reference: { type: 'string' },
  },
  required: ['score', 'correct', 'summary', 'strengths', 'improvements', 'dimensions', 'reference'],
}

async function gradeWithOpenAI(type, lesson, answer, localResult) {
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_MODEL
  if (!apiKey || !model) return null
  const scale = type === 'speaking' ? '0-10' : '0-100'
  const task = type === 'translation'
    ? `Translate prompt: ${lesson.translation.prompt}\nReference: ${lesson.translation.referenceZh}`
    : type === 'writing'
      ? `Chinese prompt: ${lesson.writing.promptZh}\nAccepted references: ${lesson.writing.answers.join(' | ')}`
      : `Speaking prompt: ${lesson.speakingPrompt}\nThis is a speech transcript, so do not claim to assess acoustic pronunciation.`
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      store: false,
      input: [
        { role: 'system', content: `You are an English learning grader. Grade on ${scale}. Return concise Simplified Chinese feedback. Preserve the supplied rubric dimensions and weights. For speech transcripts, assess content, fluency signals, grammar and vocabulary; never pretend to hear audio.` },
        { role: 'user', content: `${task}\nLearner answer: ${answer}\nDeterministic baseline: ${JSON.stringify(localResult)}` },
      ],
      text: { format: { type: 'json_schema', name: 'grading_result', strict: true, schema: outputSchema } },
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`OpenAI grading failed with HTTP ${response.status}`)
  const data = await response.json()
  const outputText = data.output?.flatMap((item) => item.content ?? []).find((item) => item.type === 'output_text')?.text
  if (!outputText) throw new Error('OpenAI grading returned no structured output')
  const result = JSON.parse(outputText)
  return { ...result, graderType: 'openai', modelVersion: model }
}

export async function gradeSubmission(type, lesson, answer) {
  const value = String(answer ?? '').trim()
  if (!value) throw new Error('请先填写或生成可评分的答案')
  if (value.length > 8_000) throw new Error('答案过长，请精简后再提交')
  const localResult = type === 'translation'
    ? gradeTranslationLocally(lesson, value)
    : type === 'writing'
      ? gradeWritingLocally(lesson, value)
      : gradeSpeakingLocally(lesson, value)
  try {
    return await gradeWithOpenAI(type, lesson, value, localResult) ?? localResult
  } catch (error) {
    console.warn(`[grading] ${error.message}; falling back to local rubric.`)
    return localResult
  }
}
