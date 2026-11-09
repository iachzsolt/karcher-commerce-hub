import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import {
  INVENTORY_REFRESH_SLICE_DEFAULTS,
  MAX_LISTINGS_PER_BATCH,
  compactBatchResults,
  completeCurrentBatch,
  createEmptyBatchState,
  createSliceBudget,
  isCurrentBatchComplete,
  mergeSliceIntoBatchState,
  parseInventoryRefreshCursor,
  readInventoryRefreshCursor,
  remainingBatchListingIds,
  resolveInventoryRefreshSliceConfig,
  serializeAutomationDetailsWithCursor,
  sliceMutationGate,
  sliceNextAdvanceAt,
  sliceNoteRateLimit,
  sliceRefundMutationAttempt,
  sliceReserveMutationAttempt,
  sliceSnapshot,
  type InventoryCursorAllegroPlan,
  type InventoryRefreshCursor,
  type InventorySliceReport,
} from '../src/inventory-refresh-slice.ts'
import { buildInventoryAutomationDiagnostics } from '../src/inventory-automation-diagnostics.ts'
import { runInventoryRefreshSlice } from '../src/platform-automation.ts'
import { allegroAuth } from '../src/allegro-auth.ts'

function budget(overrides: Partial<typeof INVENTORY_REFRESH_SLICE_DEFAULTS> = {}, now = 1_000) {
  return createSliceBudget({ ...INVENTORY_REFRESH_SLICE_DEFAULTS, ...overrides }, now)
}

void describe('slice configuration', () => {
  void it('uses the agreed defaults', () => {
    const config = resolveInventoryRefreshSliceConfig({})

    assert.deepEqual(config, {
      maxMutationAttemptsPerSlice: 5,
      maxSliceDurationMs: 40_000,
      writePacingMs: 750,
      sliceCooldownMs: 2_500,
    })
    assert.equal(MAX_LISTINGS_PER_BATCH, 25)
  })

  void it('reads operational overrides from the injected environment', () => {
    const config = resolveInventoryRefreshSliceConfig({
      COMMERCE_HUB_INVENTORY_SLICE_MAX_MUTATIONS: '3',
      COMMERCE_HUB_INVENTORY_SLICE_MAX_DURATION_MS: '15000',
      COMMERCE_HUB_INVENTORY_SLICE_WRITE_PACING_MS: '250',
      COMMERCE_HUB_INVENTORY_SLICE_COOLDOWN_MS: '1000',
    })

    assert.deepEqual(config, {
      maxMutationAttemptsPerSlice: 3,
      maxSliceDurationMs: 15_000,
      writePacingMs: 250,
      sliceCooldownMs: 1_000,
    })
  })

  void it('falls back on invalid values and never exceeds the batch size', () => {
    const config = resolveInventoryRefreshSliceConfig({
      COMMERCE_HUB_INVENTORY_SLICE_MAX_MUTATIONS: '500',
      COMMERCE_HUB_INVENTORY_SLICE_MAX_DURATION_MS: 'nope',
      COMMERCE_HUB_INVENTORY_SLICE_WRITE_PACING_MS: '-1',
      COMMERCE_HUB_INVENTORY_SLICE_COOLDOWN_MS: '0',
    })

    assert.equal(config.maxMutationAttemptsPerSlice, MAX_LISTINGS_PER_BATCH)
    assert.equal(config.maxSliceDurationMs, INVENTORY_REFRESH_SLICE_DEFAULTS.maxSliceDurationMs)
    assert.equal(config.writePacingMs, INVENTORY_REFRESH_SLICE_DEFAULTS.writePacingMs)
    assert.equal(config.sliceCooldownMs, INVENTORY_REFRESH_SLICE_DEFAULTS.sliceCooldownMs)
  })
})

