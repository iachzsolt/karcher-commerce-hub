import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  INVENTORY_REFRESH_SLICE_DEFAULTS,
  PENDING_RECONCILIATION_COOLDOWN_MS,
  PENDING_RECONCILIATION_MAX_AGE_MS,
  completeCurrentBatch,
  createEmptyBatchState,
  createSliceBudget,
  expireUnresolvedPendingListings,
  isCurrentBatchComplete,
  mergeSliceIntoBatchState,
  remainingBatchListingIds,
  sliceNextAdvanceAt,
  type InventoryCursorAllegroPlan,
  type InventoryRefreshCursor,
  type InventorySliceReport,
} from '../src/inventory-refresh-slice.ts'
import {
  executeStockMutation,
  reconcileUnresolvedStockCommands,
  type StockAuditEvent,
  type StockCommand,
  type StockCommandTaskState,
  type StockMutationInput,
  type StockMutationPorts,
} from '../src/inventory-mutation-journal.ts'
import { runInventoryRefreshSlice } from '../src/platform-automation.ts'
import { allegroAuth } from '../src/allegro-auth.ts'

const NOW = 1_000_000

function plan(
  overrides: Partial<InventoryCursorAllegroPlan> = {},
): InventoryCursorAllegroPlan {
  return {
    kind: 'ALLEGRO',
    accountId: 'account-1',
    historyGroupId: 'history-1',
    batches: [['listing-a']],
    batchIndex: 0,
    completedListingIds: [],
    partial: createEmptyBatchState(),
    completedBatches: [],
    skippedReason: null,
    ...overrides,
  }
}

function report(overrides: Partial<InventorySliceReport> = {}): InventorySliceReport {
  return {
    mutationAttempts: 0,
    stopReason: null,
    rateLimitedUntil: null,
    nextAdvanceAt: NOW,
    processedListingIds: [],
    pendingListingIds: [],
    summary: {
      attempted: 0,
      stockUpdated: 0,
      autoPaused: 0,
      reactivated: 0,
      unchanged: 0,
      skipped: 0,
      pending: 0,
      failed: 0,
    },
    refresh: { status: 'not-needed', details: null },
    results: [],
    ok: true,
    status: 200,
    ...overrides,
  }
}

function pendingReport(listingId = 'listing-a'): InventorySliceReport {
  return report({
    pendingListingIds: [listingId],
    stopReason: 'PENDING_RECONCILIATION',
    nextAdvanceAt: NOW + PENDING_RECONCILIATION_COOLDOWN_MS,
    summary: {
      attempted: 1,
      stockUpdated: 0,
      autoPaused: 0,
      reactivated: 0,
      unchanged: 0,
      skipped: 0,
      pending: 1,
      failed: 0,
    },
    results: [{ listingId, action: 'STOCK_UPDATE', status: 'PENDING' }],
  })
}

/* ------------------------------------------------------------------ *
 * 9./11./12. the durable batch keeps unresolved listings in flight
 * ------------------------------------------------------------------ */

