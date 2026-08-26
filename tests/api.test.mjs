import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const serverEntry = join(root, 'server', 'app.mjs')

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('Unable to reserve a test port'))
        return
      }
      probe.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
  })
}

function testWavDataUrl() {
  const pcm = Buffer.alloc(32_000)
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm.length, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16_000, 24)
  wav.writeUInt32LE(32_000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm.length, 40)
  return `data:audio/wav;base64,${wav.toString('base64')}`
}

async function waitForHealth(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Test server exited early.\n${readLogs()}`)
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return
    } catch {
      // The server is still starting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }

  throw new Error(`Timed out waiting for the test server.\n${readLogs()}`)
}

async function stopChild(child) {
  if (child.exitCode !== null) return

  child.kill()
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000)),
  ])

  if (child.exitCode === null) child.kill('SIGKILL')
}

test('database-backed learning and grading APIs work together', { timeout: 20_000 }, async (context) => {
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const username = 'TEST_USER'
  const password = 'test-only-password'
  const salt = randomBytes(16)
  const passwordHash = scryptSync(password, salt, 64)
  let logs = ''

  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_USER: username,
      APP_PASSWORD_SALT: salt.toString('hex'),
      APP_PASSWORD_HASH: passwordHash.toString('hex'),
      COOKIE_SECURE: 'false',
      HTTPS_ENABLED: 'false',
      TENCENTCLOUD_APP_ID: '',
      TENCENTCLOUD_SECRET_ID: '',
      TENCENTCLOUD_SECRET_KEY: '',
      AI_ENGLISH_DB_PATH: join(root, '.runtime', `api-test-${port}.sqlite`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  child.stdout.on('data', (chunk) => { logs += chunk.toString() })
  child.stderr.on('data', (chunk) => { logs += chunk.toString() })
  context.after(() => stopChild(child))

  await waitForHealth(baseUrl, child, () => logs)

  const healthResponse = await fetch(`${baseUrl}/api/health`)
  assert.equal(healthResponse.status, 200)
  assert.deepEqual(await healthResponse.json(), { ok: true, mode: 'production', schemaVersion: 9 })

  const anonymousSession = await fetch(`${baseUrl}/api/session`)
  assert.equal(anonymousSession.status, 200)
  assert.equal(await anonymousSession.json(), null)

  const weakRegistration = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'new', password: 'weak', confirmPassword: 'weak' }),
  })
  assert.equal(weakRegistration.status, 400)

  const registeredUsername = `NEW_USER_${port}`
  const registeredPassword = 'new-user-password-2026'
  const registrationResponse = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: registeredUsername, password: registeredPassword, confirmPassword: registeredPassword }),
  })
  assert.equal(registrationResponse.status, 200)
  const registeredSession = await registrationResponse.json()
  assert.equal(registeredSession.user, registeredUsername)
  assert.ok(Number.isInteger(registeredSession.userId))
  assert.match(registrationResponse.headers.get('set-cookie') ?? '', /ai_session=[^;]+/u)
  const registrationCookie = registrationResponse.headers.get('set-cookie').split(';', 1)[0]
  const registeredBootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: registrationCookie } }).then((response) => response.json())
  assert.equal(registeredBootstrap.profile.preferredLevel, 'L2')
  assert.equal(registeredBootstrap.currentLesson.difficulty.level, 'L2')

  const duplicateRegistration = await fetch(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: registeredUsername.toLowerCase(), password: registeredPassword, confirmPassword: registeredPassword }),
  })
  assert.equal(duplicateRegistration.status, 409)

  const rejectedLogin = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'incorrect-password' }),
  })
  assert.equal(rejectedLogin.status, 401)

  const loginResponse = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username.toLowerCase(), password }),
  })
  assert.equal(loginResponse.status, 200)
  const loggedInSession = await loginResponse.json()
  assert.equal(loggedInSession.user, username)
  assert.ok(Number.isInteger(loggedInSession.userId))

  const setCookie = loginResponse.headers.get('set-cookie')
  assert.match(setCookie ?? '', /ai_session=[^;]+/u)
  assert.match(setCookie ?? '', /HttpOnly/u)
  assert.match(setCookie ?? '', /SameSite=Lax/u)
  const cookie = setCookie.split(';', 1)[0]

  const authenticatedSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: cookie },
  })
  assert.equal(authenticatedSession.status, 200)
  assert.deepEqual(await authenticatedSession.json(), loggedInSession)

  const bootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } })
  assert.equal(bootstrapResponse.status, 200)
  const bootstrap = await bootstrapResponse.json()
  assert.equal(bootstrap.database.engine, 'SQLite')
  assert.equal(bootstrap.database.lessonCount, 1000)
  assert.ok(bootstrap.database.dictionaryCount > 0)
  assert.equal(bootstrap.lessonCatalog.length, 1000)
  assert.deepEqual(
    Object.fromEntries(['L1', 'L2', 'L3'].map((level) => [level, bootstrap.lessonCatalog.filter((lesson) => lesson.difficulty.level === level).length])),
    { L1: 350, L2: 400, L3: 250 },
  )
  assert.equal(bootstrap.vocabularyBook.length, 0)
  assert.equal(bootstrap.weeklyReport.completedLessons, 0)
  assert.deepEqual(new Set(bootstrap.lessonCatalog.map((lesson) => lesson.difficulty.level)), new Set(['L1', 'L2', 'L3']))

  const firstLessonResponse = await fetch(`${baseUrl}/api/lessons/${encodeURIComponent(bootstrap.lessonCatalog[0].id)}`, { headers: { Cookie: cookie } })
  assert.equal(firstLessonResponse.status, 200)
  const lesson = await firstLessonResponse.json()
  assert.equal(lesson.writing.promptZh, '我每天可以步行十分钟。')
  assert.equal(lesson.writing.secondaryPromptZh, '我可以走楼梯。')
  assert.equal(lesson.writing.secondaryAnswers[0], 'I can take the stairs.')
  assert.ok(lesson.writing.answers.every((answer) => (answer.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []).length <= 9))
  assert.ok(lesson.writing.secondaryAnswers.every((answer) => (answer.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []).length <= 9))

  const dictionaryOverviewResponse = await fetch(`${baseUrl}/api/dictionary/overview`, { headers: { Cookie: cookie } })
  assert.equal(dictionaryOverviewResponse.status, 200)
  const dictionaryOverview = await dictionaryOverviewResponse.json()
  assert.ok(dictionaryOverview.totalCount > 0)
  assert.ok(dictionaryOverview.lists.some((list) => list.id === 'article-vocabulary'))
  assert.ok(dictionaryOverview.lists.find((list) => list.id === 'article-vocabulary').studyEnabled)
  assert.equal(dictionaryOverview.dailyGoalMinutes, 15)
  assert.ok(dictionaryOverview.currentArticle)
  assert.ok(dictionaryOverview.plan)

  const dictionarySearchResponse = await fetch(`${baseUrl}/api/dictionary/search?q=${encodeURIComponent(lesson.vocabulary[0].term)}`, { headers: { Cookie: cookie } })
  assert.equal(dictionarySearchResponse.status, 200)
  const dictionarySearch = await dictionarySearchResponse.json()
  assert.ok(dictionarySearch.entries.length > 0)
  const dictionaryEntryId = dictionarySearch.entries[0].id
  const dictionaryDetailResponse = await fetch(`${baseUrl}/api/dictionary/entries/${dictionaryEntryId}`, { headers: { Cookie: cookie } })
  assert.equal(dictionaryDetailResponse.status, 200)
  assert.ok((await dictionaryDetailResponse.json()).lists.length > 0)

  const dictionaryAddResponse = await fetch(`${baseUrl}/api/dictionary/entries/${dictionaryEntryId}/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add' }),
  })
  assert.equal(dictionaryAddResponse.status, 200)
  assert.equal((await dictionaryAddResponse.json()).entry.progressState, 'learning')
  const dictionaryReviewResponse = await fetch(`${baseUrl}/api/dictionary/entries/${dictionaryEntryId}/review`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 'good' }),
  })
  assert.equal(dictionaryReviewResponse.status, 200)
  assert.equal((await dictionaryReviewResponse.json()).entry.progressState, 'review')

  const ideaSearch = await fetch(`${baseUrl}/api/dictionary/search?q=idea`, { headers: { Cookie: cookie } }).then((response) => response.json())
  const ideaEntry = ideaSearch.entries.find((entry) => entry.normalized === 'idea')
  assert.ok(ideaEntry)
  await fetch(`${baseUrl}/api/dictionary/entries/${ideaEntry.id}/action`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add' }),
  })
  for (let reviewIndex = 0; reviewIndex < 2; reviewIndex += 1) {
    const response = await fetch(`${baseUrl}/api/dictionary/entries/${ideaEntry.id}/review`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: 'good' }),
    })
    assert.equal(response.status, 200)
  }
  await fetch(`${baseUrl}/api/dictionary/entries/${ideaEntry.id}/action`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add' }),
  })
  const wordPreferenceResponse = await fetch(`${baseUrl}/api/dictionary/preferences`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeListId: 'article-vocabulary', dailyNew: 5, dailyGoalMinutes: 5, targetDate: '2026-12-31' }),
  })
  assert.equal(wordPreferenceResponse.status, 200)
  const savedWordPreference = await wordPreferenceResponse.json()
  assert.equal(savedWordPreference.targetDate, '2026-12-31')
  const studyResponse = await fetch(`${baseUrl}/api/dictionary/study?listId=article-vocabulary&scope=review`, { headers: { Cookie: cookie } })
  assert.equal(studyResponse.status, 200)
  const study = await studyResponse.json()
  assert.equal(study.status, 'active')
  assert.equal(study.scope, 'review')
  assert.equal(study.newCount, 0)
  assert.ok(study.items.length >= 1)
  assert.equal(study.items[0].entry.id, ideaEntry.id)
  assert.equal(study.items[0].mode, 'cloze')
  assert.match(study.items[0].prompt, /_____/u)
  const initialStudyCount = study.totalCount
  const wrongAttemptResponse = await fetch(`${baseUrl}/api/dictionary/study/${study.id}/attempt`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemKey: study.items[0].key,
      entryId: ideaEntry.id,
      mode: study.items[0].mode,
      answer: 'incorrect',
      rating: 'easy',
      responseMs: 1200,
      hintCount: 0,
    }),
  })
  assert.equal(wrongAttemptResponse.status, 200)
  const wrongAttempt = await wrongAttemptResponse.json()
  assert.equal(wrongAttempt.correct, false)
  assert.equal(wrongAttempt.rating, 'again')
  assert.equal(wrongAttempt.requeued, true)
  assert.equal(wrongAttempt.session.totalCount, initialStudyCount + 1)
  assert.equal(wrongAttempt.session.currentIndex, 1)
  assert.equal(wrongAttempt.session.scope, 'review')
  const activeStudy = await fetch(`${baseUrl}/api/dictionary/study/active`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.equal(activeStudy.id, study.id)
  assert.equal(activeStudy.currentIndex, 1)
  const pausedStudy = await fetch(`${baseUrl}/api/dictionary/study/${study.id}/action`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
  }).then((response) => response.json())
  assert.equal(pausedStudy.status, 'paused')
  assert.equal(pausedStudy.scope, 'review')
  const resumedStudy = await fetch(`${baseUrl}/api/dictionary/study?listId=article-vocabulary&scope=review`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.equal(resumedStudy.id, study.id)
  assert.equal(resumedStudy.resumed, true)
  assert.equal(resumedStudy.currentIndex, 1)
  const newWordStudy = await fetch(`${baseUrl}/api/dictionary/study?listId=article-vocabulary&scope=new`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.equal(newWordStudy.scope, 'new')
  assert.equal(newWordStudy.dueCount, 0)
  assert.ok(newWordStudy.items.every((item) => item.phase === 'new'))
  const wordReport = await fetch(`${baseUrl}/api/dictionary/report/weekly`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.ok(wordReport.attempts >= 4)
  assert.ok(wordReport.modeAccuracy.cloze)

  const registeredLesson = registeredBootstrap.currentLesson
  const registeredWordSearch = await fetch(`${baseUrl}/api/dictionary/search?q=${encodeURIComponent(registeredLesson.vocabulary[0].term)}`, { headers: { Cookie: registrationCookie } }).then((response) => response.json())
  const registeredEntryId = registeredWordSearch.entries.find((entry) => entry.normalized === registeredLesson.vocabulary[0].term.toLowerCase()).id
  await fetch(`${baseUrl}/api/dictionary/entries/${registeredEntryId}/action`, {
    method: 'POST', headers: { Cookie: registrationCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reset' }),
  })
  await fetch(`${baseUrl}/api/dictionary/preferences`, {
    method: 'POST', headers: { Cookie: registrationCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeListId: 'article-vocabulary', dailyNew: 5, dailyGoalMinutes: 5 }),
  })
  const resetStudy = await fetch(`${baseUrl}/api/dictionary/study?listId=article-vocabulary&scope=new`, { headers: { Cookie: registrationCookie } }).then((response) => response.json())
  assert.ok(resetStudy.items.some((item) => item.entry.id === registeredEntryId), 'reset words should re-enter the new-word queue')
  const vocabularyResponse = await fetch(`${baseUrl}/api/vocabulary/toggle`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, term: lesson.vocabulary[0].term }),
  })
  assert.equal(vocabularyResponse.status, 200)
  const vocabulary = await vocabularyResponse.json()
  assert.equal(vocabulary.saved, true)
  assert.equal(vocabulary.vocabularyBook.length, 1)

  const snoozedVocabulary = await fetch(`${baseUrl}/api/vocabulary/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, term: lesson.vocabulary[0].term, action: 'snooze' }),
  }).then((response) => response.json())
  assert.ok(snoozedVocabulary.vocabularyBook[0].reviewDueAt)
  const deletedVocabulary = await fetch(`${baseUrl}/api/vocabulary/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, term: lesson.vocabulary[0].term, action: 'delete' }),
  }).then((response) => response.json())
  assert.equal(deletedVocabulary.vocabularyBook.length, 0)
  const restoredVocabulary = await fetch(`${baseUrl}/api/vocabulary/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, term: lesson.vocabulary[0].term, action: 'restore' }),
  }).then((response) => response.json())
  assert.equal(restoredVocabulary.vocabularyBook.length, 1)

  const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`, { headers: { Cookie: cookie } })
  const capabilities = await capabilitiesResponse.json()
  assert.equal(capabilities.provider, 'tencent')
  assert.equal(capabilities.cloudSpeech, false)
  assert.equal(capabilities.cloudTranscription, false)
  assert.equal(capabilities.oralAssessment, false)
  assert.equal(capabilities.aiGrading, false)

  const manifestResponse = await fetch(`${baseUrl}/api/audio/manifest?lessonId=${encodeURIComponent(lesson.id)}&rate=1`, { headers: { Cookie: cookie } })
  assert.equal(manifestResponse.status, 200)
  const manifest = await manifestResponse.json()
  assert.equal(manifest.provider, 'tencent')
  assert.equal(manifest.available, false)
  assert.equal(manifest.baseRate, 1)
  assert.equal(manifest.article.text, lesson.body)
  assert.ok(manifest.article.url.includes('/api/audio/article'))
  assert.ok(manifest.vocabulary.length >= 5)
  assert.ok(manifest.vocabulary.every((item) => item.url.includes('/api/audio/speech')))

  const unavailableTranscription = await fetch(`${baseUrl}/api/audio/transcribe`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl: 'data:audio/webm;base64,AA==' }),
  })
  assert.equal(unavailableTranscription.status, 503)
  const translationResponse = await fetch(`${baseUrl}/api/grade/translation`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, answer: lesson.translation.referenceZh }),
  })
  assert.equal(translationResponse.status, 200)
  const translation = await translationResponse.json()
  assert.equal(translation.graderType, 'local')
  assert.equal(translation.correct, true)
  assert.equal(translation.submissionVersion, 1)
  assert.ok(translation.score >= 80)

  const nextState = bootstrap.learningState
  nextState.records[lesson.id] = {
    ...nextState.records[lesson.id],
    completedSteps: ['guide', 'listening', 'translation'],
    listeningNotes: '测试理解',
    translationDraft: lesson.translation.referenceZh,
    translationScore: translation.score,
    translationFeedback: translation,
  }
  const stateResponse = await fetch(`${baseUrl}/api/learning-state`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(nextState),
  })
  assert.equal(stateResponse.status, 200)
  const savedState = await stateResponse.json()
  assert.equal(savedState.records[lesson.id].translationScore, translation.score)

  const restartResponse = await fetch(`${baseUrl}/api/lessons/${encodeURIComponent(lesson.id)}/restart`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(restartResponse.status, 200)
  const restartedState = await restartResponse.json()
  assert.deepEqual(restartedState.records[lesson.id].completedSteps, [])
  assert.equal(restartedState.records[lesson.id].translationScore, undefined)

  const recordedAudioDataUrl = testWavDataUrl()
  const shortAssessmentResponse = await fetch(`${baseUrl}/api/audio/assess`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, dataUrl: recordedAudioDataUrl, durationSeconds: 1 }),
  })
  assert.equal(shortAssessmentResponse.status, 400)
  assert.match((await shortAssessmentResponse.json()).error, /录音过短/u)

  const savedRecordingResponse = await fetch(`${baseUrl}/api/audio/recording?lessonId=${encodeURIComponent(lesson.id)}`, {
    headers: { Cookie: cookie },
  })
  assert.equal(savedRecordingResponse.status, 200)
  assert.equal(savedRecordingResponse.headers.get('content-type'), 'audio/wav')
  assert.equal((await savedRecordingResponse.arrayBuffer()).byteLength, 44 + 32_000)

  const recordingBootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.ok(recordingBootstrap.learningState.records[lesson.id].lastSpeakingRecording.url.includes('/api/audio/recording'))
  assert.equal(recordingBootstrap.learningState.records[lesson.id].lastSpeakingRecording.durationSeconds, 1)

  const profileResponse = await fetch(`${baseUrl}/api/profile`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bootstrap.profile, targetExam: '雅思', preferredLevel: 'L3', dailyGoalMinutes: 30 }),
  })
  assert.equal(profileResponse.status, 200)
  assert.deepEqual(await profileResponse.json(), { ...bootstrap.profile, targetExam: '雅思', preferredLevel: 'L3', dailyGoalMinutes: 30 })

  const incorrectWritingResponse = await fetch(`${baseUrl}/api/grade/writing`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lessonId: lesson.id, answer: 'i can walk for ten mini every day.' }),
  })
  assert.equal(incorrectWritingResponse.status, 200)
  const incorrectWriting = await incorrectWritingResponse.json()
  assert.equal(incorrectWriting.correct, false)
  assert.ok(incorrectWriting.score <= 74)
  assert.match(incorrectWriting.improvements.join(' '), /“mini” → “minutes”/u)

  const articleWritingResponse = await fetch(`${baseUrl}/api/grade/writing`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lessonId: lesson.id,
      answer: lesson.writing.secondaryAnswers[0],
      audioMetadata: { promptIndex: 1 },
    }),
  })
  assert.equal(articleWritingResponse.status, 200)
  const articleWriting = await articleWritingResponse.json()
  assert.equal(articleWriting.correct, true)
  assert.equal(articleWriting.prompt, lesson.writing.secondaryPromptZh)
  assert.ok(articleWriting.dimensions.some((dimension) => dimension.label === '文章相关度'))

  const reviewBootstrapResponse = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } })
  const reviewBootstrap = await reviewBootstrapResponse.json()
  assert.equal(reviewBootstrap.reviewItems.length, 1)
  assert.ok(reviewBootstrap.reviewItems[0].reviewTaskId)
  const errorItemId = reviewBootstrap.reviewItems[0].id
  const snoozedReview = await fetch(`${baseUrl}/api/review-items/${errorItemId}/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'snooze' }),
  }).then((response) => response.json())
  assert.equal(snoozedReview.reviewItems.length, 1)
  const deletedReview = await fetch(`${baseUrl}/api/review-items/${errorItemId}/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'delete' }),
  }).then((response) => response.json())
  assert.equal(deletedReview.reviewItems.length, 0)
  const restoredReview = await fetch(`${baseUrl}/api/review-items/${errorItemId}/action`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'restore' }),
  }).then((response) => response.json())
  assert.equal(restoredReview.reviewItems.length, 1)
  for (let mastery = 1; mastery <= 3; mastery += 1) {
    const nextBootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json())
    const currentReview = nextBootstrap.reviewItems[0]
    const reviewResponse = await fetch(`${baseUrl}/api/review/${currentReview.reviewTaskId}/attempt`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: currentReview.correction }),
    })
    assert.equal(reviewResponse.status, 200)
    const result = await reviewResponse.json()
    assert.equal(result.correct, true)
    assert.equal(result.mastery, mastery)
  }
  const completedReviewBootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } }).then((response) => response.json())
  assert.equal(completedReviewBootstrap.reviewItems.length, 0)

  const statsResponse = await fetch(`${baseUrl}/api/content/stats`, { headers: { Cookie: cookie } })
  const stats = await statsResponse.json()
  assert.equal(stats.lessons, 1000)
  assert.equal(stats.sources, 1000)
  assert.equal(stats.submissions, 3)
  assert.ok(stats.dictionaryEntries > 0)

  const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  })
  assert.equal(logoutResponse.status, 200)
  assert.deepEqual(await logoutResponse.json(), { ok: true })

  const expiredSession = await fetch(`${baseUrl}/api/session`, {
    headers: { Cookie: cookie },
  })
  assert.equal(expiredSession.status, 200)
  assert.equal(await expiredSession.json(), null)
})
