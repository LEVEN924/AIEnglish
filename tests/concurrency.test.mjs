import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLimiter } from '../server/concurrency.mjs'

test('speech queue is bounded, expires waiting jobs, and recovers after provider failures', async () => {
  const limit = createLimiter({ concurrency: 1, maxQueued: 1, queueTimeoutMs: 20 })
  let release
  const first = limit(() => new Promise((done) => { release = done }))
  const waiting = limit(() => { throw Error('Expired job must never run') })
  await assert.rejects(limit(async () => 'overflow'), (error) => error.statusCode === 503)
  await assert.rejects(waiting, (error) => error.statusCode === 503)
  release('done'); assert.equal(await first, 'done')
  await assert.rejects(limit(async () => { throw Error('provider failed') }), /provider failed/u)
  assert.equal(await limit(async () => 'recovered'), 'recovered')
})
