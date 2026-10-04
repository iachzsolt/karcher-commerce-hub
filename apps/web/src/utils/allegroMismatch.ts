export type MismatchType = 'STOCK' | 'PRICE' | 'PUBLICATION' | 'REMOTE_DATA_UNAVAILABLE'
export type ListingStockPolicy = {
  observedStock: number | null
  desiredStock: number | null
  sellableStock: number | null
  comparison: string
  ownership: string
  stockLocked: boolean
  stockAutoPaused: boolean
  autoStockSync: boolean
  duplicateOfferCount: number
  automationGuards: string[]
}
/** Derived by the API's canonical resolver; the web does not resolve precedence. */
export type ListingPricePolicy = {
  expectedPriceMinor: number | null
  observedPriceMinor: number | null
  source: 'BASE' | 'SCHEDULE' | 'CAMPAIGN_POLICY' | 'LOCKED_PRICE' | 'UNKNOWN'
  comparison: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE'
  writeAllowed: boolean
  automaticWriteAllowed: boolean
  reason: string
  computedAt: string
  nextTransitionAt: string | null
}
export type MismatchReason = {
  type: MismatchType
  field: 'stock' | 'price' | 'publication' | 'observation'
  desired: number | string | null
  remote: number | string | null
  source?: ListingPricePolicy['source']
  policyReason?: string
  stock?: { locked: boolean | null; autoSync: boolean | null; duplicateGuard: boolean | null; autoPaused: boolean }
}
export type MismatchListing = {
  stockAvailable: number | null
  desiredStock: number | null
  stockAutoPaused: boolean | null
  publicationStatus: string | null
  desiredPublicationStatus: string | null
  priceMinor: number | null
  pricePolicy?: ListingPricePolicy | null
  stockPolicy?: ListingStockPolicy | null
  stockLocked?: boolean | null
  autoStockSync?: boolean | null
  duplicateOfferCount?: number
}

export function effectiveAllegroStock(listing: MismatchListing) {
  if (listing.stockPolicy) return listing.stockPolicy.sellableStock
  return listing.publicationStatus === 'ACTIVE' ? listing.stockAvailable
    : ['ENDED', 'INACTIVE', 'ACTIVATING'].includes(listing.publicationStatus ?? '') ? 0 : null
}

export function evaluateAllegroMismatch(
  listing: MismatchListing,
  effectiveDesiredPrice: number | null,
  unavailable = false,
) {
  const reasons: MismatchReason[] = []
  const compare = (field: MismatchReason['field'], type: MismatchType, desired: number | string | null, remote: number | string | null) => {
    if (desired === null) return
    if (remote === null || remote === 'UNKNOWN') reasons.push({ type: 'REMOTE_DATA_UNAVAILABLE', field, desired, remote })
    else if (desired !== remote) reasons.push({ type, field, desired, remote })
  }
  if ('pricePolicy' in listing) {
    const policy = listing.pricePolicy
    if (!policy || policy.comparison === 'UNAVAILABLE') {
      reasons.push({ type: 'REMOTE_DATA_UNAVAILABLE', field: 'price', desired: policy?.expectedPriceMinor ?? null,
        remote: policy?.observedPriceMinor ?? listing.priceMinor, source: policy?.source ?? 'UNKNOWN', policyReason: policy?.reason ?? 'PRICE_POLICY_UNAVAILABLE' })
    } else if (policy.comparison === 'MISMATCH') {
      reasons.push({ type: 'PRICE', field: 'price', desired: policy.expectedPriceMinor, remote: policy.observedPriceMinor,
        source: policy.source, policyReason: policy.reason })
    }
  } else {
    // Legacy callers without a policy contract (non-page comparison fixtures).
    compare('price', 'PRICE', effectiveDesiredPrice, listing.priceMinor)
  }
  const stockPolicy = listing.stockPolicy
  if (stockPolicy) {
    if (stockPolicy.comparison === 'MISMATCH' || stockPolicy.comparison === 'UNAVAILABLE') {
      compare('stock', 'STOCK', stockPolicy.desiredStock, stockPolicy.observedStock)
    }
  } else {
    const intentionallyInactive = listing.desiredPublicationStatus === 'INACTIVE' && ['INACTIVE', 'ENDED'].includes(listing.publicationStatus ?? '')
    if (!intentionallyInactive) compare('stock', 'STOCK', listing.desiredStock, listing.stockAvailable)
  }
  for (const reason of reasons) {
    if (reason.field === 'stock') reason.stock = {
      locked: stockPolicy?.stockLocked ?? listing.stockLocked ?? null,
      autoSync: stockPolicy?.autoStockSync ?? listing.autoStockSync ?? null,
      duplicateGuard: stockPolicy ? stockPolicy.duplicateOfferCount > 1 : listing.duplicateOfferCount === undefined ? null : listing.duplicateOfferCount > 1,
      autoPaused: stockPolicy?.stockAutoPaused ?? listing.stockAutoPaused ?? false,
    }
  }
  const desired = listing.desiredPublicationStatus
  if (desired === 'ACTIVE' || desired === 'INACTIVE') {
    const matches = desired === 'ACTIVE'
      ? ['ACTIVE', 'ACTIVATING'].includes(listing.publicationStatus ?? '')
      : ['INACTIVE', 'ENDED'].includes(listing.publicationStatus ?? '')
    if (!matches) compare('publication', 'PUBLICATION', desired, listing.publicationStatus)
  }
  if (unavailable) reasons.push({ type: 'REMOTE_DATA_UNAVAILABLE', field: 'observation', desired: null, remote: null })
  return { hasDifference: reasons.length > 0, reasons }
}

/** Re-observe before every DB read; never resend the original mutation. */
export async function convergeAllegroListings<T>(options: {
  targets: string[]
  reconcile: (ids: string[]) => Promise<void>
  reload: () => Promise<T[]>
  matches: (rows: T[], id: string) => boolean
  wait: () => Promise<void>
  attempts: number
}) {
  let open = [...options.targets]
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    if (attempt) await options.wait()
    try {
      await options.reconcile(open)
      const rows = await options.reload()
      open = open.filter(id => !options.matches(rows, id))
      if (!open.length) return { converged: true }
    } catch {
      // Failure cannot prove convergence. Keep targets for the bounded retry.
    }
  }
  return { converged: false }
}
