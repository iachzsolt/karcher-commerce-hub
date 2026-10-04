/** Generic discard preserves manual stock ownership. Unlocking is a separate action. */
export function resolveDiscardStock(input: {
  stockLocked: boolean
  desiredStock: number | null
  hasInventorySource: boolean
  sourceStock: number | undefined
  stockAutoPaused: boolean
  remoteStock: number | null
}): number | null {
  if (input.stockLocked) return input.desiredStock
  if (input.hasInventorySource) return input.sourceStock ?? 0
  if (input.stockAutoPaused) return 0
  return input.remoteStock ?? input.desiredStock
}
