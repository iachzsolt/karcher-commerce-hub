import { and, desc, eq, sql } from 'drizzle-orm'
import {
  allegroChangeEvents,
  createDatabase,
} from '@karcher-commerce-hub/database'
import { observedStockMatches } from './allegro-stock-policy.js'

type Database = ReturnType<typeof createDatabase>

/*
 * Durable stock-command journal.
 *
 * Mirrors the publication command journal
 * (PUBLICATION_OPERATION / PUBLICATION_CHECK in
 * allegro-publication-store.ts) so the stock path gains the
 * same crash-safety property:
 *
 *   create command identity
 *   -> persist durable ATTEMPTED intent with commandId
 *   -> send the remote PUT
 *   -> poll/reconcile that SAME commandId
 *   -> mark terminal
 *
 * The journal lives in allegro_change_events, so no schema
 * migration is required. It is written BEFORE the remote
 * mutation is dispatched, which means a crash at any point
 * leaves a recoverable commandId instead of a lost one.
 */

export const STOCK_OPERATION_EVENT = 'STOCK_OPERATION'
export const STOCK_CHECK_EVENT = 'STOCK_CHECK'
export const STOCK_JOURNAL_SOURCE = 'INVENTORY_AUTOMATION'
export const STOCK_JOURNAL_ACTION = 'STOCK_UPDATE'

export type StockCommandStatus =
  | 'ATTEMPTED'
  | 'PENDING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED_BEFORE_SEND'
  | 'DISPATCH_RESULT_UNKNOWN'

export type StockCommand = {
  commandId: string
  status: StockCommandStatus
  offerId: string
  fromStock: number | null
  toStock: number | null
  runId: string | null
  batchIndex: number | null
}

export type StockAuditEvent = {
  status: StockCommandStatus
  commandId?: string
  offerId?: string
  fromStock?: number | null
  toStock?: number | null
  runId?: string | null
  batchIndex?: number | null
  reason?: string
  observedStock?: number | null
  taskStatus?: string | null
}

const UNRESOLVED_STOCK_STATUSES: ReadonlySet<string> = new Set([
  'ATTEMPTED',
  'PENDING',
  'DISPATCH_RESULT_UNKNOWN',
])

const TERMINAL_STOCK_STATUSES: ReadonlySet<string> = new Set([
  'SUCCESS',
  'FAILED',
  'CANCELLED_BEFORE_SEND',
])

/** An unresolved command must never be replaced by a new commandId. */
export function isUnresolvedStockCommand(status: string): boolean {
  return UNRESOLVED_STOCK_STATUSES.has(status)
}

