import {
  and,
  eq,
} from 'drizzle-orm'

import {
  createDatabase,
  dataConnections,
  platformAccounts,
  platformInventorySyncSettings,
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
              }),
          },
        )

      const details =
        await response
          .json()
          .catch(() => null)

      results.push({
        platform: 'ALLEGRO',
        accountId:
          setting.accountId,
        ok:
          response.ok,
        status:
          response.status,
        details,
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