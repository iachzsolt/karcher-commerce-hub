export type StockPolicyInput = {
  observedStock: number | null
  desiredStock: number | null
  publicationStatus: string | null
  desiredPublicationStatus: string | null
  stockAutoPaused: boolean
  stockLocked: boolean
  autoStockSync: boolean
  duplicateOfferCount: number
}

/** Quantity equality, sellability and ownership are independent concepts. */
export function observedStockMatches(desired: number | null, observed: number | null) {
  return desired !== null && observed !== null && desired === observed
}

export function compareObservedStock(desired: number | null, observed: number | null, desiredPublication: string | null, publication: string | null) {
  if (desiredPublication === 'INACTIVE' && ['ENDED', 'INACTIVE'].includes(publication ?? '')) return 'SUPPRESSED'
  if (desired === null) return 'NOT_CONFIGURED'
  if (observed === null) return 'UNAVAILABLE'
  return observedStockMatches(desired, observed) ? 'MATCH' : 'MISMATCH'
}

export function resolveAllegroStockPolicy(input: StockPolicyInput) {
  const intentionallyInactive = input.desiredPublicationStatus === 'INACTIVE' &&
    ['ENDED', 'INACTIVE'].includes(input.publicationStatus ?? '')
  const rawMatches = observedStockMatches(input.desiredStock, input.observedStock)
  const comparison = compareObservedStock(input.desiredStock, input.observedStock, input.desiredPublicationStatus, input.publicationStatus)
  return {
    ...input,
    rawMatches,
    comparison,
    sellableStock: input.publicationStatus === 'ACTIVE' ? input.observedStock
      : ['ENDED', 'INACTIVE', 'ACTIVATING'].includes(input.publicationStatus ?? '') ? 0 : null,
    ownership: !input.stockAutoPaused ? 'NONE'
      : intentionallyInactive ? 'AUTO_PAUSED'
      : input.publicationStatus === 'ACTIVATING' ? 'PENDING' : 'UNRESOLVED',
    automationGuards: [
      ...(input.stockLocked ? ['MANUAL_STOCK_LOCK'] : []),
      ...(!input.autoStockSync ? ['AUTO_STOCK_SYNC_DISABLED'] : []),
      ...(input.duplicateOfferCount > 1 ? ['DUPLICATE_SKU'] : []),
    ],
  }
}

export type OwnershipEvent = { id: string; action: string | null; status: string | null; occurredAt: Date }
export function evaluateAutoPauseOwnership(input: StockPolicyInput, latest: OwnershipEvent | null, authoritative: boolean, desiredUpdatedAt?: Date) {
  if (!input.stockAutoPaused) return { clear: false, reason: 'NOT_AUTOMATION_OWNED' }
  if (latest && ['PENDING', 'REACTIVATION_IN_PROGRESS'].includes(latest.status ?? '')) return { clear: false, reason: 'TRANSITION_PENDING' }
  if (input.stockLocked || !input.autoStockSync || input.duplicateOfferCount !== 1) return { clear: false, reason: 'AUTOMATION_GUARD' }
  if (!authoritative || input.publicationStatus !== 'ACTIVE' || input.desiredPublicationStatus !== 'ACTIVE' ||
      input.desiredStock === null || input.desiredStock <= 0 || input.observedStock !== input.desiredStock) {
    return { clear: false, reason: 'OWNERSHIP_UNRESOLVED' }
  }
  if (latest?.status !== 'SUCCESS' || !['ACTIVATE', 'STOCK_UPDATE_AND_ACTIVATE', 'REACTIVATION_CONFIRMED', 'STOCK_UPDATE_AND_REACTIVATION_CONFIRMED'].includes(latest.action ?? '')) {
    return { clear: false, reason: 'NO_COMPLETED_REACTIVATION_EVIDENCE' }
  }
  if (desiredUpdatedAt && latest.occurredAt.getTime() < desiredUpdatedAt.getTime()) {
    return { clear: false, reason: 'INTENT_CHANGED_SINCE_EVIDENCE' }
  }
  return { clear: true, reason: 'CONFIRMED_REACTIVATION_OBSERVED' }
}
