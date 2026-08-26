import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations.mjs'

const STEP_IDS = new Set(['guide', 'listening', 'translation', 'speaking', 'writing', 'summary'])

function isoNow() {
  return new Date().toISOString()
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback
  } catch {
    return fallback
  }
}

function toBoolean(value) {
  return value === true || value === 1
}

function normalizedTokens(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9'\s]/gu, ' ').split(/\s+/u).filter(Boolean)
}

function answerSimilarity(left, right) {
  const a = normalizedTokens(left)
  const b = normalizedTokens(right)
  if (!a.length || !b.length) return 0
  const counts = new Map()
  for (const token of b) counts.set(token, (counts.get(token) ?? 0) + 1)
  let matches = 0
  for (const token of a) {
    const remaining = counts.get(token) ?? 0
    if (remaining > 0) {
      matches += 1
      counts.set(token, remaining - 1)
    }
  }
  return (2 * matches) / (a.length + b.length)
}

function normalizeWordAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’`]/gu, "'")
    .replace(/[^a-z0-9'\-\s\u3400-\u9fff]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

function wordVariants(entry) {
  const values = [entry.headword]
  for (const value of Object.values(entry.forms ?? {})) {
    const items = Array.isArray(value) ? value : String(value ?? '').split(/[,;/|]/u)
    for (const item of items) {
      const normalized = String(item).trim()
      if (normalized) values.push(normalized)
    }
  }
  return [...new Set(values)]
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function createWordCloze(entry) {
  const example = String(entry.exampleEn ?? '').trim()
  if (!example) return null
  const candidates = wordVariants(entry).sort((left, right) => right.length - left.length)
  for (const candidate of candidates) {
    const pattern = new RegExp(`(^|[^A-Za-z])(${escapeRegex(candidate)})(?=$|[^A-Za-z])`, 'iu')
    const match = example.match(pattern)
    if (!match) continue
    const answer = match[2]
    return {
      text: example.replace(pattern, (_, prefix) => `${prefix}${'_'.repeat(Math.max(5, answer.length))}`),
      answer,
    }
  }
  return null
}

function chooseWordStudyMode(entry) {
  if ((entry.progressState ?? 'new') === 'new' || entry.repetitions <= 0) return 'meaning'
  if (entry.repetitions === 1) return 'spelling'
  if (entry.repetitions % 3 === 2 && createWordCloze(entry)) return 'cloze'
  if (entry.repetitions % 3 === 0) return 'listening'
  return 'spelling'
}

function defaultWordStudyStats() {
  return {
    reviewed: 0,
    correct: 0,
    firstPassCorrect: 0,
    lapses: 0,
    hints: 0,
    responseMs: 0,
    newLearned: 0,
    weakEntryIds: [],
    modeStats: {},
  }
}

function defaultRecord(timestamp = isoNow()) {
  return {
    completedSteps: [],
    skipped: false,
    startedAt: timestamp,
    updatedAt: timestamp,
    listeningNotes: '',
    translationDraft: '',
    writingDraft: '',
    writingAttempts: 0,
    writingTasks: [
      { draft: '', attempts: 0 },
      { draft: '', attempts: 0 },
    ],
  }
}

function normalizeWritingTasks(record, storedTasks = record?.writingTasks) {
  const tasks = Array.isArray(storedTasks) ? storedTasks : []
  const legacy = {
    draft: String(record?.writingDraft ?? ''),
    attempts: Math.max(0, Number(record?.writingAttempts) || 0),
    ...(typeof record?.writingCorrect === 'boolean' ? { correct: record.writingCorrect } : {}),
    ...(record?.writingFeedback ? { feedback: record.writingFeedback } : {}),
  }
  return [tasks[0] ?? legacy, tasks[1] ?? { draft: '', attempts: 0 }].map((task) => ({
    draft: String(task?.draft ?? ''),
    attempts: Math.max(0, Number(task?.attempts) || 0),
    ...(typeof task?.correct === 'boolean' ? { correct: task.correct } : {}),
    ...(task?.feedback ? { feedback: task.feedback } : {}),
  }))
}

function writingScoreFromTasks(tasks, fallbackCorrect = false) {
  const scores = tasks.map((task) => Number(task.feedback?.score)).filter(Number.isFinite)
  if (scores.length) return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length)
  return fallbackCorrect ? 92 : 0
}

function withTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function createSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      target_exam TEXT NOT NULL DEFAULT '日常英语',
      preferred_level TEXT NOT NULL DEFAULT 'L2',
      daily_goal_minutes INTEGER NOT NULL DEFAULT 20,
      interests_json TEXT NOT NULL DEFAULT '[]',
      reminder_time TEXT,
      current_lesson_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS content_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      publisher TEXT NOT NULL,
      canonical_url TEXT NOT NULL UNIQUE,
      source_title TEXT NOT NULL,
      rights_note TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS source_articles (
      id TEXT PRIMARY KEY,
      source_id INTEGER NOT NULL REFERENCES content_sources(id),
      canonical_url TEXT NOT NULL,
      title TEXT NOT NULL,
      published_at TEXT,
      updated_at TEXT,
      accessed_at TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL UNIQUE,
      extraction_status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lesson_segments (
      id TEXT PRIMARY KEY,
      source_article_id TEXT NOT NULL REFERENCES source_articles(id),
      slug TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      title_zh TEXT NOT NULL,
      topic TEXT NOT NULL,
      difficulty_level TEXT NOT NULL CHECK (difficulty_level IN ('L1', 'L2', 'L3')),
      cefr TEXT NOT NULL,
      estimated_minutes INTEGER NOT NULL,
      body TEXT NOT NULL,
      quality_total INTEGER NOT NULL,
      lesson_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS lessons_active_order_idx ON lesson_segments(active, sort_order);
    CREATE INDEX IF NOT EXISTS lessons_level_idx ON lesson_segments(difficulty_level, active);
    CREATE INDEX IF NOT EXISTS lessons_topic_idx ON lesson_segments(topic, active);

    CREATE TABLE IF NOT EXISTS lesson_sentences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      sentence_order INTEGER NOT NULL,
      text TEXT NOT NULL,
      start_ms INTEGER,
      end_ms INTEGER,
      UNIQUE(lesson_id, sentence_order)
    );

    CREATE TABLE IF NOT EXISTS lesson_vocabulary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      item_order INTEGER NOT NULL,
      term TEXT NOT NULL,
      ipa TEXT NOT NULL,
      part TEXT NOT NULL,
      meaning TEXT NOT NULL,
      example TEXT,
      UNIQUE(lesson_id, item_order)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id),
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      total_score INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS lesson_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id),
      completed_steps_json TEXT NOT NULL DEFAULT '[]',
      skipped INTEGER NOT NULL DEFAULT 0,
      listening_notes TEXT NOT NULL DEFAULT '',
      translation_draft TEXT NOT NULL DEFAULT '',
      translation_score INTEGER,
      translation_feedback_json TEXT,
      speaking_score REAL,
      speaking_transcript TEXT,
      speaking_feedback_json TEXT,
      writing_draft TEXT NOT NULL DEFAULT '',
      writing_attempts INTEGER NOT NULL DEFAULT 0,
      writing_correct INTEGER,
      writing_feedback_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, lesson_id)
    );

    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id),
      step_type TEXT NOT NULL CHECK(step_type IN ('translation', 'speaking', 'writing')),
      version INTEGER NOT NULL,
      answer_text TEXT NOT NULL,
      audio_metadata_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, lesson_id, step_type, version)
    );

    CREATE TABLE IF NOT EXISTS grading_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
      total_score REAL NOT NULL,
      dimensions_json TEXT NOT NULL,
      feedback_json TEXT NOT NULL,
      grader_type TEXT NOT NULL,
      model_version TEXT,
      rubric_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS error_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id),
      submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL,
      error_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      user_answer TEXT NOT NULL,
      correction TEXT NOT NULL,
      explanation TEXT NOT NULL,
      mastery INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      error_item_id INTEGER NOT NULL REFERENCES error_items(id) ON DELETE CASCADE,
      interval_days INTEGER NOT NULL DEFAULT 1,
      due_at TEXT NOT NULL,
      completed_at TEXT,
      result TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS review_due_idx ON review_tasks(user_id, completed_at, due_at);

    CREATE TABLE IF NOT EXISTS daily_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id),
      learning_date TEXT NOT NULL,
      total_score INTEGER NOT NULL,
      translation_score INTEGER NOT NULL,
      speaking_score INTEGER NOT NULL,
      writing_score INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, learning_date)
    );
  `)

  database.prepare(`
    INSERT INTO app_metadata(key, value) VALUES('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run()
}

function seedLessons(database, catalog) {
  const now = isoNow()
  const upsertSource = database.prepare(`
    INSERT INTO content_sources(publisher, canonical_url, source_title, rights_note, active, created_at, updated_at)
    VALUES(?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(canonical_url) DO UPDATE SET
      publisher = excluded.publisher,
      source_title = excluded.source_title,
      rights_note = excluded.rights_note,
      active = 1,
      updated_at = excluded.updated_at
  `)
  const getSource = database.prepare('SELECT id FROM content_sources WHERE canonical_url = ?')
  const upsertArticle = database.prepare(`
    INSERT INTO source_articles(
      id, source_id, canonical_url, title, published_at, updated_at, accessed_at,
      raw_text, content_fingerprint, extraction_status, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)
    ON CONFLICT(id) DO UPDATE SET
      source_id = excluded.source_id,
      canonical_url = excluded.canonical_url,
      title = excluded.title,
      published_at = excluded.published_at,
      updated_at = excluded.updated_at,
      accessed_at = excluded.accessed_at,
      raw_text = excluded.raw_text,
      content_fingerprint = excluded.content_fingerprint,
      extraction_status = 'ready'
  `)
  const upsertLesson = database.prepare(`
    INSERT INTO lesson_segments(
      id, source_article_id, slug, sort_order, title, title_zh, topic,
      difficulty_level, cefr, estimated_minutes, body, quality_total,
      lesson_json, active, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      source_article_id = excluded.source_article_id,
      slug = excluded.slug,
      sort_order = excluded.sort_order,
      title = excluded.title,
      title_zh = excluded.title_zh,
      topic = excluded.topic,
      difficulty_level = excluded.difficulty_level,
      cefr = excluded.cefr,
      estimated_minutes = excluded.estimated_minutes,
      body = excluded.body,
      quality_total = excluded.quality_total,
      lesson_json = excluded.lesson_json,
      active = 1,
      updated_at = excluded.updated_at
  `)
  const insertSentence = database.prepare(`
    INSERT INTO lesson_sentences(lesson_id, sentence_order, text) VALUES(?, ?, ?)
  `)
  const insertVocabulary = database.prepare(`
    INSERT INTO lesson_vocabulary(lesson_id, item_order, term, ipa, part, meaning, example)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `)
  const insertArticleDictionaryEntry = database.prepare(`
    INSERT INTO dictionary_entries(
      headword, normalized, entry_type, ipa, part_of_speech, meaning_zh,
      example_en, source_summary, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, '今日学习重点词', ?, ?)
    ON CONFLICT(normalized) DO NOTHING
  `)
  const dictionaryEntryId = database.prepare('SELECT id FROM dictionary_entries WHERE normalized = ? COLLATE NOCASE')
  const insertArticleWordListEntry = database.prepare(`
    INSERT OR IGNORE INTO word_list_entries(word_list_id, entry_id, item_order, source_detail_json)
    VALUES('article-vocabulary', ?, ?, ?)
  `)

  withTransaction(database, () => {
    database.exec('UPDATE lesson_segments SET active = 0; UPDATE content_sources SET active = 0;')
    database.prepare(`
      INSERT INTO word_lists(id, name, short_name, description, edition, source_kind, source_reference,
        entry_count, study_enabled, sort_order, active, created_at, updated_at)
      VALUES('article-vocabulary', '当前文章重点词', '文章重点词', '优先学习当前文章，再延伸到精读内容中的高频词', ?,
        'course', 'content/lessons.json', 0, 1, 100, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name,
        description=excluded.description, edition=excluded.edition, study_enabled=1, active=1, updated_at=excluded.updated_at
    `).run(`内容库 v${catalog.version ?? 1}`, now, now)
    database.prepare("DELETE FROM word_list_entries WHERE word_list_id = 'article-vocabulary'").run()

    catalog.entries.forEach((lesson, index) => {
      const fingerprint = createHash('sha256').update(lesson.body).digest('hex')
      upsertSource.run(
        lesson.source.publisher,
        lesson.source.url,
        lesson.source.title,
        lesson.source.rightsNote ?? '',
        now,
        now,
      )
      const source = getSource.get(lesson.source.url)
      const articleId = `source-${lesson.id}`
      upsertArticle.run(
        articleId,
        source.id,
        lesson.source.url,
        lesson.source.title,
        lesson.source.publishedAt || null,
        lesson.source.updatedAt || null,
        lesson.source.accessedAt,
        lesson.body,
        fingerprint,
        now,
      )
      upsertLesson.run(
        lesson.id,
        articleId,
        lesson.slug,
        index + 1,
        lesson.title,
        lesson.titleZh,
        lesson.topic,
        lesson.difficulty.level,
        lesson.difficulty.cefr,
        lesson.estimatedMinutes,
        lesson.body,
        lesson.quality.total,
        JSON.stringify(lesson),
        now,
        now,
      )

      database.prepare('DELETE FROM lesson_sentences WHERE lesson_id = ?').run(lesson.id)
      const sentences = lesson.body.match(/[^.!?]+[.!?]+|[^.!?]+$/gu) ?? [lesson.body]
      sentences.map((sentence) => sentence.trim()).filter(Boolean).forEach((sentence, sentenceIndex) => {
        insertSentence.run(lesson.id, sentenceIndex, sentence)
      })

      database.prepare('DELETE FROM lesson_vocabulary WHERE lesson_id = ?').run(lesson.id)
      lesson.vocabulary.forEach((item, vocabularyIndex) => {
        insertVocabulary.run(
          lesson.id,
          vocabularyIndex,
          item.term,
          item.ipa,
          item.part,
          item.meaning,
          item.example ?? null,
        )
        const normalized = String(item.term).trim().toLowerCase().replace(/[’`]/gu, "'").replace(/\s+/gu, ' ')
        insertArticleDictionaryEntry.run(
          item.term,
          normalized,
          normalized.includes(' ') ? 'phrase' : 'word',
          item.ipa ?? '',
          item.part ?? '',
          item.meaning ?? '',
          item.example ?? null,
          now,
          now,
        )
        const entry = dictionaryEntryId.get(normalized)
        if (entry) insertArticleWordListEntry.run(entry.id, index * 20 + vocabularyIndex + 1, JSON.stringify({ lessonId: lesson.id }))
      })
    })

    database.prepare(`
      INSERT INTO app_metadata(key, value) VALUES('catalog_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(catalog.version ?? 1))
    database.prepare(`
      INSERT INTO app_metadata(key, value) VALUES('catalog_size', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(catalog.entries.length))
    database.prepare(`
      UPDATE word_lists SET entry_count = (
        SELECT COUNT(*) FROM word_list_entries WHERE word_list_id = 'article-vocabulary'
      ) WHERE id = 'article-vocabulary'
    `).run()
  })
}

