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

function migrateToVersion5(database) {
  if (!hasColumn(database, 'error_items', 'archived_at')) {
    database.exec('ALTER TABLE error_items ADD COLUMN archived_at TEXT;')
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS lesson_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      run_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      total_score INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, lesson_id, run_number)
    );

    CREATE INDEX IF NOT EXISTS lesson_runs_user_lesson_idx
      ON lesson_runs(user_id, lesson_id, run_number DESC);
    CREATE INDEX IF NOT EXISTS error_items_active_idx
      ON error_items(user_id, archived_at, mastery);
  `)
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(5, 'lesson relearning and review item lifecycle', ?)
  `).run(new Date().toISOString())
}

function migrateToVersion6(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS dictionary_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headword TEXT NOT NULL,
      normalized TEXT NOT NULL UNIQUE COLLATE NOCASE,
      entry_type TEXT NOT NULL DEFAULT 'word' CHECK(entry_type IN ('word', 'phrase')),
      ipa TEXT NOT NULL DEFAULT '',
      part_of_speech TEXT NOT NULL DEFAULT '',
      meaning_zh TEXT NOT NULL DEFAULT '',
      definition_en TEXT NOT NULL DEFAULT '',
      roots TEXT NOT NULL DEFAULT '',
      memory_note TEXT NOT NULL DEFAULT '',
      example_en TEXT,
      example_zh TEXT,
      forms_json TEXT NOT NULL DEFAULT '{}',
      source_summary TEXT NOT NULL DEFAULT '',
      frequency_rank INTEGER,
      audio_status TEXT NOT NULL DEFAULT 'pending' CHECK(audio_status IN ('pending', 'ready', 'failed')),
      audio_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS dictionary_entries_normalized_idx
      ON dictionary_entries(normalized);
    CREATE INDEX IF NOT EXISTS dictionary_entries_frequency_idx
      ON dictionary_entries(frequency_rank, normalized);

    CREATE TABLE IF NOT EXISTS dictionary_senses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      sense_order INTEGER NOT NULL,
      part_of_speech TEXT NOT NULL DEFAULT '',
      meaning_zh TEXT NOT NULL DEFAULT '',
      definition_en TEXT NOT NULL DEFAULT '',
      example_en TEXT,
      example_zh TEXT,
      UNIQUE(entry_id, sense_order)
    );

    CREATE TABLE IF NOT EXISTS word_lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      short_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      edition TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'book',
      source_reference TEXT NOT NULL DEFAULT '',
      entry_count INTEGER NOT NULL DEFAULT 0,
      study_enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS word_list_entries (
      word_list_id TEXT NOT NULL REFERENCES word_lists(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      item_order INTEGER NOT NULL DEFAULT 0,
      source_detail_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(word_list_id, entry_id)
    );

    CREATE INDEX IF NOT EXISTS word_list_entries_order_idx
      ON word_list_entries(word_list_id, item_order, entry_id);

    CREATE TABLE IF NOT EXISTS dictionary_audio_assets (
      entry_id INTEGER PRIMARY KEY REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      provider TEXT NOT NULL DEFAULT 'tencent',
      voice TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      duration_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'ready', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_word_preferences (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      active_list_id TEXT REFERENCES word_lists(id) ON DELETE SET NULL,
      daily_new INTEGER NOT NULL DEFAULT 20,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_word_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'new' CHECK(state IN ('new', 'learning', 'review', 'mastered', 'suspended')),
      stability REAL NOT NULL DEFAULT 0,
      difficulty REAL NOT NULL DEFAULT 5,
      due_at TEXT,
      last_reviewed_at TEXT,
      repetitions INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'wordbook',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, entry_id)
    );

    CREATE INDEX IF NOT EXISTS user_word_due_idx
      ON user_word_progress(user_id, state, due_at);

    CREATE TABLE IF NOT EXISTS word_review_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      rating TEXT NOT NULL CHECK(rating IN ('again', 'hard', 'good', 'easy')),
      previous_state_json TEXT NOT NULL DEFAULT '{}',
      next_due_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)

  try {
    database.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS dictionary_fts USING fts5(
        headword,
        meaning_zh,
        definition_en,
        content='dictionary_entries',
        content_rowid='id',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS dictionary_entries_ai AFTER INSERT ON dictionary_entries BEGIN
        INSERT INTO dictionary_fts(rowid, headword, meaning_zh, definition_en)
        VALUES (new.id, new.headword, new.meaning_zh, new.definition_en);
      END;
      CREATE TRIGGER IF NOT EXISTS dictionary_entries_ad AFTER DELETE ON dictionary_entries BEGIN
        INSERT INTO dictionary_fts(dictionary_fts, rowid, headword, meaning_zh, definition_en)
        VALUES ('delete', old.id, old.headword, old.meaning_zh, old.definition_en);
      END;
      CREATE TRIGGER IF NOT EXISTS dictionary_entries_au AFTER UPDATE ON dictionary_entries BEGIN
        INSERT INTO dictionary_fts(dictionary_fts, rowid, headword, meaning_zh, definition_en)
        VALUES ('delete', old.id, old.headword, old.meaning_zh, old.definition_en);
        INSERT INTO dictionary_fts(rowid, headword, meaning_zh, definition_en)
        VALUES (new.id, new.headword, new.meaning_zh, new.definition_en);
      END;
    `)
  } catch {
    // Prefix and indexed LIKE search remains available on SQLite builds without FTS5.
  }

  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(6, 'dictionary, word books, spaced repetition and audio assets', ?)
  `).run(new Date().toISOString())
}

