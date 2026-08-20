import { tencentCapabilities, translateTencentText } from './tencent-cloud.mjs'

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

function gradeTranslation(lesson, answer, reference, referenceProvider) {
  const normalizedAnswer = normalizeChinese(answer)
  const normalizedReference = normalizeChinese(reference)
  const similarity = diceCoefficient(normalizedAnswer, normalizedReference)
  const lengthRatio = clamp(normalizedAnswer.length / Math.max(normalizedReference.length, 1), 0, 1)
  const accuracy = round(clamp(30 + similarity * 68, 0, 100))
  const completeness = round(clamp(20 + lengthRatio * 80, 0, 100))
  const logic = round(clamp(42 + similarity * 53, 0, 100))
  const context = round(clamp(36 + similarity * 59, 0, 100))
  const naturalness = round(clamp(52 + Math.min(normalizedAnswer.length / 3, 44), 0, 96))
  const score = round(accuracy * 0.4 + completeness * 0.2 + logic * 0.15 + context * 0.15 + naturalness * 0.1)
  return {
    score,
    correct: score >= 75,
    summary: score >= 85 ? '全文主要信息完整，中文表达自然。' : score >= 70 ? '全文核心意思基本到位，仍可补足细节或逻辑关系。' : '与全文关键信息仍有明显偏差，建议对照参考译文重写。',
    strengths: [lengthRatio >= 0.8 ? '全文主要信息覆盖较完整。' : '已经抓住部分核心信息。'],
    improvements: similarity >= 0.62 ? ['进一步调整中文语序，让段落衔接更自然。'] : ['逐句核对主语、动作及因果或转折关系，避免遗漏。'],
    dimensions: [
      { label: '信息准确度', score: accuracy, weight: 40 },
      { label: '完整度', score: completeness, weight: 20 },
      { label: '语法和逻辑', score: logic, weight: 15 },
      { label: '词义与语境', score: context, weight: 15 },
      { label: '中文自然度', score: naturalness, weight: 10 },
    ],
    reference,
    graderType: referenceProvider === 'tencent-tmt' ? 'tencent-tmt-rubric' : 'local',
    modelVersion: referenceProvider === 'tencent-tmt' ? 'tencent-tmt+translation-rubric-3' : 'translation-rubric-3',
  }
}

function gradeWriting(lesson, answer) {
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
    strengths: [best.score >= 0.65 ? '句子核心结构正确。' : '已经使用与题意相关的词汇。'],
    improvements: best.score >= 0.65 ? ['检查冠词、介词和动词形式。'] : ['先还原题目中的主语、谓语和关键信息。'],
    dimensions: [
      { label: '语法准确度', score: grammar, weight: 45 },
      { label: '词汇与表达', score: vocabulary, weight: 25 },
      { label: '信息完整度', score: completeness, weight: 30 },
    ],
    reference: best.reference,
    graderType: 'local',
    modelVersion: 'level-aware-writing-rubric-3',
  }
}

export function gradingCapabilities() {
  return {
    provider: 'tencent-and-rules',
    enabled: true,
    model: tencentCapabilities().cloudTranslation ? 'tencent-tmt+rules' : 'rules-only',
  }
}

export async function gradeSubmission(type, lesson, answer) {
  const value = String(answer ?? '').trim()
  if (!value) throw new Error('请先填写可批改的答案')
  if (value.length > 12_000) throw new Error('答案过长，请精简后再提交')
  if (type === 'speaking') {
    const error = new Error('口语必须提交真实录音，并使用腾讯智聆口语评测。')
    error.statusCode = 400
    throw error
  }
  if (type === 'writing') return gradeWriting(lesson, value)
  let reference = lesson.translation.referenceZh
  let referenceProvider = 'catalog'
  if (tencentCapabilities().cloudTranslation) {
    reference = await translateTencentText(lesson.body)
    referenceProvider = 'tencent-tmt'
  }
  return gradeTranslation(lesson, value, reference, referenceProvider)
}