void describe('pending listings stay in the batch', () => {
  void it('keeps an unresolved listing in the remaining set instead of completing it', () => {
    const state = plan()

    state.partial = mergeSliceIntoBatchState(
      createEmptyBatchState(),
      pendingReport(),
      NOW,
    )
    // The server excludes pending ids from processedListingIds, so the
    // driver's completed set must stay empty.
    state.completedListingIds = [
      ...new Set([
        ...state.completedListingIds,
        ...pendingReport().processedListingIds,
      ]),
    ]

    assert.deepEqual(state.completedListingIds, [])
    assert.deepEqual(remainingBatchListingIds(state), ['listing-a'])
    assert.equal(isCurrentBatchComplete(state), false)
    assert.deepEqual(state.partial.pendingListingIds, ['listing-a'])
    assert.equal(state.partial.summary.pending, 1)
    assert.equal(state.partial.pendingSince, NOW)
  })

  void it('counts pending from the durable set instead of adding it up again', () => {
    const first = mergeSliceIntoBatchState(createEmptyBatchState(), pendingReport(), NOW)
    const second = mergeSliceIntoBatchState(first, pendingReport(), NOW + 1_000)

    assert.equal(second.summary.pending, 1, 'a re-inspected listing is not counted twice')
    assert.equal(second.pendingSince, NOW, 'the unresolved window keeps its origin')
  })

  void it('clears pending only when the same listing reaches a terminal outcome', () => {
    const first = mergeSliceIntoBatchState(createEmptyBatchState(), pendingReport(), NOW)

    const resolved = mergeSliceIntoBatchState(
      first,
      report({
        processedListingIds: ['listing-a'],
        summary: {
          attempted: 1,
          stockUpdated: 1,
          autoPaused: 0,
          reactivated: 0,
          unchanged: 0,
          skipped: 0,
          pending: 0,
          failed: 0,
        },
      }),
      NOW + 2_000,
    )

    assert.deepEqual(resolved.pendingListingIds, [])
    assert.equal(resolved.summary.pending, 0)
    assert.equal(resolved.pendingSince, null)
  })

  void it('stops a pending-only slice with its own cooldown, not the write budget', () => {
    const budget = createSliceBudget(
      { ...INVENTORY_REFRESH_SLICE_DEFAULTS },
      NOW,
    )
    budget.stopReason = 'PENDING_RECONCILIATION'

    assert.equal(
      sliceNextAdvanceAt(budget, NOW),
      NOW + PENDING_RECONCILIATION_COOLDOWN_MS,
    )
  })

  void it('expires an unresolved command after the bounded window so the batch can close', () => {
    const state = plan()

    state.partial = mergeSliceIntoBatchState(createEmptyBatchState(), pendingReport(), NOW)

    const beforeWindow = plan({
      partial: mergeSliceIntoBatchState(createEmptyBatchState(), pendingReport(), NOW),
    })
    assert.deepEqual(
      expireUnresolvedPendingListings(beforeWindow, NOW + PENDING_RECONCILIATION_MAX_AGE_MS - 1),
      [],
    )
    assert.equal(isCurrentBatchComplete(beforeWindow), false)

    const afterWindow = plan({
      partial: mergeSliceIntoBatchState(createEmptyBatchState(), pendingReport(), NOW),
    })
    const expired = expireUnresolvedPendingListings(
      afterWindow,
      NOW + PENDING_RECONCILIATION_MAX_AGE_MS + 1,
    )

    assert.deepEqual(expired, ['listing-a'])
    assert.deepEqual(afterWindow.completedListingIds, ['listing-a'])
    assert.equal(afterWindow.partial.summary.failed, 0)
    assert.equal(afterWindow.partial.summary.pending, 0)
    assert.deepEqual(afterWindow.partial.pendingListingIds, [])
    assert.equal(
      afterWindow.partial.results.at(-1)?.status,
      'RECONCILIATION_TIMEOUT',
    )
    assert.equal(
      afterWindow.partial.results.at(-1)?.reason,
      'PENDING_TIMEOUT',
    )
    assert.equal(isCurrentBatchComplete(afterWindow), true)
    assert.equal(completeCurrentBatch(afterWindow, { ok: true, status: 200 }).ok, true)

    // Unused fixture guard: the first state must not have been mutated.
    assert.equal(state.completedListingIds.length, 0)
  })
})

/* ------------------------------------------------------------------ *
 * 10./14. the same command id is reconciled, never re-created
 * ------------------------------------------------------------------ */

function stockInput(overrides: Partial<StockMutationInput> = {}): StockMutationInput {
  return {
    listingId: 'listing-a',
    offerId: 'offer-1',
    desiredStock: 5,
    observedStock: 0,
    executionMode: 'SLICED',
    ...overrides,
  }
}

function storedCommand(overrides: Partial<StockCommand> = {}): StockCommand {
  return {
    commandId: 'cmd-prior',
    status: 'PENDING',
    offerId: 'offer-1',
    fromStock: 0,
    toStock: 5,
    runId: 'run-1',
    batchIndex: 3,
    ...overrides,
  }
}

