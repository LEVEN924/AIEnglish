function getSchemaVersion(database) {
  database.prepare(`
    INSERT INTO app_metadata(key, value) VALUES('schema_version', '1')
    ON CONFLICT(key) DO NOTHING
  `).run()
  return Number(database.prepare("SELECT value FROM app_metadata WHERE key = 'schema_version'").get()?.value ?? 1)
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((item) => item.name === column)
}

function setSchemaVersion(database, version) {
  database.prepare(`UPDATE app_metadata SET value = ? WHERE key = 'schema_version'`).run(String(version))
}

function migrateToVersion2(database) {
  if (!hasColumn(database, 'learning_profiles', 'revision')) {
    database.exec('ALTER TABLE learning_profiles ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;')
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_state_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, revision)
    );

    CREATE INDEX IF NOT EXISTS state_revisions_user_idx
      ON learning_state_revisions(user_id, revision DESC);
  `)
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(2, 'learning state revisions', ?)
  `).run(new Date().toISOString())
}

function migrateToVersion3(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS vocabulary_book (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      term TEXT NOT NULL COLLATE NOCASE,
      ipa TEXT NOT NULL DEFAULT '',
      part TEXT NOT NULL DEFAULT '',
      meaning TEXT NOT NULL,
      example TEXT,
      mastery INTEGER NOT NULL DEFAULT 0,
      review_due_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, lesson_id, term)
    );

    CREATE TABLE IF NOT EXISTS review_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_task_id INTEGER NOT NULL REFERENCES review_tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      answer_text TEXT NOT NULL,
      correct INTEGER NOT NULL,
      score REAL NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_pipeline_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL,
      catalog_size INTEGER NOT NULL DEFAULT 0,
      report_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS source_health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES content_sources(id) ON DELETE CASCADE,
      status_code INTEGER,
      ok INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS source_health_latest_idx
      ON source_health_checks(source_id, checked_at DESC);

    CREATE TABLE IF NOT EXISTS audio_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      sentence_order INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      voice TEXT NOT NULL,
      file_path TEXT NOT NULL,
      duration_ms INTEGER,
      content_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(lesson_id, sentence_order, provider, model, voice)
    );

    CREATE TABLE IF NOT EXISTS pronunciation_assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id) ON DELETE CASCADE,
      transcript TEXT NOT NULL,
      provider TEXT NOT NULL,
      score REAL NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);
  `)
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(3, 'vocabulary, audio, review and operations', ?)
  `).run(new Date().toISOString())
}

function scaleLegacySpeakingFeedback(value) {
  if (!value) return value
  try {
    const feedback = JSON.parse(value)
    if (Number(feedback.score) <= 10) feedback.score = Math.round(Number(feedback.score) * 10)
    if (Array.isArray(feedback.dimensions)) {
      feedback.dimensions = feedback.dimensions.map((dimension) => ({
        ...dimension,
        score: Number(dimension.score) <= 10 ? Math.round(Number(dimension.score) * 10) : dimension.score,
      }))
    }
    feedback.legacyTranscriptAssessment = true
    return JSON.stringify(feedback)
  } catch {
    return value
  }
}

function migrateToVersion4(database) {
  const progressRows = database.prepare(`
    SELECT user_id AS userId, lesson_id AS lessonId, speaking_score AS speakingScore,
      speaking_feedback_json AS speakingFeedback
    FROM lesson_progress WHERE speaking_score IS NOT NULL AND speaking_score <= 10
  `).all()
  const updateProgress = database.prepare(`
    UPDATE lesson_progress SET speaking_score = ?, speaking_feedback_json = ?
    WHERE user_id = ? AND lesson_id = ?
  `)
  for (const row of progressRows) {
    updateProgress.run(Number(row.speakingScore) * 10, scaleLegacySpeakingFeedback(row.speakingFeedback), row.userId, row.lessonId)
  }

  const gradingRows = database.prepare(`
    SELECT grading_results.id, grading_results.total_score AS totalScore,
      grading_results.dimensions_json AS dimensions, grading_results.feedback_json AS feedback
    FROM grading_results JOIN submissions ON submissions.id = grading_results.submission_id
    WHERE submissions.step_type = 'speaking' AND grading_results.total_score <= 10
  `).all()
  const updateGrading = database.prepare(`
    UPDATE grading_results SET total_score = ?, dimensions_json = ?, feedback_json = ?, rubric_version = 'legacy-scaled-3'
    WHERE id = ?
  `)
  for (const row of gradingRows) {
    const dimensions = JSON.parse(row.dimensions || '[]').map((dimension) => ({
      ...dimension,
      score: Number(dimension.score) <= 10 ? Math.round(Number(dimension.score) * 10) : dimension.score,
    }))
    updateGrading.run(Number(row.totalScore) * 10, JSON.stringify(dimensions), scaleLegacySpeakingFeedback(row.feedback), row.id)
  }

  database.prepare(`
    UPDATE pronunciation_assessments SET score = score * 10
    WHERE score <= 10
  `).run()
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(4, 'normalize speaking scores to 100 point scale', ?)
  `).run(new Date().toISOString())
}

export function runMigrations(database) {
  let version = getSchemaVersion(database)
  database.exec('BEGIN IMMEDIATE')
  try {
    if (version < 2) {
      migrateToVersion2(database)
      version = 2
      setSchemaVersion(database, version)
    }
    if (version < 3) {
      migrateToVersion3(database)
      version = 3
      setSchemaVersion(database, version)
    }
    if (version < 4) {
      migrateToVersion4(database)
      version = 4
      setSchemaVersion(database, version)
    }
    database.exec('COMMIT')
    return version
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
