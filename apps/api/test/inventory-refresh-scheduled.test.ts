import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  continueScheduledSlices,
  SCHEDULED_MAX_COOLDOWN_MS,
  type ScheduledSliceResult,
} from '../src/data-connections.ts'
import type { InventoryRefreshState } from '../src/inventory-refresh-workflow.ts'

const noopSleep = async () => {}

function sliceResult(overrides: {
  done?: boolean
  rateLimited?: boolean
  nextAdvanceAt?: number | null
  status?: string
} = {}): ScheduledSliceResult {
  return {
    advance: {
      done: overrides.done ?? false,
      rateLimited: overrides.rateLimited ?? false,
      nextAdvanceAt: overrides.nextAdvanceAt ?? null,
    },
    status: overrides.status ?? 'RUNNING',
    importStatus: 'SUCCESS',
    rowsImported: 100,
    changedItemCount: 10,
    automationDetailsJson: '{}',
    error: null,
    finishedAt: null,
  }
}

/* ------------------------------------------------------------------ *
 * 1. Continuous execution through multiple slices until done
 * ------------------------------------------------------------------ */

void describe('continueScheduledSlices', () => {
  void it('loops through slices until done', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult(),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult({ done: sliceCount >= 3 })
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 3)
    assert.equal(result.advance.done, true)
  })

  /* ---------------------------------------------------------------- *
   * 2. Stops immediately when already done
   * ---------------------------------------------------------------- */

  void it('does not loop when the initial result is already done', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult({ done: true }),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult({ done: true })
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 0)
    assert.equal(result.advance.done, true)
  })

  /* ---------------------------------------------------------------- *
   * 3. Stops on rate-limiting
   * ---------------------------------------------------------------- */

  void it('stops immediately when rate-limited', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult({ rateLimited: true }),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult()
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 0)
    assert.equal(result.advance.rateLimited, true)
  })

  void it('stops when a slice reports rate-limiting', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult(),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult({ rateLimited: true })
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 1)
    assert.equal(result.advance.rateLimited, true)
  })

  /* ---------------------------------------------------------------- *
   * 4. Tick budget enforcement
   *
   * The budget is checked at the top of the while loop (start-by
   * semantics), so a slice that starts under budget finishes even
   * if its own work pushes elapsed past the threshold.
   * ---------------------------------------------------------------- */

  void it('stops when the tick budget is exhausted', async () => {
    let time = 1_000_000
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult(),
      runSlice: async () => {
        sliceCount += 1
        time += 70_000
        return sliceResult()
      },
      now: () => time,
      sleep: noopSleep,
      tickBudgetMs: 120_000,
    })

    // Iteration 1: 0 < 120_000 → runs → time = 1_070_000
    // Iteration 2: 70_000 < 120_000 → runs → time = 1_140_000
    // Iteration 3: 140_000 >= 120_000 → loop exits
    assert.equal(sliceCount, 2)
    assert.equal(result.advance.done, false)
  })

  /* ---------------------------------------------------------------- *
   * 5. Excessive cooldown breaks the loop
   * ---------------------------------------------------------------- */

  void it('breaks when cooldown exceeds the safety threshold', async () => {
    const time = 1_000_000
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult({
        nextAdvanceAt: time + SCHEDULED_MAX_COOLDOWN_MS + 1,
      }),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult()
      },
      now: () => time,
      sleep: noopSleep,
      tickBudgetMs: 300_000,
    })

    assert.equal(sliceCount, 0)
    assert.equal(result.advance.done, false)
  })

  /* ---------------------------------------------------------------- *
   * 6. Error propagation — an error in one slice breaks the loop
   * ---------------------------------------------------------------- */

  void it('propagates errors from individual slices', async () => {
    let sliceCount = 0

    await assert.rejects(
      () =>
        continueScheduledSlices({
          result: sliceResult(),
          runSlice: async () => {
            sliceCount += 1
            if (sliceCount === 2) throw new Error('Allegro account is not connected')
            return sliceResult()
          },
          now: () => Date.now(),
          sleep: noopSleep,
          tickBudgetMs: 60_000,
        }),
      { message: 'Allegro account is not connected' },
    )

    assert.equal(sliceCount, 2)
  })

  /* ---------------------------------------------------------------- *
   * 7. State is forwarded between slices
   * ---------------------------------------------------------------- */

  void it('forwards the state from each slice to the next', async () => {
    const receivedStates: InventoryRefreshState[] = []
    let sliceCount = 0

    await continueScheduledSlices({
      result: sliceResult({ status: 'RUNNING' }),
      runSlice: async (state) => {
        receivedStates.push(state)
        sliceCount += 1
        return {
          ...sliceResult({ done: sliceCount >= 2 }),
          rowsImported: state.rowsImported + 1,
        }
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(receivedStates.length, 2)
    assert.equal(receivedStates[0].rowsImported, 100)
    assert.equal(receivedStates[1].rowsImported, 101)
  })

  /* ---------------------------------------------------------------- *
   * 8. Cooldown between slices is honored (sleep is called)
   * ---------------------------------------------------------------- */

  void it('calls sleep for cross-slice cooldowns', async () => {
    const time = 1_000_000
    const sleepCalls: number[] = []
    let sliceCount = 0

    await continueScheduledSlices({
      result: sliceResult({ nextAdvanceAt: time + 2_500 }),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult({ done: true })
      },
      now: () => time,
      sleep: async (ms) => { sleepCalls.push(ms) },
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 1)
    assert.equal(sleepCalls.length, 1)
    assert.equal(sleepCalls[0], 2_500)
  })

  /* ---------------------------------------------------------------- *
   * 9. Pending reconciliation cooldown — the loop waits before retrying
   * ---------------------------------------------------------------- */

  void it('loops through pending reconciliation slices with cooldown', async () => {
    let time = 1_000_000
    let sliceCount = 0
    const sleepCalls: number[] = []

    const result = await continueScheduledSlices({
      result: sliceResult({ nextAdvanceAt: time + 10_000 }),
      runSlice: async () => {
        sliceCount += 1
        time += 1_000
        if (sliceCount >= 3) return sliceResult({ done: true })
        return sliceResult({ nextAdvanceAt: time + 10_000 })
      },
      now: () => time,
      sleep: async (ms) => { sleepCalls.push(ms) },
      tickBudgetMs: 300_000,
    })

    assert.equal(sliceCount, 3)
    assert.equal(result.advance.done, true)
    assert.equal(sleepCalls.length, 3)
    assert.ok(sleepCalls.every(ms => ms === 10_000), 'each cooldown should be 10 seconds')
  })

  /* ---------------------------------------------------------------- *
   * 10. Terminal status transitions are preserved
   * ---------------------------------------------------------------- */

  void it('preserves terminal status from the final slice', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult(),
      runSlice: async () => {
        sliceCount += 1
        if (sliceCount >= 2) {
          return { ...sliceResult({ done: true }), status: 'COMPLETED' }
        }
        return sliceResult()
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(result.status, 'COMPLETED')
    assert.equal(result.advance.done, true)
  })

  void it('preserves FAILED status from a slice', async () => {
    let sliceCount = 0

    const result = await continueScheduledSlices({
      result: sliceResult(),
      runSlice: async () => {
        sliceCount += 1
        if (sliceCount >= 2) {
          return {
            ...sliceResult({ done: true }),
            status: 'FAILED',
            error: 'Some listings failed',
          }
        }
        return sliceResult()
      },
      now: () => Date.now(),
      sleep: noopSleep,
      tickBudgetMs: 60_000,
    })

    assert.equal(result.status, 'FAILED')
    assert.equal(result.error, 'Some listings failed')
    assert.equal(result.advance.done, true)
  })

  /* ---------------------------------------------------------------- *
   * 11. Lease loss (simulated via runSlice throwing)
   * ---------------------------------------------------------------- */

  void it('propagates lease-loss errors without masking them', async () => {
    let sliceCount = 0
    const lostError = Object.assign(
      new Error('Inventory refresh execution lease lost'),
      { status: 409 },
    )

    await assert.rejects(
      () =>
        continueScheduledSlices({
          result: sliceResult(),
          runSlice: async () => {
            sliceCount += 1
            if (sliceCount === 2) throw lostError
            return sliceResult()
          },
          now: () => Date.now(),
          sleep: noopSleep,
          tickBudgetMs: 60_000,
        }),
      (error: Error & { status?: number }) => {
        assert.equal(error.status, 409)
        assert.equal(error.message, 'Inventory refresh execution lease lost')
        return true
      },
    )

    assert.equal(sliceCount, 2)
  })

  /* ---------------------------------------------------------------- *
   * 12. No sleep when cooldown is zero or null
   * ---------------------------------------------------------------- */

  void it('skips sleep when nextAdvanceAt is null', async () => {
    const sleepCalls: number[] = []
    let sliceCount = 0

    await continueScheduledSlices({
      result: sliceResult({ nextAdvanceAt: null }),
      runSlice: async () => {
        sliceCount += 1
        return sliceResult({ done: true })
      },
      now: () => Date.now(),
      sleep: async (ms) => { sleepCalls.push(ms) },
      tickBudgetMs: 60_000,
    })

    assert.equal(sliceCount, 1)
    assert.equal(sleepCalls.length, 0)
  })
})
