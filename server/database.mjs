import { createHash } from 'node:crypto'
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
  }
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

  withTransaction(database, () => {
    database.exec('UPDATE lesson_segments SET active = 0; UPDATE content_sources SET active = 0;')

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
      SELECT sessions.user_id AS userId, users.username AS user, sessions.expires_at AS expiresAt
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

  function findUser(username) {
    return statements.userByName.get(String(username)) ?? null
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
    database.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hashToken(token))
    return session
  }

  function deleteSession(token) {
    if (token) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  }

  function getLessons() {
    return statements.lessons.all().map((row) => JSON.parse(row.lessonJson))
  }

  function getLearningState(userId) {
    const lessons = getLessons()
    const profile = statements.profile.get(userId)
    const records = {}
    for (const row of statements.progress.all(userId)) {
      records[row.lesson_id] = {
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
    }

    const firstLessonId = lessons[0]?.id ?? ''
    const currentLessonId = lessons.some((lesson) => lesson.id === profile?.current_lesson_id)
      ? profile.current_lesson_id
      : firstLessonId
    if (currentLessonId && !records[currentLessonId]) records[currentLessonId] = defaultRecord()

    return { version: 2, currentLessonId, records }
  }

  function saveLearningState(userId, state) {
    const validIds = new Set(statements.lessonIds.all().map((row) => row.id))
    if (!state || state.version !== 2 || !validIds.has(state.currentLessonId)) {
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
          writing_draft, writing_attempts, writing_correct, writing_feedback_json,
          started_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const lessonById = new Map(getLessons().map((lesson) => [lesson.id, lesson]))

      for (const [lessonId, rawRecord] of Object.entries(state.records ?? {})) {
        if (!validIds.has(lessonId)) continue
        const record = { ...defaultRecord(), ...rawRecord }
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
          String(record.writingDraft ?? ''),
          Math.max(0, Number(record.writingAttempts) || 0),
          typeof record.writingCorrect === 'boolean' ? Number(record.writingCorrect) : null,
          record.writingFeedback ? JSON.stringify(record.writingFeedback) : null,
          record.startedAt || now,
          updatedAt,
        )

        const lesson = lessonById.get(lessonId)
        const completed = completedSteps.includes('summary')
        const status = record.skipped ? 'skipped' : completed ? 'completed' : 'active'
        const translationScore = Math.round(Number(record.translationScore) || 0)
        const speakingScore = Math.round((Number(record.speakingScore) || 0) * 10)
        const writingScore = Math.round(Number(record.writingFeedback?.score) || (record.writingCorrect ? 92 : 0))
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
    const reviewItems = database.prepare(`
      SELECT error_items.id, review_tasks.id AS reviewTaskId, error_items.lesson_id AS lessonId, error_items.error_type AS errorType,
        error_items.prompt, error_items.user_answer AS userAnswer, error_items.correction,
        error_items.explanation, error_items.mastery, review_tasks.due_at AS dueAt,
        lesson_segments.title, lesson_segments.title_zh AS titleZh
      FROM error_items
      JOIN lesson_segments ON lesson_segments.id = error_items.lesson_id
      LEFT JOIN review_tasks ON review_tasks.error_item_id = error_items.id AND review_tasks.completed_at IS NULL
      WHERE error_items.user_id = ? AND error_items.mastery < 3
      ORDER BY COALESCE(review_tasks.due_at, error_items.created_at), error_items.id DESC
    `).all(userId)
    const vocabularyBook = database.prepare(`
      SELECT lesson_id AS lessonId, term, ipa, part, meaning, example, mastery,
        review_due_at AS reviewDueAt, created_at AS createdAt
      FROM vocabulary_book WHERE user_id = ? ORDER BY updated_at DESC
    `).all(userId)
    return {
      lessons: getLessons(),
      learningState: getLearningState(userId),
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
      },
    }
  }

  function toggleVocabulary(userId, lessonId, term) {
    const lessonRow = database.prepare('SELECT lesson_json AS lessonJson FROM lesson_segments WHERE id = ? AND active = 1').get(lessonId)
    if (!lessonRow) throw new Error('Lesson not found')
    const lesson = JSON.parse(lessonRow.lessonJson)
    const item = lesson.vocabulary.find((candidate) => candidate.term.toLowerCase() === String(term).toLowerCase())
    if (!item) throw new Error('Vocabulary item not found')
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
    return { saved: !existing, vocabularyBook: getBootstrap(userId).vocabularyBook }
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
        translation_score AS translationScore, speaking_score AS speakingScore, writing_score AS writingScore
      FROM daily_summaries WHERE user_id = ? AND learning_date >= ? ORDER BY learning_date
    `).all(userId, since)
    const attempts = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(AVG(score), 0) AS averageScore
      FROM review_attempts WHERE user_id = ? AND created_at >= ?
    `).get(userId, `${since}T00:00:00.000Z`)
    return {
      periodStart: since,
      periodEnd: isoNow().slice(0, 10),
      completedLessons: days.length,
      averageScore: days.length ? Math.round(days.reduce((sum, day) => sum + day.totalScore, 0) / days.length) : 0,
      reviewAttempts: Number(attempts.count),
      reviewAverage: Math.round(Number(attempts.averageScore)),
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
        ) VALUES(?, ?, ?, ?, ?, ?, '2', ?)
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
          audioMetadata?.transcriptionProvider ?? 'transcript-rubric',
          result.score,
          JSON.stringify({ acousticAssessment: false, ...audioMetadata, dimensions: result.dimensions }),
          now,
        )
      }

      let reviewItem = null
      if (!result.correct) {
        const prompt = stepType === 'translation'
          ? lesson.translation.prompt
          : stepType === 'writing'
            ? lesson.writing.promptZh
            : lesson.speakingPrompt
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
          String(answer),
          result.reference ?? '',
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

  function getStats() {
    const query = (sql) => database.prepare(sql).get().count
    return {
      lessons: query('SELECT COUNT(*) AS count FROM lesson_segments WHERE active = 1'),
      sources: query('SELECT COUNT(*) AS count FROM content_sources WHERE active = 1'),
      users: query('SELECT COUNT(*) AS count FROM users'),
      progressRecords: query('SELECT COUNT(*) AS count FROM lesson_progress'),
      submissions: query('SELECT COUNT(*) AS count FROM submissions'),
    }
  }

  return {
    database,
    close: () => database.close(),
    findUser,
    createSession,
    getSession,
    deleteSession,
    getBootstrap,
    getSchemaVersion: () => Number(database.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get()?.value ?? 1),
    saveLearningState,
    saveProfile,
    recordGrading,
    toggleVocabulary,
    attemptReview,
    getWeeklyReport,
    completeReview,
    getStats,
    getLessons,
  }
}
