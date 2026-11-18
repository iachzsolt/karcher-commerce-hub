/**
 * Safe, structured diagnostics for inventory import failures.
 *
 * Emits only validated SQLSTATE codes, predefined error categories,
 * operation names from a fixed allowlist, and non-sensitive identifiers.
 * Never logs raw PostgreSQL messages, details, hints, SQL queries,
 * parameters, snapshots, credentials, or stack traces.
 */

export type PostgresErrorCategory =
  | 'LEASE_LOST'
  | 'ADVISORY_LOCK_CONTENTION'
  | 'ANOTHER_RUN_ACTIVE'
  | 'RUN_NOT_ACTIVE'
  | 'NEWER_COMPLETED_RUN'
  | 'INVALID_ITEMS'
  | 'DUPLICATE_SKUS'
  | 'INVALID_LEASE_NAME'
  | 'EMPTY_SNAPSHOT'
  | 'NOT_ARRAY'
  | 'FINALIZATION_REJECTED'
  | 'OTHER'

export type PostgresErrorInfo = {
  category: PostgresErrorCategory
  code?: string
  operation?: string
  connectionId?: string
}

/** Operations that are safe to include in diagnostic logs. */
const ALLOWED_OPERATIONS = new Set([
  'apply_inventory_snapshot',
  'fail_inventory_import',
])

/** Maximum cause-chain traversal depth. */
const MAX_CAUSE_DEPTH = 5

/** Validated SQLSTATE code pattern (five alphanumeric characters). */
const SQLSTATE_RE = /^[A-Z0-9]{5}$/

/**
 * Maps known `apply_inventory_snapshot` / `fail_inventory_import`
 * PostgreSQL error messages to predefined categories.
 */
function categorizeMessage(message: string): PostgresErrorCategory {
  const lower = message.toLowerCase()

  if (
    lower.includes('lease is missing') ||
    lower.includes('lease is missing, expired, or not owned')
  ) {
    return 'LEASE_LOST'
  }
  if (lower.includes('another inventory import is active')) {
    return 'ADVISORY_LOCK_CONTENTION'
  }
  if (lower.includes('another inventory import run is still active')) {
    return 'ANOTHER_RUN_ACTIVE'
  }
  if (lower.includes('inventory import run is not active')) {
    return 'RUN_NOT_ACTIVE'
  }
  if (lower.includes('a newer inventory import has already completed')) {
    return 'NEWER_COMPLETED_RUN'
  }
  if (lower.includes('invalid items')) {
    return 'INVALID_ITEMS'
  }
  if (lower.includes('duplicate skus')) {
    return 'DUPLICATE_SKUS'
  }
  if (lower.includes('invalid inventory lease name')) {
    return 'INVALID_LEASE_NAME'
  }
  if (lower.includes('inventory snapshot cannot be empty')) {
    return 'EMPTY_SNAPSHOT'
  }
  if (lower.includes('inventory snapshot must be a json array')) {
    return 'NOT_ARRAY'
  }
  return 'OTHER'
}

/**
 * Safely reads a string property from an object without throwing on
 * missing properties or throwing getters.
 */
function safeStringProp(obj: unknown, prop: string): string | undefined {
  try {
    if (obj === null || obj === undefined) return undefined
    const val = (obj as Record<string, unknown>)[prop]
    return typeof val === 'string' ? val : undefined
  } catch {
    return undefined
  }
}

/**
 * Safely reads the `cause` property from an object without throwing on
 * missing properties or throwing getters. Returns the raw value (any
 * type) or undefined.
 */
function safeCauseProp(obj: unknown): unknown {
  try {
    if (obj === null || obj === undefined) return undefined
    return (obj as { cause?: unknown }).cause
  } catch {
    return undefined
  }
}

/**
 * Extracts a bounded, allowlisted diagnostic representation from an
 * error, traversing the `cause` chain up to MAX_CAUSE_DEPTH levels.
 * Circular references and throwing property getters are handled safely.
 *
 * Never reads the full error object, stack, query, parameters,
 * snapshot data, or credentials.
 *
 * @param error - The error to diagnose.
 * @param operation - Optional operation name; only allowlisted values
 *   are included in the result.
 * @returns A safe PostgresErrorInfo with only category, optional code,
 *   operation, and connectionId fields.
 */
