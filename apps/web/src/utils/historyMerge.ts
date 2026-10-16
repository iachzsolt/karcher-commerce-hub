/*
 * Active-row merge for History background polling.
 *
 * The 60-second tick fetches only rows created or
 * finished since the last successful receipt
 * (?since=) and folds them into the already loaded
 * full-window state. Incoming rows win by id (they are
 * authoritative and newer); completed historical rows
 * are never removed or rewritten. Order is newest
 * first with a deterministic id tie-break so repeated
 * merges are stable. No terminal state is ever
 * fabricated: transitions arrive as real rows.
 */

export function mergeRowsByIdDesc<
  T extends { id: string },
>(
  existing: T[],
  incoming: T[],
  timeMs: (row: T) => number,
): T[] {
  const byId = new Map<string, T>()

  for (const row of existing) {
    byId.set(row.id, row)
  }

  for (const row of incoming) {
    byId.set(row.id, row)
  }

  const instant = (row: T) => {
    const value = timeMs(row)

    return Number.isFinite(value) ? value : 0
  }

  return [...byId.values()].sort((left, right) => {
    const delta = instant(right) - instant(left)

    if (delta !== 0) {
      return delta
    }

    return left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : 0
  })
}

/* Polling liveness: background ticks continue only
 * while one of these holds. Completed rows never match,
 * so a fully merged terminal state stops the loop by
 * itself. */
export function hasActiveHistoryRows(input: {
  events: Array<{
    eventType: string
    newValue: string | null
  }>
  catalogRuns: Array<{ status: string }>
  inventoryRuns: Array<{ status: string }>
}): boolean {
  return (
    input.events.some(
      (event) =>
        event.eventType === 'SYNC' &&
        (event.newValue === 'PENDING' ||
          event.newValue ===
            'REACTIVATION_IN_PROGRESS'),
    ) ||
    input.catalogRuns.some(
      (run) => run.status === 'RUNNING',
    ) ||
    input.inventoryRuns.some(
      (run) => run.status === 'RUNNING',
    )
  )
}

export function mergeHistoryEvents<
  T extends { id: string; occurredAt: string },
>(existing: T[], incoming: T[]): T[] {
  return mergeRowsByIdDesc(
    existing,
    incoming,
    (row) => new Date(row.occurredAt).getTime(),
  )
}

export function mergeHistoryRuns<
  T extends { id: string; startedAt: string },
>(existing: T[], incoming: T[]): T[] {
  return mergeRowsByIdDesc(
    existing,
    incoming,
    (row) => new Date(row.startedAt).getTime(),
  )
}
