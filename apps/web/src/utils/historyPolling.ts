import { hasActiveHistoryRows } from './historyMerge'
import { HISTORY_BACKGROUND_REFRESH_MS, isForegroundVisible } from './polling'

export const SYNC_FAST_POLL_WINDOW_MS = 15 * 60_000
// Successful inventory wrappers have taken ~55 minutes in production.
export const RUN_FAST_POLL_WINDOW_MS = 60 * 60_000

type HistoryState = Parameters<typeof hasActiveHistoryRows>[0]
export type PollableHistoryState = Omit<HistoryState, 'catalogRuns' | 'inventoryRuns'> & {
  catalogRuns: Array<{ status: string; startedAt: string }>
  inventoryRuns: Array<{ status: string; startedAt: string }>
}

/** Polling policy only: never rewrite the stored/displayed unresolved state.
 * Keep all terminal evidence when testing recent candidates so older pending
 * rows do not reappear as active. Receipt time is not meaningful progress.
 * Invalid/future timestamps cannot authorize an unbounded polling loop.
 */
export function hasFastPollEligibleHistoryWork(input: PollableHistoryState, now = Date.now()): boolean {
  const recent = (timestamp: string, window: number) => {
    const age = now - Date.parse(timestamp)
    return Number.isFinite(age) && age >= 0 && age < window
  }
  return hasActiveHistoryRows({
    events: input.events.filter(event =>
      !['PENDING', 'REACTIVATION_IN_PROGRESS'].includes(event.newValue ?? '') ||
      recent(event.occurredAt, SYNC_FAST_POLL_WINDOW_MS)),
    catalogRuns: input.catalogRuns.filter(run => recent(run.startedAt, RUN_FAST_POLL_WINDOW_MS)),
    inventoryRuns: input.inventoryRuns.filter(run => recent(run.startedAt, RUN_FAST_POLL_WINDOW_MS)),
  })
}

/** No recurring timer for stale work. A visibility transition can refresh once
 * even when fast polling is stopped. Refreshes never overlap or queue catch-up.
 */
export function startHistoryPolling(options: {
  eligible: () => boolean
  refresh: () => Promise<void>
  visibility: () => string
  subscribe: (listener: () => void) => () => void
  schedule: (callback: () => void, delay: number) => number
  cancel: (timer: number) => void
}) {
  let disposed = false
  let inFlight = false
  let visible = isForegroundVisible(options.visibility())
  let timer: number | null = null
  const clear = () => {
    if (timer !== null) options.cancel(timer)
    timer = null
  }
  const schedule = () => {
    clear()
    if (!disposed && visible && options.eligible()) {
      timer = options.schedule(() => {
        timer = null
        if (options.eligible()) void refresh()
      }, HISTORY_BACKGROUND_REFRESH_MS)
    }
  }
  const refresh = async () => {
    if (disposed || inFlight || !isForegroundVisible(options.visibility())) return
    clear()
    inFlight = true
    try { await options.refresh() }
    catch { /* Page owns error presentation; do not enqueue retries here. */ }
    finally { inFlight = false; schedule() }
  }
  const unsubscribe = options.subscribe(() => {
    const next = isForegroundVisible(options.visibility())
    if (next === visible) return
    visible = next
    clear()
    if (visible) void refresh()
  })
  schedule()
  return () => { disposed = true; clear(); unsubscribe() }
}