function harness(options: {
  latest?: StockCommand | null
  task?: StockCommandTaskState
  observed?: number | null
} = {}) {
  const journal: StockAuditEvent[] = []
  const dispatched: string[] = []
  const newIds: string[] = []

  const ports: StockMutationPorts = {
    latestCommand: async () => options.latest ?? null,
    record: async event => {
      journal.push(event)
    },
    readCommandTask: async () => options.task ?? 'PENDING',
    readObservedStock: async () => options.observed ?? 0,
    refreshObservation: async () => undefined,
    dispatch: async commandId => {
      dispatched.push(commandId)
      return { kind: 'ACCEPTED', httpStatus: 201 }
    },
    assertOwned: async () => undefined,
    newCommandId: () => {
      const commandId = `cmd-new-${newIds.length + 1}`
      newIds.push(commandId)
      return commandId
    },
    wait: async () => undefined,
    pollAttempts: 1,
    pollIntervalMs: 0,
  }

  return { ports, journal, dispatched, newIds }
}

void describe('unresolved command reconciliation', () => {
  void it('reconciles the same command id to SUCCESS without dispatching anything', async () => {
    const h = harness({ latest: storedCommand(), task: 'SUCCESS', observed: 5 })

    const outcome = await executeStockMutation(stockInput(), h.ports)

    assert.equal(outcome.status, 'UPDATED')
    assert.equal(outcome.status === 'UPDATED' ? outcome.commandId : null, 'cmd-prior')
    assert.deepEqual(h.dispatched, [], 'no remote write while reconciling')
    assert.deepEqual(h.newIds, [], 'no new command id')
    assert.deepEqual(
      h.journal.map(event => [event.status, event.commandId]),
      [['SUCCESS', 'cmd-prior']],
    )
    assert.equal(h.journal[0]?.reason, 'RECONCILED_AFTER_RESTART')
  })

  void it('leaves a still-pending command unresolved and safe to resume', async () => {
    const h = harness({ latest: storedCommand(), task: 'PENDING' })

    const outcome = await executeStockMutation(stockInput(), h.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.equal(outcome.status === 'PENDING' ? outcome.commandId : null, 'cmd-prior')
    assert.deepEqual(h.dispatched, [])
    assert.deepEqual(h.newIds, [])
    assert.deepEqual(h.journal, [], 'nothing is rewritten while Allegro is still working')
  })

  void it('records FAILED with the same command id when Allegro reports failure', async () => {
    const h = harness({ latest: storedCommand(), task: 'FAILED' })

    const outcome = await executeStockMutation(stockInput(), h.ports)

    assert.equal(outcome.status, 'FAILED')
    assert.equal(outcome.status === 'FAILED' ? outcome.commandId : null, 'cmd-prior')
    assert.deepEqual(h.dispatched, [])
    assert.deepEqual(h.newIds, [])
    assert.deepEqual(
      h.journal.map(event => [event.status, event.commandId]),
      [['FAILED', 'cmd-prior']],
    )
  })

  void it('re-dispatches only the same command id when Allegro never accepted it', async () => {
    const h = harness({ latest: storedCommand(), task: 'ABSENT' })

    const outcome = await executeStockMutation(stockInput(), h.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.equal(outcome.status === 'PENDING' ? outcome.commandId : null, 'cmd-prior')
    assert.deepEqual(h.dispatched, ['cmd-prior'], 'a re-dispatch reuses the stored identity')
    assert.deepEqual(h.newIds, [], 'never a second command id')
  })

  void it('never creates a command when the journal cannot be read', async () => {
    const h = harness({ latest: storedCommand(), task: 'PENDING' })
    h.ports.readCommandTask = async () => {
      throw new Error('Allegro unavailable')
    }

    const outcome = await executeStockMutation(stockInput(), h.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.deepEqual(h.dispatched, [])
    assert.deepEqual(h.newIds, [])
  })
})

/* ------------------------------------------------------------------ *
 * 9./11. observation-based journal reconciliation (same command id)
 * ------------------------------------------------------------------ */

function fakeJournalDatabase(
  rows: Array<{ listingId: string; newValue: string | null; metadataJson: string | null }>,
) {
  const inserted: Array<Record<string, unknown>> = []

  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => rows,
        }),
      }),
    }),
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value)
      },
    }),
  }

  return {
    database: database as unknown as Parameters<typeof reconcileUnresolvedStockCommands>[0],
    inserted,
  }
}

function pendingEvent(listingId: string, commandId = 'cmd-prior') {
  return {
    listingId,
    newValue: 'PENDING',
    metadataJson: JSON.stringify({
      commandId,
      offerId: 'offer-1',
      fromStock: 0,
      toStock: 5,
      runId: 'run-1',
      batchIndex: 3,
    }),
  }
}

