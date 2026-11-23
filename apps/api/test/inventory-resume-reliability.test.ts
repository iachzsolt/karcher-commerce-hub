/*
 * Regression tests for the scheduled inventory resume path
 * (incident 2026-11-23, run stuck at planIndex=0/batchIndex=0).
 *
 * Every external dependency is an in-memory fake: no database, no
 * Allegro API, no Deno runtime. The tests pin the guarantees recovery
 * relies on:
 *  - an interrupted slice never advances or drops the durable cursor;
 *  - progress is persisted only after a slice actually returned;
 *  - failures propagate unchanged (nothing is reported as progress);
 *  - scan failures and lease conflicts are surfaced, not hidden;
 *  - a run finalizes exactly once, with the right terminal status.
 *
 * Duplicate Allegro stock mutations are prevented by the durable
 * journal; see inventory-mutation-journal.test.ts and
 * inventory-reconciliation.test.ts for the command-level guarantees.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { continueScheduledSlices } from '../src/data-connections.ts'
import {
  createEmptyBatchState,
  readInventoryRefreshCursor,
  serializeAutomationDetailsWithCursor,
  type InventoryRefreshCursor,
} from '../src/inventory-refresh-slice.ts'
import {
  executeInventoryRefreshSlice,
  type InventoryRefreshState,
} from '../src/inventory-refresh-workflow.ts'
import {
  resumeEligibleInventoryRefreshes,
  type InventoryRefreshRunRow,
} from '../src/inventory-refresh-resume.ts'
import type {
  InventoryRefreshAutomationResult,
  InventoryRefreshSliceRunResult,
} from '../src/platform-automation.ts'

const RUN_ID = '2c1edbcf-a28c-478f-a354-f6620cb0648a'
const CONNECTION_ID = '0302f4dd-5593-4b76-8008-e9ae9a48087d'

function makeCursor(batchCount = 3): InventoryRefreshCursor {
  return {
    version: 1,
    runId: RUN_ID,
    connectionId: CONNECTION_ID,
    phase: 'AUTOMATION',
    planIndex: 0,
    plans: [{
      kind: 'ALLEGRO',
      accountId: 'account-1',
      historyGroupId: 'history-1',
      batches: Array.from({ length: batchCount }, (_, batch) =>
        Array.from({ length: 25 }, (_, item) => `listing-${batch}-${item}`)),
      batchIndex: 0,
      completedListingIds: [],
      partial: createEmptyBatchState(),
      completedBatches: [],
      skippedReason: null,
    }],
    nextAdvanceAt: null,
    lastStopReason: null,
  }
}

function serialized(cursor: InventoryRefreshCursor | null) {
  return serializeAutomationDetailsWithCursor({ version: 1, platforms: [] }, cursor)
}

function runningState(cursor: InventoryRefreshCursor): InventoryRefreshState {
  return {
    status: 'RUNNING',
    importStatus: 'SUCCESS',
    rowsImported: 5959,
    changedItemCount: 495,
    automationDetailsJson: serialized(cursor),
    error: null,
    finishedAt: null,
  }
}

function allegroResult(ok: boolean): InventoryRefreshAutomationResult {
  return {
    platform: 'ALLEGRO',
    accountId: 'account-1',
    outcome: ok ? 'SUCCESS' : 'FAILED',
    ok,
    status: ok ? 200 : 502,
    details: {
      status: ok ? 'SUCCESS' : 'PARTIAL_FAILURE',
      totalListings: 75,
      batchCount: 3,
      successfulBatches: ok ? 3 : 2,
      failedBatches: ok ? 0 : 1,
      batches: [],
    },
  }
}

/** Mirrors runInventoryRefreshSlice: mutates the cursor in place, one batch per call. */
function completeOneBatch(cursor: InventoryRefreshCursor, now: number): InventoryRefreshSliceRunResult {
  const plan = cursor.plans[0]
  if (plan.kind !== 'ALLEGRO') throw new Error('unexpected plan')
  plan.batchIndex += 1
  const done = plan.batchIndex >= plan.batches.length
  if (done) {
    cursor.planIndex += 1
    cursor.phase = 'FINALIZE'
    cursor.nextAdvanceAt = null
  } else {
    cursor.nextAdvanceAt = now + 2_500
  }
  return {
    cursor,
    done,
    results: [allegroResult(true)],
    stopReason: done ? null : 'WRITE_BUDGET',
    nextAdvanceAt: done ? now : now + 2_500,
    mutationAttempts: 5,
  }
}

function persistedCursor(state: InventoryRefreshState) {
  return readInventoryRefreshCursor(state.automationDetailsJson)
}

