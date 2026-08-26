import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

// Read-only aggregate audit: no learner answers or recordings are exported.
const path = resolve(process.env.AI_ENGLISH_DB_PATH || 'data/ai-english.sqlite')
const db = new DatabaseSync(path, { readOnly: true })
try {
  const totals = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN TRIM(COALESCE(ipa,'')) = '' THEN 1 ELSE 0 END) AS missingIpa,
    SUM(CASE WHEN entry_type='word' AND TRIM(COALESCE(ipa,'')) = '' THEN 1 ELSE 0 END) AS missingWordIpa,
    SUM(CASE WHEN entry_type='phrase' AND TRIM(COALESCE(ipa,'')) = '' THEN 1 ELSE 0 END) AS missingPhraseIpa,
    SUM(CASE WHEN TRIM(COALESCE(example_en,'')) = '' THEN 1 ELSE 0 END) AS missingExample
    FROM dictionary_entries`).get()
  const lists = db.prepare(`SELECT l.id, l.name, COUNT(*) AS total,
    SUM(CASE WHEN TRIM(COALESCE(e.ipa,'')) = '' THEN 1 ELSE 0 END) AS missingIpa,
    SUM(CASE WHEN TRIM(COALESCE(e.example_en,'')) = '' THEN 1 ELSE 0 END) AS missingExample
    FROM word_lists l JOIN word_list_entries m ON m.word_list_id=l.id JOIN dictionary_entries e ON e.id=m.entry_id
    WHERE l.active=1 AND l.study_enabled=1 GROUP BY l.id`).all()
  console.log(JSON.stringify({ totals, lists, note: 'Missing examples/IPA are content curation gaps; do not invent pronunciations or present this structural audit as a semantic review.' }, null, 2))
} finally { db.close() }