void describe('slice budget', () => {
  void it('stops after exactly five mutation attempts', () => {
    const b = budget()

    for (let attempt = 0; attempt < 5; attempt++) {
      const gate = sliceMutationGate(b, 1_000)
      assert.equal(gate.allowed, true)
      sliceReserveMutationAttempt(b, 1_000)
    }

    const blocked = sliceMutationGate(b, 1_000)
    assert.deepEqual(blocked, { allowed: false, reason: 'WRITE_BUDGET', waitMs: 0 })
    assert.equal(b.mutationAttempts, 5)
    assert.equal(b.stopReason, 'WRITE_BUDGET')
  })

  void it('stops on the wall-clock slice budget', () => {
    const b = budget({ maxSliceDurationMs: 40_000 })

    assert.equal(sliceMutationGate(b, 20_000).allowed, true)
    assert.deepEqual(sliceMutationGate(b, 41_000), {
      allowed: false,
      reason: 'SLICE_BUDGET',
      waitMs: 0,
    })
  })

  void it('paces every attempt by 750 ms', () => {
    const b = budget()
    sliceReserveMutationAttempt(b, 1_000)

    assert.deepEqual(sliceMutationGate(b, 1_000), { allowed: true, waitMs: 750 })
    assert.deepEqual(sliceMutationGate(b, 1_500), { allowed: true, waitMs: 250 })
    assert.deepEqual(sliceMutationGate(b, 1_750), { allowed: true, waitMs: 0 })
  })

  void it('refunds only a slot that was never dispatched', () => {
    const b = budget()

    sliceReserveMutationAttempt(b, 1_000)
    assert.equal(b.mutationAttempts, 1)

    sliceRefundMutationAttempt(b)
    assert.equal(b.mutationAttempts, 0)

    // A refund can never go below zero.
    sliceRefundMutationAttempt(b)
    assert.equal(b.mutationAttempts, 0)
  })

  void it('honours the Allegro cooldown on 429 and lets it win over the slice cooldown', () => {
    const b = budget()
    sliceReserveMutationAttempt(b, 1_000)
    sliceNoteRateLimit(b, 60_000, 1_000)

    assert.equal(b.stopReason, 'RATE_LIMIT')
    assert.equal(b.rateLimitedUntil, 61_000)
    assert.equal(sliceNextAdvanceAt(b, 1_000), 61_000)
    assert.deepEqual(sliceMutationGate(b, 2_000), {
      allowed: false,
      reason: 'RATE_LIMIT',
      waitMs: 0,
    })
  })

  void it('applies the cross-slice cooldown after a write-budget stop', () => {
    const b = budget()
    sliceReserveMutationAttempt(b, 1_000)
    assert.equal(sliceMutationGate(b, 1_000).allowed, true)
    sliceReserveMutationAttempt(b, 1_000)
    sliceReserveMutationAttempt(b, 1_000)
    sliceReserveMutationAttempt(b, 1_000)
    sliceReserveMutationAttempt(b, 1_000)
    sliceMutationGate(b, 1_000)

    assert.equal(b.stopReason, 'WRITE_BUDGET')
    assert.equal(sliceNextAdvanceAt(b, 1_000), 3_500)
  })

  void it('does not cool down a slice that finished its work', () => {
    const b = budget()
    assert.equal(sliceNextAdvanceAt(b, 1_000), 1_000)

    const snapshot = sliceSnapshot(b, 5_000)
    assert.equal(snapshot.elapsedMs, 4_000)
    assert.equal(snapshot.mutationAttempts, 0)
    assert.equal(snapshot.stopReason, null)
  })
})

function allegroPlan(
  overrides: Partial<InventoryCursorAllegroPlan> = {},
): InventoryCursorAllegroPlan {
  return {
    kind: 'ALLEGRO',
    accountId: 'account-1',
    historyGroupId: 'history-1',
    batches: [['listing-a', 'listing-b'], ['listing-c', 'listing-d']],
    batchIndex: 0,
    completedListingIds: [],
    partial: createEmptyBatchState(),
    completedBatches: [],
    skippedReason: null,
    ...overrides,
  }
}

