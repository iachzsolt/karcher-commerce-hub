import { InventoryRefreshError } from './inventory-refresh-api.js'

/** Durable lock implementation is injected, not an in-memory execution flag.
 * The second identity check handles a run completed between lookup and acquisition.
 */
export async function coordinateInventoryRefresh<Existing extends { triggerType: string }, Result, Lease>(input: {
  trigger: 'MANUAL' | 'SCHEDULED'
  existing: () => Promise<Existing | null>
  withLease: (action: (lease: Lease) => Promise<Existing | Result>) => Promise<Existing | Result>
  recentRun: () => Promise<{ id: string } | undefined>
  execute: (lease: Lease) => Promise<Result>
}) {
  const existingManualRun = async () => {
    if (input.trigger !== 'MANUAL') return null
    const existing = await input.existing()
    if (existing && existing.triggerType !== 'MANUAL') throw new InventoryRefreshError('Run ID belongs to a scheduled execution', 409)
    return existing
  }
  const existing = await existingManualRun()
  if (existing) return existing
  return input.withLease(async lease => {
    const completedDuringAcquisition = await existingManualRun()
    if (completedDuringAcquisition) return completedDuringAcquisition
    const recent = await input.recentRun()
    if (recent) throw new InventoryRefreshError(`Recent unfinished inventory run: ${recent.id}`, 409)
    return input.execute(lease)
  })
}
