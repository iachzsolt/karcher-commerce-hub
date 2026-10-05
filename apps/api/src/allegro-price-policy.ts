/** Listing marketplace prices only. Badge bargain/reference prices are not targets. */
export type PricePolicyInput = {
  basePriceMinor: number | null
  observedPriceMinor: number | null
  priceLocked: boolean
  schedules: ReadonlyArray<{
    id: string
    enabled: boolean
    promotionalPriceMinor: number
    validFrom: Date | string
    validTo: Date | string
  }>
  campaigns: ReadonlyArray<{
    id: string
    applicationStatus: string | null
    campaignStatus: string | null
    externalApplicationId: string | null
    validTo: Date | string | null
    lastSyncedAt: Date | string | null
  }>
  now: Date
}

export type AllegroPricePolicy = {
  expectedPriceMinor: number | null
  observedPriceMinor: number | null
  source: 'BASE' | 'SCHEDULE' | 'CAMPAIGN_POLICY' | 'LOCKED_PRICE' | 'UNKNOWN'
  comparison: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE'
  writeAllowed: boolean
  automaticWriteAllowed: boolean
  reason: string
  campaignIds: string[]
  scheduleId: string | null
  computedAt: string
  nextTransitionAt: string | null
}

const time = (value: Date | string) => new Date(value).getTime()
const validPrice = (value: number | null): value is number =>
  value !== null && Number.isSafeInteger(value) && value > 0

export function resolveAllegroPricePolicy(input: PricePolicyInput): AllegroPricePolicy {
  const now = input.now.getTime()
  const transitions: number[] = []
  const campaigns = input.campaigns.filter(campaign => {
    if (campaign.campaignStatus === 'FINISHED' || campaign.campaignStatus === 'DECLINED' || campaign.applicationStatus === 'DECLINED') return false
    // Prepared/scheduled local plans are not submitted campaign ownership.
    if (!campaign.externalApplicationId && ['PREPARED', 'SCHEDULED'].includes(campaign.applicationStatus ?? '') && campaign.campaignStatus === 'PREPARED') return false
    if (campaign.validTo !== null && Number.isFinite(time(campaign.validTo))) {
      if (time(campaign.validTo) < now) return false
      transitions.push(time(campaign.validTo) + 1)
    }
    return true
  })
  const activeSchedules = input.schedules.filter(schedule => {
    if (!schedule.enabled) return false
    const start = time(schedule.validFrom)
    const end = time(schedule.validTo)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    if (start > now) transitions.push(start)
    if (end >= now) transitions.push(end + 1)
    return start <= now && now <= end
  }).sort((a, b) => time(b.validFrom) - time(a.validFrom) || a.id.localeCompare(b.id))
  const schedule = activeSchedules[0]
  const trustedCampaign = campaigns.length > 0 && campaigns.every(campaign =>
    Boolean(campaign.externalApplicationId && campaign.lastSyncedAt) &&
    campaign.applicationStatus === 'PROCESSED' &&
    ['ACTIVE', 'WAITING_FOR_PUBLICATION'].includes(campaign.campaignStatus ?? ''),
  )
  // Precedence: campaign ownership (below) > active schedule >
  // locked manual base > normal base. The lock protects the stored
  // base value itself; it never suppresses an explicitly configured
  // promotional schedule.
  let source: AllegroPricePolicy['source'] = schedule ? 'SCHEDULE' : input.priceLocked ? 'LOCKED_PRICE' : 'BASE'
  let expected: number | null = schedule?.promotionalPriceMinor ?? input.basePriceMinor
  let reason: string = source
  if (campaigns.length) {
    if (!trustedCampaign) {
      source = 'UNKNOWN'
      expected = null
      reason = 'UNKNOWN'
    } else if (!input.priceLocked) {
      // Existing bulk policy: an observed normal listing price is accepted
      // during proven campaign ownership. Never substitute a badge bargain.
      source = 'CAMPAIGN_POLICY'
      expected = input.observedPriceMinor
      reason = 'CAMPAIGN_POLICY'
    }
  }
  const resolved = validPrice(expected) && validPrice(input.observedPriceMinor)
  const writeAllowed = campaigns.length === 0 && resolved
  return {
    expectedPriceMinor: validPrice(expected) ? expected : null,
    observedPriceMinor: input.observedPriceMinor,
    source: validPrice(expected) ? source : 'UNKNOWN',
    comparison: !resolved ? 'UNAVAILABLE' : expected === input.observedPriceMinor ? 'MATCH' : 'MISMATCH',
    writeAllowed,
    // Automated writers (schedule processor) may apply an explicit
    // schedule even over a locked base. A locked base without a
    // schedule stays manual-only. Campaign ownership blocks everything.
    automaticWriteAllowed: writeAllowed && source !== 'LOCKED_PRICE',
    reason: campaigns.length ? trustedCampaign ? input.priceLocked ? 'CAMPAIGN_BLOCKS_LOCKED_INTENT' : 'CAMPAIGN_ACCEPTS_OBSERVED_MARKETPLACE_PRICE' : 'CAMPAIGN_EVIDENCE_UNRESOLVED' : !resolved ? 'PRICE_DATA_UNAVAILABLE' : reason,
    campaignIds: campaigns.map(campaign => campaign.id),
    scheduleId: source === 'SCHEDULE' ? schedule?.id ?? null : null,
    computedAt: input.now.toISOString(),
    nextTransitionAt: transitions.length ? new Date(Math.min(...transitions)).toISOString() : null,
  }
}

/** All price-write entry points use this decision before dispatching a command. */
export function shouldWriteAllegroPrice(policy: AllegroPricePolicy, automatic = false) {
  return policy.comparison === 'MISMATCH' && (automatic ? policy.automaticWriteAllowed : policy.writeAllowed)
}