export function isTerminalStockCommand(status: string): boolean {
  return TERMINAL_STOCK_STATUSES.has(status)
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/*
 * Latest stock command for a listing, ordered the same way
 * as latestPublicationCommand so "latest" is stable under
 * clock ties.
 */
export async function latestStockCommand(
  database: Database,
  listingId: string,
): Promise<StockCommand | null> {
  const [row] = await database
    .select({
      status: allegroChangeEvents.newValue,
      metadata: allegroChangeEvents.metadataJson,
    })
    .from(allegroChangeEvents)
    .where(
      and(
        eq(allegroChangeEvents.listingId, listingId),
        eq(allegroChangeEvents.eventType, STOCK_OPERATION_EVENT),
        eq(allegroChangeEvents.source, STOCK_JOURNAL_SOURCE),
      ),
    )
    .orderBy(
      desc(allegroChangeEvents.occurredAt),
      desc(allegroChangeEvents.id),
    )
    .limit(1)

  if (!row) return null

  let metadata: Record<string, unknown>

  try {
    metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>
  } catch {
    return null
  }

  const commandId = typeof metadata.commandId === 'string' ? metadata.commandId : null
  if (!commandId) return null

  const status = row.status ?? 'ATTEMPTED'
  if (!isUnresolvedStockCommand(status) && !isTerminalStockCommand(status)) return null

  return {
    commandId,
    status: status as StockCommandStatus,
    offerId: typeof metadata.offerId === 'string' ? metadata.offerId : '',
    fromStock: asFiniteNumber(metadata.fromStock),
    toStock: asFiniteNumber(metadata.toStock),
    runId: typeof metadata.runId === 'string' ? metadata.runId : null,
    batchIndex: asFiniteNumber(metadata.batchIndex),
  }
}

/*
 * Awaited, error-propagating insert. This is deliberately
 * NOT best-effort: if the durable intent cannot be written,
 * the caller must never dispatch the remote mutation.
 */
export async function recordStockAudit(
  database: Database,
  listingId: string,
  event: StockAuditEvent,
): Promise<void> {
  await database
    .insert(allegroChangeEvents)
    .values({
      listingId,
      eventType: event.commandId ? STOCK_OPERATION_EVENT : STOCK_CHECK_EVENT,
      source: STOCK_JOURNAL_SOURCE,
      oldValue: STOCK_JOURNAL_ACTION,
      newValue: event.status,
      metadataJson: JSON.stringify({
        commandId: event.commandId ?? null,
        offerId: event.offerId ?? null,
        fromStock: event.fromStock ?? null,
        toStock: event.toStock ?? null,
        runId: event.runId ?? null,
        batchIndex: event.batchIndex ?? null,
        reason: event.reason ?? null,
        observedStock: event.observedStock ?? null,
        taskStatus: event.taskStatus ?? null,
      }),
      occurredAt: sql`now()`,
    })
}

export type StockCommandTaskState =
  | 'SUCCESS'
  | 'FAILED'
  | 'PENDING'
  | 'ABSENT'

export type StockDispatchResult =
  | { kind: 'ACCEPTED'; httpStatus: number }
  | { kind: 'REJECTED'; httpStatus: number; reason?: string }
  | { kind: 'RATE_LIMITED'; httpStatus: number; retryAfterMs: number }
  | { kind: 'UNKNOWN'; reason?: string }

export type StockMutationOutcome =
  | { status: 'UPDATED'; commandId: string; observedStock: number | null }
  | { status: 'PENDING'; commandId: string; observedStock: number | null }
  | { status: 'FAILED'; commandId: string; message: string; httpStatus: number; taskStatus?: string | null }
  | { status: 'RATE_LIMITED'; commandId: string; retryAfterMs: number }
  | { status: 'UNKNOWN'; commandId: string; message: string }
  | { status: 'SKIPPED'; reason: string; commandId?: string }
  | { status: 'JOURNAL_UNAVAILABLE'; commandId: string; message: string }

export type StockMutationInput = {
  listingId: string
  offerId: string
  desiredStock: number
  observedStock: number | null
  runId?: string | null
  batchIndex?: number | null
  /*
   * Explicit execution mode. Never inferred from timing or
   * request shape.
   *
   * LEGACY (default) preserves the historical 202 PENDING
   * trailing reconciliation: refresh, delay, refresh.
   *
   * SLICED returns PENDING immediately and relies on the next
   * slice's unconditional remote refresh plus journal
   * reconciliation.
   */
  executionMode?: StockExecutionMode
}

export type StockExecutionMode = 'LEGACY' | 'SLICED'

export const STOCK_LEGACY_PENDING_DELAY_MS = 4_000

export function resolveStockExecutionMode(
  mode: string | null | undefined,
): StockExecutionMode {
  return mode === 'SLICED' ? 'SLICED' : 'LEGACY'
}

export type StockMutationPorts = {
  latestCommand: () => Promise<StockCommand | null>
  record: (event: StockAuditEvent) => Promise<void>
  readCommandTask: (commandId: string) => Promise<StockCommandTaskState>
  readObservedStock: () => Promise<number | null>
  refreshObservation: () => Promise<void>
  dispatch: (commandId: string) => Promise<StockDispatchResult>
  /** Must throw when this executor no longer owns the execution lease. */
  assertOwned: () => Promise<void>
  newCommandId: () => string
  /** Called synchronously immediately before the remote PUT leaves the process. */
  onDispatch?: () => void
  wait?: (ms: number) => Promise<void>
  pollAttempts?: number
  pollIntervalMs?: number
}

const defaultWait = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))

/*
 * The only code path allowed to create a stock commandId.
 *
 * Ordering guarantees:
 *  1. An unresolved journal command is reconciled first and
 *     never replaced by a new commandId.
 *  2. The ATTEMPTED intent is committed before dispatch; if
 *     that insert fails, dispatch is never reached.
 *  3. The lease is asserted after the intent write and again
 *     immediately before dispatch, so lease loss leaves the
 *     durable ATTEMPTED command for later reconciliation.
 *  4. The dispatched commandId is the stored commandId, so a
 *     crash after dispatch always polls the exact command.
 */
