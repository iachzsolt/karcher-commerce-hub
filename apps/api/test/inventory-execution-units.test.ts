/*
 * Durable execution units for the sliced inventory refresh.
 *
 * The real slice driver (`runInventoryRefreshSlice`), the real workflow
 * (`executeInventoryRefreshSlice`, `continueScheduledSlices`) and the real
 * stock journal (`executeStockMutation`) run here. Only the in-process
 * `/inventory-sync` transport and persistence are in-memory fakes: no
 * database, no Allegro API.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { continueScheduledSlices } from '../src/data-connections.ts'
import {
  executeStockMutation,
  type StockAuditEvent,
  type StockCommand,
  type StockMutationPorts,
} from '../src/inventory-mutation-journal.ts'
import {
  MAX_LISTINGS_PER_BATCH,
  MAX_LISTINGS_PER_EXECUTION_UNIT,
  createEmptyBatchState,
  createEmptyBatchSummary,
  nextExecutionUnitListingIds,
  readInventoryRefreshCursor,
  serializeAutomationDetailsWithCursor,
  type InventoryBatchSummary,
  type InventoryCursorAllegroPlan,
  type InventoryRefreshCursor,
  type InventorySliceReport,
  type InventorySliceStopReason,
} from '../src/inventory-refresh-slice.ts'
import {
  executeInventoryRefreshSlice,
  type InventoryRefreshState,
} from '../src/inventory-refresh-workflow.ts'
import {
  runInventoryRefreshSlice,
  type InventorySyncTransport,
} from '../src/platform-automation.ts'

const RUN_ID = '2c1edbcf-a28c-478f-a354-f6620cb0648a'
const CONNECTION_ID = '0302f4dd-5593-4b76-8008-e9ae9a48087d'
const LEASE = { name: `inventory-refresh:${CONNECTION_ID}`, ownerId: 'owner-1' }

function listingIds(count: number) {
  return Array.from({ length: count }, (_, index) => `listing-${String(index).padStart(3, '0')}`)
}

function planFor(ids: string[]): InventoryCursorAllegroPlan {
  const batches: string[][] = []
  for (let index = 0; index < ids.length; index += MAX_LISTINGS_PER_BATCH) {
    batches.push(ids.slice(index, index + MAX_LISTINGS_PER_BATCH))
  }
  return {
    kind: 'ALLEGRO',
    accountId: 'account-1',
    historyGroupId: 'history-1',
    batches,
    batchIndex: 0,
    completedListingIds: [],
    partial: createEmptyBatchState(),
    completedBatches: [],
    skippedReason: null,
  }
}

function cursorFor(ids: string[]): InventoryRefreshCursor {
  return {
    version: 1,
    runId: RUN_ID,
    connectionId: CONNECTION_ID,
    phase: 'AUTOMATION',
    planIndex: 0,
    plans: [planFor(ids)],
    nextAdvanceAt: null,
    lastStopReason: null,
  }
}

function allegroPlan(cursor: InventoryRefreshCursor) {
  const plan = cursor.plans[0]
  assert.equal(plan.kind, 'ALLEGRO')
  return plan as InventoryCursorAllegroPlan
}

type UnitOutcome = {
  /** Listings reported as terminal; default: every listing in the unit. */
  processed?: (unit: string[]) => string[]
  pending?: (unit: string[]) => string[]
  summary?: (unit: string[]) => Partial<InventoryBatchSummary>
  stopReason?: InventorySliceStopReason | null
  nextAdvanceAt?: number
  mutationAttempts?: number
}

/** Fake `/inventory-sync`: records every unit it receives. */
function fakeInventorySync(outcome: (call: number, unit: string[]) => UnitOutcome | Error = () => ({})) {
  const calls: string[][] = []
  const transport: InventorySyncTransport = async body => {
    const request = JSON.parse(body) as { listingIds: string[]; executionMode: string; runId: string }
    assert.equal(request.executionMode, 'SLICED')
    assert.equal(request.runId, RUN_ID)
    const unit = request.listingIds
    calls.push(unit)
    const result = outcome(calls.length, unit)
    if (result instanceof Error) throw result
    const pending = result.pending?.(unit) ?? []
    const processed = (result.processed?.(unit) ?? unit).filter(id => !pending.includes(id))
    const summary = { ...createEmptyBatchSummary(), unchanged: processed.length, ...result.summary?.(unit) }
    const slice: InventorySliceReport = {
      mutationAttempts: result.mutationAttempts ?? 0,
      stopReason: result.stopReason ?? (pending.length > 0 ? 'PENDING_RECONCILIATION' : null),
      rateLimitedUntil: null,
      nextAdvanceAt: result.nextAdvanceAt ?? 0,
      processedListingIds: processed,
      pendingListingIds: pending,
      summary,
      refresh: { status: 'refreshed', details: null },
      results: [],
      ok: true,
      status: 200,
    }
    return new Response(JSON.stringify({ status: 'ok', slice }), { status: 200 })
  }
  return { transport, calls }
}