void describe('executeInventoryRefreshSlice: durable cursor guarantees', () => {
  void it('persists the advanced cursor after a successful slice and stays RUNNING', async () => {
    const cursor = makeCursor()
    const persisted: InventoryRefreshState[] = []

    const result = await executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor,
      state: runningState(makeCursor()),
      assertOwned: async () => {},
      persist: async state => { persisted.push(state) },
      advance: async next => completeOneBatch(next, 1_000),
    })

    assert.equal(result.status, 'RUNNING')
    assert.equal(result.finishedAt, null)
    assert.equal(result.advance.done, false)
    assert.equal(persisted.length, 1)
    const stored = persistedCursor(persisted[0])
    assert.ok(stored)
    assert.equal(stored.plans[0].kind === 'ALLEGRO' && stored.plans[0].batchIndex, 1)
    assert.equal(stored.nextAdvanceAt, 3_500)
    assert.equal(stored.lastStopReason, 'WRITE_BUDGET')
  })

  void it('keeps the original cursor and RUNNING status when the slice is interrupted mid-batch', async () => {
    const cursor = makeCursor()
    const original = runningState(makeCursor())
    const persisted: InventoryRefreshState[] = []
    const failure = new Error('Inventory slice failed with HTTP 500')

    await assert.rejects(
      executeInventoryRefreshSlice({
        trigger: 'SCHEDULED',
        runId: RUN_ID,
        cursor,
        state: original,
        assertOwned: async () => {},
        persist: async state => { persisted.push(state) },
        advance: async next => {
          // Partial in-memory progress, as the real driver makes before failing.
          const plan = next.plans[0]
          if (plan.kind === 'ALLEGRO') plan.completedListingIds.push('listing-0-0')
          throw failure
        },
      }),
      error => error === failure,
    )

    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].status, 'RUNNING')
    assert.equal(persisted[0].finishedAt, null)
    // The durable cursor is byte-identical: in-memory partial progress is never stored.
    assert.equal(persisted[0].automationDetailsJson, original.automationDetailsJson)
    // The failure message does not overwrite the run's own error field.
    assert.equal(persisted[0].error, null)
  })

  void it('fails before the first batch without calling Allegro when the lease is lost', async () => {
    const original = runningState(makeCursor())
    const persisted: InventoryRefreshState[] = []
    let advanceCalls = 0
    const lost = Object.assign(new Error('Inventory refresh execution lease lost'), { status: 409 })

    await assert.rejects(
      executeInventoryRefreshSlice({
        trigger: 'SCHEDULED',
        runId: RUN_ID,
        cursor: makeCursor(),
        state: original,
        assertOwned: async () => { throw lost },
        persist: async state => { persisted.push(state) },
        advance: async next => {
          advanceCalls += 1
          return completeOneBatch(next, 0)
        },
      }),
      error => error === lost,
    )

    assert.equal(advanceCalls, 0)
    assert.equal(persisted[0].automationDetailsJson, original.automationDetailsJson)
    assert.equal(persisted[0].status, 'RUNNING')
  })

  void it('surfaces a persistence failure instead of reporting progress', async () => {
    const dbDown = new Error('fetch failed')

    await assert.rejects(
      executeInventoryRefreshSlice({
        trigger: 'SCHEDULED',
        runId: RUN_ID,
        cursor: makeCursor(),
        state: runningState(makeCursor()),
        assertOwned: async () => {},
        persist: async () => { throw dbDown },
        advance: async next => completeOneBatch(next, 0),
      }),
      error => error === dbDown,
    )
  })

  void it('finalizes COMPLETED exactly when the last batch is done and drops the cursor', async () => {
    const cursor = makeCursor(1)
    const persisted: InventoryRefreshState[] = []

    const result = await executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor,
      state: runningState(makeCursor(1)),
      assertOwned: async () => {},
      persist: async state => { persisted.push(state) },
      advance: async next => completeOneBatch(next, 0),
      now: () => new Date('2026-11-23T15:30:00Z'),
    })

    assert.equal(result.status, 'COMPLETED')
    assert.equal(result.advance.done, true)
    assert.deepEqual(persisted[0].finishedAt, new Date('2026-11-23T15:30:00Z'))
    assert.equal(persistedCursor(persisted[0]), null)
  })

  void it('finalizes FAILED when a platform reports failed batches', async () => {
    const result = await executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor: makeCursor(1),
      state: runningState(makeCursor(1)),
      assertOwned: async () => {},
      persist: async () => {},
      advance: async next => ({ ...completeOneBatch(next, 0), results: [allegroResult(false)] }),
    })

    assert.equal(result.status, 'FAILED')
    assert.ok(result.error)
    assert.notEqual(result.finishedAt, null)
  })
})

