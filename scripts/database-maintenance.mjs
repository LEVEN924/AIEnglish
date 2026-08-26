import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, extname } from 'node:path'
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
  for (const file of files.filter((value) => /^ai-english_\d{4}-\d{2}-\d{2}_[\d-]+\.sqlite$/u.test(value))) {
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
  const outputPath = resolve(argument('--output', join(backupDirectory, `ai-english_${timestamp()}.sqlite`)))
  if (outputPath.toLowerCase() === databasePath.toLowerCase() || existsSync(outputPath)) throw new Error('Backup output must be a new file, distinct from the source database')
  await mkdir(dirname(outputPath), { recursive: true })
  const source = new DatabaseSync(databasePath, { readOnly: true })
  try {
    await backup(source, outputPath)
  } finally {
    source.close()
  }
  const result = verifyDatabase(outputPath)
  // Retention deletion is explicit; ordinary startup backups never remove files.
  if (process.argv.includes('--prune')) await pruneBackups(backupDirectory)
  console.log(JSON.stringify({ backup: outputPath, ...result }, null, 2))
} else if (command === 'restore') {
  const sourceArg = argument('--from', '')
  if (!sourceArg) throw new Error('Provide an existing backup with --from <path>')
  const sourcePath = resolve(sourceArg)
  if (!existsSync(sourcePath) || sourcePath.toLowerCase() === databasePath.toLowerCase() || extname(databasePath) !== '.sqlite') throw new Error('Restore requires distinct source and target .sqlite paths')
  if (existsSync(databasePath) && !process.argv.includes('--replace')) throw new Error('Target exists. Stop its server, then use --replace to create a safety backup and replace it.')
  if (existsSync(`${databasePath}-wal`) || existsSync(`${databasePath}-shm`)) throw new Error('Target has WAL/SHM files. Close all database connections cleanly before restoring; no files were removed.')
  const runtimePidPath = join(root, '.runtime', 'ai-english.pid')
  if (databasePath === resolve(root, 'data/ai-english.sqlite') && existsSync(runtimePidPath)) {
    const processId = Number((await readFile(runtimePidPath, 'utf8')).trim())
    try {
      process.kill(processId, 0)
      throw new Error('Stop AIEnglish before restoring the live database')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
  verifyDatabase(sourcePath)
  await mkdir(dirname(databasePath), { recursive: true })
  if (existsSync(databasePath)) {
    const safetyPath = `${databasePath}.before-restore-${timestamp()}`
    await copyFile(databasePath, safetyPath)
    console.log(JSON.stringify({ safetyBackup: safetyPath }))
  }
  await copyFile(sourcePath, databasePath)
  console.log(JSON.stringify({ restoredFrom: basename(sourcePath), database: databasePath, ...verifyDatabase(databasePath) }, null, 2))
} else {
  throw new Error(`Unknown database command: ${command}`)
}
