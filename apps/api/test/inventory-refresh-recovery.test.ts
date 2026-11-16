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

test('never recovers a run containing persisted automation state', () => {
  for (const value of ['{"cursor":{}}', 'invalid-json', '']) {
    assert.equal(canRecoverOrphanedInventoryRun(candidate({
      run: { ...candidate().run, automationDetailsJson: value },
    })), false)
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
