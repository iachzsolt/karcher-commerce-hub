import { eq, inArray } from 'drizzle-orm'
import { createDatabase, listingCampaigns, listingDesiredStates, listingPriceSchedules, listingRemoteStates } from '@karcher-commerce-hub/database'
import { resolveAllegroPricePolicy, type AllegroPricePolicy } from './allegro-price-policy.js'

/** Read-only adapter: one server instant and one policy for API, UI and writers. */
export async function loadAllegroPricePolicies(
  database: ReturnType<typeof createDatabase>,
  listingIds: string[],
  now = new Date(),
): Promise<Map<string, AllegroPricePolicy>> {
  if (!listingIds.length) return new Map()
  const [states, schedules, campaigns] = await Promise.all([
    database.select({ listingId: listingDesiredStates.listingId, basePriceMinor: listingDesiredStates.regularPriceMinor,
      priceLocked: listingDesiredStates.priceLocked, observedPriceMinor: listingRemoteStates.priceMinor })
      .from(listingDesiredStates).leftJoin(listingRemoteStates, eq(listingRemoteStates.listingId, listingDesiredStates.listingId))
      .where(inArray(listingDesiredStates.listingId, listingIds)),
    database.select({ id: listingPriceSchedules.id, listingId: listingPriceSchedules.listingId,
      enabled: listingPriceSchedules.enabled, promotionalPriceMinor: listingPriceSchedules.promotionalPriceMinor,
      validFrom: listingPriceSchedules.validFrom, validTo: listingPriceSchedules.validTo })
      .from(listingPriceSchedules).where(inArray(listingPriceSchedules.listingId, listingIds)),
    database.select({ id: listingCampaigns.id, listingId: listingCampaigns.listingId,
      applicationStatus: listingCampaigns.applicationStatus, campaignStatus: listingCampaigns.campaignStatus,
      externalApplicationId: listingCampaigns.externalApplicationId,
      validTo: listingCampaigns.validTo, lastSyncedAt: listingCampaigns.lastSyncedAt })
      .from(listingCampaigns).where(inArray(listingCampaigns.listingId, listingIds)),
  ])
  return new Map(states.map(state => [state.listingId, resolveAllegroPricePolicy({
    ...state, now,
    schedules: schedules.filter(row => row.listingId === state.listingId),
    campaigns: campaigns.filter(row => row.listingId === state.listingId),
  })]))
}
