import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasActiveHistoryRows } from '../src/utils/historyMerge.ts'
import { isActiveRun, startActiveRunPolling } from '../src/utils/activeRunPolling.ts'

const event = (status: string, minute: number, listingId = 'a', group = 'run-1') => ({
  id: `${listingId}-${minute}-${status}`, listingId, source: 'INVENTORY_AUTOMATION',
  eventType: 'SYNC', newValue: status, occurredAt: new Date(1760000000000 + minute * 60000).toISOString(),
  metadataJson: JSON.stringify({ historyGroupId: group }),
})
const active = (events: ReturnType<typeof event>[]) => hasActiveHistoryRows({ events, catalogRuns: [], inventoryRuns: [] })
for (const pending of ['PENDING', 'REACTIVATION_IN_PROGRESS']) {
  test(`${pending} followed by terminal is inactive in either input order`, () => {
    for (const terminal of ['SUCCESS', 'FAILED', 'NO_CHANGE']) {
      const rows = [event(pending, 0), event(terminal, 1)]
      assert.equal(active(rows), false)
      assert.equal(active([...rows].reverse()), false)
    }
  })
  test(`unresolved ${pending} remains active`, () => assert.equal(active([event(pending, 0)]), true))
}
test('mixed listings resolve independently; history is not mutated', () => {
  const rows = [event('PENDING', 0), event('PENDING', 1), event('SUCCESS', 2), event('PENDING', 0, 'b')]
  const snapshot = JSON.stringify(rows)
  assert.equal(active(rows), true)
  assert.equal(active([...rows, event('SUCCESS', 3, 'b')]), false)
  assert.equal(JSON.stringify(rows), snapshot)
})
test('latest listing state resolves legacy pending across display batches', () => {
  assert.equal(active([event('PENDING', 0), event('SUCCESS', 1, 'a', 'other-run')]), false)
  assert.equal(active([event('PENDING', 0), { ...event('SUCCESS', 1), metadataJson: '{"reconciled":true}' }]), false)
})
test('a different explicit command/source cannot close a pending command', () => {
  assert.equal(active([
    { ...event('PENDING', 0), metadataJson: '{"commandId":"first"}' },
    { ...event('SUCCESS', 1), metadataJson: '{"commandId":"second"}' },
  ]), true)
  assert.equal(active([event('PENDING', 0), { ...event('SUCCESS', 1), source: 'OTHER' }]), true)
})
test('equal timestamps fail conservatively without input-order dependence', () => {
  const rows = [event('PENDING', 0), event('SUCCESS', 0)]
  assert.equal(active(rows), true)
  assert.equal(active(rows.reverse()), true)
})
test('explicit reconciliation supersedes the identified pending timestamp without a command ID', () => {
  const pending = { ...event('PENDING', 0), metadataJson: '{"commandId":"first"}' }
  const confirmed = { ...event('SUCCESS', 1), metadataJson: JSON.stringify({ reconciled: true, supersedesOccurredAt: pending.occurredAt }) }
  assert.equal(active([pending, confirmed]), false)
  assert.equal(active([pending, { ...confirmed, listingId: 'another' }]), true)
})
test('running wrappers count independently of resolved events', () => {
  for (const status of ['RUNNING', 'COMPLETED', 'FAILED', 'INTERRUPTED']) {
    assert.equal(hasActiveHistoryRows({events: [], catalogRuns: [], inventoryRuns: [{status}]}), status === 'RUNNING')
  }
})

const settle = () => new Promise<void>(resolve => setImmediate(resolve))
function harness(initial = 'RUNNING', initialVisibility = 'visible') {
  let status = initial
  let visibility = initialVisibility
  let calls = 0
  let counter = 0
  const timers = new Map<number, () => void>()
  const listeners = new Set<() => void>()
  const published: string[] = []
  const stop = startActiveRunPolling({
    read: async () => { calls++; return status }, publish: value => published.push(value), isActive: isActiveRun,
    visibility: () => visibility,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    schedule: (callback, delay) => { assert.equal(delay, 60000); const id = ++counter; timers.set(id, callback); return id },
    cancel: id => { timers.delete(id) },
  })
  return {
    timers, listeners, published, stop, calls: () => calls,
    status: (next: string) => { status = next },
    visibility: (next: string) => { visibility = next; for (const listener of listeners) listener() },
    tick: () => { const entries = [...timers]; timers.clear(); for (const [,callback] of entries) callback() },
  }
}
for (const status of ['PENDING', 'RUNNING']) {
  test(`visible ${status} polls until terminal then stops`, async () => {
    const h = harness(status); await settle()
    assert.equal(h.calls(), 1); assert.equal(h.timers.size, 1)
    h.tick(); await settle(); assert.equal(h.calls(), 2); assert.equal(h.timers.size, 1)
    h.status('COMPLETED'); h.tick(); await settle(); assert.equal(h.timers.size, 0)
    h.stop(); assert.equal(h.listeners.size, 0)
  })
}
test('terminal latest run creates no recurring timer but visibility restore refreshes once', async () => {
  const h = harness('COMPLETED'); await settle(); assert.equal(h.timers.size, 0)
  h.visibility('hidden'); h.visibility('visible'); h.visibility('visible'); await settle()
  assert.equal(h.calls(), 2); assert.equal(h.timers.size, 0)
  h.status('PENDING'); h.visibility('hidden'); h.visibility('visible'); await settle()
  assert.equal(h.timers.size, 1); h.stop()
})
test('hidden mount and hide while active perform no polling or catch-up', async () => {
  const h = harness('RUNNING', 'hidden'); await settle(); assert.equal(h.calls(), 0)
  h.visibility('visible'); await settle(); assert.equal(h.calls(), 1)
  h.visibility('hidden'); assert.equal(h.timers.size, 0)
  h.tick(); await settle(); assert.equal(h.calls(), 1)
  h.visibility('visible'); h.visibility('visible'); await settle()
  assert.equal(h.calls(), 2); assert.equal(h.timers.size, 1); assert.equal(h.listeners.size, 1)
  h.stop(); assert.equal(h.timers.size, 0); assert.equal(h.listeners.size, 0)
})
test('restore during an in-flight request neither overlaps nor queues duplicate work', async () => {
  let finish!: (value: string) => void
  let listener = () => {}
  let visible = 'visible'; let calls = 0; let timers = 0; let publishes = 0
  const stop = startActiveRunPolling({
    read: () => { calls++; return new Promise<string>(resolve => { finish = resolve }) },
    publish: () => { publishes++ }, isActive: isActiveRun, visibility: () => visible,
    subscribe: cb => { listener = cb; return () => {} }, schedule: () => { timers++; return 1 }, cancel: () => { timers-- },
  })
  visible = 'hidden'; listener(); visible = 'visible'; listener(); listener()
  assert.equal(calls, 1)
  stop(); finish('RUNNING'); await settle()
  assert.equal(publishes, 0); assert.equal(timers, 0)
})
