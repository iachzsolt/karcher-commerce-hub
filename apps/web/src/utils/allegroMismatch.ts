export type MismatchType = 'STOCK' | 'PRICE' | 'PUBLICATION' | 'REMOTE_DATA_UNAVAILABLE'
export type MismatchReason = {
  type: MismatchType
  field: 'stock' | 'price' | 'publication' | 'observation'
  desired: number | string | null
  remote: number | string | null
}
export type MismatchListing = {
  stockAvailable: number | null
  desiredStock: number | null
  stockAutoPaused: boolean | null
  publicationStatus: string | null
  desiredPublicationStatus: string | null
  priceMinor: number | null
}

export function effectiveAllegroStock(listing: MismatchListing) {
  return ['ENDED', 'INACTIVE'].includes(listing.publicationStatus ?? '') || listing.stockAutoPaused
    ? 0 : listing.stockAvailable
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
  compare('price', 'PRICE', effectiveDesiredPrice, listing.priceMinor)
  const intentionallyInactive = listing.desiredPublicationStatus === 'INACTIVE' && ['INACTIVE', 'ENDED'].includes(listing.publicationStatus ?? '')
  if (!intentionallyInactive) compare('stock', 'STOCK', listing.desiredStock, effectiveAllegroStock(listing))
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