function slice(cursor: InventoryRefreshCursor, transport: InventorySyncTransport, assertOwned = async () => {}) {
  return runInventoryRefreshSlice(CONNECTION_ID, cursor, {
    executionLease: LEASE,
    assertOwned,
    transport,
    now: () => 1_000,
  })
}

function runningState(cursor: InventoryRefreshCursor): InventoryRefreshState {
  return {
    status: 'RUNNING',
    importStatus: 'SUCCESS',
    rowsImported: 5959,
    changedItemCount: 495,
    automationDetailsJson: serializeAutomationDetailsWithCursor({ version: 1, platforms: [] }, cursor),
    error: null,
    finishedAt: null,
  }
}

/** One durable resume tick: load the persisted cursor, run one slice, persist. */
function durableRun(initial: InventoryRefreshCursor, transport: InventorySyncTransport, options: {
  failPersistOnCall?: number
} = {}) {
  const durable = { state: runningState(initial) }
  let persistCalls = 0
  const tick = async () => {
    const cursor = readInventoryRefreshCursor(durable.state.automationDetailsJson)
    assert.ok(cursor, 'a RUNNING run keeps a resumable cursor')
    return executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor,
      state: durable.state,
      assertOwned: async () => {},
      persist: async next => {
        persistCalls += 1
        if (persistCalls === options.failPersistOnCall) throw new Error('fetch failed')
        durable.state = next
      },
      advance: next => slice(next, transport),
    })
  }
  const stored = () => {
    const cursor = readInventoryRefreshCursor(durable.state.automationDetailsJson)
    return cursor ? allegroPlan(cursor) : null
  }
  return { durable, tick, stored }
}

void describe('execution unit selection', () => {
  void it('caps a unit at 10 listings and keeps the logical batch at 25', () => {
    assert.equal(MAX_LISTINGS_PER_EXECUTION_UNIT, 10)
    assert.equal(MAX_LISTINGS_PER_BATCH, 25)
    const plan = planFor(listingIds(25))
    assert.deepEqual(nextExecutionUnitListingIds(plan), listingIds(10))
  })

  void it('puts listings with unresolved commands last so they cannot starve the batch', () => {
    const plan = planFor(listingIds(25))
    plan.partial.pendingListingIds = listingIds(10)
    const unit = nextExecutionUnitListingIds(plan)
    assert.deepEqual(unit, listingIds(20).slice(10))
  })

  void it('still re-inspects unresolved listings once the fresh ones are exhausted', () => {
    const plan = planFor(listingIds(25))
    plan.completedListingIds = listingIds(25).slice(3)
    plan.partial.pendingListingIds = listingIds(3)
    assert.deepEqual(nextExecutionUnitListingIds(plan), listingIds(3))
  })
})

