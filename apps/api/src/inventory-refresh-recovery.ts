import { readInventoryRefreshCursorState } from './inventory-refresh-slice.js'

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

  // A run with a valid, resumable cursor belongs to the sliced
  // workflow and may still have in-flight state the resume scheduler
  // should advance — never recover it.
  //
  // A run whose automationDetailsJson is NULL, empty, corrupt, or
  // contains legacy diagnostics (version + platforms) without a
  // cursor key is NOT resumable. The resume scheduler already skips
  // it (NO_CURSOR or CORRUPT_CURSOR), so it can only be unblocked
  // by recovery.
  const cursorState = readInventoryRefreshCursorState(
    input.run.automationDetailsJson,
  )
  if (cursorState.kind === 'ok') return false

  const age = input.now.getTime() - input.run.startedAt.getTime()

  if (!Number.isFinite(age) || age < threshold) return false

  // An unfinished or unverified import must not be bypassed.
  if (input.importState !== 'SAFE') return false

  return true
}
