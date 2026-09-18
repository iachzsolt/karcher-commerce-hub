import {
  and,
  desc,
  eq,
  inArray,
} from 'drizzle-orm'

import {
  allegroChangeEvents,
  createDatabase,
  dataConnections,
  inventorySourceItems,
  listingDesiredStates,
  listingRemoteStates,
  platformListings,
  platforms,
  products,
} from '@karcher-commerce-hub/database'

import {
  extractFailedInventoryListingDiagnostic,
} from './inventory-automation-diagnostics.js'

type Database =
  ReturnType<typeof createDatabase>

export type AllegroInventorySyncRow = {
  sku: string
  listingId: string
  offerId: string | null

  targetStock: number | null
  remoteStock: number | null
  desiredStock: number | null

  stockLocked: boolean
  stockAutoPaused: boolean

  publicationStatus:
    string | null

  desiredPublicationStatus:
    string

  duplicateOfferCount: number

  sourceMissing: boolean
}

type ResolveInventoryInput = {
  connectionId: string
  accountId: string
}

export async function resolveAllegroInventoryRows(
  database: Database,
  input: ResolveInventoryInput,
) {
  const [connection] =
    await database
      .select({
        id: dataConnections.id,
        name: dataConnections.name,
        isActive:
          dataConnections.isActive,
      })
      .from(dataConnections)
      .where(
        and(
          eq(
            dataConnections.id,
            input.connectionId,
          ),
          eq(
            dataConnections.purpose,
            'INVENTORY',
          ),
        ),
      )
      .limit(1)

  if (!connection) {
    return {
      ok: false as const,
      reason:
        'INVENTORY_CONNECTION_NOT_FOUND',
    }
  }

  const inventoryItems =
    await database
      .select({
        sku:
          inventorySourceItems.sku,
        stock:
          inventorySourceItems.stock,
      })
      .from(inventorySourceItems)
      .where(
        eq(
          inventorySourceItems.connectionId,
          input.connectionId,
        ),
      )

  const listings =
    await database
      .select({
        listingId:
          platformListings.id,

        offerId:
          platformListings
            .externalListingId,

        sku:
          products.sku,

        remoteStock:
          listingRemoteStates
            .stockAvailable,

        desiredStock:
          listingDesiredStates
            .desiredStock,

        stockLocked:
          listingDesiredStates
            .stockLocked,

        stockAutoPaused:
          listingDesiredStates
            .stockAutoPaused,

        publicationStatus:
          listingRemoteStates
            .publicationStatus,

        desiredPublicationStatus:
          listingDesiredStates
            .desiredPublicationStatus,
      })
      .from(platformListings)
      .innerJoin(
        products,
        eq(
          platformListings.productId,
          products.id,
        ),
      )
      .innerJoin(
        platforms,
        eq(
          platformListings.platformId,
          platforms.id,
        ),
      )
      .leftJoin(
        listingRemoteStates,
        eq(
          listingRemoteStates.listingId,
          platformListings.id,
        ),
      )
      .leftJoin(
        listingDesiredStates,
        eq(
          listingDesiredStates.listingId,
          platformListings.id,
        ),
      )
      .where(
        and(
          eq(
            platforms.code,
            'ALLEGRO',
          ),
          eq(
            platformListings.marketplace,
            'allegro-hu',
          ),
          eq(
            platformListings.accountId,
            input.accountId,
          ),
        ),
      )

  const inventoryBySku =
    new Map(
      inventoryItems.map(
        (item) => [
          item.sku,
          item.stock,
        ],
      ),
    )

  const listingCountBySku =
    new Map<string, number>()

  for (const listing of listings) {
    listingCountBySku.set(
      listing.sku,
      (
        listingCountBySku.get(
          listing.sku,
        ) ?? 0
      ) + 1,
    )
  }

  const rows:
    AllegroInventorySyncRow[] =
    listings.map(
      (listing) => {
        const sourceStock =
          inventoryBySku.get(
            listing.sku,
          )

        const sourceMissing =
          sourceStock === undefined

        /*
         * Prioritás:
         *
         * 1. Manuális készletrögzítés.
         * 2. Központi készlet.
         * 3. Hiányzó SKU -> 0.
         */
        const targetStock =
          listing.stockLocked
            ? listing.desiredStock
            : sourceMissing
              ? 0
              : sourceStock

        return {
          sku:
            listing.sku,

          listingId:
            listing.listingId,

          offerId:
            listing.offerId,

          targetStock,

          remoteStock:
            listing.remoteStock,

          desiredStock:
            listing.desiredStock,

          stockLocked:
            listing.stockLocked ??
            false,

          stockAutoPaused:
            listing.stockAutoPaused ??
            false,

          publicationStatus:
            listing.publicationStatus,

          desiredPublicationStatus:
            listing
              .desiredPublicationStatus ??
            'UNKNOWN',

          duplicateOfferCount:
            listingCountBySku.get(
              listing.sku,
            ) ?? 1,

          sourceMissing,
        }
      },
    )

  return {
    ok: true as const,

    connection,

    summary: {
      inventorySkuCount:
        inventoryItems.length,

      allegroListingCount:
        listings.length,

      missingSourceCount:
        rows.filter(
          (row) =>
            row.sourceMissing,
        ).length,

      lockedCount:
        rows.filter(
          (row) =>
            row.stockLocked,
        ).length,

      duplicateSkuCount:
        [...listingCountBySku.values()]
          .filter(
            (count) =>
              count > 1,
          )
          .length,
    },

    rows,
  }
}
export async function applyAllegroDesiredStock(
  database: Database,
  rows: AllegroInventorySyncRow[],
) {
  let updated = 0
  let unchanged = 0
  let missingSource = 0
  let locked = 0
  let duplicateSkuSkipped = 0
  let remoteStockUnknown = 0
  let missingDesiredState = 0

  const results: Array<{
    sku: string
    listingId: string
    offerId: string | null
    previousDesiredStock: number | null
    newDesiredStock: number | null
    status: string
  }> = []

  for (const row of rows) {
    /*
     * 1. Manuálisan rögzített készlet.
     */
    if (row.stockLocked) {
      locked += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.desiredStock,
        status: 'LOCKED',
      })

      continue
    }

    /*
     * 2. Duplikált Allegro SKU.
     */
    if (row.duplicateOfferCount > 1) {
      duplicateSkuSkipped += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.targetStock,
        status:
          'DUPLICATE_SKU_SKIPPED',
      })

      continue
    }

    /*
     * 3. A SKU nincs a központi készletben.
     * Biztonságos célérték: 0.
     *
     * Ez szándékosan megelőzi a remoteStock
     * ellenőrzését, ugyanúgy, mint a régi
     * működő logikában.
     */
    if (row.sourceMissing) {
      missingSource += 1

      if (row.desiredStock === 0) {
        unchanged += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          offerId: row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock: 0,
          status:
            'MISSING_SOURCE_ZERO_NO_CHANGE',
        })

        continue
      }

      const [updatedRow] =
        await database
          .update(
            listingDesiredStates,
          )
          .set({
            desiredStock: 0,
            updatedBy:
              'COMMERCE_HUB_INVENTORY',
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )
          .returning({
            listingId:
              listingDesiredStates.listingId,
          })

      if (!updatedRow) {
        missingDesiredState += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          offerId: row.offerId,
          previousDesiredStock:
            row.desiredStock,
          newDesiredStock: 0,
          status:
            'MISSING_DESIRED_STATE',
        })

        continue
      }

      updated += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock: 0,
        status:
          'MISSING_SOURCE_ZERO_APPLIED',
      })

      continue
    }

    /*
     * 4. Ismeretlen Allegro remote készlet:
     * egyelőre nem automatizálunk.
     */
    if (row.remoteStock === null) {
      remoteStockUnknown += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.targetStock,
        status:
          'REMOTE_STOCK_UNKNOWN',
      })

      continue
    }

    if (
      row.desiredStock ===
      row.targetStock
    ) {
      unchanged += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.targetStock,
        status: 'NO_CHANGE',
      })

      continue
    }

    const [updatedRow] =
      await database
        .update(
          listingDesiredStates,
        )
        .set({
          desiredStock:
            row.targetStock,
          updatedBy:
            'COMMERCE_HUB_INVENTORY',
          updatedAt: new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )
        .returning({
          listingId:
            listingDesiredStates.listingId,
        })

    if (!updatedRow) {
      missingDesiredState += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        offerId: row.offerId,
        previousDesiredStock:
          row.desiredStock,
        newDesiredStock:
          row.targetStock,
        status:
          'MISSING_DESIRED_STATE',
      })

      continue
    }

    updated += 1

    results.push({
      sku: row.sku,
      listingId: row.listingId,
      offerId: row.offerId,
      previousDesiredStock:
        row.desiredStock,
      newDesiredStock:
        row.targetStock,
      status: 'UPDATED',
    })
  }

  return {
    summary: {
      updated,
      unchanged,
      missingSource,
      locked,
      duplicateSkuSkipped,
      remoteStockUnknown,
      missingDesiredState,
    },
    results,
  }
}
export type AllegroInventoryActionResult = {
  ok: boolean
  status: number
  details: {
    status?: string
    message?: string
  } | null
}

