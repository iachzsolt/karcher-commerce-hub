import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { hasActiveHistoryRows } from '../src/utils/historyMerge.ts'
import {
  hasFastPollEligibleHistoryWork, startHistoryPolling,
  SYNC_FAST_POLL_WINDOW_MS, RUN_FAST_POLL_WINDOW_MS,
  type PollableHistoryState,
} from '../src/utils/historyPolling.ts'

const NOW = Date.parse('2026-10-23T10:00:00Z')
const event = (age: number, status = 'PENDING', id = 'pending') => ({
  id, listingId: 'listing-1', eventType: 'SYNC', source: 'INVENTORY_AUTOMATION',
  newValue: status, occurredAt: new Date(NOW - age).toISOString(),
})
const state = (events: ReturnType<typeof event>[] = [], inventoryRuns: PollableHistoryState['inventoryRuns'] = []): PollableHistoryState => ({
  events, inventoryRuns, catalogRuns: [],
})

for (const status of ['PENDING', 'REACTIVATION_IN_PROGRESS']) {
  test(`fresh unresolved ${status} permits fast polling`, () => {
    assert.equal(hasFastPollEligibleHistoryWork(state([event(60000, status)]), NOW), true)
  })
  test(`stale unresolved ${status} stops fast polling but remains unresolved`, () => {
    const input = state([event(SYNC_FAST_POLL_WINDOW_MS, status)])
    const snapshot = JSON.stringify(input)
    assert.equal(hasActiveHistoryRows(input), true)
    assert.equal(hasFastPollEligibleHistoryWork(input, NOW), false)
    assert.equal(JSON.stringify(input), snapshot)
  })
}
test('RUNNING wrappers use a conservative 60-minute window', () => {
  assert.equal(RUN_FAST_POLL_WINDOW_MS, 60 * 60000)
  for (const collection of ['inventoryRuns', 'catalogRuns'] as const) {
    const input = state()
    input[collection] = [{status: 'RUNNING', startedAt: new Date(NOW - 55 * 60000).toISOString()}]
    assert.equal(hasFastPollEligibleHistoryWork(input, NOW), true)
    input[collection][0].startedAt = new Date(NOW - RUN_FAST_POLL_WINDOW_MS).toISOString()
    assert.equal(hasFastPollEligibleHistoryWork(input, NOW), false)
    assert.equal(hasActiveHistoryRows(input), true)
  }
})
test('terminal evidence is preserved, including explicit reconciliation', () => {
  const pending = event(120000)
  const success = event(60000, 'SUCCESS', 'success')
  assert.equal(hasFastPollEligibleHistoryWork(state([pending, success]), NOW), false)
  const command = { ...pending, metadataJson: '{"commandId":"command-1"}' }
  const reconciled = { ...success, metadataJson: JSON.stringify({ reconciled: true, supersedesOccurredAt: pending.occurredAt }) }
  assert.equal(hasFastPollEligibleHistoryWork(state([command, reconciled]), NOW), false)
})
test('mixed fresh and stale unresolved work polls only because fresh exists', () => {
  const input = state([event(3600000), {...event(60000), listingId:'listing-2'}])
  assert.equal(hasFastPollEligibleHistoryWork(input, NOW), true)
  assert.equal(hasFastPollEligibleHistoryWork(input, NOW + SYNC_FAST_POLL_WINDOW_MS), false)
})
test('new meaningful event can restore eligibility; old evidence and receipt time cannot', () => {
  const old = event(3600000)
  assert.equal(hasFastPollEligibleHistoryWork(state([old]), NOW), false)
  assert.equal(hasFastPollEligibleHistoryWork(state([old, event(0)]), NOW), true)
  assert.equal(hasFastPollEligibleHistoryWork(state([event(60000, 'SUCCESS'), old]), NOW), false)
})
test('missing/invalid/future progress cannot authorize endless fast polling', () => {
  for (const occurredAt of ['', 'invalid', new Date(NOW + 60000).toISOString()]) {
    assert.equal(hasFastPollEligibleHistoryWork(state([{...event(0), occurredAt}]), NOW), false)
  }
})

