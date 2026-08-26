import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../server/migrations.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDirectory = join(root, 'tmp', 'word-sources')
const databasePath = resolve(root, process.env.AI_ENGLISH_DB_PATH ?? 'data/ai-english.sqlite')
const minimumDictionarySize = Math.max(20_000, Number(process.env.WORD_LIBRARY_MINIMUM ?? 30_000))

const sourceBooks = [
  {
    id: 'cet6-yu-2021-disordered',
    name: '六级词汇词根+联想记忆法·乱序版',
    shortName: '六级红宝书',
    description: '六级核心词、词根联想、派生词与真题例句',
    edition: 'ISBN 978-7-5722-1818-7',
    sourceKind: 'epub',
    path: 'C:/Users/张作明/Downloads/六级词汇词根+联想记忆法 乱序版 (俞敏洪) (z-library.sk, 1lib.sk, z-lib.sk).epub',
    parser: 'cet6',
    sortOrder: 30,
  },
  {
    id: 'toefl-yu-2012-disordered',
    name: 'TOEFL词汇词根+联想记忆法·乱序版',
    shortName: '托福绿宝书',
    description: '约4500个核心词及同义、派生和同源词',
    edition: '2012年9月版 · ISBN 978-7-5605-4296-6',
    sourceKind: 'azw',
    path: 'C:/Users/张作明/Downloads/托福词汇词根+联想记忆法(乱序版)▪ 新东方绿宝书系列 (俞敏洪) (z-library.sk, 1lib.sk, z-lib.sk).azw',
    parser: 'generic',
    sortOrder: 10,
  },
  {
    id: 'ielts-yu-disordered',
    name: '雅思词汇词根+联想记忆法·乱序版',
    shortName: '雅思红宝书',
    description: '雅思核心词、词根词缀、搭配与例句',
    edition: '用户提供电子版',
    sourceKind: 'epub',
    path: 'C:/Users/张作明/Downloads/雅思词汇词根 联想记忆法：乱序版 (俞敏洪) (z-library.sk, 1lib.sk, z-lib.sk).epub',
    parser: 'generic',
    sortOrder: 20,
  },
]

const officialSources = [
  {
    id: 'oxford-3000-5000',
    name: 'Oxford 3000 & 5000',
    shortName: 'Oxford 核心词',
    description: 'Oxford Learner’s Dictionaries A1-C1 核心词表',
    edition: '2026-08-20 页面快照',
    sourceKind: 'official-html',
    path: join(sourceDirectory, 'oxford-3000-5000.html'),
    sortOrder: 110,
  },
  {
    id: 'oxford-phrase-list',
    name: 'Oxford Phrase List',
    shortName: 'Oxford 词组',
    description: 'A1-C1 常用词组、搭配和短语动词',
    edition: '2026-08-20 页面快照',
    sourceKind: 'official-html',
    path: join(sourceDirectory, 'oxford-phrase-list.html'),
    sortOrder: 120,
  },
  {
    id: 'cambridge-a2-2025',
    name: 'Cambridge A2 Key Vocabulary List',
    shortName: 'Cambridge A2',
    description: 'A2 Key 与 A2 Key for Schools 官方词表',
    edition: 'August 2025',
    sourceKind: 'official-pdf',
    path: join(sourceDirectory, 'cambridge-a2-2025.txt'),
    sortOrder: 130,
  },
  {
    id: 'cambridge-b1-2025',
    name: 'Cambridge B1 Preliminary Vocabulary List',
    shortName: 'Cambridge B1',
    description: 'B1 Preliminary 与 Preliminary for Schools 官方词表',
    edition: 'August 2025',
    sourceKind: 'official-pdf',
    path: join(sourceDirectory, 'cambridge-b1-2025.txt'),
    sortOrder: 140,
  },
  {
    id: 'open-english-wordnet-2025',
    name: 'Open English WordNet 2025',
    shortName: '综合查词总库',
    description: '开放英文词汇网络；用于扩展查词、词性、英文释义和例句',
    edition: '2025 Edition',
    sourceKind: 'official-database',
    path: join(sourceDirectory, 'english-wordnet-2025.zip'),
    sortOrder: 150,
  },
]