export async function executeStockMutation(
  input: StockMutationInput,
  ports: StockMutationPorts,
): Promise<StockMutationOutcome> {
  const wait = ports.wait ?? defaultWait
  const pollAttempts = ports.pollAttempts ?? 10
  const pollIntervalMs = ports.pollIntervalMs ?? 500
  const executionMode = resolveStockExecutionMode(input.executionMode)
  const base = {
    offerId: input.offerId,
    toStock: input.desiredStock,
    runId: input.runId ?? null,
    batchIndex: input.batchIndex ?? null,
  }

  /*
   * Legacy compatibility.
   *
   * The historical synchronous handler answered a still-pending
   * command with:
   *
   *   refresh -> wait 4000 ms -> refresh -> 202 PENDING
   *
   * That trailing reconciliation must survive for the existing
   * synchronous/scheduled path, so LEGACY keeps it verbatim.
   *
   * SLICED returns 202 immediately: the next slice performs an
   * unconditional remote refresh and reconciles the journal, so a
   * second blocking delay inside the request would only waste the
   * slice budget.
   */
  const finishPending = async (
    commandId: string,
    observedStock: number | null,
  ): Promise<StockMutationOutcome> => {
    if (executionMode === 'SLICED') {
      return { status: 'PENDING', commandId, observedStock }
    }

    await ports.refreshObservation().catch(() => undefined)
    await wait(STOCK_LEGACY_PENDING_DELAY_MS)
    await ports.refreshObservation().catch(() => undefined)

    return { status: 'PENDING', commandId, observedStock }
  }

  const dispatchAndTrack = async (
    commandId: string,
    fromStock: number | null,
  ): Promise<StockMutationOutcome> => {
    /*
     * Lease boundary: throwing here leaves the durable
     * ATTEMPTED command untouched and dispatches nothing.
     */
    await ports.assertOwned()

    const observedBeforeSend = await ports.readObservedStock()

    if (observedStockMatches(input.desiredStock, observedBeforeSend)) {
      await ports.record({
        ...base,
        status: 'CANCELLED_BEFORE_SEND',
        commandId,
        fromStock,
        observedStock: observedBeforeSend,
        reason: 'OBSERVED_STOCK_MATCHES',
      })

      return { status: 'SKIPPED', reason: 'OBSERVED_STOCK_MATCHES', commandId }
    }

    await ports.assertOwned()

    ports.onDispatch?.()

    let dispatched: StockDispatchResult

    try {
      dispatched = await ports.dispatch(commandId)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'STOCK_DISPATCH_FAILED'

      await ports.record({
        ...base,
        status: 'DISPATCH_RESULT_UNKNOWN',
        commandId,
        fromStock,
        reason: message,
      })

      return { status: 'UNKNOWN', commandId, message }
    }

    if (dispatched.kind === 'UNKNOWN') {
      const message = dispatched.reason ?? 'DISPATCH_RESULT_UNKNOWN'

      await ports.record({
        ...base,
        status: 'DISPATCH_RESULT_UNKNOWN',
        commandId,
        fromStock,
        reason: message,
      })

      return { status: 'UNKNOWN', commandId, message }
    }

    if (dispatched.kind === 'RATE_LIMITED') {
      await ports.record({
        ...base,
        status: 'FAILED',
        commandId,
        fromStock,
        reason: 'RATE_LIMITED',
      })

      return {
        status: 'RATE_LIMITED',
        commandId,
        retryAfterMs: dispatched.retryAfterMs,
      }
    }

    if (dispatched.kind === 'REJECTED') {
      const message = dispatched.reason ?? 'Allegro rejected the stock change command'

      await ports.record({
        ...base,
        status: 'FAILED',
        commandId,
        fromStock,
        reason: message,
      })

      return {
        status: 'FAILED',
        commandId,
        message,
        httpStatus: dispatched.httpStatus,
      }
    }

    await ports.record({
      ...base,
      status: 'PENDING',
      commandId,
      fromStock,
      reason: 'COMMAND_ACCEPTED',
    })

    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      await wait(pollIntervalMs)

      let task: StockCommandTaskState

      try {
        task = await ports.readCommandTask(commandId)
      } catch {
        continue
      }

      if (task === 'ABSENT' || task === 'PENDING') continue

      if (task === 'FAILED') {
        await ports.record({
          ...base,
          status: 'FAILED',
          commandId,
          fromStock,
          reason: 'ALLEGRO_TASK_FAILED',
          taskStatus: task,
        })

        return {
          status: 'FAILED',
          commandId,
          message: 'Allegro stock update failed',
          httpStatus: 502,
          taskStatus: task,
        }
      }

      await ports.refreshObservation().catch(() => undefined)

      const observed = await ports.readObservedStock().catch(() => input.desiredStock)

      await ports.record({
        ...base,
        status: 'SUCCESS',
        commandId,
        fromStock,
        reason: 'COMMAND_CONFIRMED',
        taskStatus: task,
        observedStock: observed,
      })

      return { status: 'UPDATED', commandId, observedStock: observed }
    }

    return finishPending(commandId, input.observedStock)
  }

  /*
   * 1. Recover an unresolved command before anything else.
   *    A remapped offer makes an old command irrelevant.
   */
  const previous = await ports.latestCommand()
  const reusable = previous && previous.offerId === input.offerId ? previous : null

  if (reusable && isUnresolvedStockCommand(reusable.status)) {
    let task: StockCommandTaskState

    try {
      task = await ports.readCommandTask(reusable.commandId)
    } catch {
      // Cannot read the command: it stays unresolved. Never create another.
      return finishPending(reusable.commandId, input.observedStock)
    }

    if (task === 'SUCCESS') {
      await ports.record({
        ...base,
        status: 'SUCCESS',
        commandId: reusable.commandId,
        fromStock: reusable.fromStock,
        reason: 'RECONCILED_AFTER_RESTART',
        taskStatus: task,
      })

      await ports.refreshObservation().catch(() => undefined)

      const observed = await ports.readObservedStock().catch(() => input.desiredStock)

      return { status: 'UPDATED', commandId: reusable.commandId, observedStock: observed }
    }

    if (task === 'FAILED') {
      await ports.record({
        ...base,
        status: 'FAILED',
        commandId: reusable.commandId,
        fromStock: reusable.fromStock,
        reason: 'ALLEGRO_TASK_FAILED',
        taskStatus: task,
      })

      return {
        status: 'FAILED',
        commandId: reusable.commandId,
        message: 'Allegro stock update failed',
        httpStatus: 502,
        taskStatus: task,
      }
    }

    if (task === 'PENDING') {
      // Allegro still processing the exact stored command: no new UUID, no new PUT.
      return finishPending(reusable.commandId, input.observedStock)
    }

    /*
     * ABSENT: the command was provably never accepted remotely,
     * so re-dispatching the SAME commandId cannot duplicate it.
     */
    return dispatchAndTrack(reusable.commandId, reusable.fromStock ?? input.observedStock)
  }

  /*
   * 2. Decide whether a mutation is required at all.
   */
  const observedNow = await ports.readObservedStock()

  if (observedStockMatches(input.desiredStock, observedNow)) {
    return { status: 'SKIPPED', reason: 'OBSERVED_STOCK_MATCHES' }
  }

  /*
   * 3. Persist durable intent BEFORE dispatch.
   */
  const commandId = ports.newCommandId()

  try {
    await ports.record({
      ...base,
      status: 'ATTEMPTED',
      commandId,
      fromStock: observedNow,
    })
  } catch (error) {
    // No durable intent means no dispatch. Ever.
    return {
      status: 'JOURNAL_UNAVAILABLE',
      commandId,
      message: error instanceof Error ? error.message : 'Stock command journal write failed',
    }
  }

  return dispatchAndTrack(commandId, observedNow)
}

/*
 * Allegro may omit Retry-After. Fall back to the agreed
 * conservative cooldown instead of hammering the API.
 */
export const STOCK_RATE_LIMIT_FALLBACK_MS = 60_000

export function parseRetryAfterMs(header: string | null): number {
  if (!header) return STOCK_RATE_LIMIT_FALLBACK_MS

  const seconds = Number(header.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)

  const date = Date.parse(header)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())

  return STOCK_RATE_LIMIT_FALLBACK_MS
}