export type AllegroInventoryAdapter = {
  pushStock:
    (
      listingId: string,
    ) => Promise<AllegroInventoryActionResult>

  pushStatus:
    (
      listingId: string,
    ) => Promise<AllegroInventoryActionResult>

  refresh:
    (listingIds?: string[]) => Promise<{
      ok: boolean
      details: unknown
    }>
}

export type OpenPendingSyncEvent = {
  listingId: string
  action: string
  status: string
  publicationStatus: string | null
  targetStock: number | null
  remoteStock: number | null
  fromStock: number | null
  toStock: number | null
  occurredAt: string
}

export type ReconciliationRemoteState = {
  remoteStock: number | null
  publicationStatus: string | null
  targetStock: number | null
}

/*
 * A SYNC automation event is terminal unless Allegro is
 * still processing the accepted command.
 */
export function isTerminalInventorySyncStatus(
  status: string,
): boolean {
  return (
    status !== 'PENDING' &&
    status !== 'REACTIVATION_IN_PROGRESS'
  )
}

function isEndedPublicationStatus(
  status: string | null,
): boolean {
  return (
    status === 'ENDED' ||
    status === 'INACTIVE'
  )
}

function asFiniteNumber(
  value: number | null,
): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value)
    ? value
    : null
}

/*
 * Pure reconciliation decision for one still-open PENDING
 * automation event.
 *
 * Compares the intended target captured at write time with
 * the current remote state read back through the existing
 * safe mechanism (listingRemoteStates, refreshed by the
 * adapter after every automation run). When the remote
 * state already satisfies the intent, returns a terminal
 * SUCCESS event insert — never a new Allegro write.
 *
 * Returns null while the remote state does not yet match
 * (genuinely still processing) or when there is no
 * reliable match evidence. FAILED is never fabricated
 * here: absence of a match is not failure evidence.
 */
