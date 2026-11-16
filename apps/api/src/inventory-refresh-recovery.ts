export type OrphanedInventoryRun = {
  status: string
  startedAt: Date
  automationDetailsJson: string | null
}

export type InventoryImportRecoveryState =
  | 'SAFE'
  | 'RUNNING'
  | 'UNKNOWN'

export function canRecoverOrphanedInventoryRun(input: {
  run: OrphanedInventoryRun
  importState: InventoryImportRecoveryState
  leaseOwned: boolean
  now: Date
  staleThresholdMs?: number
}): boolean {
  const threshold = input.staleThresholdMs ?? 30 * 60 * 1000

  if (!input.leaseOwned) return false
  if (input.run.status !== 'RUNNING') return false

  // Never discard a persisted automation cursor.
  if (input.run.automationDetailsJson !== null) return false

  const age = input.now.getTime() - input.run.startedAt.getTime()

  if (!Number.isFinite(age) || age < threshold) return false

  // An unfinished or unverified import must not be bypassed.
  if (input.importState !== 'SAFE') return false

  return true
}