export function extractPostgresError(
  error: unknown,
  operation?: string,
): PostgresErrorInfo {
  const info: PostgresErrorInfo = { category: 'OTHER' }

  if (operation && ALLOWED_OPERATIONS.has(operation)) {
    info.operation = operation
  }

  if (error === null || error === undefined) {
    return info
  }

  let message: string | undefined
  const seen = new Set<object>()
  let current: unknown = error

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || current === undefined) break

    if (typeof current === 'object') {
      if (seen.has(current)) break
      seen.add(current)
    }

    try {
      if (current instanceof Error) {
        // Deeper cause messages and codes take precedence: overwrite so
        // the innermost valid value is used for categorization.
        const msg = safeStringProp(current, 'message')
        if (msg) message = msg
        const code = safeStringProp(current, 'code')
        if (code && SQLSTATE_RE.test(code)) info.code = code
      } else if (typeof current === 'string') {
        message = current
      } else if (typeof current === 'object') {
        const msg = safeStringProp(current, 'message')
        if (msg) message = msg
        const code = safeStringProp(current, 'code')
        if (code && SQLSTATE_RE.test(code)) info.code = code
      }
    } catch {
      break
    }

    // Advance to the next cause level.
    try {
      current = safeCauseProp(current)
      if (typeof current === 'string') {
        if (!message) message = current
        break
      }
    } catch {
      break
    }
  }

  if (message) {
    info.category = categorizeMessage(message)
  } else if (info.code) {
    info.category = 'OTHER'
  }

  return info
}

/**
 * Logs an inventory import error safely to console.error exactly once.
 *
 * The emitted string contains only: connection ID (UUID, non-sensitive),
 * allowlisted operation name, error category, and optional SQLSTATE code.
 * It never contains the raw error object, stack trace, SQL query,
 * parameters, snapshot data, credentials, or PostgreSQL message/detail/hint.
 *
 * @param connectionId - Non-sensitive UUID identifier.
 * @param error - The error to log.
 * @param operation - Optional operation name; must be allowlisted.
 */
export function logInventoryImportError(
  connectionId: string,
  error: unknown,
  operation?: string,
): void {
  let info: PostgresErrorInfo
  try {
    info = extractPostgresError(error, operation)
  } catch {
    info = { category: 'OTHER', operation }
  }

  if (connectionId) {
    info.connectionId = connectionId
  }

  try {
    console.error(`inventory_import_error ${JSON.stringify(info)}`)
  } catch {
    // Logging must never throw or mask the original error.
  }
}

/**
 * Logs a database finalization failure safely to console.error exactly
 * once. Used when `fail_inventory_import()` itself throws, so the
 * original import error is not masked and the HTTP response contract is
 * preserved.
 *
 * @param connectionId - Non-sensitive UUID identifier.
 * @param error - The finalization error to log.
 */
export function logInventoryImportFinalizationError(
  connectionId: string,
  error: unknown,
): void {
  let info: PostgresErrorInfo
  try {
    info = extractPostgresError(error, 'fail_inventory_import')
  } catch {
    info = { category: 'OTHER', operation: 'fail_inventory_import' }
  }

  if (connectionId) {
    info.connectionId = connectionId
  }

  try {
    console.error(
      `inventory_import_finalization_error ${JSON.stringify(info)}`,
    )
  } catch {
    // Logging must never throw or mask the original error.
  }
}

/**
 * Logs a safe, predefined finalization-rejected event when
 * `fail_inventory_import()` returns `false` (not a thrown exception).
 * This indicates the database finalization was rejected due to lease
 * loss, advisory lock contention, a stale run, or a newer completed
 * run — none of which should mask the original import error or change
 * the HTTP response contract.
 *
 * @param connectionId - Non-sensitive UUID identifier.
 */
export function logInventoryImportFinalizationRejected(
  connectionId: string,
): void {
  const info: PostgresErrorInfo = {
    category: 'FINALIZATION_REJECTED',
    operation: 'fail_inventory_import',
    connectionId,
  }

  try {
    console.error(
      `inventory_import_finalization_rejected ${JSON.stringify(info)}`,
    )
  } catch {
    // Logging must never throw or mask the original error.
  }
}
