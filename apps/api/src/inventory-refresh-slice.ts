/*
 * Bounded, resumable inventory refresh slices.
 *
 * The manual full inventory refresh used to be one long
 * synchronous request. It is now a sequence of small
 * `/advance` calls, each of which:
 *
 *  - refreshes remote state for the batch it is about to touch
 *  - mutates at most `maxMutationAttemptsPerSlice` listings
 *  - paces every mutation attempt
 *  - stops on a wall-clock budget or an Allegro 429
 *  - persists a durable cursor so the next call resumes exactly
 *    where this one stopped
 *
 * Everything in this module is pure and clock-injectable so the
 * budgeting rules can be tested without timers or HTTP.
 */

/** Stress-tested in production: do not raise casually. */
export const MAX_LISTINGS_PER_BATCH = 25

export type InventoryRefreshSliceConfig = {
  /** Mutation attempts (dispatched writes), not confirmed successes. */
  maxMutationAttemptsPerSlice: number
  maxSliceDurationMs: number
  writePacingMs: number
  sliceCooldownMs: number
}

export const INVENTORY_REFRESH_SLICE_DEFAULTS: InventoryRefreshSliceConfig = {
  maxMutationAttemptsPerSlice: 5,
  maxSliceDurationMs: 40_000,
  writePacingMs: 750,
  sliceCooldownMs: 2_500,
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Slice limits are operational knobs, not business rules, so they
 * are readable from the environment with the agreed defaults. The
 * listing batch size stays a constant.
 */
export function resolveInventoryRefreshSliceConfig(
  environment: Record<string, string | undefined> = process.env,
): InventoryRefreshSliceConfig {
  return {
    maxMutationAttemptsPerSlice: Math.min(
      MAX_LISTINGS_PER_BATCH,
      positiveInteger(
        environment.COMMERCE_HUB_INVENTORY_SLICE_MAX_MUTATIONS,
        INVENTORY_REFRESH_SLICE_DEFAULTS.maxMutationAttemptsPerSlice,
      ),
    ),
    maxSliceDurationMs: positiveInteger(
      environment.COMMERCE_HUB_INVENTORY_SLICE_MAX_DURATION_MS,
      INVENTORY_REFRESH_SLICE_DEFAULTS.maxSliceDurationMs,
    ),
    writePacingMs: positiveInteger(
      environment.COMMERCE_HUB_INVENTORY_SLICE_WRITE_PACING_MS,
      INVENTORY_REFRESH_SLICE_DEFAULTS.writePacingMs,
    ),
    sliceCooldownMs: positiveInteger(
      environment.COMMERCE_HUB_INVENTORY_SLICE_COOLDOWN_MS,
      INVENTORY_REFRESH_SLICE_DEFAULTS.sliceCooldownMs,
    ),
  }
}

export type InventorySliceStopReason =
  | 'WRITE_BUDGET'
  | 'SLICE_BUDGET'
  | 'RATE_LIMIT'

export type InventorySliceBudget = {
  config: InventoryRefreshSliceConfig
  startedAt: number
  mutationAttempts: number
  lastMutationAt: number | null
  stopReason: InventorySliceStopReason | null
  rateLimitedUntil: number | null
}

export type InventorySliceGate =
  | { allowed: true; waitMs: number }
  | { allowed: false; reason: InventorySliceStopReason; waitMs: 0 }

export function createSliceBudget(
  config: InventoryRefreshSliceConfig,
  now = Date.now(),
): InventorySliceBudget {
  return {
    config,
    startedAt: now,
    mutationAttempts: 0,
    lastMutationAt: null,
    stopReason: null,
    rateLimitedUntil: null,
  }
}

/**
 * Decide whether another mutation attempt may start.
 *
 * A refused gate latches `stopReason` so the caller cannot loop
 * again inside the same slice even if the clock moves.
 */
export function sliceMutationGate(
  budget: InventorySliceBudget,
  now = Date.now(),
): InventorySliceGate {
  if (budget.stopReason) {
    return { allowed: false, reason: budget.stopReason, waitMs: 0 }
  }

  if (budget.mutationAttempts >= budget.config.maxMutationAttemptsPerSlice) {
    budget.stopReason = 'WRITE_BUDGET'
    return { allowed: false, reason: 'WRITE_BUDGET', waitMs: 0 }
  }

  if (now - budget.startedAt >= budget.config.maxSliceDurationMs) {
    budget.stopReason = 'SLICE_BUDGET'
    return { allowed: false, reason: 'SLICE_BUDGET', waitMs: 0 }
  }

  const pacing =
    budget.lastMutationAt === null
      ? 0
      : Math.max(0, budget.lastMutationAt + budget.config.writePacingMs - now)

  return { allowed: true, waitMs: pacing }
}

/**
 * Reserve one mutation slot *before* the write leaves the process.
 *
 * The budget counts attempts, not successes. A write whose result
 * is unknown still consumed a slot, so it is never refunded.
 */
export function sliceReserveMutationAttempt(
  budget: InventorySliceBudget,
  now = Date.now(),
) {
  budget.mutationAttempts += 1
  budget.lastMutationAt = now
}

/**
 * Give back a slot only when the caller can prove no mutation was
 * dispatched (`mutationDispatched === false`). The pacing clock is
 * intentionally left alone: an extra 750 ms is harmless and keeps
 * the throttle strictly conservative.
 */
export function sliceRefundMutationAttempt(budget: InventorySliceBudget) {
  budget.mutationAttempts = Math.max(0, budget.mutationAttempts - 1)
}

export function sliceNoteRateLimit(
  budget: InventorySliceBudget,
  retryAfterMs: number,
  now = Date.now(),
) {
  budget.stopReason = 'RATE_LIMIT'
  budget.rateLimitedUntil = now + Math.max(0, retryAfterMs)
}

export type InventorySliceSnapshot = {
  mutationAttempts: number
  elapsedMs: number
  stopReason: InventorySliceStopReason | null
  rateLimitedUntil: number | null
  nextAdvanceAt: number
}

/**
 * When the next `/advance` may run.
 *
 * A 429 wins: honour Allegro's own cooldown. Otherwise a slice that
 * stopped early waits the cross-slice cooldown so a write-heavy
 * slice is never immediately followed by another burst.
 */
export function sliceNextAdvanceAt(
  budget: InventorySliceBudget,
  now = Date.now(),
) {
  if (budget.stopReason === 'RATE_LIMIT' && budget.rateLimitedUntil !== null) {
    return Math.max(now, budget.rateLimitedUntil)
  }

  if (budget.stopReason !== null) {
    const paced =
      budget.lastMutationAt === null
        ? 0
        : budget.lastMutationAt + budget.config.writePacingMs

    return Math.max(now + budget.config.sliceCooldownMs, paced)
  }

  return now
}

export function sliceSnapshot(
  budget: InventorySliceBudget,
  now = Date.now(),
): InventorySliceSnapshot {
  return {
    mutationAttempts: budget.mutationAttempts,
    elapsedMs: Math.max(0, now - budget.startedAt),
    stopReason: budget.stopReason,
    rateLimitedUntil: budget.rateLimitedUntil,
    nextAdvanceAt: sliceNextAdvanceAt(budget, now),
  }
}

/* ------------------------------------------------------------------ *
 * Durable cursor
 * ------------------------------------------------------------------ */

export type InventoryRefreshPhase = 'AUTOMATION' | 'FINALIZE'

export type InventoryBatchSummary = {
  attempted: number
  stockUpdated: number
  autoPaused: number
  reactivated: number
  unchanged: number
  skipped: number
  pending: number
  failed: number
}

export const EMPTY_BATCH_SUMMARY: InventoryBatchSummary = {
  attempted: 0,
  stockUpdated: 0,
  autoPaused: 0,
  reactivated: 0,
  unchanged: 0,
  skipped: 0,
  pending: 0,
  failed: 0,
}

export function createEmptyBatchSummary(): InventoryBatchSummary {
  return { ...EMPTY_BATCH_SUMMARY }
}

export type InventoryCursorBatchResult = {
  batchNumber: number
  listingCount: number
  ok: boolean
  status: number
  details: unknown
}

/**
 * Everything accumulated for the batch currently in flight. A batch
 * can span several slices, so its summary and diagnostics are built
 * up incrementally and only committed when every listing has been
 * processed.
 */
export type InventoryCursorBatchState = {
  summary: InventoryBatchSummary
  results: Array<Record<string, unknown>>
  refreshStatus: string
  refreshDetails: unknown
  failureStatus: number | null
  lastStatus: number
}

export function createEmptyBatchState(): InventoryCursorBatchState {
  return {
    summary: createEmptyBatchSummary(),
    results: [],
    refreshStatus: 'not-needed',
    refreshDetails: null,
    failureStatus: null,
    lastStatus: 200,
  }
}

export type InventoryCursorAllegroPlan = {
  kind: 'ALLEGRO'
  accountId: string
  historyGroupId: string
  /** Frozen at begin: `enabledListings` has no ORDER BY. */
  batches: string[][]
  batchIndex: number
  /** Listing ids of the in-flight batch already handled. */
  completedListingIds: string[]
  partial: InventoryCursorBatchState
  completedBatches: InventoryCursorBatchResult[]
  /** Set when the account has no auto-stock-sync listings at all. */
  skippedReason: string | null
}

export type InventoryCursorUnsupportedPlan = {
  kind: 'UNSUPPORTED'
  platformCode: string
  accountId: string
}

export type InventoryCursorPlan =
  | InventoryCursorAllegroPlan
  | InventoryCursorUnsupportedPlan

export type InventoryRefreshCursor = {
  version: 1
  runId: string
  connectionId: string
  phase: InventoryRefreshPhase
  planIndex: number
  plans: InventoryCursorPlan[]
  /** Server-side pacing gate: no `/advance` before this instant. */
  nextAdvanceAt: number | null
}

/** What a single `/inventory-sync` call reports back to the slice driver. */
export type InventorySliceReport = {
  mutationAttempts: number
  stopReason: InventorySliceStopReason | null
  rateLimitedUntil: number | null
  nextAdvanceAt: number
  processedListingIds: string[]
  summary: InventoryBatchSummary
  refresh: { status: string; details: unknown }
  /** Already compacted: `summary` plus only SKIP/FAILED rows. */
  results: Array<Record<string, unknown>>
  ok: boolean
  status: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.every(item => typeof item === 'string') ? [...value] : null
}

function asBatchSummary(value: unknown): InventoryBatchSummary {
  const record = asRecord(value)
  const summary = createEmptyBatchSummary()

  for (const key of Object.keys(summary) as Array<keyof InventoryBatchSummary>) {
    const raw = record?.[key]
    summary[key] =
      typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
        ? Math.trunc(raw)
        : 0
  }

  return summary
}

function asBatchState(value: unknown): InventoryCursorBatchState | null {
  const record = asRecord(value)
  if (!record) return null

  const results = Array.isArray(record.results)
    ? record.results
        .map(item => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
    : []

  return {
    summary: asBatchSummary(record.summary),
    results,
    refreshStatus:
      typeof record.refreshStatus === 'string' ? record.refreshStatus : 'not-needed',
    refreshDetails: record.refreshDetails ?? null,
    failureStatus:
      typeof record.failureStatus === 'number' ? record.failureStatus : null,
    lastStatus: typeof record.lastStatus === 'number' ? record.lastStatus : 200,
  }
}

function asCompletedBatches(value: unknown): InventoryCursorBatchResult[] {
  if (!Array.isArray(value)) return []

  return value.flatMap(item => {
    const record = asRecord(item)
    if (!record) return []

    if (
      typeof record.batchNumber !== 'number' ||
      typeof record.listingCount !== 'number' ||
      typeof record.ok !== 'boolean' ||
      typeof record.status !== 'number'
    ) {
      return []
    }

    return [
      {
        batchNumber: record.batchNumber,
        listingCount: record.listingCount,
        ok: record.ok,
        status: record.status,
        details: record.details ?? null,
      },
    ]
  })
}

function asAllegroPlan(value: unknown): InventoryCursorAllegroPlan | null {
  const record = asRecord(value)
  if (!record || record.kind !== 'ALLEGRO') return null
  if (typeof record.accountId !== 'string') return null
  if (typeof record.historyGroupId !== 'string') return null

  if (!Array.isArray(record.batches)) return null

  const batches: string[][] = []

  for (const batch of record.batches) {
    const listingIds = asStringArray(batch)
    if (!listingIds) return null
    batches.push(listingIds)
  }

  const completedListingIds = asStringArray(record.completedListingIds) ?? []
  const partial = asBatchState(record.partial) ?? createEmptyBatchState()

  return {
    kind: 'ALLEGRO',
    accountId: record.accountId,
    historyGroupId: record.historyGroupId,
    batches,
    batchIndex:
      typeof record.batchIndex === 'number' &&
      Number.isInteger(record.batchIndex) &&
      record.batchIndex >= 0 &&
      record.batchIndex <= batches.length
        ? record.batchIndex
        : 0,
    completedListingIds,
    partial,
    completedBatches: asCompletedBatches(record.completedBatches),
    skippedReason:
      typeof record.skippedReason === 'string' ? record.skippedReason : null,
  }
}

function asUnsupportedPlan(value: unknown): InventoryCursorUnsupportedPlan | null {
  const record = asRecord(value)
  if (!record || record.kind !== 'UNSUPPORTED') return null
  if (typeof record.platformCode !== 'string') return null
  if (typeof record.accountId !== 'string') return null

  return {
    kind: 'UNSUPPORTED',
    platformCode: record.platformCode,
    accountId: record.accountId,
  }
}

/**
 * Tolerant parse. Anything malformed returns `null` so a corrupt
 * cursor can never be mistaken for a resumable run.
 */
export function parseInventoryRefreshCursor(
  value: unknown,
): InventoryRefreshCursor | null {
  const record = asRecord(value)
  if (!record) return null
  if (record.version !== 1) return null
  if (typeof record.runId !== 'string') return null
  if (typeof record.connectionId !== 'string') return null
  if (record.phase !== 'AUTOMATION' && record.phase !== 'FINALIZE') return null
  if (!Array.isArray(record.plans)) return null

  const plans: InventoryCursorPlan[] = []

  for (const planValue of record.plans) {
    const plan = asAllegroPlan(planValue) ?? asUnsupportedPlan(planValue)
    if (!plan) return null
    plans.push(plan)
  }

  const planIndex =
    typeof record.planIndex === 'number' &&
    Number.isInteger(record.planIndex) &&
    record.planIndex >= 0 &&
    record.planIndex <= plans.length
      ? record.planIndex
      : 0

  return {
    version: 1,
    runId: record.runId,
    connectionId: record.connectionId,
    phase: record.phase,
    planIndex,
    plans,
    nextAdvanceAt:
      typeof record.nextAdvanceAt === 'number' &&
      Number.isFinite(record.nextAdvanceAt)
        ? record.nextAdvanceAt
        : null,
  }
}

/**
 * The cursor is a sibling key of `version`/`platforms` so the
 * existing diagnostics reader keeps working untouched.
 */
export function readInventoryRefreshCursor(
  automationDetailsJson: string | null,
): InventoryRefreshCursor | null {
  if (!automationDetailsJson || !automationDetailsJson.trim()) return null

  try {
    const parsed = asRecord(JSON.parse(automationDetailsJson))
    return parseInventoryRefreshCursor(parsed?.cursor)
  } catch {
    return null
  }
}

export function serializeAutomationDetailsWithCursor(
  diagnostics: { version: 1; platforms: unknown[] },
  cursor: InventoryRefreshCursor | null,
) {
  return JSON.stringify(
    cursor ? { ...diagnostics, cursor } : diagnostics,
  )
}

export function remainingBatchListingIds(plan: InventoryCursorAllegroPlan) {
  const batch = plan.batches[plan.batchIndex]
  if (!batch) return []

  const completed = new Set(plan.completedListingIds)
  return batch.filter(listingId => !completed.has(listingId))
}

export function isCurrentBatchComplete(plan: InventoryCursorAllegroPlan) {
  const batch = plan.batches[plan.batchIndex]
  if (!batch) return true

  const completed = new Set(plan.completedListingIds)
  return batch.every(listingId => completed.has(listingId))
}

/**
 * Fold one slice report into the in-flight batch.
 *
 * Summaries add up because each listing is processed exactly once
 * per batch: completed ids are removed from the next slice's input.
 * Diagnostic rows are de-duplicated by listing id so a retried
 * listing cannot inflate the skip/failure breakdown.
 */
export function mergeSliceIntoBatchState(
  state: InventoryCursorBatchState,
  report: InventorySliceReport,
): InventoryCursorBatchState {
  const summary = { ...state.summary }

  for (const key of Object.keys(summary) as Array<keyof InventoryBatchSummary>) {
    summary[key] += Math.max(0, Math.trunc(report.summary[key] ?? 0))
  }

  const byListingId = new Map<string, Record<string, unknown>>()

  for (const result of [...state.results, ...report.results]) {
    const listingId = typeof result.listingId === 'string' ? result.listingId : null
    if (listingId) {
      byListingId.set(listingId, result)
      continue
    }

    byListingId.set(`anonymous:${byListingId.size}`, result)
  }

  const failureStatus =
    state.failureStatus ?? (report.ok ? null : report.status)

  return {
    summary,
    results: [...byListingId.values()],
    refreshStatus: report.refresh.status,
    refreshDetails: report.refresh.details,
    failureStatus,
    lastStatus: report.status,
  }
}

/** Commit the in-flight batch once every listing has been processed. */
export function completeCurrentBatch(
  plan: InventoryCursorAllegroPlan,
  transport: { ok: boolean; status: number },
): InventoryCursorBatchResult {
  const batch = plan.batches[plan.batchIndex] ?? []
  const details = {
    summary: plan.partial.summary,
    refresh: {
      status: plan.partial.refreshStatus,
      details: plan.partial.refreshDetails,
    },
    results: plan.partial.results,
  }

  const ok =
    transport.ok &&
    plan.partial.failureStatus === null &&
    plan.partial.summary.failed === 0 &&
    plan.partial.refreshStatus !== 'failed'

  return {
    batchNumber: plan.batchIndex + 1,
    listingCount: batch.length,
    ok,
    status: ok ? transport.status : plan.partial.failureStatus ?? transport.status,
    details,
  }
}

/** Diagnostic rows that `buildInventoryAutomationDiagnostics` actually reads. */
export function compactBatchResults(
  results: Array<Record<string, unknown>>,
) {
  return results.filter(
    result => result.action === 'SKIP' || result.status === 'FAILED',
  )
}
