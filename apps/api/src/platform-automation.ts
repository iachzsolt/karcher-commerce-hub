import {
  and,
  eq,
} from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { InventoryExecutionLease } from './inventory-execution-lease.js'

import {
  createDatabase,
  dataConnections,
  listingDesiredStates,
  platformAccounts,
  platformInventorySyncSettings,
  platformListings,
  platforms,
} from '@karcher-commerce-hub/database'

import {
  allegroAuth,
} from './allegro-auth.js'
import {
  MAX_LISTINGS_PER_BATCH,
  completeCurrentBatch,
  createEmptyBatchState,
  isCurrentBatchComplete,
  mergeSliceIntoBatchState,
  remainingBatchListingIds,
  type InventoryCursorAllegroPlan,
  type InventoryRefreshCursor,
  type InventorySliceReport,
  type InventorySliceStopReason,
} from './inventory-refresh-slice.js'

type Database =
  ReturnType<typeof createDatabase>

export type InventoryRefreshAutomationResult = {
  platform: string
  accountId: string
  outcome: 'SUCCESS' | 'FAILED' | 'SKIPPED'
  ok: boolean
  status: number
  details: unknown
}

export type InventorySyncRequestInput = {
  connectionId: string
  listingIds: string[]
  historyGroupId: string
  batchIndex: number
  executionLease?: InventoryExecutionLease
  /*
   * Deliberately optional and omitted when undefined. The
   * synchronous/scheduled caller must keep the historical
   * request shape so `/inventory-sync` defaults to LEGACY.
   */
  executionMode?: 'LEGACY' | 'SLICED'
}

export function buildInventorySyncRequest(
  input: InventorySyncRequestInput,
) {
  return {
    confirm: true as const,
    connectionId: input.connectionId,
    listingIds: input.listingIds,
    historyGroupId: input.historyGroupId,
    batchIndex: input.batchIndex,
    executionLease: input.executionLease,
    ...(input.executionMode
      ? { executionMode: input.executionMode }
      : {}),
  }
}

export function hasInventorySyncFailure(details: unknown) {
  if (!details || typeof details !== 'object') {
    return false
  }

  const result = details as {
    summary?: { failed?: unknown }
    refresh?: { status?: unknown }
  }

  return (
    (typeof result.summary?.failed === 'number' &&
      result.summary.failed > 0) ||
    result.refresh?.status === 'failed'
  )
}