function cursor(plan: InventoryCursorAllegroPlan = allegroPlan()): InventoryRefreshCursor {
  return {
    version: 1,
    runId: 'run-1',
    connectionId: 'connection-1',
    phase: 'AUTOMATION',
    planIndex: 0,
    plans: [plan],
    nextAdvanceAt: null,
  }
}

function report(overrides: Partial<InventorySliceReport> = {}): InventorySliceReport {
  return {
    mutationAttempts: 0,
    stopReason: null,
    rateLimitedUntil: null,
    nextAdvanceAt: 0,
    processedListingIds: [],
    summary: {
      attempted: 0, stockUpdated: 0, autoPaused: 0, reactivated: 0,
      unchanged: 0, skipped: 0, pending: 0, failed: 0,
    },
    refresh: { status: 'not-needed', details: null },
    results: [],
    ok: true,
    status: 200,
    ...overrides,
  }
}

void describe('durable cursor', () => {
  void it('round-trips through automationDetailsJson as a sibling key', () => {
    const original = cursor()

    const serialized = serializeAutomationDetailsWithCursor(
      { version: 1, platforms: [] },
      original,
    )

    assert.equal(readInventoryRefreshCursor(serialized)?.runId, 'run-1')
    assert.deepEqual(readInventoryRefreshCursor(serialized)?.plans, original.plans)

    // Diagnostics still parse with the extra key present.
    const diagnostics = buildInventoryAutomationDiagnostics({
      results: [
        {
          platform: 'ALLEGRO',
          status: 200,
          details: {
            totalListings: 4,
            batchCount: 2,
            batches: [],
          },
        },
      ],
    })
    const withCursor = serializeAutomationDetailsWithCursor(diagnostics, original)

    assert.equal(JSON.parse(withCursor).version, 1)
    assert.equal(JSON.parse(withCursor).platforms.length, 1)
    assert.equal(JSON.parse(withCursor).cursor.runId, 'run-1')
  })

  void it('rejects a corrupt or foreign cursor instead of resuming it', () => {
    assert.equal(parseInventoryRefreshCursor(null), null)
    assert.equal(parseInventoryRefreshCursor({}), null)
    assert.equal(parseInventoryRefreshCursor({ version: 2 }), null)
    assert.equal(readInventoryRefreshCursor(null), null)
    assert.equal(readInventoryRefreshCursor('not-json'), null)
    assert.equal(readInventoryRefreshCursor(JSON.stringify({ version: 1, platforms: [] })), null)

    const broken = cursor() as unknown as Record<string, unknown>
    broken.phase = 'SOMETHING'

    assert.equal(parseInventoryRefreshCursor(broken), null)
  })

  void it('tracks which listings of the in-flight batch still need work', () => {
    const plan = allegroPlan({ completedListingIds: ['listing-a'] })

    assert.deepEqual(remainingBatchListingIds(plan), ['listing-b'])
    assert.equal(isCurrentBatchComplete(plan), false)

    plan.completedListingIds.push('listing-b')

    assert.deepEqual(remainingBatchListingIds(plan), [])
    assert.equal(isCurrentBatchComplete(plan), true)
  })
})

