/*
 * Backend self-resume for the sliced manual inventory refresh.
 *
 * The browser loop is the fast path, not the correctness mechanism. A
 * MANUAL run that is still `RUNNING`, still owns a readable cursor and
 * is past its own `nextAdvanceAt` may be advanced by the scheduler with
 * exactly the same internal function the HTTP `/advance` route uses.
 *
 * Everything here is pure and injectable so the eligibility rules can be
 * tested without a database, a clock or a timer.
 *
 * The execution lease stays the single authority: this module never
 * mutates, it only decides who is worth calling and then calls the
 * shared advance function, which acquires the per-connection lease with
 * `waitMs: 0` and answers 409 when somebody else is already running.
 */

import {
  readInventoryRefreshCursorState,
  type InventoryRefreshCursor,
} from './inventory-refresh-slice.js'

export type InventoryRefreshRunRow = {
  id: string
  connectionId: string
  triggerType: string
  status: string
  automationDetailsJson: string | null
  /** Only used to pick the newest eligible run; not part of eligibility. */
  startedAt?: Date
}

export type ResumableInventoryRefresh = {
  connectionId: string
  runId: string
  nextAdvanceAt: number | null
}

export type InventoryRefreshSkipReason =
  | 'NOT_MANUAL'
  | 'NOT_RUNNING'
  /** Legacy RUNNING row from before the sliced cursor existed. */
  | 'NO_CURSOR'
  | 'CORRUPT_CURSOR'
  /** Cursor belongs to another run/connection: never advance it. */
  | 'RUN_MISMATCH'
  | 'COOLDOWN'
  /** Another executor holds the per-connection lease right now. */
  | 'BUSY'

export type InventoryRefreshEligibility =
  | { resumable: true; target: ResumableInventoryRefresh }
  | { resumable: false; reason: InventoryRefreshSkipReason }

export function cursorMatchesRun(
  cursor: InventoryRefreshCursor,
  row: Pick<InventoryRefreshRunRow, 'id' | 'connectionId'>,
) {
  return cursor.runId === row.id && cursor.connectionId === row.connectionId
}

/**
 * A run is safe to resume only when every one of these holds:
 *
 *   status = RUNNING, trigger = MANUAL,
 *   a readable cursor bound to this exact run/connection,
 *   nextAdvanceAt is absent or already reached.
 *
 * A legacy RUNNING row without a cursor therefore stays excluded, and a
 * corrupt cursor is skipped (reported separately, never resumed).
 */
export function classifyInventoryRefreshRun(
  row: InventoryRefreshRunRow,
  now = Date.now(),
  options?: {
    /**
     * UI adoption wants any resumable run, even one currently in its
     * cross-slice cooldown. The scheduler always requires due-ness.
     */
    requireDue?: boolean
  },
): InventoryRefreshEligibility {
  const requireDue = options?.requireDue ?? true

  if (row.triggerType !== 'MANUAL') {
    return { resumable: false, reason: 'NOT_MANUAL' }
  }

  if (row.status !== 'RUNNING') {
    return { resumable: false, reason: 'NOT_RUNNING' }
  }

  const state = readInventoryRefreshCursorState(row.automationDetailsJson)

  if (state.kind === 'none') {
    return { resumable: false, reason: 'NO_CURSOR' }
  }

  if (state.kind === 'corrupt') {
    return { resumable: false, reason: 'CORRUPT_CURSOR' }
  }

  if (!cursorMatchesRun(state.cursor, row)) {
    return { resumable: false, reason: 'RUN_MISMATCH' }
  }

  if (
    requireDue &&
    state.cursor.nextAdvanceAt !== null &&
    now < state.cursor.nextAdvanceAt
  ) {
    return { resumable: false, reason: 'COOLDOWN' }
  }

  return {
    resumable: true,
    target: {
      connectionId: row.connectionId,
      runId: row.id,
      nextAdvanceAt: state.cursor.nextAdvanceAt,
    },
  }
}

export function selectResumableInventoryRefreshRuns(
  rows: InventoryRefreshRunRow[],
  now = Date.now(),
) {
  const eligible: ResumableInventoryRefresh[] = []
  const skipped: Array<{ runId: string; reason: InventoryRefreshSkipReason }> = []

  for (const row of rows) {
    const eligibility = classifyInventoryRefreshRun(row, now)

    if (eligibility.resumable) {
      eligible.push(eligibility.target)
      continue
    }

    skipped.push({ runId: row.id, reason: eligibility.reason })
  }

  return { eligible, skipped }
}

export type InventoryRefreshResumeResult = {
  considered: number
  eligible: number
  advanced: string[]
  skipped: Array<{ runId: string; reason: InventoryRefreshSkipReason }>
  failed: Array<{ runId: string; message: string }>
}

/**
 * Advance every eligible run by at most one slice.
 *
 * `advance` is the shared `advanceManualFullInventoryRefresh`, so this
 * adds no mutation logic and no second locking system. A 409 from the
 * lease is a normal outcome (the frontend won the race) and is recorded
 * as BUSY instead of an error.
 */
export async function resumeEligibleInventoryRefreshes(options: {
  scan: (now: number) => Promise<InventoryRefreshRunRow[]>
  advance: (target: ResumableInventoryRefresh) => Promise<unknown>
  now?: () => number
  /** Bounded so one scheduler tick can never become a full refresh. */
  limit?: number
  onSkip?: (entry: { runId: string; reason: InventoryRefreshSkipReason }) => void
  onError?: (entry: { runId: string; message: string }) => void
}): Promise<InventoryRefreshResumeResult> {
  const now = options.now ?? Date.now
  const limit = Math.max(1, options.limit ?? 3)

  const rows = await options.scan(now())
  const { eligible, skipped } = selectResumableInventoryRefreshRuns(rows, now())
  const result: InventoryRefreshResumeResult = {
    considered: rows.length,
    eligible: eligible.length,
    advanced: [],
    skipped,
    failed: [],
  }

  for (const entry of skipped) {
    options.onSkip?.(entry)
  }

  for (const target of eligible.slice(0, limit)) {
    try {
      await options.advance(target)
      result.advanced.push(target.runId)
    } catch (error) {
      const status =
        typeof error === 'object' &&
        error !== null &&
        typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status
          : null

      /*
       * 409 means the lease is held, the run finished or the cooldown
       * moved on between the scan and the call. All three are normal
       * and resolved by the persisted state, so they are not errors.
       */
      if (status === 409) {
        const entry = { runId: target.runId, reason: 'BUSY' as const }
        result.skipped.push(entry)
        options.onSkip?.(entry)
        continue
      }

      const failure = {
        runId: target.runId,
        message: error instanceof Error ? error.message : String(error),
      }

      result.failed.push(failure)
      options.onError?.(failure)
    }
  }

  return result
}