void describe('runInventoryRefreshSlice: one execution unit per slice', () => {
  void it('processes a 25-listing batch as 10 + 10 + 5 and closes it exactly once', async () => {
    const cursor = cursorFor(listingIds(25))
    const fake = fakeInventorySync()

    const first = await slice(cursor, fake.transport)
    assert.equal(first.done, false)
    assert.equal(first.stopReason, null)
    assert.equal(first.nextAdvanceAt, 1_000, 'no cooldown between plain units')
    assert.equal(allegroPlan(cursor).completedListingIds.length, 10)

    await slice(cursor, fake.transport)
    assert.equal(allegroPlan(cursor).completedListingIds.length, 20)
    assert.equal(allegroPlan(cursor).completedBatches.length, 0)

    const last = await slice(cursor, fake.transport)
    assert.deepEqual(fake.calls.map(unit => unit.length), [10, 10, 5])
    assert.equal(new Set(fake.calls.flat()).size, 25, 'no listing sent twice')
    assert.equal(last.done, true)
    assert.equal(allegroPlan(cursor).completedBatches.length, 1)
    assert.equal(allegroPlan(cursor).completedBatches[0].listingCount, 25)
  })

  void it('aggregates summaries across units without double counting', async () => {
    const cursor = cursorFor(listingIds(25))
    const fake = fakeInventorySync((call, unit) => ({
      summary: () => ({
        attempted: call === 1 ? 2 : 1,
        stockUpdated: call === 1 ? 2 : 1,
        unchanged: unit.length - (call === 1 ? 2 : 1),
      }),
      mutationAttempts: call === 1 ? 2 : 1,
    }))

    await slice(cursor, fake.transport)
    await slice(cursor, fake.transport)
    await slice(cursor, fake.transport)

    const summary = (allegroPlan(cursor).completedBatches[0].details as { summary: InventoryBatchSummary }).summary
    assert.equal(summary.attempted, 4)
    assert.equal(summary.stockUpdated, 4)
    assert.equal(summary.unchanged, 21)
    assert.equal(summary.pending, 0)
    assert.equal(summary.attempted + summary.unchanged, 25)
  })

  void it('counts an unresolved listing once while it is re-inspected', async () => {
    const cursor = cursorFor(listingIds(25))
    let pendingRounds = 1
    const fake = fakeInventorySync((_call, unit) => ({
      pending: () => (unit.includes('listing-000') && pendingRounds-- > 0 ? ['listing-000'] : []),
      nextAdvanceAt: 11_000,
    }))

    const first = await slice(cursor, fake.transport)
    assert.equal(first.stopReason, 'PENDING_RECONCILIATION')
    assert.equal(first.nextAdvanceAt, 11_000, 'pending cooldown is honoured')
    assert.equal(allegroPlan(cursor).partial.summary.pending, 1)

    await slice(cursor, fake.transport) // fresh listings 10..19 first
    // Fresh 20..24 leave room in the unit, so listing-000 is re-inspected alongside them.
    const last = await slice(cursor, fake.transport)
    assert.deepEqual(fake.calls[2], [...listingIds(25).slice(20), 'listing-000'])
    assert.equal(fake.calls.length, 3)
    assert.equal(last.done, true)
    const summary = (allegroPlan(cursor).completedBatches[0].details as { summary: InventoryBatchSummary }).summary
    assert.equal(summary.pending, 0)
    assert.equal(summary.unchanged, 25)
  })

  void it('honours a write-budget stop with a partial unit and resumes the rest', async () => {
    const cursor = cursorFor(listingIds(25))
    const fake = fakeInventorySync(call => call === 1
      ? { processed: unit => unit.slice(0, 5), stopReason: 'WRITE_BUDGET', nextAdvanceAt: 3_500, mutationAttempts: 5 }
      : {})

    const first = await slice(cursor, fake.transport)
    assert.equal(first.stopReason, 'WRITE_BUDGET')
    assert.equal(first.nextAdvanceAt, 3_500)
    await slice(cursor, fake.transport)
    assert.deepEqual(fake.calls[1], listingIds(15).slice(5), 'unprocessed listings come back first')
  })

  void it('does not call Allegro when the execution lease is lost', async () => {
    const cursor = cursorFor(listingIds(25))
    const fake = fakeInventorySync()
    const lost = Object.assign(new Error('Inventory refresh execution lease lost'), { status: 409 })

    await assert.rejects(slice(cursor, fake.transport, async () => { throw lost }), error => error === lost)
    assert.equal(fake.calls.length, 0)
    assert.equal(allegroPlan(cursor).completedListingIds.length, 0)
  })

  void it('fails loudly instead of guessing when a unit reports no progress', async () => {
    const cursor = cursorFor(listingIds(25))
    const fake = fakeInventorySync(() => ({ processed: () => [] }))
    await assert.rejects(slice(cursor, fake.transport), /made no progress/)
  })
})

