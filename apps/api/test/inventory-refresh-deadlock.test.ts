import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { coordinateInventoryRefresh } from '../src/inventory-refresh-coordinator.ts'
import {
  recoverOrphanedInventoryRuns,
  DATA_CONNECTION_RUN_STALE_THRESHOLD_MS,
} from '../src/data-connections.ts'

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const connectionId = 'conn-1'

function stubRecoveryDatabase(orphanRows: Array<{
  id: string
  status: string
  startedAt: Date
  automationDetailsJson: string | null
}>) {
  const updateCalls: Array<{ set: Record<string, unknown>; where: unknown }> = []

  const database = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(orphanRows),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          updateCalls.push({ set: values, where: condition })
          return Promise.resolve()
        },
      }),
    }),
  }

  return { database, updateCalls }
}

/* ================================================================== *
 * 1. Coordinator-level deadlock and recovery
 * ================================================================== */

void describe('coordinator deadlock recovery', () => {

  void it('deadlock: orphaned run blocks new refresh without recovery hook', async () => {
    await assert.rejects(
      () =>
        coordinateInventoryRefresh({
          trigger: 'SCHEDULED',
          existing: async () => null,
          withLease: async action => action({} as never),
          recentRun: async () => ({ id: 'orphan-run' }),
          execute: async () => 'unreachable',
        }),
      { message: /Recent unfinished inventory run: orphan-run/ },
    )
  })

  void it('recovery hook runs before recentRun and unblocks new execution', async () => {
    const callOrder: string[] = []
    let orphanCleared = false

    const result = await coordinateInventoryRefresh({
      trigger: 'SCHEDULED',
      existing: async () => null,
      withLease: async action => action({} as never),
      recoverOrphanedRun: async () => {
        callOrder.push('recover')
        orphanCleared = true
      },
      recentRun: async () => {
        callOrder.push('recentRun')
        return orphanCleared ? undefined : { id: 'orphan-run' }
      },
      execute: async () => {
        callOrder.push('execute')
        return 'new-run-started'
      },
    })

    assert.deepEqual(callOrder, ['recover', 'recentRun', 'execute'])
    assert.equal(result, 'new-run-started')
  })

  void it('recovery hook is skipped for MANUAL trigger existing-run fast path', async () => {
    let recoverCalled = false

    const result = await coordinateInventoryRefresh({
      trigger: 'MANUAL',
      existing: async () => ({ triggerType: 'MANUAL', id: 'existing-run' }),
      withLease: async () => { throw new Error('should not acquire lease') },
      recoverOrphanedRun: async () => { recoverCalled = true },
      recentRun: async () => undefined,
      execute: async () => 'unreachable',
    })

    assert.equal(recoverCalled, false)
    assert.deepEqual(result, { triggerType: 'MANUAL', id: 'existing-run' })
  })

  void it('concurrent schedulers serialize on the execution lease', async () => {
    let leaseHeld = false
    const callOrder: string[] = []

    const withLease = async (action: (lease: unknown) => Promise<unknown>) => {
      if (leaseHeld) throw new Error('Lease already held — concurrent access')
      leaseHeld = true
      callOrder.push('lease-acquired')
      try {
        return await action({})
      } finally {
        leaseHeld = false
        callOrder.push('lease-released')
      }
    }

    await coordinateInventoryRefresh({
      trigger: 'SCHEDULED',
      existing: async () => null,
      withLease: withLease as never,
      recoverOrphanedRun: async () => { callOrder.push('recover') },
      recentRun: async () => undefined,
      execute: async () => { callOrder.push('execute'); return 'done' },
    })

    assert.deepEqual(callOrder, [
      'lease-acquired', 'recover', 'execute', 'lease-released',
    ])
  })
})

/* ================================================================== *
 * 2. recoverOrphanedInventoryRuns
 * ================================================================== */

void describe('recoverOrphanedInventoryRuns', () => {
  const now = new Date('2026-11-17T12:00:00.000Z')
  const staleStart = new Date(
    now.getTime() - DATA_CONNECTION_RUN_STALE_THRESHOLD_MS - 60_000,
  )
  const freshStart = new Date(
    now.getTime() - 10 * 60 * 1000,
  )

  void it('recovers a stale cursor-less RUNNING record', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'orphan-1', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: null },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, ['orphan-1'])
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0]!.set['status'], 'INTERRUPTED')
    assert.ok(updateCalls[0]!.set['finishedAt'] instanceof Date)
  })

  void it('skips a fresh cursor-less RUNNING record', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'fresh-1', status: 'RUNNING', startedAt: freshStart, automationDetailsJson: null },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, [])
    assert.equal(updateCalls.length, 0)
  })

  void it('never touches records with a valid resumable cursor', async () => {
    const validCursor = JSON.stringify({
      version: 1,
      platforms: [],
      cursor: {
        version: 1,
        runId: 'with-cursor',
        connectionId: connectionId,
        phase: 'AUTOMATION',
        plans: [{ kind: 'UNSUPPORTED', platformCode: 'ALLEGRO', accountId: 'a-1' }],
        planIndex: 0,
      },
    })
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'with-cursor', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: validCursor },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, [])
    assert.equal(updateCalls.length, 0)
  })

  void it('recovers legacy non-null details without cursor key (production scenario)', async () => {
    const legacyDetails = JSON.stringify({
      version: 1,
      platforms: [
        { ok: true, httpStatus: 204, attempted: 0, pending: 0 },
        { ok: false, httpStatus: 200, attempted: 15, pending: 15, failed: 0, totalListings: 470 },
      ],
    })
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'legacy-run', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: legacyDetails },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, ['legacy-run'])
    assert.equal(updateCalls.length, 1)
    assert.equal(updateCalls[0]!.set['status'], 'INTERRUPTED')
  })

  void it('recovers corrupt automation details', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'corrupt-1', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: '{"cursor":{}}' },
      { id: 'corrupt-2', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: 'not-json' },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, ['corrupt-1', 'corrupt-2'])
    assert.equal(updateCalls.length, 2)
  })

  void it('recovers multiple orphans in one pass', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'orphan-a', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: null },
      { id: 'orphan-b', status: 'RUNNING', startedAt: new Date(staleStart.getTime() - 3600_000), automationDetailsJson: null },
      { id: 'too-fresh', status: 'RUNNING', startedAt: freshStart, automationDetailsJson: null },
    ])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, ['orphan-a', 'orphan-b'])
    assert.equal(updateCalls.length, 2)
  })

  void it('returns empty when no orphans exist', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([])

    const result = await recoverOrphanedInventoryRuns(
      database as never, connectionId, now,
    )

    assert.deepEqual(result.recovered, [])
    assert.equal(updateCalls.length, 0)
  })

  void it('sets the atomic status guard on each update', async () => {
    const { database, updateCalls } = stubRecoveryDatabase([
      { id: 'orphan-1', status: 'RUNNING', startedAt: staleStart, automationDetailsJson: null },
    ])

    await recoverOrphanedInventoryRuns(database as never, connectionId, now)

    assert.equal(updateCalls.length, 1)
    const set = updateCalls[0]!.set
    assert.equal(set['status'], 'INTERRUPTED')
    assert.equal(
      set['error'],
      'Az elárvult futást automatikusan lezárta az ütemező.',
    )
  })
})
