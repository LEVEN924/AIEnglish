import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backup, DatabaseSync } from 'node:sqlite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2] ?? 'verify'

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, '-').replace('T', '_').replace('Z', '')
}

function verifyDatabase(databasePath) {
  if (!existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`)
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check)
    if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`Integrity check failed: ${integrity.join(', ')}`)
    const schemaVersion = database.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get()?.value ?? 'unknown'
    const lessons = database.prepare('SELECT COUNT(*) AS count FROM lesson_segments WHERE active = 1').get()?.count ?? 0
    return { integrity: 'ok', schemaVersion: Number(schemaVersion), lessons: Number(lessons) }
  } finally {
    database.close()
  }
}

async function pruneBackups(directory, keep = 14) {
  if (!existsSync(directory)) return
  const files = await readdir(directory)
  const backups = []
  for (const file of files.filter((value) => value.endsWith('.sqlite'))) {
    const path = join(directory, file)
    backups.push({ path, modified: (await stat(path)).mtimeMs })
  }
  backups.sort((left, right) => right.modified - left.modified)
  for (const item of backups.slice(keep)) await rm(item.path, { force: true })
}

const databasePath = resolve(root, argument('--database', 'data/ai-english.sqlite'))

if (command === 'verify') {
  console.log(JSON.stringify({ database: databasePath, ...verifyDatabase(databasePath) }, null, 2))
} else if (command === 'backup') {
  const backupDirectory = resolve(root, argument('--directory', 'backups'))
  const outputPath = argument('--output', join(backupDirectory, `ai-english_${timestamp()}.sqlite`))
  await mkdir(dirname(outputPath), { recursive: true })
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try {
    await backup(source, outputPath)
  } finally {
    source.close()
  }
  const result = verifyDatabase(outputPath)
  await pruneBackups(backupDirectory)
  console.log(JSON.stringify({ backup: outputPath, ...result }, null, 2))
} else if (command === 'restore') {
  const sourcePath = resolve(argument('--from', ''))
  if (!sourcePath || !existsSync(sourcePath)) throw new Error('Provide an existing backup with --from <path>')
  const runtimePidPath = join(root, '.runtime', 'ai-english.pid')
  if (databasePath === resolve(root, 'data/ai-english.sqlite') && existsSync(runtimePidPath)) {
    const processId = Number((await readFile(runtimePidPath, 'utf8')).trim())
    try {
      process.kill(processId, 0)
      throw new Error('Stop AIEnglish before restoring the live database')
    } catch (error) {
      if (error.message === 'Stop AIEnglish before restoring the live database') throw error
    }
  }
  verifyDatabase(sourcePath)
  await mkdir(dirname(databasePath), { recursive: true })
  for (const suffix of ['-wal', '-shm']) await rm(`${databasePath}${suffix}`, { force: true })
  await copyFile(sourcePath, databasePath)
  console.log(JSON.stringify({ restoredFrom: basename(sourcePath), database: databasePath, ...verifyDatabase(databasePath) }, null, 2))
} else {
  throw new Error(`Unknown database command: ${command}`)
}