export function reconcilePendingSyncEvent(
  event: OpenPendingSyncEvent,
  current: ReconciliationRemoteState,
  nowIso: string,
): {
  listingId: string
  eventType: 'SYNC'
  source: 'INVENTORY_AUTOMATION'
  oldValue: string
  newValue: 'SUCCESS'
  metadataJson: string
  occurredAt: Date
} | null {
  if (isTerminalInventorySyncStatus(event.status)) {
    return null
  }

  const confirm = (
    action: string,
    metadata: Record<string, unknown>,
  ) => ({
    listingId: event.listingId,
    eventType: 'SYNC' as const,
    source: 'INVENTORY_AUTOMATION' as const,
    oldValue: action,
    newValue: 'SUCCESS' as const,
    metadataJson: JSON.stringify({
      ...metadata,
      reconciled: true,
      supersedesOccurredAt: event.occurredAt,
    }),
    occurredAt: new Date(nowIso),
  })

  if (event.action === 'STOCK_UPDATE') {
    const target =
      asFiniteNumber(event.toStock) ??
      asFiniteNumber(event.targetStock)
    const remote = asFiniteNumber(
      current.remoteStock,
    )

    if (
      target === null ||
      remote === null ||
      remote !== target
    ) {
      return null
    }

    return confirm('STOCK_UPDATE', {
      publicationStatus:
        current.publicationStatus,
      targetStock: target,
      remoteStock: remote,
      fromStock:
        asFiniteNumber(event.fromStock) ??
        asFiniteNumber(event.remoteStock) ??
        remote,
      toStock: target,
      confirmedRemoteStock: remote,
    })
  }

  if (event.action === 'END') {
    if (
      !isEndedPublicationStatus(
        current.publicationStatus,
      )
    ) {
      return null
    }

    return confirm('END', {
      publicationStatus:
        current.publicationStatus,
      targetStock: asFiniteNumber(
        event.targetStock,
      ),
      remoteStock: asFiniteNumber(
        current.remoteStock,
      ),
      fromStock:
        asFiniteNumber(event.fromStock) ??
        asFiniteNumber(event.remoteStock),
      toStock:
        asFiniteNumber(event.toStock) ??
        asFiniteNumber(event.targetStock) ??
        0,
      confirmedPublicationStatus:
        current.publicationStatus,
    })
  }

  if (event.action === 'ACTIVATE') {
    if (
      current.publicationStatus !== 'ACTIVE'
    ) {
      return null
    }

    return confirm('ACTIVATE', {
      publicationStatus:
        current.publicationStatus,
      targetStock: asFiniteNumber(
        event.targetStock,
      ),
      remoteStock: asFiniteNumber(
        current.remoteStock,
      ),
      confirmedPublicationStatus:
        current.publicationStatus,
    })
  }

  if (
    event.action === 'NONE' &&
    event.status === 'REACTIVATION_IN_PROGRESS'
  ) {
    if (
      current.publicationStatus !== 'ACTIVE'
    ) {
      return null
    }

    return confirm('REACTIVATION_CONFIRMED', {
      publicationStatus:
        current.publicationStatus,
      confirmedPublicationStatus:
        current.publicationStatus,
    })
  }

  return null
}

