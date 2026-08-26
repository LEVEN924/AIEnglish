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

function splitEnglishSentences(value) {
  return String(value).match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? []
}

function splitChineseSentences(value) {
  return String(value).match(/[^。！？!?]+[。！？!?]+|[^。！？!?]+$/gu)?.map((sentence) => sentence.trim()).filter(Boolean) ?? []
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
  const referenceParts = splitChineseSentences(reference)
  const answerParts = splitChineseSentences(answer)
  const sourceParts = referenceParts.length > 1
    ? splitEnglishSentences(lesson.body)
    : [lesson.translation.legacyKeySentence ?? lesson.translation.prompt ?? lesson.body]
  const segmentCount = Math.max(sourceParts.length, referenceParts.length)
  const segments = Array.from({ length: segmentCount }, (_, index) => {
    const segmentReference = referenceParts[index] ?? ''
    const segmentAnswer = answerParts[index] ?? ''
    return {
      index,
      source: sourceParts[index] ?? '',
      answer: segmentAnswer,
      reference: segmentReference,
      score: segmentReference ? round(diceCoefficient(normalizeChinese(segmentAnswer), normalizeChinese(segmentReference)) * 100) : 0,
    }
  }).filter((segment) => segment.source || segment.reference)
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
    referenceScope: referenceParts.length > 1 ? 'full' : 'excerpt',
    segments,
    graderType: referenceProvider === 'tencent-tmt' ? 'tencent-tmt-rubric' : 'local',
    modelVersion: referenceProvider === 'tencent-tmt' ? 'tencent-tmt+translation-rubric-3' : 'translation-rubric-3',
  }
}

function normalizeStrictEnglish(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[’`]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.!?]+$/gu, '')
}

function englishTokens(value) {
  return String(value).match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []
}

function gradeWriting(lesson, answer, promptIndex = 0) {
  const isSecondPrompt = Number(promptIndex) === 1
  const references = isSecondPrompt
    ? (lesson.writing.secondaryAnswers?.length
        ? lesson.writing.secondaryAnswers
        : [lesson.translation.legacyKeySentence || splitEnglishSentences(lesson.body)[0] || lesson.title])
    : lesson.writing.answers
  const similarities = references.map((reference) => ({
    reference,
    score: Math.max(tokenF1(answer, reference), diceCoefficient(normalizeEnglish(answer), normalizeEnglish(reference))),
  })).sort((left, right) => right.score - left.score)
  const best = similarities[0]
  const correct = references.some((reference) => normalizeStrictEnglish(answer) === normalizeStrictEnglish(reference))
  const answerTokens = englishTokens(answer)
  const referenceTokens = englishTokens(best.reference)
  const corrections = Array.from({ length: Math.max(answerTokens.length, referenceTokens.length) }, (_, index) => {
    if (answerTokens[index] === referenceTokens[index]) return ''
    if (!answerTokens[index]) return `补上 “${referenceTokens[index]}”`
    if (!referenceTokens[index]) return `删去多余的 “${answerTokens[index]}”`
    return `“${answerTokens[index]}” → “${referenceTokens[index]}”`
  }).filter(Boolean).slice(0, 5)
  const caseOnlyDifference = !correct && normalizeEnglish(answer) === normalizeEnglish(best.reference)
  const lexicalAccuracy = correct ? 100 : Math.min(70, round(best.score * 100))
  const grammar = correct ? 100 : Math.min(74, round(20 + best.score * 72))
  const completeness = correct ? 100 : Math.min(74, round(10 + tokenF1(answer, best.reference) * 80))
  const relevance = correct ? 100 : Math.min(74, round(25 + best.score * 65))
  const rawScore = round(grammar * 0.3 + lexicalAccuracy * 0.35 + completeness * 0.2 + relevance * 0.15)
  const score = correct ? 100 : Math.min(74, rawScore)
  return {
    score,
    correct,
    summary: correct ? '单词、词形、大小写和句子结构全部正确。' : '句意可能接近，但仍有单词、词形、大小写或结构错误，本题不判为正确。',
    strengths: [correct ? '完整匹配本题接受的正确英文表达。' : best.score >= 0.65 ? '句子大意已经接近参考表达。' : '已经尝试写出完整英文句子。'],
    improvements: [caseOnlyDifference ? '单词内容接近，但大小写不正确；请特别检查句首和代词 I。' : corrections.length ? `逐词检查：${corrections.join('；')}。` : '请逐词对照参考表达，检查拼写、词形和语序。'],
    dimensions: [
      { label: '单词与词形', score: lexicalAccuracy, weight: 35 },
      { label: '语法与大小写', score: grammar, weight: 30 },
      { label: '信息完整度', score: completeness, weight: 20 },
      { label: '文章相关度', score: relevance, weight: 15 },
    ],
    reference: best.reference,
    prompt: isSecondPrompt ? (lesson.writing.secondaryPromptZh || lesson.translation.referenceZh) : lesson.writing.promptZh,
    graderType: 'local',
    modelVersion: 'strict-article-translation-rubric-1',
  }
}

export function gradingCapabilities() {
  return {
    provider: 'tencent-and-rules',
    enabled: true,
    model: tencentCapabilities().cloudTranslation ? 'tencent-tmt+rules' : 'rules-only',
  }
}

export async function gradeSubmission(type, lesson, answer, metadata = null) {
  const value = String(answer ?? '').trim()
  if (!value) throw new Error('请先填写可批改的答案')
  if (value.length > 12_000) throw new Error('答案过长，请精简后再提交')
  if (type === 'speaking') {
    const error = new Error('口语必须提交真实录音，并使用腾讯智聆口语评测。')
    error.statusCode = 400
    throw error
  }
  if (type === 'writing') return gradeWriting(lesson, value, metadata?.promptIndex)
  let reference = lesson.translation.referenceZh
  let referenceProvider = 'catalog'
  if (tencentCapabilities().cloudTranslation) {
    try {
      reference = await translateTencentText(lesson.body)
      referenceProvider = 'tencent-tmt'
    } catch {
      referenceProvider = 'catalog'
    }
  }
  return gradeTranslation(lesson, value, reference, referenceProvider)
}