const ENTITY_MAP = {
  amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ', shy: '',
  aelig: 'æ', AElig: 'Æ', ndash: '-', mdash: '-', hellip: '…', middot: '·',
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/giu, (match, name) => ENTITY_MAP[name] ?? match)
}

function cleanText(value) {
  return decodeEntities(String(value ?? ''))
    .replace(/\u0000/gu, '')
    .replace(/[\uFFFD]+/gu, '')
    .replace(/[\u00A0\t\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function stripTags(value) {
  return cleanText(String(value ?? '')
    .replace(/<script\b[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/giu, ' ')
    .replace(/<br\s*\/?\s*>/giu, ' ')
    .replace(/<[^>]+>/gu, ' '))
}

function normalizedHeadword(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[’`]/gu, "'")
    .replace(/[.…]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

function isUsefulHeadword(value) {
  const normalized = normalizedHeadword(value)
  return normalized.length >= 1
    && normalized.length <= 72
    && /^[a-z][a-z0-9'./ -]*$/u.test(normalized)
    && normalized.split(/\s+/u).length <= 8
    && !/^(word list|using this book|introduction|preface|contents?|unit \d+)$/iu.test(normalized)
}

function parseExample(value) {
  const text = cleanText(value).replace(/^(?:【(?:例|真)】|例[：\s]*)/u, '').trim()
  const chineseIndex = text.search(/[\u3400-\u9fff]/u)
  if (chineseIndex < 0) return { exampleEn: text, exampleZh: '' }
  return {
    exampleEn: text.slice(0, chineseIndex).replace(/\/+$/u, '').trim(),
    exampleZh: text.slice(chineseIndex).trim(),
  }
}

function parsePart(value) {
  const text = cleanText(value)
  const matches = [...text.matchAll(/(?:^|\s)(n|v|vi|vt|adj|adv|prep|conj|pron|det|num|art|aux|modal|exclam)\./giu)]
  return [...new Set(matches.map((match) => match[1].toLowerCase()))].join(', ')
}

function createEntry(headword, values = {}) {
  const normalized = normalizedHeadword(headword)
  return {
    headword: cleanText(headword).replace(/\*+$/u, '').trim(),
    normalized,
    entryType: normalized.includes(' ') ? 'phrase' : 'word',
    ipa: cleanText(values.ipa ?? '').replace(/^[\[［/\s]+|[\]］/\s]+$/gu, ''),
    partOfSpeech: cleanText(values.partOfSpeech ?? ''),
    meaningZh: cleanText(values.meaningZh ?? ''),
    definitionEn: cleanText(values.definitionEn ?? ''),
    roots: cleanText(values.roots ?? ''),
    memoryNote: cleanText(values.memoryNote ?? ''),
    exampleEn: cleanText(values.exampleEn ?? ''),
    exampleZh: cleanText(values.exampleZh ?? ''),
    forms: values.forms ?? {},
    sourceSummary: cleanText(values.sourceSummary ?? ''),
    frequencyRank: Number.isFinite(values.frequencyRank) ? values.frequencyRank : null,
    cefr: cleanText(values.cefr ?? '').toUpperCase(),
  }
}

function mergeEntry(target, incoming, preferIncoming = false) {
  for (const field of ['headword', 'ipa', 'partOfSpeech', 'meaningZh', 'definitionEn', 'roots', 'memoryNote', 'exampleEn', 'exampleZh', 'cefr']) {
    if ((preferIncoming && incoming[field]) || (!target[field] && incoming[field])) target[field] = incoming[field]
  }
  target.forms = { ...(target.forms ?? {}), ...(incoming.forms ?? {}) }
  if (incoming.frequencyRank !== null && (target.frequencyRank === null || incoming.frequencyRank < target.frequencyRank)) {
    target.frequencyRank = incoming.frequencyRank
  }
  const sources = new Set([...(target.sourceSummary || '').split(' · '), ...(incoming.sourceSummary || '').split(' · ')].filter(Boolean))
  target.sourceSummary = [...sources].join(' · ')
  return target
}

function archiveMembers(archivePath) {
  return execFileSync('tar', ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
}

function archiveText(archivePath, member) {
  return execFileSync('tar', ['-xOf', archivePath, member], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
}

function htmlBlocks(html) {
  const blocks = []
  for (const match of String(html).matchAll(/<(p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/giu)) {
    blocks.push({ attributes: match[2], html: match[3], text: stripTags(match[3]) })
  }
  return blocks
}

function finalizeBookEntry(entries, raw, sourceName) {
  if (!raw || !isUsefulHeadword(raw.headword)) return
  const entry = createEntry(raw.headword, {
    ...raw,
    partOfSpeech: raw.partOfSpeech || parsePart(raw.meaningZh),
    sourceSummary: sourceName,
  })
  if (!entry.meaningZh && !entry.ipa) return
  const existing = entries.get(entry.normalized)
  entries.set(entry.normalized, existing ? mergeEntry(existing, entry, true) : entry)
}

function parseCet6Html(html, sourceName) {
  const entries = new Map()
  let current = null
  for (const block of htmlBlocks(html)) {
    const className = block.attributes.match(/class=["']([^"']+)["']/iu)?.[1] ?? ''
    if (className.split(/\s+/u).includes('bodycontent-none')) {
      const headword = block.text.match(/^([A-Za-z][A-Za-z'’ -]{0,70})\s+(\[[^\]]+\](?:\s*\/\s*\[[^\]]+\])?)$/u)
      if (headword) {
        finalizeBookEntry(entries, current, sourceName)
        current = { headword: headword[1], ipa: headword[2], meaningZh: '', roots: '', memoryNote: '', exampleEn: '', exampleZh: '' }
      }
      continue
    }
    if (!current || !block.text) continue
    if (/^【记】/u.test(block.text)) current.roots ||= block.text.replace(/^【记】\s*/u, '')
    else if (/^【(?:例|真)】/u.test(block.text)) Object.assign(current, parseExample(block.text))
    else if (/^【(?:考|派|辨|搭)】/u.test(block.text)) current.memoryNote = [current.memoryNote, block.text].filter(Boolean).join(' ')
    else if (!current.meaningZh) current.meaningZh = block.text
  }
  finalizeBookEntry(entries, current, sourceName)
  return entries
}

function parseGenericHtml(html, sourceName) {
  const blocks = htmlBlocks(html)
  const entries = new Map()
  let current = null
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const candidate = block.text.replace(/[\]*]+$/gu, '').replace(/^\]+/gu, '').trim()
    const next = blocks[index + 1]?.text ?? ''
    const boldHeadword = /<font\b[^>]*size=["']?4["']?[^>]*>[\s\S]*?<b>/iu.test(block.html)
      || /^\s*<b>/iu.test(block.html)
    const nextIsIpa = /^[［\[].{1,80}[］\]]$/u.test(next)
    if (boldHeadword && nextIsIpa && isUsefulHeadword(candidate)) {
      finalizeBookEntry(entries, current, sourceName)
      current = { headword: candidate, ipa: next, meaningZh: '', roots: '', memoryNote: '', exampleEn: '', exampleZh: '' }
      index += 1
      continue
    }
    if (!current || !block.text) continue
    const text = block.text
    if (/^(?:记|【记】)/u.test(text)) current.roots ||= text.replace(/^(?:记|【记】)\s*/u, '')
    else if (/^(?:例|【例】|【真】)/u.test(text)) Object.assign(current, parseExample(text))
    else if (/^(?:派|参|考|用|搭|辨|同|反|注|联|真|【)/u.test(text)) current.memoryNote = [current.memoryNote, text].filter(Boolean).join(' ')
    else if (!current.meaningZh && /[\u3400-\u9fff]/u.test(text)) current.meaningZh = text
  }
  finalizeBookEntry(entries, current, sourceName)
  return entries
}

function extractEpubBook(book) {
  const members = archiveMembers(book.path).filter((name) => /\.(?:xhtml|html|htm)$/iu.test(name))
  const aggregate = new Map()
  for (const member of members) {
    const html = archiveText(book.path, member)
    const parsed = book.parser === 'cet6' ? parseCet6Html(html, book.shortName) : parseGenericHtml(html, book.shortName)
    for (const [key, entry] of parsed) aggregate.set(key, aggregate.has(key) ? mergeEntry(aggregate.get(key), entry, true) : entry)
  }
  return aggregate
}

function decompressPalmDoc(input) {
  const output = []
  for (let index = 0; index < input.length;) {
    const value = input[index++]
    if (value === 0) output.push(0)
    else if (value <= 8) {
      for (let count = 0; count < value && index < input.length; count += 1) output.push(input[index++])
    } else if (value <= 0x7f) output.push(value)
    else if (value <= 0xbf) {
      if (index >= input.length) break
      const pair = (value << 8) | input[index++]
      const distance = (pair >> 3) & 0x7ff
      const length = (pair & 7) + 3
      const start = output.length - distance
      if (start < 0) continue
      for (let count = 0; count < length; count += 1) output.push(output[start + count])
    } else output.push(0x20, value ^ 0x80)
  }
  return Buffer.from(output)
}

function extractMobiHtml(path) {
  const buffer = readFileSync(path)
  const recordCount = buffer.readUInt16BE(76)
  const offsets = []
  for (let index = 0; index < recordCount; index += 1) offsets.push(buffer.readUInt32BE(78 + index * 8))
  offsets.push(buffer.length)
  const recordZero = offsets[0]
  const compression = buffer.readUInt16BE(recordZero)
  const textLength = buffer.readUInt32BE(recordZero + 4)
  const textRecords = buffer.readUInt16BE(recordZero + 8)
  const encryption = buffer.readUInt16BE(recordZero + 12)
  if (buffer.subarray(recordZero + 16, recordZero + 20).toString('ascii') !== 'MOBI') throw new Error('AZW 不是可识别的 MOBI 容器')
  if (encryption !== 0) throw new Error('AZW 带有 DRM，无法导入')
  const parts = []
  for (let index = 1; index <= textRecords; index += 1) {
    const record = buffer.subarray(offsets[index], offsets[index + 1])
    parts.push(compression === 2 ? decompressPalmDoc(record) : record)
  }
  return Buffer.concat(parts).subarray(0, textLength).toString('utf8')
}

function parseOfficialOxford(path, listId, sourceName, phrase = false) {
  const html = readFileSync(path, 'utf8')
  const entries = new Map()
  const attribute = phrase ? 'data-oxford_phrase_list' : 'data-ox(?:3000|5000)'
  const pattern = new RegExp(`<li\\b[^>]*data-hw=["']([^"']+)["'][^>]*${attribute}=["']([a-c][12])["'][^>]*>`, 'giu')
  let order = 0
  for (const match of html.matchAll(pattern)) {
    const headword = decodeEntities(match[1]).replace(/\.{3}|…/gu, '').trim()
    if (!isUsefulHeadword(headword)) continue
    const entry = createEntry(headword, { cefr: match[2], sourceSummary: sourceName })
    entry.listId = listId
    entry.itemOrder = ++order
    const existing = entries.get(entry.normalized)
    entries.set(entry.normalized, existing ? mergeEntry(existing, entry) : entry)
  }
  return entries
}

function parseCambridgeText(path, sourceName, cefr) {
  const entries = new Map()
  let order = 0
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    const line = cleanText(rawLine).replace(/^[•·-]\s*/u, '')
    const match = line.match(/^([A-Za-z][A-Za-z' -]{0,55})\s+\(([^)]{1,24})\)\s*$/u)
    if (!match || !isUsefulHeadword(match[1])) continue
    const entry = createEntry(match[1], { partOfSpeech: match[2], cefr, sourceSummary: sourceName })
    entry.itemOrder = ++order
    const existing = entries.get(entry.normalized)
    entries.set(entry.normalized, existing ? mergeEntry(existing, entry) : entry)
  }
  return entries
}

function readWordNetMember(member) {
  return archiveText(join(sourceDirectory, 'english-wordnet-2025.zip'), `oewn2025/${member}`)
}

function wordNetLemma(senseKey) {
  return senseKey.slice(0, senseKey.indexOf('%')).replaceAll('_', ' ').replace(/\\([0-9a-f]{2})/giu, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
}

function selectWordNetEntries(limit, existingKeys) {
  const ranked = new Map()
  for (const line of readWordNetMember('index.sense').split(/\r?\n/u)) {
    if (!line || line.startsWith(' ')) continue
    const [senseKey, , , rawCount] = line.trim().split(/\s+/u)
    const headword = wordNetLemma(senseKey)
    if (!isUsefulHeadword(headword)) continue
    const normalized = normalizedHeadword(headword)
    const item = ranked.get(normalized) ?? { headword, count: 0 }
    item.count += Number(rawCount) || 0
    ranked.set(normalized, item)
  }
  const selected = [...ranked.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0], 'en'))
    .slice(0, Math.max(limit, 20_000))
  const targets = new Set([...existingKeys, ...selected.map(([key]) => key)])
  const entries = new Map()
  const orderByKey = new Map(selected.map(([key], index) => [key, index + 1]))
  const posMap = { noun: 'n', verb: 'v', adj: 'adj', adv: 'adv' }
  for (const type of Object.keys(posMap)) {
    for (const line of readWordNetMember(`data.${type}`).split(/\r?\n/u)) {
      if (!/^\d/u.test(line)) continue
      const separator = line.indexOf('|')
      if (separator < 0) continue
      const left = line.slice(0, separator).trim().split(/\s+/u)
      const wordCount = Number.parseInt(left[3], 16)
      const words = []
      for (let index = 0; index < wordCount; index += 1) words.push(left[4 + index * 2].replaceAll('_', ' '))
      const gloss = cleanText(line.slice(separator + 1))
      const example = [...gloss.matchAll(/"([^"]+)"/gu)][0]?.[1] ?? ''
      const definition = gloss.replace(/;\s*"[^"]+"/gu, '').trim()
      for (const headword of words) {
        const normalized = normalizedHeadword(headword)
        if (!targets.has(normalized) || !isUsefulHeadword(headword)) continue
        const incoming = createEntry(headword, {
          partOfSpeech: posMap[type], definitionEn: definition, exampleEn: example,
          sourceSummary: 'Open English WordNet 2025', frequencyRank: orderByKey.get(normalized) ?? null,
        })
        const current = entries.get(normalized)
        if (!current) entries.set(normalized, incoming)
        else {
          if (!current.definitionEn.includes(definition) && current.definitionEn.split('；').length < 3) {
            current.definitionEn = [current.definitionEn, definition].filter(Boolean).join('；')
          }
          const parts = new Set(current.partOfSpeech.split(', ').filter(Boolean))
          parts.add(posMap[type])
          current.partOfSpeech = [...parts].join(', ')
          if (!current.exampleEn && example) current.exampleEn = example
        }
      }
    }
  }
  return { entries, orderByKey }
}

function parseCsvLine(line) {
  const fields = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quoted && character === '"' && line[index + 1] === '"') {
      value += '"'
      index += 1
    } else if (character === '"') quoted = !quoted
    else if (character === ',' && !quoted) {
      fields.push(value)
      value = ''
    } else value += character
  }
  fields.push(value)
  return fields
}

function parseForms(exchange) {
  const result = {}
  for (const part of String(exchange ?? '').split('/')) {
    const match = part.match(/^([a-z]+):(.+)$/iu)
    if (match) result[match[1]] = match[2]
  }
  return result
}

async function enrichFromEcdict(entries) {
  const targets = new Set(entries.keys())
  const stream = createInterface({ input: createReadStream(join(sourceDirectory, 'ecdict.csv'), { encoding: 'utf8' }), crlfDelay: Infinity })
  let header = null
  let enriched = 0
  for await (const line of stream) {
    if (!header) {
      header = parseCsvLine(line)
      continue
    }
    const values = parseCsvLine(line)
    const row = Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))
    const normalized = normalizedHeadword(row.word)
    if (!targets.has(normalized)) continue
    const entry = entries.get(normalized)
    const incoming = createEntry(row.word, {
      ipa: row.phonetic,
      partOfSpeech: row.pos,
      meaningZh: row.translation.replaceAll('\\n', '；'),
      definitionEn: row.definition.replaceAll('\\n', '；'),
      forms: parseForms(row.exchange),
      sourceSummary: 'ECDICT 字段补充',
      frequencyRank: Math.min(Number(row.frq) || Number.MAX_SAFE_INTEGER, Number(row.bnc) || Number.MAX_SAFE_INTEGER),
    })
    mergeEntry(entry, incoming)
    enriched += 1
  }
  return enriched
}

function mergeMap(target, source, preferIncoming = false) {
  for (const [key, entry] of source) target.set(key, target.has(key) ? mergeEntry(target.get(key), entry, preferIncoming) : entry)
}

function ensureSources() {
  const all = [...sourceBooks, ...officialSources]
  for (const source of all) {
    if (!existsSync(source.path)) throw new Error(`缺少词库来源：${source.path}`)
  }
  if (!existsSync(join(sourceDirectory, 'ecdict.csv'))) throw new Error('缺少 ECDICT 字段补充文件')
  if (!existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`)
}

function importIntoDatabase(entries, memberships, listMetadata) {
  const database = new DatabaseSync(databasePath)
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;')
  runMigrations(database)
  const now = new Date().toISOString()
  const upsertList = database.prepare(`
    INSERT INTO word_lists(id, name, short_name, description, edition, source_kind, source_reference,
      entry_count, study_enabled, sort_order, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name,
      description=excluded.description, edition=excluded.edition, source_kind=excluded.source_kind,
      source_reference=excluded.source_reference, study_enabled=excluded.study_enabled,
      sort_order=excluded.sort_order, active=1, updated_at=excluded.updated_at
  `)
  const upsertEntry = database.prepare(`
    INSERT INTO dictionary_entries(headword, normalized, entry_type, ipa, part_of_speech, meaning_zh,
      definition_en, roots, memory_note, example_en, example_zh, forms_json, source_summary,
      frequency_rank, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized) DO UPDATE SET headword=excluded.headword, entry_type=excluded.entry_type,
      ipa=excluded.ipa, part_of_speech=excluded.part_of_speech, meaning_zh=excluded.meaning_zh,
      definition_en=excluded.definition_en, roots=excluded.roots, memory_note=excluded.memory_note,
      example_en=excluded.example_en, example_zh=excluded.example_zh, forms_json=excluded.forms_json,
      source_summary=excluded.source_summary, frequency_rank=excluded.frequency_rank,
      updated_at=excluded.updated_at
  `)
  const entryId = database.prepare('SELECT id FROM dictionary_entries WHERE normalized = ?')
  const insertMembership = database.prepare(`
    INSERT OR REPLACE INTO word_list_entries(word_list_id, entry_id, item_order, source_detail_json)
    VALUES(?, ?, ?, ?)
  `)
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const list of listMetadata) {
      upsertList.run(list.id, list.name, list.shortName, list.description, list.edition, list.sourceKind,
        String(list.path), list.studyEnabled ? 1 : 0, list.sortOrder, now, now)
      database.prepare('DELETE FROM word_list_entries WHERE word_list_id = ?').run(list.id)
    }
    for (const entry of entries.values()) {
      upsertEntry.run(entry.headword, entry.normalized, entry.entryType, entry.ipa, entry.partOfSpeech,
        entry.meaningZh, entry.definitionEn, entry.roots, entry.memoryNote, entry.exampleEn || null,
        entry.exampleZh || null, JSON.stringify(entry.forms ?? {}), entry.sourceSummary,
        Number.isFinite(entry.frequencyRank) ? entry.frequencyRank : null, now, now)
    }
    for (const membership of memberships) {
      const row = entryId.get(membership.normalized)
      if (row) insertMembership.run(membership.listId, row.id, membership.itemOrder, JSON.stringify(membership.detail ?? {}))
    }
    for (const list of listMetadata) {
      database.prepare(`UPDATE word_lists SET entry_count = (SELECT COUNT(*) FROM word_list_entries WHERE word_list_id = ?) WHERE id = ?`).run(list.id, list.id)
    }
    try { database.exec("INSERT INTO dictionary_fts(dictionary_fts) VALUES('rebuild')") } catch { /* optional FTS */ }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  const stats = {
    entries: Number(database.prepare('SELECT COUNT(*) AS count FROM dictionary_entries').get().count),
    phrases: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries WHERE entry_type = 'phrase'").get().count),
    withChinese: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries WHERE meaning_zh <> ''").get().count),
    withIpa: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries WHERE ipa <> ''").get().count),
    withExamples: Number(database.prepare("SELECT COUNT(*) AS count FROM dictionary_entries WHERE example_en IS NOT NULL AND example_en <> ''").get().count),
    lists: database.prepare('SELECT id, name, entry_count AS entryCount FROM word_lists WHERE active = 1 ORDER BY sort_order').all(),
  }
  database.close()
  return stats
}

async function main() {
  ensureSources()
  const entries = new Map()
  const memberships = []
  const metadata = [
    ...sourceBooks.map((book) => ({ ...book, studyEnabled: true })),
    ...officialSources.map((source) => ({ ...source, studyEnabled: false })),
  ]
  const sourceReports = []

  for (const book of sourceBooks) {
    const parsed = book.sourceKind === 'azw'
      ? parseGenericHtml(extractMobiHtml(book.path), book.shortName)
      : extractEpubBook(book)
    mergeMap(entries, parsed, true)
    let order = 0
    for (const key of parsed.keys()) memberships.push({ listId: book.id, normalized: key, itemOrder: ++order })
    sourceReports.push({ id: book.id, file: basename(book.path), parsed: parsed.size })
  }

  const officialMaps = [
    [officialSources[0], parseOfficialOxford(officialSources[0].path, officialSources[0].id, officialSources[0].shortName)],
    [officialSources[1], parseOfficialOxford(officialSources[1].path, officialSources[1].id, officialSources[1].shortName, true)],
    [officialSources[2], parseCambridgeText(officialSources[2].path, officialSources[2].shortName, 'A2')],
    [officialSources[3], parseCambridgeText(officialSources[3].path, officialSources[3].shortName, 'B1')],
  ]
  for (const [source, parsed] of officialMaps) {
    mergeMap(entries, parsed)
    let order = 0
    for (const [key, entry] of parsed) memberships.push({ listId: source.id, normalized: key, itemOrder: entry.itemOrder ?? ++order, detail: { cefr: entry.cefr } })
    sourceReports.push({ id: source.id, file: basename(source.path), parsed: parsed.size })
  }

  const neededFromWordNet = Math.max(minimumDictionarySize - entries.size + 2_000, 22_000)
  const wordNet = selectWordNetEntries(neededFromWordNet, entries.keys())
  mergeMap(entries, wordNet.entries)
  let wordNetOrder = 0
  for (const key of wordNet.entries.keys()) memberships.push({ listId: officialSources[4].id, normalized: key, itemOrder: wordNet.orderByKey.get(key) ?? ++wordNetOrder })
  sourceReports.push({ id: officialSources[4].id, file: basename(officialSources[4].path), parsed: wordNet.entries.size })

  const enriched = await enrichFromEcdict(entries)
  const stats = importIntoDatabase(entries, memberships, metadata)
  if (stats.entries < 20_000) throw new Error(`词典数量不足：${stats.entries}`)
  const report = {
    generatedAt: new Date().toISOString(), database: databasePath, minimumRequired: 20_000,
    sourceReports, ecdictEnriched: enriched, ...stats,
    fingerprint: createHash('sha256').update(JSON.stringify({ sourceReports, entries: stats.entries })).digest('hex'),
  }
  writeFileSync(join(root, 'content', 'word-library-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(report, null, 2))
}

await main()
