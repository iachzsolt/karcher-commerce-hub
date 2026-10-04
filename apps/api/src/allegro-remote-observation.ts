export type AllegroObservedOffer = {
  id?: string
  publication?: { status?: string; marketplaces?: { base?: { id?: string } } }
  stock?: { available?: number }
  sellingMode?: { price?: { amount?: string; currency?: string } }
  additionalMarketplaces?: Record<string, { sellingMode?: { price?: { amount?: string; currency?: string } } }>
}

export async function reconcileAllegroObservation(
  offerId: string,
  read: (id: string) => Promise<AllegroObservedOffer>,
  persist: (observation: ReturnType<typeof observationFromOffer>) => Promise<void>,
) {
  const offer = await read(offerId)
  if (offer.id !== offerId) throw new Error('Offer identity mismatch')
  const observation = observationFromOffer(offer)
  await persist(observation)
  return observation
}

export function observationFromOffer(offer: AllegroObservedOffer) {
  const price = offer.publication?.marketplaces?.base?.id === 'allegro-hu'
    ? offer.sellingMode?.price
    : offer.additionalMarketplaces?.['allegro-hu']?.sellingMode?.price
  const amount = !price?.amount?.trim() ? NaN : Number(price.amount)
  const status = offer.publication?.status
  const publicationStatus: 'ACTIVE' | 'ACTIVATING' | 'INACTIVE' | 'ENDED' | 'UNKNOWN' = status === 'ACTIVE' || status === 'ACTIVATING' || status === 'INACTIVE' || status === 'ENDED'
    ? status : 'UNKNOWN'
  const observedAt = new Date()
  return {
    publicationStatus,
    stockAvailable: Number.isInteger(offer.stock?.available) && offer.stock!.available! >= 0 ? offer.stock!.available! : null,
    priceMinor: Number.isSafeInteger(Math.round(amount * 100)) && amount >= 0 && price?.currency === 'HUF' ? Math.round(amount * 100) : null,
    currency: 'HUF',
    lastSyncedAt: observedAt,
    updatedAt: observedAt,
  } as const
}