export async function runInventoryRefreshAutomations(
  database: Database,
  connectionId: string,
  options?: {
    executionLease: InventoryExecutionLease
    assertOwned: () => Promise<void>
    onProgress: (result: { status: 'COMPLETED'; connectionId: string; enabledAutomationCount: number; results: InventoryRefreshAutomationResult[] }) => Promise<void>
  },
) {
  /*
   * Platform automatizáció kizárólag az aktív,
   * központi INVENTORY forrás után indulhat.
   */
  const [connection] =
    await database
      .select({
        id:
          dataConnections.id,
        purpose:
          dataConnections.purpose,
        isActive:
          dataConnections.isActive,
      })
      .from(dataConnections)
      .where(
        eq(
          dataConnections.id,
          connectionId,
        ),
      )
      .limit(1)

  if (
    !connection ||
    connection.purpose !== 'INVENTORY' ||
    !connection.isActive
  ) {
    return {
      status: 'SKIPPED' as const,
      reason:
        'NOT_ACTIVE_INVENTORY_SOURCE',
      results:
        [] as InventoryRefreshAutomationResult[],
    }
  }

  /*
   * Minden platform saját account-szintű
   * beállítás alapján dönt arról,
   * hogy reagál-e az inventory refresh eseményre.
   */
  const enabledSettings =
    await database
      .select({
        accountId:
          platformAccounts.id,

        platformCode:
          platforms.code,

        triggerMode:
          platformInventorySyncSettings
            .triggerMode,
      })
      .from(
        platformInventorySyncSettings,
      )
      .innerJoin(
        platformAccounts,
        eq(
          platformAccounts.id,
          platformInventorySyncSettings
            .accountId,
        ),
      )
      .innerJoin(
        platforms,
        eq(
          platforms.id,
          platformAccounts.platformId,
        ),
      )
      .where(
        and(
          eq(
            platformInventorySyncSettings
              .enabled,
            true,
          ),

          eq(
            platformInventorySyncSettings
              .triggerMode,
            'INVENTORY_REFRESH',
          ),

          eq(
            platformAccounts.active,
            true,
          ),
        ),
      )

  const results:
    InventoryRefreshAutomationResult[] =
    []

  for (
    const setting of
    enabledSettings
  ) {
    /*
     * Allegro adapter.
     *
     * Később más platformok ugyanebben az
     * orchestrátorban kaphatnak saját adaptert.
     */
    if (
      setting.platformCode ===
      'ALLEGRO'
    ) {
      const enabledListings =
        await database
          .select({
            listingId:
              platformListings.id,
          })
          .from(platformListings)
          .innerJoin(
            listingDesiredStates,
            eq(
              listingDesiredStates.listingId,
              platformListings.id,
            ),
          )
          .where(
            and(
              eq(
                platformListings.accountId,
                setting.accountId,
              ),
              eq(
                platformListings.marketplace,
                'allegro-hu',
              ),
              eq(
                listingDesiredStates.autoStockSync,
                true,
              ),
            ),
          )

      const listingIds =
        enabledListings.map(
          (listing) =>
            listing.listingId,
        )

      if (listingIds.length === 0) {
        results.push({
          platform: 'ALLEGRO',
          accountId:
            setting.accountId,
          outcome: 'SKIPPED',
          ok: true,
          status: 204,
          details: {
            status: 'SKIPPED',
            reason:
              'NO_AUTO_STOCK_SYNC_LISTINGS',
          },
        })

        continue
      }

      const batches: string[][] = []

      for (
        let index = 0;
        index < listingIds.length;
        index += 25
      ) {
        batches.push(
          listingIds.slice(
            index,
            index + 25,
          ),
        )
      }

      const batchResults: Array<{
        batchNumber: number
        listingCount: number
        ok: boolean
        status: number
        details: unknown
      }> = []
      const historyGroupId = randomUUID()
      const accountResult = (): InventoryRefreshAutomationResult => {
        const failedBatches = batchResults.filter(batch => !batch.ok)
        return {
          platform: 'ALLEGRO', accountId: setting.accountId,
          outcome: failedBatches.length ? 'FAILED' : 'SUCCESS', ok: failedBatches.length === 0,
          status: failedBatches[0]?.status ?? 200,
          details: { status: failedBatches.length ? 'PARTIAL_FAILURE' : 'SUCCESS', totalListings: listingIds.length,
            batchCount: batches.length, successfulBatches: batchResults.length - failedBatches.length,
            failedBatches: failedBatches.length, historyGroupId, batches: [...batchResults] },
        }
      }

      for (
        let batchIndex = 0;
        batchIndex < batches.length;
        batchIndex++
      ) {
        const batch =
          batches[batchIndex]

        await options?.assertOwned()

        const response =
          await allegroAuth.request(
            '/inventory-sync',
            {
              method: 'POST',
              headers: {
                'Content-Type':
                  'application/json',
              },
              body:
                JSON.stringify(
                  buildInventorySyncRequest({
                    connectionId,
                    listingIds: batch,
                    historyGroupId,
                    batchIndex: batchIndex + 1,
                    executionLease: options?.executionLease,
                  }),
                ),
            },
          )

        const details =
          await response
            .json()
            .catch(() => null)
        const ok =
          response.ok && !hasInventorySyncFailure(details)

        batchResults.push({
          batchNumber:
            batchIndex + 1,
          listingCount:
            batch.length,
          ok,
          status:
            response.status,
          details,
        })
        await options?.onProgress({ status: 'COMPLETED', connectionId,
          enabledAutomationCount: enabledSettings.length, results: [...results, accountResult()] })
      }

      const failedBatches =
        batchResults.filter(
          (batch) => !batch.ok,
        )

      results.push({
        platform: 'ALLEGRO',
        accountId:
          setting.accountId,
        outcome:
          failedBatches.length === 0
            ? 'SUCCESS'
            : 'FAILED',
        ok:
          failedBatches.length === 0,
        status:
          failedBatches.length === 0
            ? 200
            : failedBatches[0].status,
        details: {
          status:
            failedBatches.length === 0
              ? 'SUCCESS'
              : 'PARTIAL_FAILURE',
          totalListings:
            listingIds.length,
          batchCount:
            batches.length,
          successfulBatches:
            batchResults.length -
            failedBatches.length,
          failedBatches:
            failedBatches.length,
          historyGroupId,
          batches:
            batchResults,
        },
      })

      continue
    }

    results.push({
      platform:
        setting.platformCode,
      accountId:
        setting.accountId,
      outcome: 'FAILED',
      ok: false,
      status: 501,
      details: {
        message:
          'Inventory automation adapter is not implemented.',
      },
    })
  }

  return {
    status: 'COMPLETED' as const,
    connectionId,
    enabledAutomationCount:
      enabledSettings.length,
    results,
  }
}