void describe('batch accumulation', () => {
  void it('adds summaries and de-duplicates diagnostic rows by listing id', () => {
    const first = mergeSliceIntoBatchState(
      createEmptyBatchState(),
      report({
        summary: { attempted: 2, stockUpdated: 2, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 0 },
        results: [
          { listingId: 'listing-a', action: 'SKIP', status: 'STOCK_LOCKED' },
        ],
      }),
    )

    const second = mergeSliceIntoBatchState(
      first,
      report({
        summary: { attempted: 1, stockUpdated: 1, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 1, pending: 0, failed: 0 },
        results: [
          { listingId: 'listing-a', action: 'NONE', status: 'NO_CHANGE' },
          { listingId: 'listing-b', action: 'STOCK_UPDATE', status: 'FAILED' },
        ],
      }),
    )

    assert.equal(second.summary.attempted, 3)
    assert.equal(second.summary.skipped, 1)
    assert.deepEqual(second.results, [
      { listingId: 'listing-a', action: 'NONE', status: 'NO_CHANGE' },
      { listingId: 'listing-b', action: 'STOCK_UPDATE', status: 'FAILED' },
    ])
  })

  void it('marks a batch failed when any listing failed or the refresh failed', () => {
    const plan = allegroPlan()

    plan.partial = mergeSliceIntoBatchState(
      createEmptyBatchState(),
      report({
        summary: { attempted: 1, stockUpdated: 0, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 1 },
      }),
    )

    assert.equal(completeCurrentBatch(plan, { ok: true, status: 200 }).ok, false)

    const refreshedPlan = allegroPlan()
    refreshedPlan.partial = mergeSliceIntoBatchState(
      createEmptyBatchState(),
      report({ refresh: { status: 'failed', details: null } }),
    )

    assert.equal(completeCurrentBatch(refreshedPlan, { ok: true, status: 200 }).ok, false)

    const cleanPlan = allegroPlan()
    cleanPlan.partial = mergeSliceIntoBatchState(createEmptyBatchState(), report())

    const completed = completeCurrentBatch(cleanPlan, { ok: true, status: 200 })
    assert.equal(completed.ok, true)
    assert.equal(completed.batchNumber, 1)
    assert.equal(completed.listingCount, 2)
  })

  void it('keeps only the rows the diagnostics builder reads', () => {
    const compacted = compactBatchResults([
      { listingId: 'a', action: 'SKIP', status: 'STOCK_LOCKED' },
      { listingId: 'b', action: 'STOCK_UPDATE', status: 'SUCCESS' },
      { listingId: 'c', action: 'STOCK_UPDATE', status: 'FAILED' },
      { listingId: 'd', action: 'NONE', status: 'NO_CHANGE' },
    ])

    assert.deepEqual(compacted.map(row => row.listingId), ['a', 'c'])
  })
})

/* ------------------------------------------------------------------ *
 * Slice driver
 * ------------------------------------------------------------------ */

const originalRequest = allegroAuth.request

after(() => {
  allegroAuth.request = originalRequest
})