void describe('durable checkpoints across interrupted executions', () => {
  void it('persists after the first unit and resumes without reprocessing it', async () => {
    const fake = fakeInventorySync()
    const run = durableRun(cursorFor(listingIds(25)), fake.transport)

    await run.tick()
    assert.deepEqual(run.stored()?.completedListingIds, listingIds(10), 'unit 1 is durable')

    // The execution is interrupted here; a later cron tick reloads the cursor.
    await run.tick()
    await run.tick()

    assert.deepEqual(fake.calls, [listingIds(10), listingIds(20).slice(10), listingIds(25).slice(20)])
    assert.equal(run.durable.state.status, 'COMPLETED')
  })

  void it('repeats only the interrupted unit, never a completed one', async () => {
    let interrupted = false
    const fake = fakeInventorySync(call => {
      if (call === 2 && !interrupted) {
        interrupted = true
        return new Error('isolate interrupted')
      }
      return {}
    })
    const run = durableRun(cursorFor(listingIds(25)), fake.transport)

    await run.tick()
    await assert.rejects(run.tick(), /isolate interrupted/)
    assert.deepEqual(run.stored()?.completedListingIds, listingIds(10), 'cursor unchanged by the failed unit')
    assert.equal(run.durable.state.status, 'RUNNING')

    await run.tick()
    await run.tick()

    assert.deepEqual(fake.calls[1], fake.calls[2], 'the interrupted unit is retried as a whole')
    assert.equal(fake.calls.flat().filter(id => listingIds(10).includes(id)).length, 10, 'unit 1 never resent')
    assert.equal(run.durable.state.status, 'COMPLETED')
  })

  void it('retries a unit whose cursor checkpoint could not be persisted', async () => {
    const fake = fakeInventorySync()
    const run = durableRun(cursorFor(listingIds(25)), fake.transport, { failPersistOnCall: 2 })

    await run.tick()
    await assert.rejects(run.tick(), /fetch failed/)
    assert.deepEqual(run.stored()?.completedListingIds, listingIds(10), 'last durable checkpoint kept')

    await run.tick()
    assert.deepEqual(fake.calls[1], fake.calls[2], 'unpersisted unit is sent again')
    assert.deepEqual(run.stored()?.completedListingIds, listingIds(20))
  })

  void it('completes the production plan (472 listings, 19 batches) unit by unit', async () => {
    const fake = fakeInventorySync()
    const ids = listingIds(472)
    const run = durableRun(cursorFor(ids), fake.transport)
    const initial = readInventoryRefreshCursor(run.durable.state.automationDetailsJson)
    assert.ok(initial)
    assert.equal(allegroPlan(initial).batches.length, 19)

    let checkpoints = 0
    const cursor = initial
    let clock = 0
    const runSlice = (state: InventoryRefreshState) => executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: RUN_ID,
      cursor,
      state,
      assertOwned: async () => {},
      persist: async next => { checkpoints += 1; run.durable.state = next },
      advance: next => runInventoryRefreshSlice(CONNECTION_ID, next, {
        executionLease: LEASE, assertOwned: async () => {}, transport: fake.transport, now: () => clock,
      }),
    })

    const result = await continueScheduledSlices({
      result: await runSlice(run.durable.state),
      runSlice,
      now: () => clock,
      sleep: async ms => { clock += ms },
      tickBudgetMs: Number.MAX_SAFE_INTEGER,
    })

    assert.equal(result.status, 'COMPLETED')
    assert.equal(fake.calls.length, 18 * 3 + 3, '18 full batches (10+10+5) and one of 22 (10+10+2)')
    assert.ok(fake.calls.every(unit => unit.length <= MAX_LISTINGS_PER_EXECUTION_UNIT))
    assert.deepEqual([...fake.calls.flat()].sort(), [...ids].sort(), 'every listing exactly once')
    assert.equal(checkpoints, fake.calls.length, 'one durable checkpoint per unit')
    assert.equal(allegroPlan(cursor).completedBatches.length, 19)
    assert.equal(run.durable.state.status, 'COMPLETED')
  })
})

void describe('duplicate Allegro stock mutation prevention across a retried unit', () => {
  void it('a retried unit reconciles the stored command instead of sending a second PUT', async () => {
    // Durable journal shared by both executions, as in allegro_change_events.
    const journal: StockAuditEvent[] = []
    const remotePuts: string[] = []
    let ids = 0

    const latest = async (): Promise<StockCommand | null> => {
      const last = [...journal].reverse().find(event => event.commandId)
      return last
        ? {
            commandId: last.commandId!,
            status: last.status,
            offerId: last.offerId ?? 'offer-1',
            fromStock: last.fromStock ?? null,
            toStock: last.toStock ?? null,
            runId: last.runId ?? null,
            batchIndex: last.batchIndex ?? null,
          }
        : null
    }

    const ports = (dispatch: StockMutationPorts['dispatch']): StockMutationPorts => ({
      latestCommand: latest,
      record: async event => { journal.push(event) },
      readCommandTask: async () => 'SUCCESS',
      readObservedStock: async () => 0,
      refreshObservation: async () => {},
      dispatch,
      assertOwned: async () => {},
      newCommandId: () => `cmd-${++ids}`,
      wait: async () => {},
      pollAttempts: 1,
      pollIntervalMs: 0,
    })

    const mutation = {
      listingId: 'listing-000',
      offerId: 'offer-1',
      desiredStock: 5,
      observedStock: 0,
      runId: RUN_ID,
      batchIndex: 1,
      executionMode: 'SLICED' as const,
    }

    // Execution 1: the PUT leaves the process, then the network result is lost.
    await executeStockMutation(mutation, ports(async commandId => {
      remotePuts.push(commandId)
      throw new Error('connection reset')
    }))

    // Execution 2: the same unit is retried after the interruption.
    const retried = await executeStockMutation(mutation, ports(async commandId => {
      remotePuts.push(commandId)
      return { kind: 'ACCEPTED', httpStatus: 201 }
    }))

    assert.deepEqual(remotePuts, ['cmd-1'], 'exactly one remote PUT')
    assert.equal(ids, 1, 'no second command identity')
    assert.equal('commandId' in retried ? retried.commandId : null, 'cmd-1')
  })
})