/* ------------------------------------------------------------------ *
 * Sliced (manual) execution
 * ------------------------------------------------------------------ */

export type InventoryRefreshSliceRunResult = {
  cursor: InventoryRefreshCursor
  done: boolean
  results: InventoryRefreshAutomationResult[]
  stopReason: InventorySliceStopReason | null
  nextAdvanceAt: number
  mutationAttempts: number
}

function unsupportedResult(
  platformCode: string,
  accountId: string,
): InventoryRefreshAutomationResult {
  return {
    platform: platformCode,
    accountId,
    outcome: 'FAILED',
    ok: false,
    status: 501,
    details: {
      message: 'Inventory automation adapter is not implemented.',
    },
  }
}

function allegroResult(
  plan: InventoryCursorAllegroPlan,
): InventoryRefreshAutomationResult {
  const totalListings = plan.batches.reduce(
    (sum, batch) => sum + batch.length,
    0,
  )

  if (plan.skippedReason) {
    return {
      platform: 'ALLEGRO',
      accountId: plan.accountId,
      outcome: 'SKIPPED',
      ok: true,
      status: 204,
      details: {
        status: 'SKIPPED',
        reason: plan.skippedReason,
      },
    }
  }

  const failedBatches = plan.completedBatches.filter(batch => !batch.ok)

  return {
    platform: 'ALLEGRO',
    accountId: plan.accountId,
    outcome: failedBatches.length === 0 ? 'SUCCESS' : 'FAILED',
    ok: failedBatches.length === 0,
    status: failedBatches[0]?.status ?? 200,
    details: {
      status: failedBatches.length === 0 ? 'SUCCESS' : 'PARTIAL_FAILURE',
      totalListings,
      batchCount: plan.batches.length,
      successfulBatches: plan.completedBatches.length - failedBatches.length,
      failedBatches: failedBatches.length,
      historyGroupId: plan.historyGroupId,
      batches: [...plan.completedBatches],
    },
  }
}

/** Shape the persisted cursor into the same results the legacy loop returns. */
export function inventoryCursorResults(
  cursor: InventoryRefreshCursor,
): InventoryRefreshAutomationResult[] {
  return cursor.plans.map(plan =>
    plan.kind === 'ALLEGRO'
      ? allegroResult(plan)
      : unsupportedResult(plan.platformCode, plan.accountId),
  )
}

/**
 * Freeze the whole plan once, at begin time.
 *
 * Batch membership must not be re-derived per slice: the
 * `enabledListings` query has no ORDER BY, so re-running it could
 * reshuffle listings between batches and skip or repeat work.
 */
export async function buildInventoryRefreshCursor(
  database: Database,
  connectionId: string,
  runId: string,
): Promise<InventoryRefreshCursor> {
  const enabledSettings = await database
    .select({
      accountId: platformAccounts.id,
      platformCode: platforms.code,
    })
    .from(platformInventorySyncSettings)
    .innerJoin(
      platformAccounts,
      eq(platformAccounts.id, platformInventorySyncSettings.accountId),
    )
    .innerJoin(
      platforms,
      eq(platforms.id, platformAccounts.platformId),
    )
    .where(
      and(
        eq(platformInventorySyncSettings.enabled, true),
        eq(platformInventorySyncSettings.triggerMode, 'INVENTORY_REFRESH'),
        eq(platformAccounts.active, true),
      ),
    )

  const plans: InventoryRefreshCursor['plans'] = []

  for (const setting of enabledSettings) {
    if (setting.platformCode !== 'ALLEGRO') {
      plans.push({
        kind: 'UNSUPPORTED',
        platformCode: setting.platformCode,
        accountId: setting.accountId,
      })
      continue
    }

    const enabledListings = await database
      .select({ listingId: platformListings.id })
      .from(platformListings)
      .innerJoin(
        listingDesiredStates,
        eq(listingDesiredStates.listingId, platformListings.id),
      )
      .where(
        and(
          eq(platformListings.accountId, setting.accountId),
          eq(platformListings.marketplace, 'allegro-hu'),
          eq(listingDesiredStates.autoStockSync, true),
        ),
      )

    const listingIds = enabledListings.map(listing => listing.listingId)
    const batches: string[][] = []

    for (let index = 0; index < listingIds.length; index += MAX_LISTINGS_PER_BATCH) {
      batches.push(listingIds.slice(index, index + MAX_LISTINGS_PER_BATCH))
    }

    plans.push({
      kind: 'ALLEGRO',
      accountId: setting.accountId,
      historyGroupId: randomUUID(),
      batches,
      batchIndex: 0,
      completedListingIds: [],
      partial: createEmptyBatchState(),
      completedBatches: [],
      skippedReason: listingIds.length === 0 ? 'NO_AUTO_STOCK_SYNC_LISTINGS' : null,
    })
  }

  return {
    version: 1,
    runId,
    connectionId,
    phase: 'AUTOMATION',
    planIndex: 0,
    plans,
    nextAdvanceAt: null,
  }
}