void describe('scheduled resume: end-to-end with in-memory persistence', () => {
  void it('drives an untouched planIndex=0/batchIndex=0 run to COMPLETED in order', async () => {
    // Production starting point: frozen plan, no completed batch, nextAdvanceAt=null.
    const durable = { state: runningState(makeCursor(3)) }
    let clock = 10_000
    const seenBatchIndexes: number[] = []

    const stored = persistedCursor(durable.state)
    assert.ok(stored)
    const run = (state: InventoryRefreshState) => executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor: stored,
      state,
      assertOwned: async () => {},
      persist: async next => { durable.state = next },
      advance: async next => {
        const plan = next.plans[0]
        if (plan.kind === 'ALLEGRO') seenBatchIndexes.push(plan.batchIndex)
        return completeOneBatch(next, clock)
      },
    })

    const result = await continueScheduledSlices({
      result: await run(durable.state),
      runSlice: run,
      now: () => clock,
      sleep: async ms => { clock += ms },
      tickBudgetMs: 120_000,
    })

    assert.deepEqual(seenBatchIndexes, [0, 1, 2], 'each batch exactly once, in order')
    assert.equal(result.status, 'COMPLETED')
    assert.equal(durable.state.status, 'COMPLETED')
    assert.notEqual(durable.state.finishedAt, null)
  })

  void it('resumes from the last persisted batch after an interruption', async () => {
    const durable = { state: runningState(makeCursor(3)) }
    const seenBatchIndexes: number[] = []
    let interrupt = true

    const tick = async () => {
      const cursor = persistedCursor(durable.state)
      assert.ok(cursor, 'a RUNNING run always keeps a resumable cursor')
      return executeInventoryRefreshSlice({
        trigger: 'SCHEDULED',
        runId: RUN_ID,
        cursor,
        state: durable.state,
        assertOwned: async () => {},
        persist: async next => { durable.state = next },
        advance: async next => {
          const plan = next.plans[0]
          if (plan.kind === 'ALLEGRO') seenBatchIndexes.push(plan.batchIndex)
          if (plan.kind === 'ALLEGRO' && plan.batchIndex === 1 && interrupt) {
            interrupt = false
            throw new Error('isolate interrupted')
          }
          return completeOneBatch(next, 0)
        },
      })
    }

    await tick() // batch 0 completes and is persisted
    await assert.rejects(tick()) // batch 1 interrupted
    const afterInterruption = persistedCursor(durable.state)
    assert.ok(afterInterruption)
    assert.equal(afterInterruption.plans[0].kind === 'ALLEGRO' && afterInterruption.plans[0].batchIndex, 1)
    await tick() // batch 1 retried from the durable cursor
    await tick() // batch 2

    assert.deepEqual(seenBatchIndexes, [0, 1, 1, 2], 'batch 0 is never repeated')
    assert.equal(durable.state.status, 'COMPLETED')
  })
})

void describe('resume tick: failure surfacing', () => {
  function row(): InventoryRefreshRunRow {
    return {
      id: RUN_ID,
      connectionId: CONNECTION_ID,
      triggerType: 'SCHEDULED',
      status: 'RUNNING',
      automationDetailsJson: serialized(makeCursor()),
    }
  }

  void it('propagates a database scan failure unchanged and never advances', async () => {
    const scanFailure = new Error('NeonDbError: connection terminated')
    let advanced = 0

    await assert.rejects(
      resumeEligibleInventoryRefreshes({
        scan: async () => { throw scanFailure },
        advance: async () => { advanced += 1 },
      }),
      error => error === scanFailure,
    )
    assert.equal(advanced, 0)
  })

  void it('records a transient Allegro failure and resumes on the next tick', async () => {
    const failures: Array<{ runId: string; message: string }> = []
    let calls = 0
    const advance = async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
    }

    const first = await resumeEligibleInventoryRefreshes({
      scan: async () => [row()],
      advance,
      onError: entry => failures.push(entry),
    })
    const second = await resumeEligibleInventoryRefreshes({
      scan: async () => [row()],
      advance,
    })

    assert.deepEqual(first.failed, [{ runId: RUN_ID, message: 'fetch failed' }])
    assert.deepEqual(failures, first.failed)
    assert.deepEqual(second.advanced, [RUN_ID])
  })

  void it('treats an execution-lease conflict as BUSY without advancing twice', async () => {
    const busy = Object.assign(
      new Error('Inventory refresh is already executing for this connection'),
      { status: 409 },
    )

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [row()],
      advance: async () => { throw busy },
    })

    assert.deepEqual(result.advanced, [])
    assert.deepEqual(result.failed, [])
    assert.deepEqual(result.skipped, [{ runId: RUN_ID, reason: 'BUSY' }])
  })
})

void describe('inventory slice Allegro reads are bounded', () => {
  const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8')

  void it('the /sync product-offer publication lookup carries a timeout signal', () => {
    const syncRoute = source.indexOf("allegroAuth.post('/sync'")
    assert.ok(syncRoute > 0, '/sync route present')
    const lookup = source.indexOf("'/sale/product-offers/' +", syncRoute)
    assert.ok(lookup > syncRoute, 'product-offer lookup inside /sync')
    const callWindow = source.slice(lookup, lookup + 600)
    assert.match(callWindow, /signal: AbortSignal\.timeout\(10_000\)/)
  })

  void it('the /sync offer list request keeps its timeout', () => {
    assert.match(
      source,
      /offersUrl\.toString\(\),\s+\{\s+signal: AbortSignal\.timeout\(10_000\)/,
    )
  })
})
