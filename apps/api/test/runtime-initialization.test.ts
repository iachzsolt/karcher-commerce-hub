import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createRuntimeInitializer, needsPrimaryAllegroSession } from '../src/runtime-initialization.ts'

test('construction does not restore; concurrent callers await one restoration', async () => {
  let calls = 0
  let finish!: (value: boolean) => void
  const init = createRuntimeInitializer(() => {}, () => { calls++; return new Promise(resolve => { finish = resolve }) })
  assert.equal(calls, 0)
  const first = init(), second = init()
  assert.equal(first, second)
  await Promise.resolve(); assert.equal(calls, 1)
  finish(true); await first; await init(); assert.equal(calls, 1)
})
test('failed and unavailable restorations are retryable', async () => {
  let calls = 0
  const init = createRuntimeInitializer(() => {}, async () => {
    calls++
    if (calls === 1) throw new Error('unavailable')
    return calls > 2
  })
  await assert.rejects(init(), /unavailable/)
  await init(); await init(); await init(); assert.equal(calls, 3)
})
test('configuration remains fail-closed', () => {
  let restores = 0
  const init = createRuntimeInitializer(() => { throw new Error('config') }, async () => { restores++; return true })
  assert.throws(init, /config/); assert.equal(restores, 0)
})
test('health and notification routes do not request primary-session I/O', () => {
  for (const path of ['/health', '/auth/session', '/auth/allegro/notify-pull', '/auth/allegro/notify-ack', '/auth/allegro/notify-connect', '/auth/allegro/notify-callback']) {
    assert.equal(needsPrimaryAllegroSession(path), false)
  }
  for (const path of ['/allegro/listings', '/allegro/catalog-sync', '/auth/allegro/status', '/auth/allegro/push-status/id']) {
    assert.equal(needsPrimaryAllegroSession(path), true)
  }
})
test('Deno cron registration stays awaited and callbacks await initialization', () => {
  const deno = readFileSync(new URL('../src/deno.ts', import.meta.url), 'utf8')
  assert.match(deno, /await registerDataConnectionSchedulerCrons\(\)/)
  assert.match(deno, /await initializeCommerceHubRuntime\(\)\s+await job\(\)/)
  assert.doesNotMatch(deno, /initializeCommerceHubRuntime\(\)\.catch/)
  assert.match(deno, /validateCommerceHubRuntimeConfiguration\(\)\s+Deno.serve/)
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert(index.indexOf("app.use('*', accessAuthMiddleware)") < index.indexOf('needsPrimaryAllegroSession(context.req.path)'))
  assert.match(index, /await initializeCommerceHubRuntime\(\)\s+}\s+await next\(\)/)
})