/*
 * Closes stale PENDING automation events whose intent the
 * remote state already satisfies. Runs at the start of
 * every inventory sync using the already-resolved remote
 * states — no new Allegro reads, no Allegro writes, no
 * desired-state changes. Insert-only and idempotent: an
 * event is only reconciled while it is still the latest
 * SYNC event of its listing, so a repeated run finds the
 * terminal confirmation and does nothing.
 */
export async function reconcileOpenPendingSyncEvents(
  database: Database,
  rows: AllegroInventorySyncRow[],
): Promise<{ reconciled: number }> {
  const listingIds = [
    ...new Set(
      rows.map((row) => row.listingId),
    ),
  ]

  if (listingIds.length === 0) {
    return { reconciled: 0 }
  }

  const rowByListingId = new Map(
    rows.map((row) => [row.listingId, row]),
  )

  let storedEvents: Array<{
    listingId: string
    oldValue: string | null
    newValue: string | null
    metadataJson: string | null
    occurredAt: Date
  }>

  try {
    storedEvents = await database
      .select({
        listingId:
          allegroChangeEvents.listingId,
        oldValue:
          allegroChangeEvents.oldValue,
        newValue:
          allegroChangeEvents.newValue,
        metadataJson:
          allegroChangeEvents.metadataJson,
        occurredAt:
          allegroChangeEvents.occurredAt,
      })
      .from(allegroChangeEvents)
      .where(
        and(
          eq(
            allegroChangeEvents.eventType,
            'SYNC',
          ),
          inArray(
            allegroChangeEvents.listingId,
            listingIds,
          ),
        ),
      )
      .orderBy(
        desc(allegroChangeEvents.occurredAt),
      )
  } catch (error) {
    console.error(
      'Allegro pending reconciliation lookup failed:',
      error,
    )

    return { reconciled: 0 }
  }

  const seenListingIds = new Set<string>()
  const nowIso = new Date().toISOString()
  const confirmations: Array<{
    listingId: string
    eventType: 'SYNC'
    source: 'INVENTORY_AUTOMATION'
    oldValue: string
    newValue: 'SUCCESS'
    metadataJson: string
    occurredAt: Date
  }> = []

  for (const stored of storedEvents) {
    if (seenListingIds.has(stored.listingId)) {
      continue
    }

    seenListingIds.add(stored.listingId)

    const status = stored.newValue ?? ''

    if (isTerminalInventorySyncStatus(status)) {
      continue
    }

    const row = rowByListingId.get(
      stored.listingId,
    )

    if (!row) {
      continue
    }

    let metadata: {
      publicationStatus?: unknown
      targetStock?: unknown
      remoteStock?: unknown
      fromStock?: unknown
      toStock?: unknown
    } | null = null

    try {
      metadata = stored.metadataJson
        ? (JSON.parse(
            stored.metadataJson,
          ) as Record<string, unknown>)
        : null
    } catch {
      metadata = null
    }

    const numberOrNull = (
      value: unknown,
    ): number | null =>
      typeof value === 'number' &&
      Number.isFinite(value)
        ? value
        : null

    const textOrNull = (
      value: unknown,
    ): string | null =>
      typeof value === 'string'
        ? value
        : null

    const confirmed =
      reconcilePendingSyncEvent(
        {
          listingId: stored.listingId,
          action: stored.oldValue ?? '',
          status,
          publicationStatus: textOrNull(
            metadata?.publicationStatus,
          ),
          targetStock: numberOrNull(
            metadata?.targetStock,
          ),
          remoteStock: numberOrNull(
            metadata?.remoteStock,
          ),
          fromStock: numberOrNull(
            metadata?.fromStock,
          ),
          toStock: numberOrNull(
            metadata?.toStock,
          ),
          occurredAt:
            stored.occurredAt.toISOString(),
        },
        {
          remoteStock: row.remoteStock,
          publicationStatus:
            row.publicationStatus,
          targetStock: row.targetStock,
        },
        nowIso,
      )

    if (confirmed) {
      confirmations.push(confirmed)
    }
  }

  if (confirmations.length > 0) {
    try {
      await database
        .insert(allegroChangeEvents)
        .values(confirmations)
    } catch (error) {
      console.error(
        'Allegro pending reconciliation logging failed:',
        error,
      )

      return { reconciled: 0 }
    }
  }

  return { reconciled: confirmations.length }
}