function stubInventorySync(
  handler: (body: Record<string, unknown>) => InventorySliceReport | { error: string },
) {
  const bodies: Array<Record<string, unknown>> = []

  allegroAuth.request = (async (path: string, init?: { body?: string }) => {
    assert.equal(path, '/inventory-sync')
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    bodies.push(body)

    const result = handler(body)

    if ('error' in result) {
      return new Response(JSON.stringify({ status: 'error', message: result.error }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ status: 'ok', slice: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof allegroAuth.request

  return bodies
}

const lease = { name: 'inventory-refresh:connection-1', ownerId: 'owner-1' }
const assertOwned = async () => undefined

void describe('slice driver', () => {
  void it('freezes the batch order and resumes exactly where the budget stopped', async () => {
    let call = 0

    const bodies = stubInventorySync(() => {
      call += 1

      if (call === 1) {
        return report({
          processedListingIds: ['listing-a', 'listing-b'],
          mutationAttempts: 2,
          summary: { attempted: 2, stockUpdated: 2, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 0 },
        })
      }

      if (call === 2) {
        return report({
          processedListingIds: ['listing-c'],
          mutationAttempts: 5,
          stopReason: 'WRITE_BUDGET',
          nextAdvanceAt: 9_000,
          summary: { attempted: 1, stockUpdated: 1, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 0 },
        })
      }

      return report({
        processedListingIds: ['listing-d'],
        mutationAttempts: 1,
        summary: { attempted: 1, stockUpdated: 1, autoPaused: 0, reactivated: 0, unchanged: 0, skipped: 0, pending: 0, failed: 0 },
      })
    })

    const state = cursor()
    const first = await runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned })

    assert.equal(first.done, false)
    assert.equal(first.stopReason, 'WRITE_BUDGET')
    assert.equal(first.nextAdvanceAt, 9_000)
    // Cumulative across this slice's two `/inventory-sync` calls.
    assert.equal(first.mutationAttempts, 7)
    assert.equal(state.plans[0].kind, 'ALLEGRO')

    const plan = state.plans[0] as InventoryCursorAllegroPlan
    assert.equal(plan.batchIndex, 1)
    assert.deepEqual(plan.completedListingIds, ['listing-c'])
    assert.equal(plan.completedBatches.length, 1)

    const second = await runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned })

    assert.equal(second.done, true)
    assert.equal(state.phase, 'FINALIZE')
    assert.equal(state.nextAdvanceAt, null)

    // Only the unprocessed listing of the in-flight batch is retried.
    assert.deepEqual(bodies.map(body => body.listingIds), [
      ['listing-a', 'listing-b'],
      ['listing-c', 'listing-d'],
      ['listing-d'],
    ])
    // Sliced mode is explicit on every request.
    assert.ok(bodies.every(body => body.executionMode === 'SLICED'))

    const planAfter = state.plans[0] as InventoryCursorAllegroPlan
    assert.equal(planAfter.completedBatches.length, 2)
    assert.deepEqual(
      planAfter.completedBatches.map(batch => batch.details && (batch.details as { summary: { attempted: number } }).summary.attempted),
      [2, 2],
    )

    const diagnostics = buildInventoryAutomationDiagnostics({ results: second.results })
    assert.equal(diagnostics.platforms.length, 1)
    assert.equal(diagnostics.platforms[0].totalListings, 4)
    assert.equal(diagnostics.platforms[0].batchCount, 2)
    assert.equal(diagnostics.platforms[0].failedBatches, 0)
    assert.equal(diagnostics.platforms[0].attempted, 4)
    assert.equal(diagnostics.platforms[0].stockUpdated, 4)
  })

  void it('surfaces a rate limit without advancing the batch', async () => {
    const bodies = stubInventorySync(() =>
      report({
        processedListingIds: ['listing-a'],
        mutationAttempts: 5,
        stopReason: 'RATE_LIMIT',
        rateLimitedUntil: 60_000,
        nextAdvanceAt: 60_000,
      }),
    )

    const state = cursor()
    const result = await runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned })

    assert.equal(result.done, false)
    assert.equal(result.stopReason, 'RATE_LIMIT')
    assert.equal(result.nextAdvanceAt, 60_000)
    assert.equal(state.nextAdvanceAt, 60_000)

    const plan = state.plans[0] as InventoryCursorAllegroPlan
    assert.equal(plan.batchIndex, 0)
    assert.deepEqual(plan.completedListingIds, ['listing-a'])
    assert.equal(plan.completedBatches.length, 0)

    // The retry excludes the listing that already consumed an attempt.
    await runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned })
    assert.deepEqual(bodies[1].listingIds, ['listing-b'])
  })

  void it('keeps the run resumable when a slice transport call fails', async () => {
    stubInventorySync(() => ({ error: 'Allegro is unavailable' }))

    const state = cursor()

    await assert.rejects(
      () => runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned }),
      /Allegro is unavailable/,
    )

    assert.equal(state.plans[0].kind, 'ALLEGRO')
    assert.deepEqual((state.plans[0] as InventoryCursorAllegroPlan).completedListingIds, [])
    assert.equal(state.planIndex, 0)
  })

  void it('completes a plan with no listings without calling Allegro', async () => {
    const bodies = stubInventorySync(() => report())
    const state = cursor(
      allegroPlan({ batches: [], skippedReason: 'NO_AUTO_STOCK_SYNC_LISTINGS' }),
    )

    const result = await runInventoryRefreshSlice('connection-1', state, { executionLease: lease, assertOwned })

    assert.equal(result.done, true)
    assert.equal(bodies.length, 0)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].outcome, 'SKIPPED')
    assert.equal(result.results[0].status, 204)
  })
})