const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function harness(input: PollableHistoryState, initialVisibility = 'visible') {
  let now = NOW, visibility = initialVisibility, calls = 0, nextId = 0
  const timers = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const stop = startHistoryPolling({
    eligible: () => hasFastPollEligibleHistoryWork(input, now),
    refresh: async () => { calls++ }, visibility: () => visibility,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    schedule: (callback, delay) => { assert.equal(delay,60000); const id = ++nextId; timers.set(id,callback); return id },
    cancel: id => { timers.delete(id) },
  })
  return { timers, listeners, stop, calls: () => calls,
    advance: (ms: number) => { now += ms },
    tick: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()) },
    visibility: (next: string) => { visibility = next; listeners.forEach(listener => listener()) },
  }
}
test('production-shaped two stale wrappers and 89 pending rows create zero timers', () => {
  const input = state(Array.from({length:89},(_,i)=>({...event(24*3600000),listingId:`listing-${i}`})),
    Array.from({length:2},()=>({status:'RUNNING',startedAt:new Date(NOW-23*3600000).toISOString()})))
  const snapshot = JSON.stringify(input)
  const h = harness(input)
  assert.equal(hasActiveHistoryRows(input), true)
  assert.equal(h.timers.size,0); assert.equal(h.calls(),0)
  assert.equal(JSON.stringify(input),snapshot)
  h.stop()
})
test('fast polling expires without another render or any fabricated terminal state', async () => {
  const input = state([event(SYNC_FAST_POLL_WINDOW_MS - 120000)])
  const h = harness(input)
  h.advance(60000); h.tick(); await settle()
  assert.equal(h.calls(),1); assert.equal(h.timers.size,1)
  h.advance(60000); h.tick(); await settle()
  assert.equal(h.calls(),1); assert.equal(h.timers.size,0)
  assert.equal(hasActiveHistoryRows(input),true); h.stop()
})
test('hidden suppresses all polling; restoration refreshes once and stale remains timer-free', async () => {
  const h = harness(state([event(24*3600000)]),'hidden')
  assert.equal(h.timers.size,0)
  h.visibility('visible'); h.visibility('visible'); await settle()
  assert.equal(h.calls(),1); assert.equal(h.timers.size,0)
  h.stop(); assert.equal(h.listeners.size,0)
})
test('hide cancels fresh timer; restore resumes exactly one timer', async () => {
  const h = harness(state([event(0)]))
  assert.equal(h.timers.size,1)
  h.visibility('hidden'); assert.equal(h.timers.size,0)
  h.visibility('visible'); h.visibility('visible'); await settle()
  assert.equal(h.calls(),1); assert.equal(h.timers.size,1); assert.equal(h.listeners.size,1)
  h.stop(); assert.equal(h.timers.size,0)
})
test('terminal response stops timer; repeated receipts do not extend timestamps', async () => {
  const input = state([event(0)])
  const h = harness(input)
  input.events.push(event(0,'SUCCESS','success'))
  // Move terminal after pending to supply unambiguous authoritative resolution.
  input.events[1].occurredAt = new Date(NOW+1).toISOString()
  h.tick(); await settle(); assert.equal(h.timers.size,0); assert.equal(h.calls(),0)
  h.stop()
})
test('visibility changes during in-flight work do not duplicate or defer refreshes', async () => {
  let visible = 'hidden', calls = 0, listener = () => {}, timers = 0
  let finish!: () => void
  const stop = startHistoryPolling({
    eligible: () => true, refresh: () => { calls++; return new Promise<void>(resolve => { finish=resolve }) },
    visibility: () => visible, subscribe: cb => { listener=cb; return () => {} },
    schedule: () => { timers++; return 1 }, cancel: () => { timers-- },
  })
  visible='visible'; listener(); visible='hidden'; listener(); visible='visible'; listener()
  assert.equal(calls,1); finish(); await settle(); assert.equal(timers,1)
  stop(); assert.equal(timers,0)
})
test('manual full refresh stays available and bypasses fast-poll eligibility', () => {
  const page = readFileSync(new URL('../src/pages/AllegroHistoryPage.tsx',import.meta.url),'utf8')
  assert.match(page,/onClick=\{\(\) => void loadHistory\(\)\}>\s*Frissítés/)
  const fullLoader = page.slice(page.indexOf('const loadHistory ='),page.indexOf('const loadActiveUpdates ='))
  assert.doesNotMatch(fullLoader,/hasFastPollEligibleHistoryWork/)
  assert.match(fullLoader,/new URLSearchParams\(\{ from, to \}\)/)
  assert.match(page,/refresh: loadActiveUpdates/)
})
