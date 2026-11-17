import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canRecoverOrphanedInventoryRun } from '../src/inventory-refresh-recovery.js'

const now = new Date('2026-11-16T12:00:00.000Z')

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    run: {
      status: 'RUNNING',
      startedAt: new Date('2026-11-16T11:00:00.000Z'),
      automationDetailsJson: null,
    },
    importState: 'SAFE' as const,
    leaseOwned: true,
    now,
    ...overrides,
  }
}

test('allows recovery of a stale cursorless run with verified safe import', () => {
  assert.equal(canRecoverOrphanedInventoryRun(candidate()), true)
})

test('does not recover a recent run', () => {
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    run: {
      ...candidate().run,
      startedAt: new Date('2026-11-16T11:45:00.000Z'),
    },
  })), false)
})

test('never recovers a run with a valid resumable cursor', () => {
  const validCursor = JSON.stringify({
    version: 1,
    platforms: [],
    cursor: {
      version: 1,
      runId: 'run-1',
      connectionId: 'conn-1',
      phase: 'AUTOMATION',
      plans: [{ kind: 'UNSUPPORTED', platformCode: 'ALLEGRO', accountId: 'a-1' }],
      planIndex: 0,
    },
  })
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    run: { ...candidate().run, automationDetailsJson: validCursor },
  })), false)
})

test('recovers a run with non-null details but no cursor key (legacy format)', () => {
  const legacyDetails = JSON.stringify({ version: 1, platforms: [{ ok: true }] })
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    run: { ...candidate().run, automationDetailsJson: legacyDetails },
  })), true)
})

test('recovers a run with corrupt or empty automation details', () => {
  for (const value of ['{"cursor":{}}', 'invalid-json', '']) {
    assert.equal(canRecoverOrphanedInventoryRun(candidate({
      run: { ...candidate().run, automationDetailsJson: value },
    })), true, `expected recovery for automationDetailsJson = ${JSON.stringify(value)}`)
  }
})

test('does not recover without an owned lease', () => {
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    leaseOwned: false,
  })), false)
})

test('does not recover while import is running', () => {
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    importState: 'RUNNING',
  })), false)
})

test('does not recover with unknown import state', () => {
  assert.equal(canRecoverOrphanedInventoryRun(candidate({
    importState: 'UNKNOWN',
  })), false)
})
