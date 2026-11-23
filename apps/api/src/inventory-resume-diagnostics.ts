/**
 * Structured, diagnostics-only checkpoints for scheduled cron jobs and the
 * sliced inventory resume workflow.
 *
 * Purpose: a production isolate that dies mid-slice leaves no exception, so
 * the last emitted `start` checkpoint without a matching `end` marks the
 * failing phase.
 *
 * Contract:
 * - Logging never throws and never changes control flow. `tracePhase`
 *   rethrows the original error object unchanged.
 * - Only allowlisted scalar fields are emitted: identifiers, counts, HTTP
 *   status codes, durations and phase names. Never credentials, tokens,
 *   request/response bodies, inventory payloads or listing lists.
 * - Error messages are truncated and scrubbed of URL credentials, bearer
 *   tokens and JWT-like strings before they are logged.
 */

import type { InventoryRefreshCursor } from './inventory-refresh-slice.js'

export const DIAGNOSTIC_LOG_PREFIX = 'inventory_resume_diagnostic'

const MAX_MESSAGE_LENGTH = 300
const MAX_FIELD_STRING_LENGTH = 120

export type DiagnosticFieldValue = string | number | boolean | null | undefined

export type DiagnosticFields = Record<string, DiagnosticFieldValue>

export type DiagnosticEvent = 'start' | 'end' | 'error' | 'info'

export type DescribedError = {
  errorName: string
  errorMessage: string
  errorStatus?: number
  causeName?: string
  causeMessage?: string
}

/** Removes credentials and token-like material from a free-text message. */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/gi, '[redacted-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[redacted-jwt]')
    .replace(
      /\b(access_?token|refresh_?token|client_?secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      '$1$2[redacted]',
    )
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function safeRead(target: unknown, key: string): unknown {
  try {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
      return undefined
    }
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function describeSingle(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    const name = safeRead(error, 'name')
    const message = safeRead(error, 'message')
    return {
      name: typeof name === 'string' && name ? name : 'Error',
      message: typeof message === 'string' ? message : '',
    }
  }
  if (typeof error === 'string') return { name: 'NonErrorString', message: error }
  if (error === null) return { name: 'Null', message: '' }
  if (error === undefined) return { name: 'Undefined', message: '' }
  return { name: `NonError:${typeof error}`, message: '' }
}

/** Safe name/message/status summary of any thrown value (one cause level). */
export function describeError(error: unknown): DescribedError {
  try {
    const main = describeSingle(error)
    const described: DescribedError = {
      errorName: truncate(main.name, MAX_FIELD_STRING_LENGTH),
      errorMessage: truncate(redactDiagnosticText(main.message), MAX_MESSAGE_LENGTH),
    }
    const status = safeRead(error, 'status')
    if (typeof status === 'number' && Number.isFinite(status)) {
      described.errorStatus = status
    }
    const cause = safeRead(error, 'cause')
    if (cause !== undefined && cause !== error) {
      const inner = describeSingle(cause)
      described.causeName = truncate(inner.name, MAX_FIELD_STRING_LENGTH)
      described.causeMessage = truncate(redactDiagnosticText(inner.message), MAX_MESSAGE_LENGTH)
    }
    return described
  } catch {
    return { errorName: 'UndescribableError', errorMessage: '' }
  }
}

function sanitizeFields(fields: DiagnosticFields | undefined) {
  const sanitized: Record<string, string | number | boolean | null> = {}
  if (!fields) return sanitized
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === 'string') {
      sanitized[key] = truncate(redactDiagnosticText(value), MAX_FIELD_STRING_LENGTH)
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      sanitized[key] = value
    }
  }
  return sanitized
}

export type DiagnosticSink = {
  info: (line: string) => void
  error: (line: string) => void
}

const consoleSink: DiagnosticSink = {
  info: line => console.info(line),
  error: line => console.error(line),
}

let activeSink: DiagnosticSink = consoleSink

/** Test seam: redirect output. Returns a restore function. */
export function setDiagnosticSink(sink: DiagnosticSink): () => void {
  const previous = activeSink
  activeSink = sink
  return () => {
    activeSink = previous
  }
}

