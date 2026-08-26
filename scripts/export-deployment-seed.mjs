// Export only shared vocabulary into a NEW database. Never copy learner tables.
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openAppDatabase } from '../server/database.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const sourcePath = resolve(root, option('source') ?? 'data/ai-english.sqlite')
const output = option('output')
if (!output) throw new Error('Provide --output=<NEW private .sqlite file>; do not commit this data.')
const outputPath = resolve(root, output)
if (!outputPath.endsWith('.sqlite') || outputPath === sourcePath || existsSync(outputPath)) {
  throw new Error('Output must be a new, distinct .sqlite file. Existing files are never overwritten.')
}
if (!existsSync(sourcePath)) throw new Error('Source database not found')
const source = new DatabaseSync(sourcePath, { readOnly: true })
source.exec('BEGIN')
mkdirSync(dirname(outputPath), { recursive: true })
const empty = openAppDatabase({ databasePath: outputPath, catalog: { version: 1, entries: [] } })
empty.close()
const target = new DatabaseSync(outputPath)
const counts = {}
try {
  target.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM word_lists;')
  for (const table of ['dictionary_entries', 'dictionary_senses', 'word_lists', 'word_list_entries']) {
    const columns = target.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name)
    const insert = target.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    const rows = source.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all()
    for (const row of rows) {
      // Audio is regenerated on the destination; local absolute source paths are not portable.
      if (table === 'dictionary_entries') { row.audio_status = 'pending'; row.audio_key = null }
      if (table === 'word_lists' && /^[A-Z]:[\\/]/iu.test(row.source_reference)) row.source_reference = row.source_reference.split(/[\\/]/u).at(-1)
      insert.run(...columns.map((column) => row[column]))
    }
    counts[table] = rows.length
  }
  for (const table of ['users', 'sessions', 'speaking_recordings', 'submissions', 'learning_profiles', 'word_review_attempts']) {
    if (target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count !== 0) throw new Error(`Unexpected private data in ${table}`)
  }
  if (target.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Seed foreign key check failed')
  if (target.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Seed integrity check failed')
  target.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);')
  console.log(JSON.stringify({ ok: true, output: outputPath, counts, users: 0, recordings: 0, lessons: 'loaded from content/lessons.json on first start' }, null, 2))
} catch (error) {
  try { target.exec('ROLLBACK') } catch { /* Keep the failed output for inspection; never replace it silently. */ }
  throw error
} finally {
  source.exec('ROLLBACK')
  source.close()
  target.close()
}
