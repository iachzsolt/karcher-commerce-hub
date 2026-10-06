/**
 * Desired-stock edits must never change stock-lock ownership.
 * Only the explicit stock-lock control (PATCH .../stock-lock)
 * may toggle the lock. A manual stock edit while unlocked stays
 * unlocked; while locked stays locked. The existing auto-pause
 * takeover (positive stock on an auto-paused listing takes
 * control and clears the pause) is preserved, but it also
 * leaves the lock untouched.
 */
export function resolveDesiredStockUpdate(
  current: { stockAutoPaused: boolean },
  desiredStock: number,
): {
  desiredStock: number
  desiredPublicationStatus?: 'ACTIVE'
  stockAutoPaused?: false
} {
  if (
    current.stockAutoPaused === true &&
    desiredStock > 0
  ) {
    return {
      desiredStock,
      desiredPublicationStatus: 'ACTIVE',
      stockAutoPaused: false,
    }
  }

  return { desiredStock }
}
