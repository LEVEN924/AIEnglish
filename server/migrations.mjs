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
    database.exec('COMMIT')
    return version
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
