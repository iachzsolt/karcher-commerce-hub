import {
  and,
  eq,
} from 'drizzle-orm'

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

type Database =
  ReturnType<typeof createDatabase>

export type InventoryRefreshAutomationResult = {
  platform: string
  accountId: string
  ok: boolean
  status: number
  details: unknown
}

export async function runInventoryRefreshAutomations(
  database: Database,
  connectionId: string,
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

      for (
        let batchIndex = 0;
        batchIndex < batches.length;
        batchIndex++
      ) {
        const batch =
          batches[batchIndex]

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
                JSON.stringify({
                  confirm: true,
                  connectionId,
                  listingIds: batch,
                }),
            },
          )

        const details =
          await response
            .json()
            .catch(() => null)

        batchResults.push({
          batchNumber:
            batchIndex + 1,
          listingCount:
            batch.length,
          ok:
            response.ok,
          status:
            response.status,
          details,
        })
      }

      const failedBatches =
        batchResults.filter(
          (batch) => !batch.ok,
        )

      results.push({
        platform: 'ALLEGRO',
        accountId:
          setting.accountId,
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
