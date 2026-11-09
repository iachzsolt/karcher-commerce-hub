import {
  buildInventoryAutomationDiagnostics,
  formatInventoryAutomationFailure,
} from './inventory-automation-diagnostics.js'
import type { runInventoryRefreshAutomations } from './platform-automation.js'
import {
  serializeAutomationDetailsWithCursor,
  type InventoryRefreshCursor,
  type InventorySliceStopReason,
} from './inventory-refresh-slice.js'
import type { InventoryRefreshSliceRunResult } from './platform-automation.js'

export type InventoryRefreshTrigger = 'MANUAL' | 'SCHEDULED'
export type InventoryRefreshState = {
  status: 'RUNNING' | 'COMPLETED' | 'IMPORT_ONLY' | 'FAILED'
  importStatus: string | null
  rowsImported: number
  changedItemCount: number
  automationDetailsJson: string | null
  error: string | null
  finishedAt: Date | null
}
type AutomationResult = Awaited<ReturnType<typeof runInventoryRefreshAutomations>>

/** The business workflow owns finalization; its caller owns the execution lease.
 * No scheduler state or historical runs are touched here.
 */
export async function executeInventoryRefresh(input: {
  trigger: InventoryRefreshTrigger
  runId: string
  assertOwned: () => Promise<void>
  create: (state: InventoryRefreshState) => Promise<void>
  persist: (state: InventoryRefreshState) => Promise<void>
  importSource: () => Promise<{ ok: boolean; status?: string; rowsImported?: number; changedItemCount?: number; error?: string }>
  catalog?: () => Promise<void> | void
  automate: (progress: (result: AutomationResult) => Promise<void>) => Promise<AutomationResult>
  now?: () => Date
}) {
  const state: InventoryRefreshState = {
    status: 'RUNNING', importStatus: null, rowsImported: 0, changedItemCount: 0,
    automationDetailsJson: null, error: null, finishedAt: null,
  }
  const check = async () => {
await input.assertOwned()
  }
  await check()
  await input.create({ ...state })
  try {
    const imported = await input.importSource()
    state.importStatus = imported.status ?? null
    state.rowsImported = imported.rowsImported ?? 0
    state.changedItemCount = imported.changedItemCount ?? 0
    await input.persist({ ...state })
    if (!imported.ok || imported.status === 'FAILED') {
      throw new Error(imported.error ?? 'Automatic inventory import failed.')
    }
    await check()
    // Preserve scheduled behavior: a catalog failure is recorded, but the
    // existing guarded inventory automation still evaluates known listings.
    try { await input.catalog?.() } catch (error) {
      state.error = error instanceof Error ? error.message : 'Inventory pre-automation hook failed.'
    }
    await check()
    const result = await input.automate(async progress => {
      state.automationDetailsJson = JSON.stringify(buildInventoryAutomationDiagnostics(progress))
      await input.persist({ ...state })
    })
    state.automationDetailsJson = JSON.stringify(buildInventoryAutomationDiagnostics(result))
    if (result.results.some(platform => !platform.ok)) {
      state.error = formatInventoryAutomationFailure(buildInventoryAutomationDiagnostics(result))
    }
    await check()
    state.status = state.error ? 'FAILED'
      : result.status === 'SKIPPED' || result.results.length === 0 || result.results.every(platform => platform.outcome === 'SKIPPED')
        ? 'IMPORT_ONLY' : 'COMPLETED'
  } catch (error) {
    state.status = 'FAILED'
    state.error = error instanceof Error ? error.message : 'Inventory refresh failed.'
  } finally {
    state.finishedAt = (input.now ?? (() => new Date()))()
    // Do not assert ownership here: even lease loss must finalize this run's
    // own row. A DB outage/runtime kill cannot be repaired by an in-process finally.
    await input.persist({ ...state })
  }
  return { runId: input.runId, triggerType: input.trigger, ...state }
}

export type InventoryRefreshAdvance = {
  done: boolean
  nextAdvanceAt: number | null
  stopReason: InventorySliceStopReason | null
  mutationAttempts: number
  rateLimited: boolean
}

/**
 * Run exactly one bounded slice of a manual refresh and persist the
 * result.
 *
 * A slice-level transport failure is deliberately NOT terminal: the
 * cursor is durable, so the run stays RUNNING and the next
 * `/advance` resumes. Only a completed run is finalized, and only
 * an unexpected exception outside the slice itself marks FAILED.
 */
export async function executeInventoryRefreshSlice(input: {
  trigger: InventoryRefreshTrigger
  runId: string
  cursor: InventoryRefreshCursor
  state: InventoryRefreshState
  assertOwned: () => Promise<void>
  persist: (state: InventoryRefreshState) => Promise<void>
  advance: (cursor: InventoryRefreshCursor) => Promise<InventoryRefreshSliceRunResult>
  now?: () => Date
}) {
  const clock = input.now ?? (() => new Date())
  const state: InventoryRefreshState = { ...input.state }
  let advance: InventoryRefreshAdvance = {
    done: false,
    nextAdvanceAt: null,
    stopReason: null,
    mutationAttempts: 0,
    rateLimited: false,
  }

  try {
    await input.assertOwned()

    const run = await input.advance(input.cursor)
    const diagnostics = buildInventoryAutomationDiagnostics({ results: run.results })

    state.automationDetailsJson = serializeAutomationDetailsWithCursor(
      diagnostics,
      run.done ? null : run.cursor,
    )

    advance = {
      done: run.done,
      nextAdvanceAt: run.done ? null : run.nextAdvanceAt,
      stopReason: run.stopReason,
      mutationAttempts: run.mutationAttempts,
      rateLimited: run.stopReason === 'RATE_LIMIT',
    }

    if (run.done) {
      if (run.results.some(platform => !platform.ok)) {
        state.error = formatInventoryAutomationFailure(diagnostics)
      } else {
        state.error = null
      }

      state.status = state.error
        ? 'FAILED'
        : run.results.length === 0 ||
            run.results.every(platform => platform.outcome === 'SKIPPED')
          ? 'IMPORT_ONLY'
          : 'COMPLETED'
    } else {
      state.status = 'RUNNING'
    }
  } catch (error) {
    /*
     * Keep RUNNING: nothing here proves the remote state is wrong,
     * and the durable cursor lets the next call resume safely. The
     * message travels in the HTTP error, not in the run row, so a
     * pre-existing (catalog) error is not masked.
     */
    state.status = 'RUNNING'
    state.finishedAt = null
    await input.persist({ ...state })
    throw error
  }

  state.finishedAt = state.status === 'RUNNING' ? null : clock()
  await input.persist({ ...state })

  return {
    runId: input.runId,
    triggerType: input.trigger,
    ...state,
    advance,
  }
}
