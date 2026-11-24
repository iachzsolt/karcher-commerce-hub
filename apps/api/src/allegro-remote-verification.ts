/**
 * Per-offer remote verification for the sliced inventory refresh.
 *
 * A stock or publication mutation may only be decided on a remote state
 * that was read from Allegro and persisted during the same
 * `/inventory-sync` request. A successful `/sync` HTTP response never
 * implies that every requested offer was verified: only the offer ids
 * that `/sync` itself reports as persisted count.
 *
 * Everything here is pure so the rules are testable without a database
 * or the Allegro API.
 */

export type RemoteVerificationFailureReason =
  /** Allegro did not return the offer for the requested id. */
  | 'OFFER_NOT_RETURNED'
  /** Returned, but without allegro-hu marketplace data. */
  | 'MISSING_HU_MARKETPLACE'
  /** Returned, but without a seller SKU (`external.id`). */
  | 'MISSING_SKU'
  /** The listing has no Allegro offer id to verify. */
  | 'MISSING_OFFER_ID'
  /** `/sync` answered with a non-2xx status for the whole chunk. */
  | 'SYNC_HTTP_ERROR'
  /** `/sync` answered 2xx without a usable per-offer verification report. */
  | 'SYNC_RESPONSE_INVALID'
  /** `/sync` did not report this offer as verified, without a specific reason. */
  | 'NOT_VERIFIED'
  /** Verified offer without the persisted listing id: identity cannot be proven. */
  | 'VERIFICATION_IDENTITY_MISSING'
  /** `/sync` persisted a different listing (e.g. another account) for this offer. */
  | 'VERIFICATION_IDENTITY_MISMATCH'

export const VERIFICATION_FAILURE_REASONS: ReadonlySet<string> = new Set<RemoteVerificationFailureReason>([
  'OFFER_NOT_RETURNED',
  'MISSING_HU_MARKETPLACE',
  'MISSING_SKU',
  'MISSING_OFFER_ID',
  'SYNC_HTTP_ERROR',
  'SYNC_RESPONSE_INVALID',
  'NOT_VERIFIED',
  'VERIFICATION_IDENTITY_MISSING',
  'VERIFICATION_IDENTITY_MISMATCH',
])

/**
 * The per-offer report `/sync` returns in its JSON body.
 *
 * `verified` carries the platform listing id `/sync` actually persisted.
 * A listing id belongs to exactly one platform account (and so one
 * environment), which is what binds a verification to the inventory row.
 * `verifiedOfferIds` is kept for readability of the response only.
 */
export type SyncVerificationReport = {
  verifiedOfferIds: string[]
  verified: Array<{ offerId: string; listingId: string }>
  unverified: Array<{ offerId: string; reason: RemoteVerificationFailureReason }>
}

export type OfferVerificationResult =
  | { verified: true; listingId: string | null }
  | { verified: false; reason: RemoteVerificationFailureReason; httpStatus?: number }

function asVerificationReport(value: unknown): SyncVerificationReport | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.verifiedOfferIds) || !Array.isArray(record.unverified)) return null
  const verifiedOfferIds = record.verifiedOfferIds.filter(
    (offerId): offerId is string => typeof offerId === 'string',
  )
  const verified: SyncVerificationReport['verified'] = []
  for (const entry of Array.isArray(record.verified) ? record.verified : []) {
    if (!entry || typeof entry !== 'object') continue
    const { offerId, listingId } = entry as Record<string, unknown>
    if (typeof offerId !== 'string' || typeof listingId !== 'string' || !listingId.trim()) continue
    verified.push({ offerId, listingId })
  }
  const unverified: SyncVerificationReport['unverified'] = []
  for (const entry of record.unverified) {
    if (!entry || typeof entry !== 'object') continue
    const { offerId, reason } = entry as Record<string, unknown>
    if (typeof offerId !== 'string') continue
    unverified.push({
      offerId,
      reason: typeof reason === 'string' && VERIFICATION_FAILURE_REASONS.has(reason)
        ? reason as RemoteVerificationFailureReason
        : 'NOT_VERIFIED',
    })
  }
  return { verifiedOfferIds, verified, unverified }
}