/** Emit one structured checkpoint line. Never throws. */
export function logDiagnostic(
  phase: string,
  event: DiagnosticEvent,
  fields?: DiagnosticFields,
): void {
  try {
    const line = `${DIAGNOSTIC_LOG_PREFIX} ${JSON.stringify({
      at: new Date().toISOString(),
      phase,
      event,
      ...sanitizeFields(fields),
    })}`
    if (event === 'error') activeSink.error(line)
    else activeSink.info(line)
  } catch {
    // Diagnostics must never affect the workflow.
  }
}

/** Log a caught error with its phase and context. Never throws. */
export function logDiagnosticError(
  phase: string,
  error: unknown,
  fields?: DiagnosticFields,
): void {
  logDiagnostic(phase, 'error', { ...fields, ...describeError(error) })
}

/**
 * Wrap one awaited step with start/end/error checkpoints.
 *
 * The original result is returned and the original error object is
 * rethrown unchanged, so propagation and failure semantics are preserved.
 * `summarize` may add scalar fields to the `end` line; its failures are
 * ignored.
 */
export async function tracePhase<T>(
  phase: string,
  fields: DiagnosticFields,
  action: () => T | Promise<T>,
  summarize?: (result: T) => DiagnosticFields,
): Promise<T> {
  const startedAt = Date.now()
  logDiagnostic(phase, 'start', fields)
  let result: T
  try {
    result = await action()
  } catch (error) {
    logDiagnosticError(phase, error, { ...fields, durationMs: Date.now() - startedAt })
    throw error
  }
  let summary: DiagnosticFields = {}
  if (summarize) {
    try {
      summary = summarize(result)
    } catch {
      summary = {}
    }
  }
  logDiagnostic(phase, 'end', { ...fields, ...summary, durationMs: Date.now() - startedAt })
  return result
}

/**
 * Counts and indexes only: never listing ids, batch membership or payloads.
 * Read-only; the cursor object is not modified.
 */
export function summarizeInventoryCursor(
  cursor: InventoryRefreshCursor | null | undefined,
): DiagnosticFields {
  if (!cursor) return { cursorPresent: false }
  try {
    const plan = cursor.plans[cursor.planIndex]
    const allegroPlan = plan && plan.kind === 'ALLEGRO' ? plan : null
    return {
      cursorPresent: true,
      cursorPhase: cursor.phase,
      planIndex: cursor.planIndex,
      planCount: cursor.plans.length,
      planKind: plan?.kind ?? null,
      batchIndex: allegroPlan?.batchIndex ?? null,
      batchCount: allegroPlan?.batches.length ?? null,
      completedBatchCount: allegroPlan?.completedBatches.length ?? null,
      currentBatchSize: allegroPlan?.batches[allegroPlan.batchIndex]?.length ?? null,
      currentBatchHandledCount: allegroPlan?.completedListingIds.length ?? null,
      planSkippedReason: allegroPlan?.skippedReason ?? null,
      nextAdvanceAt: cursor.nextAdvanceAt,
      lastStopReason: cursor.lastStopReason,
    }
  } catch {
    return { cursorPresent: true, cursorSummaryFailed: true }
  }
}

type GlobalEventTargetLike = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
}

/**
 * Log process-level failures that would otherwise terminate a Deno isolate
 * silently. Listeners only log: they never call `preventDefault`, so the
 * runtime's default behavior (including termination) is unchanged.
 * Returns false when the target has no event API (e.g. Node).
 */
export function installGlobalErrorDiagnostics(
  target: unknown = globalThis,
): boolean {
  const eventTarget = target as GlobalEventTargetLike | null
  if (!eventTarget || typeof eventTarget.addEventListener !== 'function') return false

  eventTarget.addEventListener('unhandledrejection', event => {
    logDiagnosticError('global.unhandledrejection', safeRead(event, 'reason'))
  })
  eventTarget.addEventListener('error', event => {
    const error = safeRead(event, 'error')
    logDiagnosticError(
      'global.error',
      error !== undefined ? error : new Error(String(safeRead(event, 'message') ?? '')),
    )
  })
  return true
}