export async function syncAllegroInventoryRows(
  database: Database,
  rows: AllegroInventorySyncRow[],
  adapter: AllegroInventoryAdapter,
  options?: {
    historyGroupId?: string
    batchIndex?: number
  },
) {
  const results:
    Array<Record<string, unknown>> = []

  let attempted = 0
  let stockUpdated = 0
  let autoPaused = 0
  let reactivated = 0
  let unchanged = 0
  let skipped = 0
  let pending = 0
  let failed = 0

  const pendingListingIds =
    new Set<string>()

  const writtenListingIds =
    new Set<string>()

  /*
   * Close stale PENDING events whose intent the current
   * remote state already satisfies. Read-only compare
   * plus terminal event inserts — never resends writes.
   */
  await reconcileOpenPendingSyncEvents(
    database,
    rows,
  )

  for (const row of rows) {
    if (row.stockLocked) {
      skipped += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'SKIP',
        status: 'STOCK_LOCKED',
      })

      continue
    }

    if (row.duplicateOfferCount > 1) {
      skipped += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'SKIP',
        status: 'DUPLICATE_SKU',
      })

      continue
    }

    if (row.targetStock === null) {
      skipped += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'SKIP',
        status: 'TARGET_STOCK_UNKNOWN',
      })

      continue
    }

    const remoteEnded =
      row.publicationStatus === 'ENDED' ||
      row.publicationStatus === 'INACTIVE'

    const remoteActive =
      row.publicationStatus === 'ACTIVE' ||
      row.publicationStatus === 'ACTIVATING'

    /*
     * TARGET STOCK = 0
     *
     * Allegro quantity=0 nem használható,
     * ezért az ajánlatot END állapotba tesszük.
     */
    if (row.targetStock === 0) {
      if (
        row.stockAutoPaused &&
        remoteEnded
      ) {
        unchanged += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'NONE',
          status: 'ALREADY_AUTO_PAUSED',
        })

        continue
      }

      /*
       * Manuálisan vagy külsőleg leállított ajánlatot
       * nem veszünk át automatikusan.
       */
      if (
        !row.stockAutoPaused &&
        remoteEnded
      ) {
        /*
         * Explicit desired INACTIVE:
         * manuálisan leállított ajánlat.
         */
        if (
          row.desiredPublicationStatus ===
          'INACTIVE'
        ) {
          skipped += 1

          results.push({
            sku: row.sku,
            listingId: row.listingId,
            action: 'SKIP',
            status: 'MANUAL_INACTIVE',
          })

          continue
        }

        /*
         * Legacy, már leállított 0 készletes ajánlat.
         * Átvesszük auto-pause kezelésbe, hogy
         * készlet-visszatéréskor újraaktiválható legyen.
         */
        await database
          .update(
            listingDesiredStates,
          )
          .set({
            stockAutoPaused:
              true,

            desiredPublicationStatus:
              'INACTIVE',

            updatedBy:
              'COMMERCE_HUB_INVENTORY',

            updatedAt:
              new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        row.stockAutoPaused = true

        autoPaused += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'ADOPT_AUTO_PAUSE',
          status: 'SUCCESS',
        })

        continue
      }

      if (!remoteActive) {
        skipped += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status:
            'UNSUPPORTED_PUBLICATION_STATE',
          publicationStatus:
            row.publicationStatus,
        })

        continue
      }

      await database
        .update(
          listingDesiredStates,
        )
        .set({
          desiredPublicationStatus:
            'INACTIVE',

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      attempted += 1

      writtenListingIds.add(row.listingId)

      const push =
        await adapter.pushStatus(
          row.listingId,
        )

      if (push.status === 202) {
        /*
         * Az END parancs 202/PENDING esetén is
         * a Commerce Hub által kezelt auto-pause.
         * Így a későbbi készlet-visszatérés
         * automatikusan újraaktiválhatja.
         */
        await database
          .update(
            listingDesiredStates,
          )
          .set({
            stockAutoPaused:
              true,

            updatedBy:
              'COMMERCE_HUB_INVENTORY',

            updatedAt:
              new Date(),
          })
          .where(
            eq(
              listingDesiredStates.listingId,
              row.listingId,
            ),
          )

        row.stockAutoPaused = true
        autoPaused += 1

        pending += 1

        pendingListingIds.add(row.listingId)


        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'END',
          status: 'PENDING',
          details: push.details,
        })

        continue
      }

      if (
        !push.ok ||
        push.details?.status !== 'ok'
      ) {
        failed += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          offerId: row.offerId,
          action: 'END',
          status: 'FAILED',
          remoteStock: row.remoteStock,
          targetStock: row.targetStock,
          publicationStatus: row.publicationStatus,
          desiredPublicationStatus:
            'INACTIVE',
          httpStatus: push.status,
          details: push.details,
        })

        continue
      }

      await database
        .update(
          listingDesiredStates,
        )
        .set({
          stockAutoPaused:
            true,

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      autoPaused += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'END',
        status: 'SUCCESS',
      })

      continue
    }

    /*
     * TARGET STOCK > 0
     */

    if (
      !row.stockAutoPaused &&
      remoteEnded
    ) {
      /*
       * Explicit desired INACTIVE:
       * manuálisan leállított ajánlat.
       */
      if (
        row.desiredPublicationStatus ===
        'INACTIVE'
      ) {
        skipped += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'SKIP',
          status: 'MANUAL_INACTIVE',
        })

        continue
      }

      /*
       * Legacy készlethiány miatt leállt ajánlat.
       * Auto-pause kezelésbe vesszük.
       * A meglévő logika ezután frissíti a készletet
       * és ACTIVATE parancsot küld.
       */
      await database
        .update(
          listingDesiredStates,
        )
        .set({
          stockAutoPaused:
            true,

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      row.stockAutoPaused = true
    }

    if (row.remoteStock === null) {
      skipped += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'SKIP',
        status: 'REMOTE_STOCK_UNKNOWN',
      })

      continue
    }

    let stockChanged = false

    if (
      row.remoteStock !==
      row.targetStock
    ) {
      attempted += 1

      writtenListingIds.add(row.listingId)

      const push =
        await adapter.pushStock(
          row.listingId,
        )

      if (push.status === 202) {
        pending += 1

        pendingListingIds.add(row.listingId)


        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'STOCK_UPDATE',
          status: 'PENDING',
          fromStock:
            row.remoteStock,
          toStock:
            row.targetStock,
          details:
            push.details,
        })

        continue
      }

      if (
        !push.ok ||
        push.details?.status !== 'ok'
      ) {
        failed += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          offerId: row.offerId,
          action: 'STOCK_UPDATE',
          status: 'FAILED',
          fromStock:
            row.remoteStock,
          toStock:
            row.targetStock,
          remoteStock: row.remoteStock,
          targetStock: row.targetStock,
          publicationStatus: row.publicationStatus,
          desiredPublicationStatus:
            row.desiredPublicationStatus,
          httpStatus: push.status,
          details:
            push.details,
        })

        continue
      }

      stockChanged = true
      stockUpdated += 1
    }

    /*
     * Csak a Commerce Hub által korábban
     * automatikusan leállított ajánlatot
     * aktiváljuk újra.
     */
    /*
     * Az Allegro publikációs parancsa aszinkron lehet.
     * Ha egy korábbi ACTIVATE időközben már befejeződött,
     * csak a Commerce Hub belső auto-pause állapotát
     * kell lezárnunk. Új ACTIVATE parancsot nem küldünk.
     */
    if (
      row.stockAutoPaused &&
      row.publicationStatus === 'ACTIVE'
    ) {
      await database
        .update(
          listingDesiredStates,
        )
        .set({
          stockAutoPaused:
            false,

          desiredPublicationStatus:
            'ACTIVE',

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      reactivated += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,

        action:
          stockChanged
            ? 'STOCK_UPDATE_AND_REACTIVATION_CONFIRMED'
            : 'REACTIVATION_CONFIRMED',

        status: 'SUCCESS',
        ...(stockChanged
          ? {
              fromStock: row.remoteStock,
              toStock: row.targetStock,
            }
          : {}),
      })

      continue
    }

    /*
     * Az Allegro még dolgozik a korábban elküldött
     * ACTIVATE parancson. Nem küldünk rá még egyet.
     */
    if (
      row.stockAutoPaused &&
      row.publicationStatus === 'ACTIVATING'
    ) {
      pending += 1

        pendingListingIds.add(row.listingId)


      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'NONE',
        status: 'REACTIVATION_IN_PROGRESS',
      })

      continue
    }

    if (row.stockAutoPaused) {
      await database
        .update(
          listingDesiredStates,
        )
        .set({
          desiredPublicationStatus:
            'ACTIVE',

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      attempted += 1

      writtenListingIds.add(row.listingId)

      const push =
        await adapter.pushStatus(
          row.listingId,
        )

      if (push.status === 202) {
        pending += 1

        pendingListingIds.add(row.listingId)


        results.push({
          sku: row.sku,
          listingId: row.listingId,
          action: 'ACTIVATE',
          status: 'PENDING',
          stockUpdated:
            stockChanged,
          details:
            push.details,
        })

        continue
      }

      if (
        !push.ok ||
        push.details?.status !== 'ok'
      ) {
        failed += 1

        results.push({
          sku: row.sku,
          listingId: row.listingId,
          offerId: row.offerId,
          action: 'ACTIVATE',
          status: 'FAILED',
          stockUpdated:
            stockChanged,
          remoteStock: row.remoteStock,
          targetStock: row.targetStock,
          publicationStatus: row.publicationStatus,
          desiredPublicationStatus:
            'ACTIVE',
          httpStatus: push.status,
          details:
            push.details,
        })

        continue
      }

      await database
        .update(
          listingDesiredStates,
        )
        .set({
          stockAutoPaused:
            false,

          updatedBy:
            'COMMERCE_HUB_INVENTORY',

          updatedAt:
            new Date(),
        })
        .where(
          eq(
            listingDesiredStates.listingId,
            row.listingId,
          ),
        )

      reactivated += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,

        action:
          stockChanged
            ? 'STOCK_UPDATE_AND_ACTIVATE'
            : 'ACTIVATE',

        status: 'SUCCESS',
        ...(stockChanged
          ? {
              fromStock: row.remoteStock,
              toStock: row.targetStock,
            }
          : {}),
      })

      continue
    }

    if (stockChanged) {
      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'STOCK_UPDATE',
        status: 'SUCCESS',
        fromStock:
          row.remoteStock,
        toStock:
          row.targetStock,
      })
    } else {
      unchanged += 1

      results.push({
        sku: row.sku,
        listingId: row.listingId,
        action: 'NONE',
        status: 'NO_CHANGE',
      })
    }
  }

  const rowByListingId = new Map(
    rows.map((row) => [row.listingId, row]),
  )
  const syncOccurredAt = new Date()
  const syncEvents = results.flatMap((result) => {
    const listingId =
      typeof result.listingId === 'string'
        ? result.listingId
        : null
    const action =
      typeof result.action === 'string'
        ? result.action
        : 'UNKNOWN'
    const status =
      typeof result.status === 'string'
        ? result.status
        : 'UNKNOWN'
    const failedDiagnostic =
      extractFailedInventoryListingDiagnostic(
        result,
        {
          historyGroupId:
            options?.historyGroupId,
          batchIndex:
            options?.batchIndex,
        },
      )

    if (!listingId) return []

    const row = rowByListingId.get(listingId)

    return [
      {
        listingId,
        eventType: 'SYNC',
        source: 'INVENTORY_AUTOMATION',
        oldValue: action,
        newValue: status,
        metadataJson: JSON.stringify({
          historyGroupId:
            options?.historyGroupId ?? null,
          publicationStatus:
            row?.publicationStatus ?? null,
          targetStock: row?.targetStock ?? null,
          remoteStock: row?.remoteStock ?? null,
          fromStock:
            typeof result.fromStock === 'number'
              ? result.fromStock
              : null,
          toStock:
            typeof result.toStock === 'number'
              ? result.toStock
              : null,
          ...(failedDiagnostic ?? {}),
        }),
        occurredAt: syncOccurredAt,
      },
    ]
  })

  if (syncEvents.length > 0) {
    await database
      .insert(allegroChangeEvents)
      .values(syncEvents)
      .catch((error) => {
        console.error(
          'Allegro inventory history logging failed:',
          error,
        )
      })
  }

  let refreshStatus =
    'not-needed'

  let refreshDetails:
    unknown = null

  if (attempted > 0) {
    const initialRefresh =
      await adapter.refresh(
        [...writtenListingIds],
      )

    refreshStatus =
      initialRefresh.ok
        ? 'success'
        : 'failed'

    refreshDetails =
      initialRefresh.details

    const delayedRefreshListingIds =
      new Set([
        ...pendingListingIds,
        ...writtenListingIds,
      ])

    if (
      initialRefresh.ok &&
      delayedRefreshListingIds.size > 0
    ) {
      await new Promise<void>(
        (resolve) => {
          setTimeout(resolve, 4000)
        },
      )

      const delayedRefresh =
        await adapter.refresh(
          [...delayedRefreshListingIds],
        )

      refreshStatus =
        delayedRefresh.ok
          ? 'success'
          : 'failed'

      refreshDetails = {
        initial:
          initialRefresh.details,
        delayedWriteRefresh: {
          listingCount:
            delayedRefreshListingIds.size,
          pendingListingCount:
            pendingListingIds.size,
          writtenListingCount:
            writtenListingIds.size,
          ok:
            delayedRefresh.ok,
          details:
            delayedRefresh.details,
        },
      }
    }
  }

  return {
    summary: {
      selected:
        rows.length,

      attempted,
      stockUpdated,
      autoPaused,
      reactivated,
      unchanged,
      skipped,
      pending,
      failed,
    },

    refresh: {
      status:
        refreshStatus,

      details:
        refreshDetails,
    },

    results,
  }
}
