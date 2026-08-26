import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessTencentPronunciation, planAssessmentSegments, splitAssessmentReference } from '../server/tencent-cloud.mjs'

const wordsOf = text => text.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/gu) ?? []
const reference = Array.from({ length: 20 }, () => 'A daily learning habit helps people make steady progress.').join(' ')

function wavData(seconds) {
  const pcm = Buffer.alloc(Math.round(seconds * 32000 / 2) * 2)
  const wav = Buffer.alloc(44 + pcm.length)
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44)
  return `data:audio/wav;base64,${wav.toString('base64')}`
}

function mockProvider(context, outcome = 'success') {
  for (const [key, value] of Object.entries({ TENCENTCLOUD_APP_ID: '1250000000', TENCENTCLOUD_SECRET_ID: 'not-a-real-id', TENCENTCLOUD_SECRET_KEY: 'never-sent', TENCENT_SOE_SCORE_COEFF: '4', TENCENT_SOE_CONCURRENCY: '4' })) {
    const previous = process.env[key]
    process.env[key] = value
    context.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  }
  const previous = globalThis.WebSocket
  const state = { connections: [], active: 0, peak: 0 }
  globalThis.WebSocket = class FakeSocket extends EventTarget {
    static OPEN = 1
    readyState = 1
    packets = []
    constructor(url) {
      super()
      const params = new URL(url).searchParams
      this.mode = Number(params.get('rec_mode'))
      this.reference = params.get('ref_text')
      assert.equal(params.get('score_coeff'), '4')
      assert.equal(params.get('voice_format'), '0')
      state.connections.push(this)
      state.active++; state.peak = Math.max(state.peak, state.active)
      queueMicrotask(() => this.message({ code: 0, message: 'success' }))
    }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
    send(data) {
      if (outcome === 'send-error') throw new Error('socket write failed')
      if (typeof data !== 'string') { this.packets.push(Buffer.from(data)); return }
      assert.deepEqual(JSON.parse(data), { type: 'end' })
      setTimeout(() => {
        const result = { SuggestedScore: 86, PronAccuracy: 90, PronFluency: 80, PronCompletion: 95, Words: [{ Word: 'daily', PronAccuracy: 65, MatchTag: 0 }] }
        if (outcome === 'early-close') {
          this.message({ code: 0, result, final: 0 })
          this.close()
        } else if (outcome === 'provider-error') this.message({ code: 4001, message: 'test provider failure' })
        else this.message({ code: 0, ...(outcome === 'no-result' ? {} : { result }), final: 1 })
      }, 10)
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3; state.active--
      this.dispatchEvent(new Event('close'))
    }
  }
  context.after(() => { globalThis.WebSocket = previous })
  return state
}

test('recording plans preserve all PCM/text and keep normal segments within 60s/118 words', () => {
  for (const seconds of [8, 60, 60.001, 64.296, 120, 300]) {
    const pcm = Buffer.alloc(Math.floor(seconds * 32000 / 2) * 2, 0x3c)
    const segments = planAssessmentSegments(pcm, reference)
    assert.deepEqual(Buffer.concat(segments.map(segment => segment.pcm)), pcm)
    assert.deepEqual(segments.flatMap(segment => wordsOf(segment.reference)), wordsOf(reference))
    assert.ok(segments.every(segment => segment.pcm.length > 0 && segment.pcm.length % 2 === 0))
    assert.ok(segments.every(segment => segment.pcm.length <= 60 * 32000 && segment.recordingMode))
    assert.ok(segments.every(segment => wordsOf(segment.reference).length <= 118))
  }
  const oneSentence = planAssessmentSegments(Buffer.alloc(64 * 32000), 'I can walk every day.')
  assert.ok(oneSentence.length > 1 && oneSentence.every(segment => segment.recordingMode))
  const indivisible = planAssessmentSegments(Buffer.alloc(90 * 32000), 'Hello.')
  assert.equal(indivisible.length, 1)
  assert.equal(indivisible[0].recordingMode, false)
  assert.throws(() => planAssessmentSegments(Buffer.alloc(8 * 32000), '123 ...'), /英文单词/u)
})

test('word limits count actual English words even with numbers or joined punctuation', () => {
  const text = '123 '.repeat(200) + 'hello/world '.repeat(150)
  const chunks = splitAssessmentReference(text)
  assert.ok(chunks.every(chunk => wordsOf(chunk).length <= 118))
  assert.deepEqual(chunks.flatMap(wordsOf), wordsOf(text))
})

test('finished recordings are sent once per connection and multiple users share a bounded queue', async context => {
  const state = mockProvider(context)
  const dataUrl = wavData(64.296)
  const results = await Promise.all(Array.from({ length: 3 }, () => assessTencentPronunciation({ dataUrl, referenceText: reference })))
  assert.equal(state.connections.length, 6)
  assert.equal(state.peak, 4)
  assert.equal(state.active, 0)
  for (const socket of state.connections) {
    assert.equal(socket.mode, 1)
    assert.equal(socket.packets.length, 1)
    assert.ok(socket.packets[0].length <= 60 * 32000)
    assert.ok(wordsOf(socket.reference).length <= 118)
  }
  for (const result of results) {
    assert.equal(result.graderType, 'tencent-soe')
    assert.equal(result.acousticAssessment, true)
    assert.equal(result.score, 86)
    assert.equal(result.providerScores.completion, 95)
    assert.equal(result.referenceSegments, 2)
    assert.equal(result.words.length, 2)
    assert.equal(result.transcript, 'daily daily')
  }
})

for (const [outcome, message] of [['early-close', /提前关闭/u], ['no-result', /没有返回/u], ['provider-error', /test provider failure/u], ['send-error', /发送失败/u]]) {
  test(`recording assessment fails promptly and closes resources: ${outcome}`, { timeout: 1000 }, async context => {
    const state = mockProvider(context, outcome)
    await assert.rejects(assessTencentPronunciation({ dataUrl: wavData(8), referenceText: 'A daily learning habit helps me.' }), message)
    assert.equal(state.active, 0)
  })
}
