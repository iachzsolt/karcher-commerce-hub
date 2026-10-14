export const INACTIVE_PUBLICATION_STALE_MS = 15 * 60 * 1000

/** Bounded freshness may select apparently compliant inactive offers too. */
export function needsInactivePublicationVerification(listing: {
  offerId: string
  desiredPublicationStatus: string | null
  publicationStatus: string | null
  publicationObservedAt?: string | null
  lastSyncedAt: string | null
}, now = Date.now()) {
  if (listing.desiredPublicationStatus !== 'INACTIVE' ||
    !['ENDED', 'INACTIVE'].includes(listing.publicationStatus ?? '') || !/^\d+$/.test(listing.offerId)) return false
  const timestamp = listing.publicationObservedAt ?? listing.lastSyncedAt
  const observed = timestamp ? new Date(timestamp).getTime() : NaN
  return !Number.isFinite(observed) || now - observed >= INACTIVE_PUBLICATION_STALE_MS
}
