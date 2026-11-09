import { and, eq, gt } from 'drizzle-orm'
import { createDatabase, schedulerLeases } from '@karcher-commerce-hub/database'

export type InventoryExecutionLease = { name: string; ownerId: string }
export const inventoryExecutionLeaseName = (connectionId: string) => `inventory-refresh:${connectionId}`

/** Check the same durable lease at batch/write boundaries. Never refresh it here. */
export async function assertInventoryExecutionLeaseOwned(
  database: ReturnType<typeof createDatabase>,
  lease: InventoryExecutionLease,
) {
  const [owned] = await database.select({ ownerId: schedulerLeases.ownerId }).from(schedulerLeases)
    .where(and(eq(schedulerLeases.name, lease.name), eq(schedulerLeases.ownerId, lease.ownerId), gt(schedulerLeases.lockedUntil, new Date()))).limit(1)
  if (!owned) throw new Error('Inventory execution lease lost; no further writes permitted')
}

/** Check the same durable lease at batch/write boundaries. Never refresh it here. */
export async function assertInventoryExecutionLease(
  database: ReturnType<typeof createDatabase>,
  connectionId: string,
  lease: InventoryExecutionLease,
) {
  if (lease.name !== inventoryExecutionLeaseName(connectionId)) throw new Error('Inventory execution lease scope mismatch')
  await assertInventoryExecutionLeaseOwned(database, lease)
}
