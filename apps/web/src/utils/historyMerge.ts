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
 * while one of these holds. A historical SYNC event with
 * newValue PENDING/REACTIVATION_IN_PROGRESS does NOT keep
 * polling alive on its own: completion is stored as a
 * separate (later) event, so only the latest state in the
 * same listing/operation scope matters. Completed rows never match, so a
 * fully merged terminal state stops the loop by itself. */
export function hasActiveHistoryRows(input: {
  events: Array<{
    id: string
    listingId: string
    eventType: string
    newValue: string | null
    occurredAt: string
    source?: string
    metadataJson?: string | null
  }>
  catalogRuns: Array<{ status: string }>
  inventoryRuns: Array<{ status: string }>
}): boolean {
  // Inventory/catalog wrapper runs still running → active work
  if (
    input.catalogRuns.some((run) => run.status === 'RUNNING') ||
    input.inventoryRuns.some((run) => run.status === 'RUNNING')
  ) {
    return true
  }

  // Match the existing newest-listing-state rule for inventory SYNC history.
  // historyGroupId is a display batch, not a durable command identity:
  // reconciliation confirmations deliberately omit it. Explicit commands,
  // when present, remain isolated from unrelated commands.
  const latestByListing = new Map<
    string,
    { pending: boolean; at: number }
  >()

  const confirmedPositions = new Set<string>()
  for (const event of input.events) {
    if (event.eventType !== 'SYNC' || event.newValue !== 'SUCCESS') continue
    try {
      const meta = JSON.parse(event.metadataJson ?? '{}')
      if (meta?.reconciled === true && typeof meta.supersedesOccurredAt === 'string') {
        const predecessorAt = Date.parse(meta.supersedesOccurredAt)
        if (Date.parse(event.occurredAt) > predecessorAt) {
          confirmedPositions.add(JSON.stringify([event.listingId, event.source ?? '', predecessorAt]))
        }
      }
    } catch { /* No authoritative supersession evidence. */ }
  }

  for (const event of input.events) {
    if (event.eventType !== 'SYNC') continue
    let metadata: { commandId?: unknown } = {}
    try { metadata = JSON.parse(event.metadataJson ?? '{}') ?? {} } catch { /* Legacy event. */ }
    const operation = typeof metadata.commandId === 'string' && metadata.commandId
      ? `command:${metadata.commandId}`
      : 'listing'
    const key = JSON.stringify([event.listingId, event.source ?? '', operation])
    const pending = event.newValue === 'PENDING' || event.newValue === 'REACTIVATION_IN_PROGRESS'
    const at = Date.parse(event.occurredAt)
    if (pending && confirmedPositions.has(JSON.stringify([event.listingId, event.source ?? '', at]))) continue
    // Ambiguous chronology must not silently stop a real operation's polling.
    if (!Number.isFinite(at)) { if (pending) return true; continue }
    const existing = latestByListing.get(key)
    if (!existing || at > existing.at) {
      latestByListing.set(key, { pending, at })
    } else if (at === existing.at && pending) {
      existing.pending = true
    }
  }

  return [...latestByListing.values()].some(
    (entry) => entry.pending,
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