function migrateToVersion7(database) {
  if (!hasColumn(database, 'user_word_preferences', 'daily_goal_minutes')) {
    database.exec('ALTER TABLE user_word_preferences ADD COLUMN daily_goal_minutes INTEGER NOT NULL DEFAULT 15;')
  }
  if (!hasColumn(database, 'user_word_preferences', 'target_date')) {
    database.exec("ALTER TABLE user_word_preferences ADD COLUMN target_date TEXT NOT NULL DEFAULT '';")
  }
  if (!hasColumn(database, 'word_review_attempts', 'session_id')) {
    database.exec("ALTER TABLE word_review_attempts ADD COLUMN session_id TEXT NOT NULL DEFAULT '';")
  }
  if (!hasColumn(database, 'word_review_attempts', 'mode')) {
    database.exec("ALTER TABLE word_review_attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'meaning';")
  }
  if (!hasColumn(database, 'word_review_attempts', 'answer_text')) {
    database.exec("ALTER TABLE word_review_attempts ADD COLUMN answer_text TEXT NOT NULL DEFAULT '';")
  }
  if (!hasColumn(database, 'word_review_attempts', 'expected_text')) {
    database.exec("ALTER TABLE word_review_attempts ADD COLUMN expected_text TEXT NOT NULL DEFAULT '';")
  }
  if (!hasColumn(database, 'word_review_attempts', 'correct')) {
    database.exec('ALTER TABLE word_review_attempts ADD COLUMN correct INTEGER NOT NULL DEFAULT 0;')
  }
  if (!hasColumn(database, 'word_review_attempts', 'response_ms')) {
    database.exec('ALTER TABLE word_review_attempts ADD COLUMN response_ms INTEGER NOT NULL DEFAULT 0;')
  }
  if (!hasColumn(database, 'word_review_attempts', 'hint_count')) {
    database.exec('ALTER TABLE word_review_attempts ADD COLUMN hint_count INTEGER NOT NULL DEFAULT 0;')
  }
  if (!hasColumn(database, 'word_review_attempts', 'objective_score')) {
    database.exec('ALTER TABLE word_review_attempts ADD COLUMN objective_score REAL NOT NULL DEFAULT 0;')
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS word_study_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word_list_id TEXT NOT NULL REFERENCES word_lists(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'abandoned')),
      queue_json TEXT NOT NULL DEFAULT '[]',
      current_index INTEGER NOT NULL DEFAULT 0,
      initial_due_count INTEGER NOT NULL DEFAULT 0,
      initial_new_count INTEGER NOT NULL DEFAULT 0,
      estimated_minutes INTEGER NOT NULL DEFAULT 0,
      stats_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS word_study_sessions_user_idx
      ON word_study_sessions(user_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS word_pronunciation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id INTEGER NOT NULL REFERENCES dictionary_entries(id) ON DELETE CASCADE,
      session_id TEXT,
      score REAL NOT NULL,
      transcript TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS word_pronunciation_user_idx
      ON word_pronunciation_attempts(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS word_review_attempts_user_created_idx
      ON word_review_attempts(user_id, created_at DESC);

    UPDATE word_lists SET study_enabled = 1 WHERE id = 'article-vocabulary';
  `)

  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(7, 'resumable word study, objective recall, pronunciation and analytics', ?)
  `).run(new Date().toISOString())
}

function migrateToVersion8(database) {
  if (!hasColumn(database, 'word_study_sessions', 'study_scope')) {
    database.exec("ALTER TABLE word_study_sessions ADD COLUMN study_scope TEXT NOT NULL DEFAULT 'mixed';")
  }
  database.exec(`
    UPDATE word_study_sessions
    SET study_scope = CASE
      WHEN initial_due_count > 0 AND initial_new_count = 0 THEN 'review'
      WHEN initial_new_count > 0 AND initial_due_count = 0 THEN 'new'
      ELSE 'mixed'
    END
    WHERE study_scope = 'mixed';

    CREATE INDEX IF NOT EXISTS word_study_sessions_scope_idx
      ON word_study_sessions(user_id, word_list_id, study_scope, status, updated_at DESC);
  `)
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(8, 'separate review and new word study queues', ?)
  `).run(new Date().toISOString())
}

function migrateToVersion9(database) {
  if (!hasColumn(database, 'lesson_progress', 'writing_tasks_json')) {
    database.exec("ALTER TABLE lesson_progress ADD COLUMN writing_tasks_json TEXT NOT NULL DEFAULT '[]';")
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS speaking_recordings (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      lesson_id TEXT NOT NULL REFERENCES lesson_segments(id) ON DELETE CASCADE,
      audio_blob BLOB NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'audio/wav',
      duration_seconds REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, lesson_id)
    );

    CREATE INDEX IF NOT EXISTS speaking_recordings_user_created_idx
      ON speaking_recordings(user_id, created_at DESC);
  `)
  database.prepare(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES(9, 'two writing translations and persisted speaking recordings', ?)
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
    if (version < 5) {
      migrateToVersion5(database)
      version = 5
      setSchemaVersion(database, version)
    }
    if (version < 6) {
      migrateToVersion6(database)
      version = 6
      setSchemaVersion(database, version)
    }
    if (version < 7) {
      migrateToVersion7(database)
      version = 7
      setSchemaVersion(database, version)
    }
    if (version < 8) {
      migrateToVersion8(database)
      version = 8
      setSchemaVersion(database, version)
    }
    if (version < 9) {
      migrateToVersion9(database)
      version = 9
      setSchemaVersion(database, version)
    }
    database.exec('COMMIT')
    return version
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
