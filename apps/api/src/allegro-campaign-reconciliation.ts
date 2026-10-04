// Unknown/missing remote evidence must never reopen a terminal campaign.
export function campaignRejection(status: string, reasons: unknown[]) {
  return status === 'DECLINED'
    ? reasons.length ? JSON.stringify(reasons) : 'Allegro declined the campaign badge'
    : null
}

export function reconciledBadgeStatus(local: string | null, remote: string | undefined) {
  if (remote && ['ACTIVE', 'IN_VERIFICATION', 'WAITING_FOR_PUBLICATION', 'FINISHED', 'DECLINED'].includes(remote)) {
    return remote
  }
  return local === 'FINISHED' ? 'FINISHED' : 'AWAITING_BADGE'
}

export async function refreshCampaignListingPublication(
  offerId: string,
  localStatus: string | null,
  readOffer: (offerId: string) => Promise<{ publication?: { status?: string } }>,
  persistActive: () => Promise<void>,
) {
  if (localStatus !== 'ENDED' && localStatus !== 'INACTIVE') return
  const offer = await readOffer(offerId)
  if (offer.publication?.status === 'ACTIVE') await persistActive()
}