/**
 * Run one bounded slice.
 *
 * The slice budget lives inside `/inventory-sync` (it cannot cross
 * an in-process request boundary as an object), so this driver only
 * consumes the reported stop reason, pacing hint and processed
 * listing ids.
 */
export async function runInventoryRefreshSlice(
  connectionId: string,
  cursor: InventoryRefreshCursor,
  options: {
    executionLease: InventoryExecutionLease
    assertOwned: () => Promise<void>
    now?: () => number
  },
): Promise<InventoryRefreshSliceRunResult> {
  const now = options.now ?? Date.now
  let stopReason: InventorySliceStopReason | null = null
  let nextAdvanceAt = now()
  let mutationAttempts = 0

  while (cursor.planIndex < cursor.plans.length) {
    const plan = cursor.plans[cursor.planIndex]

    if (plan.kind === 'UNSUPPORTED' || plan.skippedReason) {
      cursor.planIndex += 1
      continue
    }

    if (plan.batchIndex >= plan.batches.length) {
      cursor.planIndex += 1
      continue
    }

    if (isCurrentBatchComplete(plan)) {
      plan.completedBatches.push(
        completeCurrentBatch(plan, { ok: true, status: 200 }),
      )
      plan.batchIndex += 1
      plan.completedListingIds = []
      plan.partial = createEmptyBatchState()
      continue
    }

    const remaining = remainingBatchListingIds(plan)

    await options.assertOwned()

    const response = await allegroAuth.request('/inventory-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildInventorySyncRequest({
          connectionId,
          listingIds: remaining,
          historyGroupId: plan.historyGroupId,
          batchIndex: plan.batchIndex + 1,
          executionLease: options.executionLease,
          executionMode: 'SLICED',
        }),
      ),
    })

    const details = (await response.json().catch(() => null)) as
      | { slice?: InventorySliceReport | null; message?: string }
      | null

    if (!response.ok || !details?.slice) {
      /*
       * No retry here: the caller surfaces the failure and the run
       * stays resumable. Never guess how far the batch got.
       */
      throw new Error(
        details?.message ??
          `Inventory slice failed with HTTP ${response.status}`,
      )
    }

    const report = details.slice

    plan.partial = mergeSliceIntoBatchState(plan.partial, report)
    plan.completedListingIds = [
      ...new Set([...plan.completedListingIds, ...report.processedListingIds]),
    ]
    mutationAttempts += report.mutationAttempts

    if (report.stopReason) {
      stopReason = report.stopReason
      nextAdvanceAt = report.nextAdvanceAt
      break
    }

    if (isCurrentBatchComplete(plan)) {
      plan.completedBatches.push(
        completeCurrentBatch(plan, { ok: true, status: 200 }),
      )
      plan.batchIndex += 1
      plan.completedListingIds = []
      plan.partial = createEmptyBatchState()
      continue
    }

    if (report.processedListingIds.length === 0) {
      // No stop reason and no progress: never spin forever.
      throw new Error('Inventory slice made no progress')
    }
  }

  const done = cursor.planIndex >= cursor.plans.length

  if (done) {
    cursor.phase = 'FINALIZE'
    cursor.nextAdvanceAt = null
    nextAdvanceAt = now()
  } else {
    cursor.nextAdvanceAt = nextAdvanceAt
  }

  return {
    cursor,
    done,
    results: inventoryCursorResults(cursor),
    stopReason,
    nextAdvanceAt,
    mutationAttempts,
  }
}