void describe('observed-stock reconciliation', () => {
  void it('closes the same command id when the fresh observation already matches', async () => {
    const { database, inserted } = fakeJournalDatabase([pendingEvent('listing-a')])

    const result = await reconcileUnresolvedStockCommands(database, [
      { listingId: 'listing-a', remoteStock: 5 },
    ])

    assert.deepEqual(result, { reconciled: 1, unresolved: 0 })
    assert.equal(inserted.length, 1)
    assert.equal(inserted[0]?.newValue, 'SUCCESS')

    const metadata = JSON.parse(String(inserted[0]?.metadataJson)) as Record<string, unknown>
    assert.equal(metadata.commandId, 'cmd-prior', 'the stored identity is preserved')
    assert.equal(metadata.runId, 'run-1')
    assert.equal(metadata.batchIndex, 3)
    assert.equal(metadata.reason, 'RECONCILED_OBSERVED_STOCK')
  })

  void it('leaves the command unresolved while the observation does not match', async () => {
    const { database, inserted } = fakeJournalDatabase([pendingEvent('listing-a')])

    const result = await reconcileUnresolvedStockCommands(database, [
      { listingId: 'listing-a', remoteStock: 3 },
    ])

    assert.deepEqual(result, { reconciled: 0, unresolved: 1 })
    assert.deepEqual(inserted, [])
  })

  void it('ignores an already terminal journal row', async () => {
    const { database, inserted } = fakeJournalDatabase([
      { ...pendingEvent('listing-a'), newValue: 'SUCCESS' },
    ])

    const result = await reconcileUnresolvedStockCommands(database, [
      { listingId: 'listing-a', remoteStock: 5 },
    ])

    assert.deepEqual(result, { reconciled: 0, unresolved: 0 })
    assert.deepEqual(inserted, [])
  })
})

/* ------------------------------------------------------------------ *
 * 12. driver-level: a pending slice resumes, then terminates
 * ------------------------------------------------------------------ */

const originalRequest = allegroAuth.request

after(() => {
  allegroAuth.request = originalRequest
})

function stubInventorySync(handler: () => InventorySliceReport) {
  const bodies: Array<Record<string, unknown>> = []

  allegroAuth.request = (async (path: string, init?: { body?: string }) => {
    assert.equal(path, '/inventory-sync')
    bodies.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>)

    return new Response(JSON.stringify({ status: 'ok', slice: handler() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof allegroAuth.request

  return bodies
}

void describe('pending slice driver', () => {
  void it('re-inspects the same listing next slice and terminates after the bounded window', async () => {
    const bodies = stubInventorySync(() => pendingReport())

    const state: InventoryRefreshCursor = {
      version: 1,
      runId: 'run-1',
      connectionId: 'connection-1',
      phase: 'AUTOMATION',
      planIndex: 0,
      plans: [plan()],
      nextAdvanceAt: null,
      lastStopReason: null,
    }

    const lease = { name: 'inventory-refresh:connection-1', ownerId: 'owner-1' }
    const assertOwned = async () => undefined

    const first = await runInventoryRefreshSlice('connection-1', state, {
      executionLease: lease,
      assertOwned,
      now: () => NOW,
    })

    const planAfterFirst = state.plans[0] as InventoryCursorAllegroPlan

    assert.equal(first.done, false)
    assert.equal(first.stopReason, 'PENDING_RECONCILIATION')
    assert.deepEqual(planAfterFirst.completedListingIds, [])
    assert.deepEqual(remainingBatchListingIds(planAfterFirst), ['listing-a'])
    assert.deepEqual(planAfterFirst.partial.pendingListingIds, ['listing-a'])

    const second = await runInventoryRefreshSlice('connection-1', state, {
      executionLease: lease,
      assertOwned,
      now: () => NOW + PENDING_RECONCILIATION_MAX_AGE_MS + 1,
    })

    const planAfterSecond = state.plans[0] as InventoryCursorAllegroPlan

    // Both slices re-sent the same listing, never a second command identity.
    assert.deepEqual(
      bodies.map(body => body.listingIds),
      [['listing-a'], ['listing-a']],
    )
    assert.equal(second.done, true)
    assert.equal(planAfterSecond.completedBatches.length, 1)
    assert.deepEqual(planAfterSecond.completedListingIds, [])
  })
})