/**
 * Interpret one `/sync` chunk response for the offers it was asked for.
 *
 * Conservative by construction: an offer is verified only when the body
 * explicitly lists it as verified. A non-2xx response, an unreadable body
 * or a missing report leaves every requested offer unverified.
 */
export function evaluateSyncChunk(
  requestedOfferIds: readonly string[],
  response: { ok: boolean; status: number; body: unknown },
): Map<string, OfferVerificationResult> {
  const results = new Map<string, OfferVerificationResult>()

  if (!response.ok) {
    for (const offerId of requestedOfferIds) {
      results.set(offerId, { verified: false, reason: 'SYNC_HTTP_ERROR', httpStatus: response.status })
    }
    return results
  }

  const body = response.body && typeof response.body === 'object'
    ? response.body as Record<string, unknown>
    : null
  const report = asVerificationReport(body?.verification)

  if (!report) {
    for (const offerId of requestedOfferIds) {
      results.set(offerId, { verified: false, reason: 'SYNC_RESPONSE_INVALID', httpStatus: response.status })
    }
    return results
  }

  const verified = new Set([
    ...report.verifiedOfferIds,
    ...report.verified.map(entry => entry.offerId),
  ])
  const listingByOffer = new Map<string, string | null>()
  for (const entry of report.verified) {
    // Two different persisted listings for one offer is ambiguous: no identity.
    const previous = listingByOffer.get(entry.offerId)
    listingByOffer.set(
      entry.offerId,
      previous === undefined || previous === entry.listingId ? entry.listingId : null,
    )
  }
  const reasons = new Map(report.unverified.map(entry => [entry.offerId, entry.reason]))

  for (const offerId of requestedOfferIds) {
    results.set(
      offerId,
      verified.has(offerId) && !reasons.has(offerId)
        ? { verified: true, listingId: listingByOffer.get(offerId) ?? null }
        : { verified: false, reason: reasons.get(offerId) ?? 'NOT_VERIFIED' },
    )
  }
  return results
}

/**
 * Map offer-level verification onto listings.
 *
 * Returns only the listings that are NOT verified, with their reason. A
 * listing is verified only when `/sync` persisted exactly this listing id;
 * the rows come from the session's platform account, so a matching listing
 * id also proves the account and environment. A listing without an offer
 * id, or without a matching persisted identity, is never verified.
 */
export function unverifiedListings(
  rows: ReadonlyArray<{ listingId: string; offerId: string | null }>,
  offers: ReadonlyMap<string, OfferVerificationResult>,
): Map<string, RemoteVerificationFailureReason> {
  const unverified = new Map<string, RemoteVerificationFailureReason>()

  for (const row of rows) {
    const offerId = row.offerId?.trim()
    if (!offerId) {
      unverified.set(row.listingId, 'MISSING_OFFER_ID')
      continue
    }
    const result = offers.get(offerId)
    if (!result) {
      unverified.set(row.listingId, 'NOT_VERIFIED')
      continue
    }
    if (!result.verified) {
      unverified.set(row.listingId, result.reason)
      continue
    }
    if (!result.listingId) {
      unverified.set(row.listingId, 'VERIFICATION_IDENTITY_MISSING')
      continue
    }
    if (result.listingId !== row.listingId) {
      unverified.set(row.listingId, 'VERIFICATION_IDENTITY_MISMATCH')
    }
  }

  return unverified
}

/* ------------------------------------------------------------------ *
 * Allegro asynchronous task diagnostics
 * ------------------------------------------------------------------ */

const MAX_TEXT = 500
const MAX_ERRORS = 10

export type AllegroTaskError = {
  code: string | null
  message: string | null
  userMessage: string | null
  path: string | null
  details: string | null
}