export function openAppDatabase({ databasePath, catalog, configuredUser, configuredSalt, configuredHash }) {
  mkdirSync(dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  createSchema(database)
  runMigrations(database)
  seedLessons(database, catalog)

  if (configuredUser && configuredSalt && configuredHash) {
    const now = isoNow()
    database.prepare(`
      INSERT INTO users(username, password_salt, password_hash, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(username) DO UPDATE SET
        password_salt = excluded.password_salt,
        password_hash = excluded.password_hash,
        updated_at = excluded.updated_at
    `).run(configuredUser, configuredSalt, configuredHash, now, now)
    const user = database.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(configuredUser)
    database.prepare(`
      INSERT INTO learning_profiles(user_id, current_lesson_id, updated_at)
      VALUES(?, (SELECT id FROM lesson_segments WHERE active = 1 ORDER BY sort_order LIMIT 1), ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(user.id, now)
  }

  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(isoNow())

  const statements = {
    userByName: database.prepare(`
      SELECT id, username, password_salt AS passwordSalt, password_hash AS passwordHash
      FROM users WHERE username = ? COLLATE NOCASE
    `),
    sessionByToken: database.prepare(`
      SELECT sessions.user_id AS userId, users.username AS user, sessions.expires_at AS expiresAt,
        sessions.last_seen_at AS lastSeenAt
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `),
    lessons: database.prepare(`
      SELECT lesson_json AS lessonJson FROM lesson_segments
      WHERE active = 1 ORDER BY sort_order
    `),
    lessonIds: database.prepare('SELECT id FROM lesson_segments WHERE active = 1'),
    progress: database.prepare(`
      SELECT * FROM lesson_progress WHERE user_id = ? ORDER BY updated_at
    `),
    profile: database.prepare('SELECT * FROM learning_profiles WHERE user_id = ?'),
  }

  // Lesson content is immutable for the lifetime of a server process. Parse it once so
  // concurrent users do not repeatedly deserialize the full 1000-lesson catalog.
  const lessonCache = statements.lessons.all().map((row) => JSON.parse(row.lessonJson))
  const lessonByIdCache = new Map(lessonCache.map((lesson) => [lesson.id, lesson]))
  const validLessonIds = new Set(lessonByIdCache.keys())
  const lessonCatalogCache = lessonCache.map((lesson) => ({
    id: lesson.id,
    slug: lesson.slug,
    title: lesson.title,
    titleZh: lesson.titleZh,
    topic: lesson.topic,
    difficulty: {
      level: lesson.difficulty.level,
      label: lesson.difficulty.label,
      cefr: lesson.difficulty.cefr,
    },
    estimatedMinutes: lesson.estimatedMinutes,
    source: { publisher: lesson.source.publisher },
    quality: { total: lesson.quality.total },
  }))

  function findUser(username) {
    return statements.userByName.get(String(username)) ?? null
  }

  function createUser(username, passwordSalt, passwordHash) {
    const normalizedUsername = String(username).trim()
    if (findUser(normalizedUsername)) throw new Error('用户名已被使用')
    const now = isoNow()
    return withTransaction(database, () => {
      const inserted = database.prepare(`
        INSERT INTO users(username, password_salt, password_hash, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(normalizedUsername, passwordSalt, passwordHash, now, now)
      const userId = Number(inserted.lastInsertRowid)
      database.prepare(`
        INSERT INTO learning_profiles(user_id, current_lesson_id, updated_at)
        VALUES(?, (
          SELECT id FROM lesson_segments
          WHERE active = 1 AND difficulty_level = 'L2'
          ORDER BY sort_order LIMIT 1
        ), ?)
      `).run(userId, now)
      return { id: userId, username: normalizedUsername }
    })
  }

  function createSession(userId, token, expiresAt) {
    const now = isoNow()
    database.prepare(`
      INSERT INTO sessions(token_hash, user_id, expires_at, created_at, last_seen_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(hashToken(token), userId, expiresAt, now, now)
  }

  function getSession(token) {
    if (!token) return null
    const now = isoNow()
    const session = statements.sessionByToken.get(hashToken(token), now)
    if (!session) return null
    if (Date.now() - new Date(session.lastSeenAt).getTime() > 5 * 60_000) {
      database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hashToken(token))
    }
    return session
  }

  function deleteSession(token) {
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  }

  function getLessons() {
    return lessonCache
  }

  function getLesson(lessonId) {
    return lessonByIdCache.get(String(lessonId)) ?? null
  }

  function getLessonCatalog() {
    return lessonCatalogCache
  }

  function speakingRecordingMetadata(row, userId) {
    if (!row) return null
    return {
      url: `/api/audio/recording?lessonId=${encodeURIComponent(row.lessonId)}&userId=${userId}&v=${encodeURIComponent(row.createdAt)}`,
      durationSeconds: Number(row.durationSeconds ?? 0),
      createdAt: row.createdAt,
    }
  }

  function saveSpeakingRecording(userId, lessonId, dataUrl, durationSeconds) {
    const lesson = database.prepare('SELECT id FROM lesson_segments WHERE id = ? AND active = 1').get(String(lessonId))
    if (!lesson) throw new Error('Lesson not found')
    const match = String(dataUrl ?? '').match(/^data:(audio\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/iu)
    if (!match) throw new Error('录音格式无效')
    const audioBuffer = Buffer.from(match[2], 'base64')
    if (audioBuffer.length < 44 || audioBuffer.length > 16 * 1024 * 1024) throw new Error('录音文件大小无效')
    const mimeType = match[1].toLowerCase()
    const now = isoNow()
    database.prepare(`
      INSERT INTO speaking_recordings(user_id, lesson_id, audio_blob, mime_type, duration_seconds, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, lesson_id) DO UPDATE SET audio_blob=excluded.audio_blob,
        mime_type=excluded.mime_type, duration_seconds=excluded.duration_seconds, created_at=excluded.created_at
    `).run(userId, lesson.id, audioBuffer, mimeType, Math.max(0, Number(durationSeconds) || 0), now)
    return speakingRecordingMetadata({ lessonId: lesson.id, durationSeconds, createdAt: now }, userId)
  }

  function getSpeakingRecording(userId, lessonId) {
    const row = database.prepare(`
      SELECT lesson_id AS lessonId, audio_blob AS audioBlob, mime_type AS mimeType,
        duration_seconds AS durationSeconds, created_at AS createdAt
      FROM speaking_recordings WHERE user_id = ? AND lesson_id = ?
    `).get(userId, String(lessonId))
    return row ? { ...row, buffer: Buffer.from(row.audioBlob), metadata: speakingRecordingMetadata(row, userId) } : null
  }

  function getLearningState(userId) {
    const profile = statements.profile.get(userId)
    const speakingRecordings = new Map(database.prepare(`
      SELECT lesson_id AS lessonId, duration_seconds AS durationSeconds, created_at AS createdAt
      FROM speaking_recordings WHERE user_id = ?
    `).all(userId).map((row) => [row.lessonId, speakingRecordingMetadata(row, userId)]))
    const records = {}
    for (const row of statements.progress.all(userId)) {
      const record = {
        completedSteps: parseJson(row.completed_steps_json, []),
        skipped: toBoolean(row.skipped),
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        listeningNotes: row.listening_notes,
        translationDraft: row.translation_draft,
        ...(row.translation_score === null ? {} : { translationScore: row.translation_score }),
        ...(row.translation_feedback_json ? { translationFeedback: parseJson(row.translation_feedback_json, null) } : {}),
        ...(row.speaking_score === null ? {} : { speakingScore: row.speaking_score }),
        ...(row.speaking_transcript ? { speakingTranscript: row.speaking_transcript } : {}),
        ...(row.speaking_feedback_json ? { speakingFeedback: parseJson(row.speaking_feedback_json, null) } : {}),
        writingDraft: row.writing_draft,
        writingAttempts: row.writing_attempts,
        ...(row.writing_correct === null ? {} : { writingCorrect: toBoolean(row.writing_correct) }),
        ...(row.writing_feedback_json ? { writingFeedback: parseJson(row.writing_feedback_json, null) } : {}),
      }
      record.writingTasks = normalizeWritingTasks(record, parseJson(row.writing_tasks_json, []))
      const lastSpeakingRecording = speakingRecordings.get(row.lesson_id)
      if (lastSpeakingRecording) record.lastSpeakingRecording = lastSpeakingRecording
      records[row.lesson_id] = record
    }

    const firstLessonId = lessonCache[0]?.id ?? ''
    const currentLessonId = validLessonIds.has(profile?.current_lesson_id)
      ? profile.current_lesson_id
      : firstLessonId
    if (currentLessonId && !records[currentLessonId]) records[currentLessonId] = defaultRecord()

    return { version: 2, currentLessonId, records }
  }

  function saveLearningState(userId, state) {
    if (!state || state.version !== 2 || !validLessonIds.has(state.currentLessonId)) {
      throw new Error('Invalid learning state')
    }

    const now = isoNow()
    withTransaction(database, () => {
      database.prepare(`
        UPDATE learning_profiles SET current_lesson_id = ?, updated_at = ? WHERE user_id = ?
      `).run(state.currentLessonId, now, userId)

      const upsertProgress = database.prepare(`
        INSERT INTO lesson_progress(
          user_id, lesson_id, completed_steps_json, skipped, listening_notes,
          translation_draft, translation_score, translation_feedback_json,
          speaking_score, speaking_transcript, speaking_feedback_json,
          writing_draft, writing_attempts, writing_correct, writing_feedback_json, writing_tasks_json,
          started_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, lesson_id) DO UPDATE SET
          completed_steps_json = excluded.completed_steps_json,
          skipped = excluded.skipped,
          listening_notes = excluded.listening_notes,
          translation_draft = excluded.translation_draft,
          translation_score = excluded.translation_score,
          translation_feedback_json = excluded.translation_feedback_json,
          speaking_score = excluded.speaking_score,
          speaking_transcript = excluded.speaking_transcript,
          speaking_feedback_json = excluded.speaking_feedback_json,
          writing_draft = excluded.writing_draft,
          writing_attempts = excluded.writing_attempts,
          writing_correct = excluded.writing_correct,
          writing_feedback_json = excluded.writing_feedback_json,
          writing_tasks_json = excluded.writing_tasks_json,
          updated_at = excluded.updated_at
      `)
      const upsertConversation = database.prepare(`
        INSERT INTO conversations(user_id, lesson_id, title, status, total_score, started_at, completed_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, lesson_id) DO UPDATE SET
          title = excluded.title,
          status = excluded.status,
          total_score = excluded.total_score,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `)
      const upsertSummary = database.prepare(`
        INSERT INTO daily_summaries(
          user_id, lesson_id, learning_date, total_score, translation_score,
          speaking_score, writing_score, summary_json, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, learning_date) DO UPDATE SET
          lesson_id = excluded.lesson_id,
          total_score = excluded.total_score,
          translation_score = excluded.translation_score,
          speaking_score = excluded.speaking_score,
          writing_score = excluded.writing_score,
          summary_json = excluded.summary_json
      `)
      for (const [lessonId, rawRecord] of Object.entries(state.records ?? {})) {
        if (!validLessonIds.has(lessonId)) continue
        const record = { ...defaultRecord(), ...rawRecord }
        const writingTasks = normalizeWritingTasks(record)
        const primaryWritingTask = writingTasks[0]
        const completedSteps = [...new Set(record.completedSteps)].filter((step) => STEP_IDS.has(step))
        const updatedAt = record.updatedAt || now
        upsertProgress.run(
          userId,
          lessonId,
          JSON.stringify(completedSteps),
          record.skipped ? 1 : 0,
          String(record.listeningNotes ?? ''),
          String(record.translationDraft ?? ''),
          Number.isFinite(record.translationScore) ? record.translationScore : null,
          record.translationFeedback ? JSON.stringify(record.translationFeedback) : null,
          Number.isFinite(record.speakingScore) ? record.speakingScore : null,
          record.speakingTranscript ? String(record.speakingTranscript) : null,
          record.speakingFeedback ? JSON.stringify(record.speakingFeedback) : null,
          primaryWritingTask.draft,
          primaryWritingTask.attempts,
          typeof primaryWritingTask.correct === 'boolean' ? Number(primaryWritingTask.correct) : null,
          primaryWritingTask.feedback ? JSON.stringify(primaryWritingTask.feedback) : null,
          JSON.stringify(writingTasks),
          record.startedAt || now,
          updatedAt,
        )

        const lesson = lessonByIdCache.get(lessonId)
        const completed = completedSteps.includes('summary')
        const status = record.skipped ? 'skipped' : completed ? 'completed' : 'active'
        const translationScore = Math.round(Number(record.translationScore) || 0)
        const speakingScore = Math.round(Number(record.speakingScore) || 0)
        const writingScore = writingScoreFromTasks(writingTasks, Boolean(record.writingCorrect))
        const totalScore = completed ? Math.round(translationScore * 0.4 + speakingScore * 0.35 + writingScore * 0.25) : null
        const title = completed ? `${totalScore}分｜${lesson.title}` : lesson.title
        upsertConversation.run(
          userId,
          lessonId,
          title,
          status,
          totalScore,
          record.startedAt || now,
          completed ? updatedAt : null,
          updatedAt,
        )
        if (completed) {
          upsertSummary.run(
            userId,
            lessonId,
            updatedAt.slice(0, 10),
            totalScore,
            translationScore,
            speakingScore,
            writingScore,
            JSON.stringify({ title, topic: lesson.topic, keyIdeaZh: lesson.keyIdeaZh }),
            now,
          )
        }
      }
    })

    return getLearningState(userId)
  }

  function getBootstrap(userId) {
    const profile = statements.profile.get(userId)
    const reviewItems = getReviewItems(userId)
    const vocabularyBook = getVocabularyBook(userId)
    const learningState = getLearningState(userId)
    return {
      lessonCatalog: getLessonCatalog(),
      currentLesson: getLesson(learningState.currentLessonId) ?? lessonCache[0],
      learningState,
      profile: profile ? {
        targetExam: profile.target_exam,
        preferredLevel: profile.preferred_level,
        dailyGoalMinutes: profile.daily_goal_minutes,
        interests: parseJson(profile.interests_json, []),
        reminderTime: profile.reminder_time,
      } : null,
      reviewItems,
      vocabularyBook,
      weeklyReport: getWeeklyReport(userId),
      database: {
        engine: 'SQLite',
        lessonCount: database.prepare('SELECT COUNT(*) AS count FROM lesson_segments WHERE active = 1').get().count,
        dictionaryCount: database.prepare('SELECT COUNT(*) AS count FROM dictionary_entries').get().count,
      },
    }
  }

  function getReviewItems(userId) {
    return database.prepare(`
      SELECT error_items.id, review_tasks.id AS reviewTaskId, error_items.lesson_id AS lessonId, error_items.error_type AS errorType,
        error_items.prompt, error_items.user_answer AS userAnswer, error_items.correction,
        error_items.explanation, error_items.mastery, review_tasks.due_at AS dueAt,
        lesson_segments.title, lesson_segments.title_zh AS titleZh
      FROM error_items
      JOIN lesson_segments ON lesson_segments.id = error_items.lesson_id
      LEFT JOIN review_tasks ON review_tasks.error_item_id = error_items.id AND review_tasks.completed_at IS NULL
      WHERE error_items.user_id = ? AND error_items.mastery < 3 AND error_items.archived_at IS NULL
      ORDER BY COALESCE(review_tasks.due_at, error_items.created_at), error_items.id DESC
    `).all(userId)
  }

  function getVocabularyBook(userId) {
    return database.prepare(`
      SELECT lesson_id AS lessonId, term, ipa, part, meaning, example, mastery,
        review_due_at AS reviewDueAt, created_at AS createdAt
      FROM vocabulary_book WHERE user_id = ?
      ORDER BY CASE WHEN review_due_at IS NULL THEN 1 ELSE 0 END, review_due_at, updated_at DESC
    `).all(userId)
  }

  function toggleVocabulary(userId, lessonId, term) {
    const lesson = getLesson(lessonId)
    if (!lesson) throw new Error('Lesson not found')
    const item = lesson.vocabulary.find((candidate) => candidate.term.toLowerCase() === String(term).toLowerCase())
    if (!item) throw new Error('Vocabulary item not found')
    return withTransaction(database, () => {
      const existing = database.prepare(`
        SELECT 1 FROM vocabulary_book WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE
      `).get(userId, lessonId, item.term)
      if (existing) {
        database.prepare(`DELETE FROM vocabulary_book WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE`).run(userId, lessonId, item.term)
      } else {
        const now = isoNow()
        database.prepare(`
          INSERT INTO vocabulary_book(user_id, lesson_id, term, ipa, part, meaning, example, review_due_at, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(userId, lessonId, item.term, item.ipa, item.part, item.meaning, item.example ?? null, now, now, now)
      }
      return { saved: !existing, vocabularyBook: getVocabularyBook(userId) }
    })
  }

  function updateVocabulary(userId, lessonId, term, action) {
    const value = String(term).trim()
    const now = isoNow()
    if (action === 'restore') {
      const existing = database.prepare(`
        SELECT 1 FROM vocabulary_book WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE
      `).get(userId, lessonId, value)
      if (!existing) toggleVocabulary(userId, lessonId, value)
      return { action, vocabularyBook: getVocabularyBook(userId) }
    }

    const existing = database.prepare(`
      SELECT 1 FROM vocabulary_book WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE
    `).get(userId, lessonId, value)
    if (!existing) throw new Error('生词本中未找到该词')
    if (action === 'delete') {
      database.prepare(`DELETE FROM vocabulary_book WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE`).run(userId, lessonId, value)
    } else if (action === 'snooze') {
      const dueAt = new Date(Date.now() + 86_400_000).toISOString()
      database.prepare(`
        UPDATE vocabulary_book SET review_due_at = ?, updated_at = ?
        WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE
      `).run(dueAt, now, userId, lessonId, value)
    } else if (action === 'master') {
      database.prepare(`
        UPDATE vocabulary_book SET mastery = 3, review_due_at = NULL, updated_at = ?
        WHERE user_id = ? AND lesson_id = ? AND term = ? COLLATE NOCASE
      `).run(now, userId, lessonId, value)
    } else throw new Error('不支持的生词操作')
    return { action, vocabularyBook: getVocabularyBook(userId) }
  }

  function updateReviewItem(userId, errorItemId, action) {
    const item = database.prepare(`SELECT id, mastery, archived_at AS archivedAt FROM error_items WHERE id = ? AND user_id = ?`).get(errorItemId, userId)
    if (!item) throw new Error('未找到错题')
    const now = isoNow()
    withTransaction(database, () => {
      if (action === 'snooze') {
        const dueAt = new Date(Date.now() + 86_400_000).toISOString()
        const task = database.prepare(`
          SELECT id FROM review_tasks WHERE error_item_id = ? AND user_id = ? AND completed_at IS NULL ORDER BY id DESC LIMIT 1
        `).get(item.id, userId)
        if (task) database.prepare('UPDATE review_tasks SET due_at = ? WHERE id = ?').run(dueAt, task.id)
        else database.prepare(`INSERT INTO review_tasks(user_id, error_item_id, due_at, created_at) VALUES(?, ?, ?, ?)`).run(userId, item.id, dueAt, now)
      } else if (action === 'master') {
        database.prepare('UPDATE error_items SET mastery = 3, updated_at = ? WHERE id = ?').run(now, item.id)
        database.prepare(`UPDATE review_tasks SET completed_at = ?, result = 'mastered' WHERE error_item_id = ? AND completed_at IS NULL`).run(now, item.id)
      } else if (action === 'delete') {
        database.prepare('UPDATE error_items SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, item.id)
        database.prepare(`UPDATE review_tasks SET completed_at = ?, result = 'archived' WHERE error_item_id = ? AND completed_at IS NULL`).run(now, item.id)
      } else if (action === 'restore') {
        database.prepare('UPDATE error_items SET archived_at = NULL, mastery = MIN(mastery, 2), updated_at = ? WHERE id = ?').run(now, item.id)
        const task = database.prepare(`SELECT 1 FROM review_tasks WHERE error_item_id = ? AND completed_at IS NULL`).get(item.id)
        if (!task) database.prepare(`INSERT INTO review_tasks(user_id, error_item_id, due_at, created_at) VALUES(?, ?, ?, ?)`).run(userId, item.id, now, now)
      } else throw new Error('不支持的错题操作')
    })
    return { action, reviewItems: getReviewItems(userId) }
  }

  function restartLesson(userId, lessonId) {
    const lesson = database.prepare('SELECT id, title FROM lesson_segments WHERE id = ? AND active = 1').get(lessonId)
    if (!lesson) throw new Error('Lesson not found')
    const now = isoNow()
    return withTransaction(database, () => {
      const existing = database.prepare('SELECT * FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId)
      if (existing) {
        const completedSteps = parseJson(existing.completed_steps_json, [])
        const completed = completedSteps.includes('summary')
        const translationScore = Math.round(Number(existing.translation_score) || 0)
        const speakingScore = Math.round(Number(existing.speaking_score) || 0)
        const writingFeedback = parseJson(existing.writing_feedback_json, null)
        const archivedWritingTasks = normalizeWritingTasks({
          writingDraft: existing.writing_draft,
          writingAttempts: existing.writing_attempts,
          writingCorrect: existing.writing_correct === null ? undefined : toBoolean(existing.writing_correct),
          writingFeedback,
        }, parseJson(existing.writing_tasks_json, []))
        const writingScore = writingScoreFromTasks(archivedWritingTasks, toBoolean(existing.writing_correct))
        const totalScore = completed ? Math.round(translationScore * 0.4 + speakingScore * 0.35 + writingScore * 0.25) : null
        const runNumber = Number(database.prepare(`SELECT COALESCE(MAX(run_number), 0) + 1 AS value FROM lesson_runs WHERE user_id = ? AND lesson_id = ?`).get(userId, lessonId).value)
        database.prepare(`
          INSERT INTO lesson_runs(user_id, lesson_id, run_number, status, state_json, total_score, started_at, completed_at, created_at)
          VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          lessonId,
          runNumber,
          existing.skipped ? 'skipped' : completed ? 'completed' : 'restarted',
          JSON.stringify(existing),
          totalScore,
          existing.started_at,
          completed ? existing.updated_at : null,
          now,
        )
      }
      database.prepare('DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').run(userId, lessonId)
      database.prepare(`
        INSERT INTO lesson_progress(
          user_id, lesson_id, completed_steps_json, skipped, listening_notes,
          translation_draft, speaking_transcript, writing_draft, writing_attempts,
          started_at, updated_at
        ) VALUES(?, ?, '[]', 0, '', '', NULL, '', 0, ?, ?)
      `).run(userId, lessonId, now, now)
      database.prepare('UPDATE learning_profiles SET current_lesson_id = ?, updated_at = ? WHERE user_id = ?').run(lessonId, now, userId)
      database.prepare(`
        INSERT INTO conversations(user_id, lesson_id, title, status, total_score, started_at, completed_at, updated_at)
        VALUES(?, ?, ?, 'active', NULL, ?, NULL, ?)
        ON CONFLICT(user_id, lesson_id) DO UPDATE SET
          title = excluded.title, status = 'active', total_score = NULL,
          started_at = excluded.started_at, completed_at = NULL, updated_at = excluded.updated_at
      `).run(userId, lessonId, lesson.title, now, now)
      return getLearningState(userId)
    })
  }

  function attemptReview(userId, reviewId, answer) {
    const task = database.prepare(`
      SELECT review_tasks.id, review_tasks.error_item_id AS errorItemId,
        error_items.correction, error_items.mastery
      FROM review_tasks JOIN error_items ON error_items.id = review_tasks.error_item_id
      WHERE review_tasks.id = ? AND review_tasks.user_id = ? AND review_tasks.completed_at IS NULL
    `).get(reviewId, userId)
    if (!task) throw new Error('Review task not found')
    const value = String(answer ?? '').trim()
    if (!value) throw new Error('请先写下复习答案')
    const score = Math.round(Math.min(100, answerSimilarity(value, task.correction) * 112))
    const correct = score >= 72
    const now = isoNow()
    return withTransaction(database, () => {
      database.prepare(`
        INSERT INTO review_attempts(review_task_id, user_id, answer_text, correct, score, created_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(task.id, userId, value, correct ? 1 : 0, score, now)
      database.prepare(`UPDATE review_tasks SET completed_at = ?, result = ? WHERE id = ?`).run(now, correct ? 'correct' : 'retry', task.id)
      const mastery = correct ? Math.min(3, Number(task.mastery) + 1) : Math.max(0, Number(task.mastery) - 1)
      database.prepare('UPDATE error_items SET mastery = ?, updated_at = ? WHERE id = ?').run(mastery, now, task.errorItemId)
      let nextDueAt = null
      if (mastery < 3) {
        const intervals = [1, 3, 7]
        const intervalDays = correct ? intervals[Math.min(mastery, intervals.length - 1)] : 1
        nextDueAt = new Date(Date.now() + intervalDays * 86_400_000).toISOString()
        database.prepare(`
          INSERT INTO review_tasks(user_id, error_item_id, interval_days, due_at, created_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(userId, task.errorItemId, intervalDays, nextDueAt, now)
      }
      return { correct, score, mastery, nextDueAt, reference: task.correction }
    })
  }

  function getWeeklyReport(userId) {
    const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10)
    const days = database.prepare(`
      SELECT learning_date AS learningDate, total_score AS totalScore,
        translation_score AS translationScore, speaking_score AS speakingScore, writing_score AS writingScore,
        lesson_segments.estimated_minutes AS estimatedMinutes
      FROM daily_summaries
      JOIN lesson_segments ON lesson_segments.id = daily_summaries.lesson_id
      WHERE daily_summaries.user_id = ? AND learning_date >= ? ORDER BY learning_date
    `).all(userId, since)
    const attempts = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(AVG(score), 0) AS averageScore
      FROM review_attempts WHERE user_id = ? AND created_at >= ?
    `).get(userId, `${since}T00:00:00.000Z`)
    const average = (key) => days.length ? Math.round(days.reduce((sum, day) => sum + Number(day[key] ?? 0), 0) / days.length) : 0
    const skillAverages = {
      translation: average('translationScore'),
      speaking: average('speakingScore'),
      writing: average('writingScore'),
    }
    const weakestSkill = days.length
      ? Object.entries(skillAverages).sort((left, right) => left[1] - right[1])[0][0]
      : null
    const skillLabels = { translation: '翻译', speaking: '口语', writing: '写作' }
    const completedDates = new Set(days.map((day) => day.learningDate))
    let cursor = new Date(`${isoNow().slice(0, 10)}T00:00:00.000Z`)
    if (!completedDates.has(cursor.toISOString().slice(0, 10))) cursor = new Date(cursor.getTime() - 86_400_000)
    let streakDays = 0
    while (completedDates.has(cursor.toISOString().slice(0, 10))) {
      streakDays += 1
      cursor = new Date(cursor.getTime() - 86_400_000)
    }
    return {
      periodStart: since,
      periodEnd: isoNow().slice(0, 10),
      completedLessons: days.length,
      averageScore: days.length ? Math.round(days.reduce((sum, day) => sum + day.totalScore, 0) / days.length) : 0,
      reviewAttempts: Number(attempts.count),
      reviewAverage: Math.round(Number(attempts.averageScore)),
      streakDays,
      estimatedMinutes: days.reduce((sum, day) => sum + Number(day.estimatedMinutes ?? 0), 0),
      skillAverages,
      weakestSkill,
      insight: days.length ? `本周${skillLabels[weakestSkill]}得分相对最低，适合优先安排一次针对性复盘。` : '完成第一篇课程后，系统会开始识别你的技能趋势。',
      nextAction: weakestSkill === 'translation'
        ? '下一次学习先完成一张逐句翻译错题，再进入新文章。'
        : weakestSkill === 'speaking'
          ? '下一次学习先重读低分词，再录制整篇原文。'
          : weakestSkill === 'writing'
            ? '下一次学习先重写上一篇的文章相关句型。'
            : '完成一篇与你当前等级匹配的精选课程。',
      days,
    }
  }

  function saveProfile(userId, profile) {
    const current = statements.profile.get(userId)
    if (!current) throw new Error('Profile not found')
    database.prepare(`
      UPDATE learning_profiles SET
        target_exam = ?, preferred_level = ?, daily_goal_minutes = ?,
        interests_json = ?, reminder_time = ?, updated_at = ?
      WHERE user_id = ?
    `).run(
      String(profile.targetExam ?? current.target_exam).slice(0, 40),
      ['L1', 'L2', 'L3'].includes(profile.preferredLevel) ? profile.preferredLevel : current.preferred_level,
      Math.min(120, Math.max(5, Number(profile.dailyGoalMinutes) || current.daily_goal_minutes)),
      JSON.stringify(Array.isArray(profile.interests) ? profile.interests.slice(0, 12) : parseJson(current.interests_json, [])),
      profile.reminderTime ? String(profile.reminderTime).slice(0, 5) : null,
      isoNow(),
      userId,
    )
    return getBootstrap(userId).profile
  }

  function recordGrading(userId, lessonId, stepType, answer, result, audioMetadata = null) {
    if (!['translation', 'speaking', 'writing'].includes(stepType)) throw new Error('Invalid grading step')
    const lessonRow = database.prepare('SELECT lesson_json AS lessonJson FROM lesson_segments WHERE id = ? AND active = 1').get(lessonId)
    if (!lessonRow) throw new Error('Lesson not found')
    const lesson = JSON.parse(lessonRow.lessonJson)
    const now = isoNow()
    return withTransaction(database, () => {
      const version = database.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS version FROM submissions
        WHERE user_id = ? AND lesson_id = ? AND step_type = ?
      `).get(userId, lessonId, stepType).version
      const submission = database.prepare(`
        INSERT INTO submissions(user_id, lesson_id, step_type, version, answer_text, audio_metadata_json, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run(userId, lessonId, stepType, version, String(answer), audioMetadata ? JSON.stringify(audioMetadata) : null, now)
      database.prepare(`
        INSERT INTO grading_results(
          submission_id, total_score, dimensions_json, feedback_json,
          grader_type, model_version, rubric_version, created_at
        ) VALUES(?, ?, ?, ?, ?, ?, '3', ?)
      `).run(
        submission.lastInsertRowid,
        result.score,
        JSON.stringify(result.dimensions),
        JSON.stringify(result),
        result.graderType,
        result.modelVersion ?? null,
        now,
      )

      if (stepType === 'speaking') {
        database.prepare(`
          INSERT INTO pronunciation_assessments(submission_id, transcript, provider, score, details_json, created_at)
          VALUES(?, ?, ?, ?, ?, ?)
        `).run(
          submission.lastInsertRowid,
          String(answer),
          result.graderType ?? audioMetadata?.transcriptionProvider ?? 'unknown',
          result.score,
          JSON.stringify({
            ...audioMetadata,
            acousticAssessment: Boolean(result.acousticAssessment),
            dimensions: result.dimensions,
            providerScores: result.providerScores ?? null,
            words: result.words ?? [],
          }),
          now,
        )
      }

      let reviewItem = null
      if (!result.correct) {
        const weakestTranslationSegment = stepType === 'translation' && result.segments?.length
          ? [...result.segments].sort((left, right) => left.score - right.score)[0]
          : null
        const weakestSpeakingWords = stepType === 'speaking'
          ? (result.words ?? []).filter((word) => word.matchTag !== 0 || word.accuracy < 75).slice(0, 8)
          : []
        const prompt = stepType === 'translation'
          ? weakestTranslationSegment?.source ?? lesson.translation.prompt
          : stepType === 'writing'
            ? result.prompt ?? lesson.writing.promptZh
            : weakestSpeakingWords.length
              ? `请重新朗读这些词：${weakestSpeakingWords.map((word) => word.referenceWord || word.word).join(' · ')}`
              : lesson.body
        const correction = stepType === 'translation'
          ? weakestTranslationSegment?.reference ?? result.reference ?? ''
          : stepType === 'speaking' && weakestSpeakingWords.length
            ? weakestSpeakingWords.map((word) => word.referenceWord || word.word).join(' ')
            : result.reference ?? ''
        const userAnswer = stepType === 'translation'
          ? weakestTranslationSegment?.answer ?? String(answer)
          : String(answer)
        const error = database.prepare(`
          INSERT INTO error_items(
            user_id, lesson_id, submission_id, error_type, prompt, user_answer,
            correction, explanation, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          userId,
          lessonId,
          submission.lastInsertRowid,
          stepType,
          prompt,
          userAnswer,
          correction,
          result.improvements.join(' '),
          now,
          now,
        )
        const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        database.prepare(`
          INSERT INTO review_tasks(user_id, error_item_id, due_at, created_at)
          VALUES(?, ?, ?, ?)
        `).run(userId, error.lastInsertRowid, dueAt, now)
        reviewItem = { id: Number(error.lastInsertRowid), dueAt }
      }
      return { ...result, submissionVersion: Number(version), reviewItem }
    })
  }

  function completeReview(userId, reviewId) {
    const task = database.prepare(`
      SELECT review_tasks.id, review_tasks.error_item_id AS errorItemId
      FROM review_tasks WHERE review_tasks.id = ? AND review_tasks.user_id = ? AND review_tasks.completed_at IS NULL
    `).get(reviewId, userId)
    if (!task) throw new Error('Review task not found')
    const now = isoNow()
    return withTransaction(database, () => {
      database.prepare(`UPDATE review_tasks SET completed_at = ?, result = 'mastered' WHERE id = ?`).run(now, task.id)
      database.prepare('UPDATE error_items SET mastery = 1, updated_at = ? WHERE id = ?').run(now, task.errorItemId)
      return { ok: true }
    })
  }

  function mapDictionaryEntry(row) {
    if (!row) return null
    return {
      id: Number(row.id),
      headword: row.headword,
      normalized: row.normalized,
      entryType: row.entryType,
      ipa: row.ipa,
      partOfSpeech: row.partOfSpeech,
      meaningZh: row.meaningZh,
      definitionEn: row.definitionEn,
      roots: row.roots,
      memoryNote: row.memoryNote,
      exampleEn: row.exampleEn,
      exampleZh: row.exampleZh,
      forms: parseJson(row.formsJson, {}),
      sourceSummary: row.sourceSummary,
      frequencyRank: row.frequencyRank === null ? null : Number(row.frequencyRank),
      audioStatus: row.audioStatus,
      progressState: row.progressState ?? 'new',
      dueAt: row.dueAt ?? null,
      repetitions: Number(row.repetitions ?? 0),
      stability: Number(row.stability ?? 0),
      difficulty: Number(row.difficulty ?? 5),
      lapses: Number(row.lapses ?? 0),
      lastReviewedAt: row.lastReviewedAt ?? null,
    }
  }

  const dictionaryEntrySelect = `
    SELECT dictionary_entries.id, dictionary_entries.headword, dictionary_entries.normalized,
      dictionary_entries.entry_type AS entryType, dictionary_entries.ipa,
      dictionary_entries.part_of_speech AS partOfSpeech,
      dictionary_entries.meaning_zh AS meaningZh, dictionary_entries.definition_en AS definitionEn,
      dictionary_entries.roots, dictionary_entries.memory_note AS memoryNote,
      dictionary_entries.example_en AS exampleEn, dictionary_entries.example_zh AS exampleZh,
      dictionary_entries.forms_json AS formsJson, dictionary_entries.source_summary AS sourceSummary,
      dictionary_entries.frequency_rank AS frequencyRank, dictionary_entries.audio_status AS audioStatus,
      user_word_progress.state AS progressState, user_word_progress.due_at AS dueAt,
      user_word_progress.repetitions, user_word_progress.stability, user_word_progress.difficulty,
      user_word_progress.lapses, user_word_progress.last_reviewed_at AS lastReviewedAt
    FROM dictionary_entries
    LEFT JOIN user_word_progress
      ON user_word_progress.entry_id = dictionary_entries.id AND user_word_progress.user_id = ?
  `

  function ensureWordPreference(userId) {
    const now = isoNow()
    database.prepare(`
      INSERT INTO user_word_preferences(user_id, active_list_id, daily_new, updated_at)
      VALUES(?, (SELECT id FROM word_lists WHERE active = 1 AND study_enabled = 1 ORDER BY sort_order LIMIT 1), 20, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).run(userId, now)
    return database.prepare(`
      SELECT active_list_id AS activeListId, daily_new AS dailyNew,
        daily_goal_minutes AS dailyGoalMinutes, target_date AS targetDate
      FROM user_word_preferences WHERE user_id = ?
    `).get(userId)
  }

  function buildWordStudyPlan(userId, listId, preference = ensureWordPreference(userId)) {
    if (!listId) return { dueBacklog: 0, plannedDue: 0, plannedNew: 0, estimatedMinutes: 0 }
    const now = isoNow()
    const counts = database.prepare(`
      SELECT
        SUM(CASE WHEN user_word_progress.state IN ('learning', 'review') AND user_word_progress.due_at <= ? THEN 1 ELSE 0 END) AS dueBacklog,
        SUM(CASE WHEN user_word_progress.entry_id IS NULL OR user_word_progress.state = 'new' THEN 1 ELSE 0 END) AS availableNew
      FROM word_list_entries
      LEFT JOIN user_word_progress ON user_word_progress.entry_id = word_list_entries.entry_id
        AND user_word_progress.user_id = ?
      WHERE word_list_entries.word_list_id = ?
    `).get(now, userId, listId)
    const dueBacklog = Number(counts?.dueBacklog ?? 0)
    const dailyGoalMinutes = Math.min(90, Math.max(5, Number(preference?.dailyGoalMinutes ?? 15)))
    const newLimit = Math.min(100, Math.max(5, Number(preference?.dailyNew ?? 20)))
    const dueLimit = Math.min(40, Math.max(5, Math.floor((dailyGoalMinutes * 60) / 14)))
    const plannedDue = Math.min(dueBacklog, dueLimit)
    const secondsLeft = Math.max(0, dailyGoalMinutes * 60 - plannedDue * 14)
    const plannedNew = Math.min(Number(counts?.availableNew ?? 0), newLimit, Math.floor(secondsLeft / 25))
    const estimatedMinutes = Math.max(plannedDue + plannedNew > 0 ? 1 : 0, Math.ceil((plannedDue * 14 + plannedNew * 25) / 60))
    const targetTime = preference?.targetDate ? new Date(`${preference.targetDate}T23:59:59Z`).getTime() : Number.NaN
    const daysToTarget = Number.isFinite(targetTime) ? Math.max(1, Math.ceil((targetTime - Date.now()) / 86_400_000)) : null
    const recommendedNew = daysToTarget ? Math.min(50, Math.ceil(Number(counts?.availableNew ?? 0) / daysToTarget)) : plannedNew
    return { dueBacklog, plannedDue, plannedNew, estimatedMinutes, dailyGoalMinutes, newLimit, daysToTarget, recommendedNew }
  }

  function getDictionaryOverview(userId) {
    const preference = ensureWordPreference(userId)
    const counts = database.prepare(`
      SELECT COUNT(*) AS totalCount,
        SUM(CASE WHEN entry_type = 'phrase' THEN 1 ELSE 0 END) AS phraseCount,
        SUM(CASE WHEN audio_status = 'ready' THEN 1 ELSE 0 END) AS cachedAudioCount
      FROM dictionary_entries
    `).get()
    const progress = database.prepare(`
      SELECT COUNT(*) AS learnedCount,
        SUM(CASE WHEN state = 'mastered' THEN 1 ELSE 0 END) AS masteredCount,
        SUM(CASE WHEN state IN ('learning', 'review') AND due_at <= ? THEN 1 ELSE 0 END) AS dueCount
      FROM user_word_progress WHERE user_id = ?
    `).get(isoNow(), userId)
    const lists = database.prepare(`
      SELECT id, name, short_name AS shortName, description, edition, source_kind AS sourceKind,
        entry_count AS entryCount, study_enabled AS studyEnabled,
        SUM(CASE WHEN user_word_progress.state IN ('learning', 'review', 'mastered') THEN 1 ELSE 0 END) AS learnedCount,
        SUM(CASE WHEN user_word_progress.state = 'mastered' THEN 1 ELSE 0 END) AS masteredCount,
        SUM(CASE WHEN user_word_progress.state IN ('learning', 'review') AND user_word_progress.due_at <= ? THEN 1 ELSE 0 END) AS dueCount,
        SUM(CASE WHEN user_word_progress.entry_id IS NULL OR user_word_progress.state = 'new' THEN 1 ELSE 0 END) AS availableNew
      FROM word_lists
      LEFT JOIN word_list_entries ON word_list_entries.word_list_id = word_lists.id
      LEFT JOIN user_word_progress ON user_word_progress.entry_id = word_list_entries.entry_id
        AND user_word_progress.user_id = ?
      WHERE word_lists.active = 1
      GROUP BY word_lists.id
      ORDER BY word_lists.sort_order, word_lists.name
    `).all(isoNow(), userId).map((list) => ({
      ...list,
      entryCount: Number(list.entryCount),
      studyEnabled: toBoolean(list.studyEnabled),
      learnedCount: Number(list.learnedCount ?? 0),
      masteredCount: Number(list.masteredCount ?? 0),
      dueCount: Number(list.dueCount ?? 0),
      availableNew: Number(list.availableNew ?? 0),
    }))
    const activeSessionRow = database.prepare(`
      SELECT word_study_sessions.id, word_study_sessions.word_list_id AS listId,
        word_study_sessions.status, word_study_sessions.current_index AS currentIndex,
        word_study_sessions.queue_json AS queueJson, word_study_sessions.updated_at AS updatedAt,
        word_lists.short_name AS shortName
      FROM word_study_sessions JOIN word_lists ON word_lists.id = word_study_sessions.word_list_id
      WHERE word_study_sessions.user_id = ? AND word_study_sessions.status IN ('active', 'paused')
      ORDER BY word_study_sessions.updated_at DESC LIMIT 1
    `).get(userId)
    const activeSessionQueue = parseJson(activeSessionRow?.queueJson, [])
    const learningState = getLearningState(userId)
    const currentArticle = learningState.currentLessonId ? database.prepare(`
      SELECT lesson_segments.id, lesson_segments.title, lesson_segments.title_zh AS titleZh,
        COUNT(lesson_vocabulary.term) AS wordCount
      FROM lesson_segments LEFT JOIN lesson_vocabulary ON lesson_vocabulary.lesson_id = lesson_segments.id
      WHERE lesson_segments.id = ? GROUP BY lesson_segments.id
    `).get(learningState.currentLessonId) : null
    const plan = buildWordStudyPlan(userId, preference?.activeListId, preference)
    const targetExam = String(database.prepare('SELECT target_exam AS targetExam FROM learning_profiles WHERE user_id = ?').get(userId)?.targetExam ?? '')
    const target = targetExam.toLowerCase()
    const recommendedListId = target.includes('托福') || target.includes('toefl') ? 'toefl-yu-2012-disordered'
      : target.includes('雅思') || target.includes('ielts') ? 'ielts-yu-disordered'
        : target.includes('六级') || target.includes('cet6') ? 'cet6-yu-2021-disordered'
          : 'article-vocabulary'
    return {
      totalCount: Number(counts.totalCount ?? 0),
      phraseCount: Number(counts.phraseCount ?? 0),
      cachedAudioCount: Number(counts.cachedAudioCount ?? 0),
      learnedCount: Number(progress.learnedCount ?? 0),
      masteredCount: Number(progress.masteredCount ?? 0),
      dueCount: Number(progress.dueCount ?? 0),
      activeListId: preference?.activeListId ?? null,
      dailyNew: Number(preference?.dailyNew ?? 20),
      dailyGoalMinutes: Number(preference?.dailyGoalMinutes ?? 15),
      targetDate: preference?.targetDate ?? '',
      targetExam,
      recommendedListId,
      plan,
      currentArticle: currentArticle ? { ...currentArticle, wordCount: Number(currentArticle.wordCount ?? 0) } : null,
      activeSession: activeSessionRow ? {
        id: activeSessionRow.id,
        listId: activeSessionRow.listId,
        shortName: activeSessionRow.shortName,
        status: activeSessionRow.status,
        completedCount: Number(activeSessionRow.currentIndex ?? 0),
        totalCount: activeSessionQueue.length,
        updatedAt: activeSessionRow.updatedAt,
      } : null,
      lists,
    }
  }

  function searchDictionary(userId, rawQuery, rawLimit = 40) {
    const query = String(rawQuery ?? '').trim().slice(0, 80)
    const limit = Math.min(60, Math.max(1, Number(rawLimit) || 40))
    if (!query) return { query, entries: [] }
    const normalized = query.toLowerCase().replace(/[’`]/gu, "'").replace(/\s+/gu, ' ')
    const rows = database.prepare(`${dictionaryEntrySelect}
      WHERE dictionary_entries.normalized LIKE ? ESCAPE '\\'
        OR dictionary_entries.meaning_zh LIKE ? ESCAPE '\\'
      ORDER BY
        CASE WHEN dictionary_entries.normalized = ? THEN 0
             WHEN dictionary_entries.normalized LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END,
        COALESCE(dictionary_entries.frequency_rank, 999999999),
        LENGTH(dictionary_entries.normalized), dictionary_entries.normalized
      LIMIT ?
    `).all(userId, `%${normalized.replace(/[\\%_]/gu, '\\$&')}%`, `%${query.replace(/[\\%_]/gu, '\\$&')}%`, normalized, `${normalized.replace(/[\\%_]/gu, '\\$&')}%`, limit)
    return { query, entries: rows.map(mapDictionaryEntry) }
  }

  function getDictionaryEntry(userId, entryId) {
    const row = database.prepare(`${dictionaryEntrySelect} WHERE dictionary_entries.id = ?`).get(userId, Number(entryId))
    const entry = mapDictionaryEntry(row)
    if (!entry) throw new Error('Dictionary entry not found')
    entry.lists = database.prepare(`
      SELECT word_lists.id, word_lists.short_name AS shortName, word_lists.name,
        word_list_entries.item_order AS itemOrder, word_list_entries.source_detail_json AS detailJson
      FROM word_list_entries JOIN word_lists ON word_lists.id = word_list_entries.word_list_id
      WHERE word_list_entries.entry_id = ? AND word_lists.active = 1
      ORDER BY word_lists.sort_order
    `).all(entry.id).map((item) => ({ ...item, itemOrder: Number(item.itemOrder), detail: parseJson(item.detailJson, {}) }))
    return entry
  }

  function saveWordPreference(userId, { activeListId, dailyNew, dailyGoalMinutes, targetDate }) {
    const list = database.prepare(`SELECT id FROM word_lists WHERE id = ? AND active = 1 AND study_enabled = 1`).get(String(activeListId ?? ''))
    if (!list) throw new Error('Word list not found')
    const count = Math.min(100, Math.max(5, Number(dailyNew) || 20))
    const minutes = Math.min(90, Math.max(5, Number(dailyGoalMinutes) || 15))
    const normalizedTargetDate = /^\d{4}-\d{2}-\d{2}$/u.test(String(targetDate ?? '')) ? String(targetDate) : ''
    database.prepare(`
      INSERT INTO user_word_preferences(user_id, active_list_id, daily_new, daily_goal_minutes, target_date, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET active_list_id=excluded.active_list_id,
        daily_new=excluded.daily_new, daily_goal_minutes=excluded.daily_goal_minutes,
        target_date=excluded.target_date, updated_at=excluded.updated_at
    `).run(userId, list.id, count, minutes, normalizedTargetDate, isoNow())
    return getDictionaryOverview(userId)
  }

  function buildWordStudyTask(entry, queueItem, pool) {
    let mode = queueItem.mode
    const cloze = createWordCloze(entry)
    if (mode === 'cloze' && !cloze) mode = 'spelling'
    const acceptedAnswers = mode === 'meaning'
      ? [entry.meaningZh || entry.definitionEn]
      : mode === 'cloze' && cloze
        ? [cloze.answer, ...wordVariants(entry)]
        : wordVariants(entry)
    const meaningChoices = mode === 'meaning'
      ? [entry, ...pool
        .filter((candidate) => candidate.id !== entry.id && (candidate.meaningZh || candidate.definitionEn))
        .sort((left, right) => hashToken(`${entry.id}:${left.id}`).localeCompare(hashToken(`${entry.id}:${right.id}`)))
        .slice(0, 3)]
        .map((candidate) => candidate.meaningZh || candidate.definitionEn)
        .filter((value, index, values) => value && values.indexOf(value) === index)
        .sort((left, right) => hashToken(`${queueItem.key}:${left}`).localeCompare(hashToken(`${queueItem.key}:${right}`)))
      : []
    return {
      key: queueItem.key,
      phase: queueItem.phase,
      attempt: Number(queueItem.attempt ?? 0),
      mode,
      prompt: mode === 'meaning' ? `选择 “${entry.headword}” 最贴近的核心义项`
        : mode === 'spelling' ? entry.meaningZh || entry.definitionEn
          : mode === 'cloze' ? cloze.text
            : '听发音后，完整拼写这个单词',
      choices: meaningChoices,
      acceptedAnswers,
      hint: mode === 'meaning'
        ? entry.roots || entry.memoryNote || `词性：${entry.partOfSpeech || '未标注'}`
        : `${entry.headword.slice(0, 1)}${' ·'.repeat(Math.max(0, Math.min(12, entry.headword.length - 1)))} · ${entry.headword.length} 个字符`,
      entry,
    }
  }

  function buildWordSessionSummary(userId, row, stats) {
    const weakIds = [...new Set(stats.weakEntryIds ?? [])].slice(-5)
    const weakWords = weakIds.map((entryId) => {
      const entry = database.prepare('SELECT id, headword, meaning_zh AS meaningZh FROM dictionary_entries WHERE id = ?').get(entryId)
      return entry ? { ...entry, id: Number(entry.id) } : null
    }).filter(Boolean)
    const nextDue = database.prepare(`
      SELECT MIN(due_at) AS nextDueAt FROM user_word_progress
      WHERE user_id = ? AND state IN ('learning', 'review') AND due_at IS NOT NULL
    `).get(userId)?.nextDueAt ?? null
    const reviewed = Number(stats.reviewed ?? 0)
    const totalInitial = Number(row.initialDueCount ?? 0) + Number(row.initialNewCount ?? 0)
    return {
      reviewed,
      accuracy: reviewed ? Math.round((Number(stats.correct ?? 0) / reviewed) * 100) : 0,
      firstPassAccuracy: totalInitial ? Math.round((Number(stats.firstPassCorrect ?? 0) / totalInitial) * 100) : 0,
      lapses: Number(stats.lapses ?? 0),
      hints: Number(stats.hints ?? 0),
      newLearned: Number(stats.newLearned ?? 0),
      durationMinutes: Math.max(1, Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60_000)),
      nextDueAt: nextDue,
      weakWords,
      modeStats: stats.modeStats ?? {},
    }
  }

  function hydrateWordStudySession(userId, row, resumed = false) {
    const list = database.prepare('SELECT id, name, short_name AS shortName FROM word_lists WHERE id = ?').get(row.listId)
    const queue = parseJson(row.queueJson, [])
    const poolMap = new Map()
    for (const item of queue) {
      if (poolMap.has(item.entryId)) continue
      const entry = mapDictionaryEntry(database.prepare(`${dictionaryEntrySelect} WHERE dictionary_entries.id = ?`).get(userId, item.entryId))
      if (entry) poolMap.set(entry.id, entry)
    }
    const pool = [...poolMap.values()]
    const items = queue.map((item) => {
      const entry = poolMap.get(item.entryId)
      return entry ? buildWordStudyTask(entry, item, pool) : null
    }).filter(Boolean)
    const stats = { ...defaultWordStudyStats(), ...parseJson(row.statsJson, {}) }
    return {
      id: row.id,
      list,
      scope: ['review', 'new'].includes(row.scope) ? row.scope : 'mixed',
      status: row.status,
      resumed,
      dueCount: Number(row.initialDueCount ?? 0),
      newCount: Number(row.initialNewCount ?? 0),
      totalCount: queue.length,
      currentIndex: Number(row.currentIndex ?? 0),
      remainingCount: Math.max(0, queue.length - Number(row.currentIndex ?? 0)),
      estimatedMinutes: Number(row.estimatedMinutes ?? 0),
      items,
      summary: row.status === 'completed' ? buildWordSessionSummary(userId, row, stats) : null,
    }
  }

  function getActiveWordStudySession(userId) {
    const row = database.prepare(`
      SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
        initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
        estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
        study_scope AS scope
      FROM word_study_sessions
      WHERE user_id = ? AND status IN ('active', 'paused')
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId)
    return row ? hydrateWordStudySession(userId, row, true) : null
  }

  function getWordStudySession(userId, requestedListId = '', requestedScope = 'mixed') {
    const preference = ensureWordPreference(userId)
    const listId = String(requestedListId || preference?.activeListId || '')
    const scope = ['review', 'new'].includes(String(requestedScope)) ? String(requestedScope) : 'mixed'
    const list = database.prepare('SELECT id, name, short_name AS shortName FROM word_lists WHERE id = ? AND active = 1 AND study_enabled = 1').get(listId)
    if (!list) throw new Error('Word list not found')
    const resumable = database.prepare(`
      SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
        initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
        estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
        study_scope AS scope
      FROM word_study_sessions
      WHERE user_id = ? AND word_list_id = ? AND study_scope = ? AND status IN ('active', 'paused')
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId, listId, scope)
    if (resumable) {
      database.prepare("UPDATE word_study_sessions SET status = 'active', updated_at = ? WHERE id = ?").run(isoNow(), resumable.id)
      return hydrateWordStudySession(userId, { ...resumable, status: 'active' }, true)
    }

    const plan = buildWordStudyPlan(userId, listId, preference)
    const now = isoNow()
    const currentLessonId = getLearningState(userId).currentLessonId || ''
    const dueRows = scope !== 'new' && plan.plannedDue ? database.prepare(`${dictionaryEntrySelect}
      JOIN word_list_entries ON word_list_entries.entry_id = dictionary_entries.id
      WHERE word_list_entries.word_list_id = ? AND user_word_progress.state IN ('learning', 'review')
        AND user_word_progress.due_at <= ?
      ORDER BY CASE WHEN ? = 'article-vocabulary' AND EXISTS (
          SELECT 1 FROM lesson_vocabulary
          WHERE lesson_vocabulary.lesson_id = ? AND LOWER(lesson_vocabulary.term) = dictionary_entries.normalized
        ) THEN 0 ELSE 1 END,
        user_word_progress.due_at, word_list_entries.item_order LIMIT ?
    `).all(userId, listId, now, listId, currentLessonId, plan.plannedDue) : []
    const newRows = scope !== 'review' && plan.plannedNew ? database.prepare(`${dictionaryEntrySelect}
      JOIN word_list_entries ON word_list_entries.entry_id = dictionary_entries.id
      WHERE word_list_entries.word_list_id = ?
        AND (user_word_progress.entry_id IS NULL OR user_word_progress.state = 'new')
      ORDER BY CASE WHEN ? = 'article-vocabulary' AND EXISTS (
          SELECT 1 FROM lesson_vocabulary
          WHERE lesson_vocabulary.lesson_id = ? AND LOWER(lesson_vocabulary.term) = dictionary_entries.normalized
        ) THEN 0 ELSE 1 END,
        COALESCE(dictionary_entries.frequency_rank, 999999999), word_list_entries.item_order LIMIT ?
    `).all(userId, listId, listId, currentLessonId, plan.plannedNew) : []
    const entries = [...dueRows.map(mapDictionaryEntry), ...newRows.map(mapDictionaryEntry)]
    const queue = entries.map((entry, index) => ({
      key: `${entry.id}:${index}:0`,
      entryId: entry.id,
      mode: chooseWordStudyMode(entry),
      phase: index < dueRows.length ? 'review' : 'new',
      attempt: 0,
    }))
    const id = randomUUID()
    const estimatedMinutes = Math.max(
      queue.length ? 1 : 0,
      Math.ceil((dueRows.length * 14 + newRows.length * 25) / 60),
    )
    database.prepare("UPDATE word_study_sessions SET status = 'paused', updated_at = ? WHERE user_id = ? AND status = 'active'").run(now, userId)
    database.prepare(`
      INSERT INTO word_study_sessions(id, user_id, word_list_id, study_scope, status, queue_json, current_index,
        initial_due_count, initial_new_count, estimated_minutes, stats_json, started_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      userId,
      listId,
      scope,
      queue.length ? 'active' : 'completed',
      JSON.stringify(queue),
      dueRows.length,
      newRows.length,
      estimatedMinutes,
      JSON.stringify(defaultWordStudyStats()),
      now,
      now,
    )
    const row = database.prepare(`
      SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
        initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
        estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
        study_scope AS scope
      FROM word_study_sessions WHERE id = ?
    `).get(id)
    return hydrateWordStudySession(userId, row, false)
  }

  function updateWordEntry(userId, entryId, action) {
    const entry = database.prepare('SELECT id FROM dictionary_entries WHERE id = ?').get(Number(entryId))
    if (!entry) throw new Error('Dictionary entry not found')
    const now = isoNow()
    if (action === 'report') {
      database.prepare(`
        INSERT INTO audit_log(user_id, event_type, entity_type, entity_id, details_json, created_at)
        VALUES(?, 'dictionary_entry_reported', 'dictionary_entry', ?, '{}', ?)
      `).run(userId, String(entry.id), now)
    } else if (action === 'remove') {
      database.prepare('DELETE FROM user_word_progress WHERE user_id = ? AND entry_id = ?').run(userId, entry.id)
    } else {
      const states = { add: 'learning', suspend: 'suspended', master: 'mastered', reset: 'new' }
      const state = states[action]
      if (!state) throw new Error('Unsupported word action')
      const dueAt = state === 'learning' || state === 'new' ? now : null
      database.prepare(`
        INSERT INTO user_word_progress(user_id, entry_id, state, due_at, source, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'dictionary', ?, ?)
        ON CONFLICT(user_id, entry_id) DO UPDATE SET state=excluded.state, due_at=excluded.due_at,
          stability=CASE WHEN excluded.state='new' THEN 0 ELSE user_word_progress.stability END,
          repetitions=CASE WHEN excluded.state='new' THEN 0 ELSE user_word_progress.repetitions END,
          updated_at=excluded.updated_at
      `).run(userId, entry.id, state, dueAt, now, now)
    }
    return { action, entry: getDictionaryEntry(userId, entry.id), overview: getDictionaryOverview(userId) }
  }

  function evaluateWordAnswer(entry, mode, answer) {
    const normalized = normalizeWordAnswer(answer)
    if (!normalized) return false
    const task = buildWordStudyTask(entry, { key: 'evaluation', phase: 'review', attempt: 0, mode }, [entry])
    return task.acceptedAnswers.some((candidate) => normalizeWordAnswer(candidate) === normalized)
  }

  function applyWordReview(userId, entryId, {
    rating,
    correct = true,
    mode = 'meaning',
    answer = '',
    expectedText = '',
    responseMs = 0,
    hintCount = 0,
    sessionId = '',
    retry = false,
    diagnosticKnown = false,
  }) {
    if (!['again', 'hard', 'good', 'easy'].includes(rating)) throw new Error('Unsupported review rating')
    const entry = database.prepare('SELECT id FROM dictionary_entries WHERE id = ?').get(Number(entryId))
    if (!entry) throw new Error('Dictionary entry not found')
    const current = database.prepare(`SELECT * FROM user_word_progress WHERE user_id = ? AND entry_id = ?`).get(userId, entry.id)
    const previous = current ?? { state: 'new', stability: 0, difficulty: 5, repetitions: 0, lapses: 0 }
    const latencyPenalty = Math.min(0.25, Math.max(0, (Number(responseMs) - 5_000) / 40_000))
    const objectiveScore = correct ? Math.max(0.5, 1 - Math.min(0.36, Number(hintCount) * 0.12) - latencyPenalty) : 0
    let effectiveRating = correct ? rating : 'again'
    if (correct && diagnosticKnown) effectiveRating = 'easy'
    if (correct && retry && ['good', 'easy'].includes(effectiveRating)) effectiveRating = 'hard'
    if (correct && hintCount > 0 && effectiveRating === 'easy') effectiveRating = hintCount > 1 ? 'hard' : 'good'
    const modeBonus = ['spelling', 'cloze', 'listening'].includes(mode) ? 0.15 : 0
    const stability = Number(previous.stability) || 0
    const intervalDays = diagnosticKnown && correct ? 180
      : effectiveRating === 'again' ? 10 / 1440
      : effectiveRating === 'hard' ? Math.max(1, stability * (1.15 + objectiveScore * 0.35 + modeBonus))
        : effectiveRating === 'good' ? Math.max(3, stability * (1.65 + objectiveScore * 0.75 + modeBonus))
          : Math.max(7, stability * (2.5 + objectiveScore * 1.15 + modeBonus))
    const nextDueAt = new Date(Date.now() + intervalDays * 86_400_000).toISOString()
    const repetitions = Number(previous.repetitions ?? 0) + 1
    const nextState = diagnosticKnown && correct ? 'mastered'
      : effectiveRating === 'again' ? 'learning'
      : intervalDays >= 21 && repetitions >= 4 && hintCount === 0 ? 'mastered' : 'review'
    const nextStability = effectiveRating === 'again' ? Math.max(0.5, stability * 0.5) : intervalDays
    const nextDifficulty = Math.min(10, Math.max(1, Number(previous.difficulty) + (effectiveRating === 'again' ? 0.9 : effectiveRating === 'hard' ? 0.25 : effectiveRating === 'easy' ? -0.55 : -0.15)))
    const now = isoNow()
    database.prepare(`
      INSERT INTO user_word_progress(user_id, entry_id, state, stability, difficulty, due_at,
        last_reviewed_at, repetitions, lapses, source, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, 'wordbook', ?, ?)
      ON CONFLICT(user_id, entry_id) DO UPDATE SET state=excluded.state, stability=excluded.stability,
        difficulty=excluded.difficulty, due_at=excluded.due_at, last_reviewed_at=excluded.last_reviewed_at,
        repetitions=user_word_progress.repetitions+1,
        lapses=user_word_progress.lapses+excluded.lapses, updated_at=excluded.updated_at
    `).run(userId, entry.id, nextState, nextStability, nextDifficulty, nextDueAt, now, effectiveRating === 'again' ? 1 : 0, now, now)
    database.prepare(`
      INSERT INTO word_review_attempts(user_id, entry_id, rating, previous_state_json, next_due_at, created_at,
        session_id, mode, answer_text, expected_text, correct, response_ms, hint_count, objective_score)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      entry.id,
      effectiveRating,
      JSON.stringify(previous),
      nextDueAt,
      now,
      sessionId,
      mode,
      String(answer ?? ''),
      String(expectedText ?? ''),
      correct ? 1 : 0,
      Math.max(0, Math.round(Number(responseMs) || 0)),
      Math.max(0, Math.round(Number(hintCount) || 0)),
      objectiveScore,
    )
    return { rating: effectiveRating, nextDueAt, intervalDays, objectiveScore, nextState }
  }

  function submitWordStudyAttempt(userId, sessionId, payload) {
    const row = database.prepare(`
      SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
        initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
        estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
        study_scope AS scope
      FROM word_study_sessions WHERE id = ? AND user_id = ? AND status IN ('active', 'paused')
    `).get(String(sessionId), userId)
    if (!row) throw new Error('Word study session not found')
    const queue = parseJson(row.queueJson, [])
    const currentItem = queue[Number(row.currentIndex)]
    if (!currentItem || Number(currentItem.entryId) !== Number(payload.entryId) || currentItem.key !== payload.itemKey) {
      throw new Error('Word study item is no longer current')
    }
    const entry = getDictionaryEntry(userId, currentItem.entryId)
    const mode = String(payload.mode || currentItem.mode || 'meaning')
    const evaluationTask = buildWordStudyTask(entry, { ...currentItem, mode }, [entry])
    const expectedText = String(evaluationTask.acceptedAnswers[0] ?? entry.headword)
    const correct = evaluateWordAnswer(entry, mode, payload.answer)
    const stats = { ...defaultWordStudyStats(), ...parseJson(row.statsJson, {}) }
    const modeStats = { ...(stats.modeStats ?? {}) }
    const currentModeStats = { attempts: 0, correct: 0, ...(modeStats[mode] ?? {}) }
    currentModeStats.attempts += 1
    currentModeStats.correct += correct ? 1 : 0
    modeStats[mode] = currentModeStats
    stats.reviewed += 1
    stats.correct += correct ? 1 : 0
    stats.firstPassCorrect += correct && Number(currentItem.attempt ?? 0) === 0 ? 1 : 0
    stats.lapses += correct ? 0 : 1
    stats.hints += Math.max(0, Number(payload.hintCount) || 0)
    stats.responseMs += Math.max(0, Number(payload.responseMs) || 0)
    stats.newLearned += correct && currentItem.phase === 'new' && Number(currentItem.attempt ?? 0) === 0 ? 1 : 0
    stats.weakEntryIds = correct ? stats.weakEntryIds : [...(stats.weakEntryIds ?? []), entry.id].slice(-20)

    return withTransaction(database, () => {
      const review = applyWordReview(userId, entry.id, {
        rating: payload.rating,
        correct,
        mode,
        answer: payload.answer,
        expectedText,
        responseMs: payload.responseMs,
        hintCount: payload.hintCount,
        sessionId: row.id,
        retry: currentItem.phase === 'retry',
        diagnosticKnown: Boolean(payload.diagnosticKnown) && currentItem.phase === 'new' && mode === 'spelling' && Number(payload.hintCount ?? 0) === 0,
      })
      const nextIndex = Number(row.currentIndex) + 1
      const requeued = !correct || review.rating === 'again'
      if (requeued) {
        const retryItem = {
          key: `${entry.id}:retry:${Number(currentItem.attempt ?? 0) + 1}:${stats.reviewed}`,
          entryId: entry.id,
          mode: mode === 'listening' ? 'spelling' : mode,
          phase: 'retry',
          attempt: Number(currentItem.attempt ?? 0) + 1,
        }
        queue.splice(Math.min(queue.length, nextIndex + 4), 0, retryItem)
      }
      const completed = nextIndex >= queue.length
      const now = isoNow()
      database.prepare(`
        UPDATE word_study_sessions SET status = ?, queue_json = ?, current_index = ?,
          stats_json = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(completed ? 'completed' : 'active', JSON.stringify(queue), nextIndex, JSON.stringify({ ...stats, modeStats }), now, completed ? now : null, row.id)
      const nextRow = database.prepare(`
        SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
          initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
          estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
          study_scope AS scope
        FROM word_study_sessions WHERE id = ?
      `).get(row.id)
      return {
        correct,
        expectedText: expectedText || (mode === 'meaning' ? entry.meaningZh || entry.definitionEn : entry.headword),
        requeued,
        rating: review.rating,
        nextDueAt: review.nextDueAt,
        intervalDays: review.intervalDays,
        objectiveScore: review.objectiveScore,
        session: hydrateWordStudySession(userId, nextRow, false),
      }
    })
  }

  function updateWordStudySession(userId, sessionId, { action, entryId }) {
    const row = database.prepare(`
      SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
        initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
        estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
        study_scope AS scope
      FROM word_study_sessions WHERE id = ? AND user_id = ? AND status IN ('active', 'paused')
    `).get(String(sessionId), userId)
    if (!row) throw new Error('Word study session not found')
    if (action === 'pause') {
      database.prepare("UPDATE word_study_sessions SET status = 'paused', updated_at = ? WHERE id = ?").run(isoNow(), row.id)
      return hydrateWordStudySession(userId, { ...row, status: 'paused' }, true)
    }
    if (!['skip', 'report'].includes(action)) throw new Error('Unsupported word study action')
    const queue = parseJson(row.queueJson, [])
    const currentItem = queue[Number(row.currentIndex)]
    if (!currentItem || Number(currentItem.entryId) !== Number(entryId)) throw new Error('Word study item is no longer current')
    if (action === 'report') {
      updateWordEntry(userId, entryId, 'report')
      return hydrateWordStudySession(userId, row, false)
    }
    return withTransaction(database, () => {
      const now = isoNow()
      database.prepare(`
        INSERT INTO user_word_progress(user_id, entry_id, state, due_at, source, created_at, updated_at)
        VALUES(?, ?, 'suspended', NULL, 'wordbook', ?, ?)
        ON CONFLICT(user_id, entry_id) DO UPDATE SET state='suspended', due_at=NULL, updated_at=excluded.updated_at
      `).run(userId, Number(entryId), now, now)
      const nextIndex = Number(row.currentIndex) + 1
      const completed = nextIndex >= queue.length
      database.prepare(`UPDATE word_study_sessions SET status = ?, current_index = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(
        completed ? 'completed' : 'active', nextIndex, now, completed ? now : null, row.id,
      )
      const nextRow = database.prepare(`
        SELECT id, word_list_id AS listId, status, queue_json AS queueJson, current_index AS currentIndex,
          initial_due_count AS initialDueCount, initial_new_count AS initialNewCount,
          estimated_minutes AS estimatedMinutes, stats_json AS statsJson, started_at AS startedAt,
          study_scope AS scope
        FROM word_study_sessions WHERE id = ?
      `).get(row.id)
      return hydrateWordStudySession(userId, nextRow, false)
    })
  }

  function reviewWord(userId, entryId, rating) {
    return withTransaction(database, () => {
      const review = applyWordReview(userId, entryId, { rating, correct: rating !== 'again' })
      return { ...review, entry: getDictionaryEntry(userId, entryId), overview: getDictionaryOverview(userId) }
    })
  }

  function recordWordPronunciation(userId, entryId, sessionId, result) {
    const entry = database.prepare('SELECT id FROM dictionary_entries WHERE id = ?').get(Number(entryId))
    if (!entry) throw new Error('Dictionary entry not found')
    database.prepare(`
      INSERT INTO word_pronunciation_attempts(user_id, entry_id, session_id, score, transcript, details_json, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      entry.id,
      String(sessionId ?? ''),
      Number(result.score ?? 0),
      String(result.transcript ?? ''),
      JSON.stringify(result),
      isoNow(),
    )
    return result
  }

  function getWordWeeklyReport(userId) {
    const end = new Date()
    const start = new Date(end.getTime() - 6 * 86_400_000)
    start.setUTCHours(0, 0, 0, 0)
    const attempts = database.prepare(`
      SELECT word_review_attempts.entry_id AS entryId, word_review_attempts.mode,
        word_review_attempts.rating, word_review_attempts.correct,
        word_review_attempts.response_ms AS responseMs, word_review_attempts.hint_count AS hintCount,
        word_review_attempts.previous_state_json AS previousStateJson,
        word_review_attempts.created_at AS createdAt, dictionary_entries.headword,
        dictionary_entries.meaning_zh AS meaningZh
      FROM word_review_attempts JOIN dictionary_entries ON dictionary_entries.id = word_review_attempts.entry_id
      WHERE word_review_attempts.user_id = ? AND word_review_attempts.created_at >= ?
      ORDER BY word_review_attempts.created_at
    `).all(userId, start.toISOString())
    const pronunciation = database.prepare(`
      SELECT COUNT(*) AS attempts, AVG(score) AS averageScore
      FROM word_pronunciation_attempts WHERE user_id = ? AND created_at >= ?
    `).get(userId, start.toISOString())
    const modes = {}
    const days = new Map()
    const weak = new Map()
    let correct = 0
    let activeAttempts = 0
    let activeCorrect = 0
    let hints = 0
    let responseMs = 0
    let newLearned = 0
    for (const attempt of attempts) {
      const isCorrect = toBoolean(attempt.correct)
      correct += isCorrect ? 1 : 0
      hints += Number(attempt.hintCount ?? 0)
      responseMs += Number(attempt.responseMs ?? 0)
      if (attempt.mode !== 'meaning') {
        activeAttempts += 1
        activeCorrect += isCorrect ? 1 : 0
      }
      const previous = parseJson(attempt.previousStateJson, {})
      if (isCorrect && (previous.state ?? 'new') === 'new') newLearned += 1
      const mode = modes[attempt.mode] ?? { attempts: 0, correct: 0 }
      mode.attempts += 1
      mode.correct += isCorrect ? 1 : 0
      modes[attempt.mode] = mode
      const dayKey = String(attempt.createdAt).slice(0, 10)
      const day = days.get(dayKey) ?? { date: dayKey, attempts: 0, correct: 0 }
      day.attempts += 1
      day.correct += isCorrect ? 1 : 0
      days.set(dayKey, day)
      const word = weak.get(attempt.entryId) ?? { id: Number(attempt.entryId), headword: attempt.headword, meaningZh: attempt.meaningZh, attempts: 0, errors: 0 }
      word.attempts += 1
      word.errors += isCorrect ? 0 : 1
      weak.set(attempt.entryId, word)
    }
    const modeAccuracy = Object.fromEntries(Object.entries(modes).map(([mode, value]) => [mode, {
      ...value,
      accuracy: value.attempts ? Math.round((value.correct / value.attempts) * 100) : 0,
    }]))
    const weakWords = [...weak.values()]
      .filter((item) => item.errors > 0)
      .sort((left, right) => right.errors - left.errors || right.attempts - left.attempts)
      .slice(0, 5)
    const reviewDebt = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM user_word_progress
      WHERE user_id = ? AND state IN ('learning', 'review') AND due_at <= ?
    `).get(userId, isoNow())?.count ?? 0)
    return {
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
      attempts: attempts.length,
      accuracy: attempts.length ? Math.round((correct / attempts.length) * 100) : 0,
      activeRecallAccuracy: activeAttempts ? Math.round((activeCorrect / activeAttempts) * 100) : 0,
      averageResponseSeconds: attempts.length ? Math.round(responseMs / attempts.length / 100) / 10 : 0,
      hints,
      lapses: attempts.length - correct,
      newLearned,
      reviewDebt,
      pronunciationAttempts: Number(pronunciation?.attempts ?? 0),
      pronunciationAverage: Math.round(Number(pronunciation?.averageScore ?? 0)),
      modeAccuracy,
      weakWords,
      days: [...days.values()].map((day) => ({ ...day, accuracy: day.attempts ? Math.round((day.correct / day.attempts) * 100) : 0 })),
    }
  }

  function markDictionaryAudio(entryId, { key, voice, status = 'ready', error = null }) {
    const now = isoNow()
    database.prepare(`UPDATE dictionary_entries SET audio_status = ?, audio_key = ?, updated_at = ? WHERE id = ?`).run(status, key ?? null, now, Number(entryId))
    database.prepare(`
      INSERT INTO dictionary_audio_assets(entry_id, provider, voice, file_path, content_hash, status, error, created_at, updated_at)
      VALUES(?, 'tencent', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET voice=excluded.voice, file_path=excluded.file_path,
        content_hash=excluded.content_hash, status=excluded.status, error=excluded.error, updated_at=excluded.updated_at
    `).run(Number(entryId), String(voice ?? ''), `cache:${key ?? ''}`, String(key ?? ''), status, error, now, now)
  }

  function getStats() {
    const query = (sql) => database.prepare(sql).get().count
    return {
      lessons: query('SELECT COUNT(*) AS count FROM lesson_segments WHERE active = 1'),
      sources: query('SELECT COUNT(*) AS count FROM content_sources WHERE active = 1'),
      users: query('SELECT COUNT(*) AS count FROM users'),
      progressRecords: query('SELECT COUNT(*) AS count FROM lesson_progress'),
      submissions: query('SELECT COUNT(*) AS count FROM submissions'),
      dictionaryEntries: query('SELECT COUNT(*) AS count FROM dictionary_entries'),
    }
  }

  return {
    database,
    close: () => database.close(),
    findUser,
    createUser,
    createSession,
    getSession,
    deleteSession,
    getBootstrap,
    getSchemaVersion: () => Number(database.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get()?.value ?? 1),
    saveLearningState,
    saveProfile,
    recordGrading,
    toggleVocabulary,
    updateVocabulary,
    updateReviewItem,
    restartLesson,
    attemptReview,
    getWeeklyReport,
    completeReview,
    getStats,
    getLessons,
    getLesson,
    getLessonCatalog,
    saveSpeakingRecording,
    getSpeakingRecording,
    getDictionaryOverview,
    searchDictionary,
    getDictionaryEntry,
    saveWordPreference,
    getWordStudySession,
    getActiveWordStudySession,
    submitWordStudyAttempt,
    updateWordStudySession,
    updateWordEntry,
    reviewWord,
    recordWordPronunciation,
    getWordWeeklyReport,
    markDictionaryAudio,
  }
}