/** Faithful, bounded representation of one Allegro command task. */
export type AllegroTaskDiagnostics = {
  offerId: string | null
  status: string | null
  field: string | null
  message: string | null
  errors: AllegroTaskError[]
  scheduledAt: string | null
  finishedAt: string | null
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object') {
    try {
      return text(JSON.stringify(value))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Keep the fields Allegro documents for command tasks; drop anything else.
 * Task payloads never carry credentials, but values are still bounded.
 */
export function sanitizeAllegroTask(task: unknown): AllegroTaskDiagnostics {
  const record = task && typeof task === 'object' ? task as Record<string, unknown> : {}
  const offer = record.offer && typeof record.offer === 'object' ? record.offer as Record<string, unknown> : {}
  const rawErrors = Array.isArray(record.errors) ? record.errors : []

  return {
    offerId: text(offer.id),
    status: text(record.status),
    field: text(record.field),
    message: text(record.message),
    errors: rawErrors.slice(0, MAX_ERRORS).map(error => {
      const item = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      return {
        code: text(item.code),
        message: text(item.message),
        userMessage: text(item.userMessage),
        path: text(item.path),
        details: text(item.details),
      }
    }),
    scheduledAt: text(record.scheduledAt),
    finishedAt: text(record.finishedAt),
  }
}

/** Sanitized task list from a `GET .../tasks` response body. */
export function sanitizeAllegroTaskList(body: unknown): AllegroTaskDiagnostics[] {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  return Array.isArray(record.tasks) ? record.tasks.slice(0, 100).map(sanitizeAllegroTask) : []
}

/** Bounded raw text for a non-2xx Allegro response (never headers). */
export function boundedResponseText(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value
}

/* ------------------------------------------------------------------ *
 * Stock-command diagnostic access control
 * ------------------------------------------------------------------ */

const COMMAND_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isValidStockCommandId(value: string): boolean {
  return COMMAND_ID_PATTERN.test(value)
}

export type StockCommandOwnership = {
  listingId: string
  offerId: string | null
  accountId: string
  environment: string
}

export type StockCommandDiagnosticDecision =
  | { allowed: true; command: StockCommandOwnership }
  | { allowed: false; status: 400 | 401 | 403 | 404; reason: string }

/**
 * Who may read an Allegro stock command task, and for which command.
 *
 * Only administrators, only well-formed ids, and only commands this
 * Commerce Hub journal created for the currently connected account and
 * environment. Anything else is answered as not found, so command ids of
 * other accounts cannot be probed.
 */
/** Checks that need no I/O; run before touching the session or database. */
export function precheckStockCommandDiagnostic(input: {
  role: string | null
  commandId: string
}): Extract<StockCommandDiagnosticDecision, { allowed: false }> | null {
  if (input.role !== 'ADMIN') return { allowed: false, status: 403, reason: 'ADMIN_REQUIRED' }
  if (!isValidStockCommandId(input.commandId)) return { allowed: false, status: 400, reason: 'INVALID_COMMAND_ID' }
  return null
}

export function authorizeStockCommandDiagnostic(input: {
  role: string | null
  commandId: string
  session: { platformAccountId: string; environment: string } | null
  journalMatches: ReadonlyArray<StockCommandOwnership>
}): StockCommandDiagnosticDecision {
  const rejected = precheckStockCommandDiagnostic(input)
  if (rejected) return rejected
  if (!input.session) return { allowed: false, status: 401, reason: 'ALLEGRO_NOT_CONNECTED' }

  const owned = input.journalMatches.filter(
    match =>
      match.accountId === input.session!.platformAccountId &&
      match.environment === input.session!.environment,
  )
  // One command belongs to exactly one listing; ambiguity is never resolved by guessing.
  const listings = new Set(owned.map(match => match.listingId))
  if (owned.length === 0 || listings.size !== 1) {
    return { allowed: false, status: 404, reason: 'COMMAND_NOT_FOUND' }
  }

  return { allowed: true, command: owned[0] }
}
