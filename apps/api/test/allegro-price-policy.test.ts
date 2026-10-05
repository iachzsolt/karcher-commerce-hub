import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolveAllegroPricePolicy, shouldWriteAllegroPrice, type PricePolicyInput } from '../src/allegro-price-policy.js'
import { evaluateAllegroMismatch } from '../../web/src/utils/allegroMismatch.js'
import { reconcileAllegroObservation } from '../src/allegro-remote-observation.js'

const now = new Date('2026-10-05T10:00:00Z')
const fixture = (): PricePolicyInput => ({ basePriceMinor: 10000, observedPriceMinor: 12000, priceLocked: false, schedules: [], campaigns: [], now })
const schedule = { id: 's1', enabled: true, promotionalPriceMinor: 9000, validFrom: '2026-10-05T09:00:00Z', validTo: '2026-10-05T11:00:00Z' }
const campaign = { id: 'campaign-row', externalApplicationId: 'existing-application', applicationStatus: 'PROCESSED', campaignStatus: 'ACTIVE', validTo: '2026-10-18T21:59:59Z', lastSyncedAt: '2026-10-05T09:59:00Z', badgeId: 'existing-badge', bargainPrice: 7000, validFrom: '2026-10-04T22:00:00Z' }

test('base, schedule, expired schedule and deterministic overlapping winner', () => {
  assert.equal(resolveAllegroPricePolicy(fixture()).expectedPriceMinor, 10000)
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [schedule] }).expectedPriceMinor, 9000)
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [schedule], now: new Date('2026-10-05T12:00Z') }).expectedPriceMinor, 10000)
  const later = { ...schedule, id: 's2', validFrom: '2026-10-05T09:30Z', promotionalPriceMinor: 8000 }
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [schedule, later] }).scheduleId, 's2')
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [later, schedule] }).scheduleId, 's2')
})

for (const status of ['ACTIVE', 'WAITING_FOR_PUBLICATION', 'IN_VERIFICATION', 'AWAITING_BADGE', 'FINISH_FAILED', 'SUBMISSION_UNKNOWN']) {
  test(`existing ${status} campaign is immutable and all price writes are blocked`, () => {
    const input = { ...fixture(), campaigns: [{ ...campaign, campaignStatus: status }], schedules: [schedule] }
    const before = structuredClone(input)
    const result = resolveAllegroPricePolicy(input)
    assert.equal(shouldWriteAllegroPrice(result), false)
    assert.equal(shouldWriteAllegroPrice(result, true), false)
    assert.deepEqual(input, before)
    if (['ACTIVE', 'WAITING_FOR_PUBLICATION'].includes(status)) {
      assert.equal(result.expectedPriceMinor, 12000)
      assert.equal(result.source, 'CAMPAIGN_POLICY')
      assert.equal(result.comparison, 'MATCH')
    } else assert.equal(result.comparison, 'UNAVAILABLE')
  })
}
test('active campaign without schedule accepts marketplace observation, not bargain/reference', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [campaign] })
  assert.equal(result.expectedPriceMinor, 12000)
  assert.notEqual(result.expectedPriceMinor, campaign.bargainPrice)
})
test('terminal/expired campaign releases price control without modifying records', () => {
  for (const entry of [{ ...campaign, campaignStatus: 'FINISHED' }, { ...campaign, validTo: '2026-10-04T00:00Z' }]) {
    const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry], schedules: [schedule] })
    assert.equal(result.expectedPriceMinor, 9000)
    assert.equal(result.writeAllowed, true)
  }
})
test('locked manual expectation remains visible during campaigns but cannot be pushed', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked: true, campaigns: [campaign], schedules: [schedule] })
  assert.equal(result.expectedPriceMinor, 9000)
  assert.equal(result.source, 'SCHEDULE')
  assert.equal(result.comparison, 'MISMATCH')
  assert.equal(shouldWriteAllegroPrice(result), false)
})
test('active schedule overrides locked base; lock and base survive untouched', () => {
  const input = { ...fixture(), priceLocked: true, schedules: [schedule] }
  const before = structuredClone(input)
  const result = resolveAllegroPricePolicy(input)
  assert.equal(result.expectedPriceMinor, 9000)
  assert.equal(result.source, 'SCHEDULE')
  assert.equal(result.scheduleId, 's1')
  assert.equal(result.comparison, 'MISMATCH')
  assert.deepEqual(input, before)
})
test('locked base without schedule still expects the locked base', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked: true })
  assert.equal(result.expectedPriceMinor, 10000)
  assert.equal(result.source, 'LOCKED_PRICE')
})
test('expired schedule restores locked base policy', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked: true, schedules: [schedule], now: new Date('2026-10-05T12:00Z') })
  assert.equal(result.expectedPriceMinor, 10000)
  assert.equal(result.source, 'LOCKED_PRICE')
})
test('price lock owns base target; explicit push may apply it, automated schedule may not', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked: true })
  assert.equal(result.expectedPriceMinor, 10000)
  assert.equal(shouldWriteAllegroPrice(result), true)
  assert.equal(shouldWriteAllegroPrice(result, true), false)
})
test('single, bulk and save+sync resolve the schedule price during an active schedule', () => {
  for (const priceLocked of [false, true]) {
    const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked, schedules: [schedule] })
    assert.equal(result.expectedPriceMinor, 9000)
    assert.equal(shouldWriteAllegroPrice(result), true)
    assert.equal(shouldWriteAllegroPrice(result, true), true)
  }
})
test('missing remote or campaign evidence never implies equality or permits a write', () => {
  for (const campaigns of [[], [campaign], [{ ...campaign, externalApplicationId: null }]]) {
    const result = resolveAllegroPricePolicy({ ...fixture(), observedPriceMinor: null, campaigns })
    assert.equal(result.comparison, 'UNAVAILABLE')
    assert.equal(shouldWriteAllegroPrice(result), false)
  }
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), campaigns: [{ ...campaign, lastSyncedAt: null }] }).source, 'UNKNOWN')
})
test('schedule boundaries are inclusive UTC instants, independent of timezone offset', () => {
  const input = { ...fixture(), schedules: [schedule] }
  for (const date of ['2026-10-05T09:00:00Z', '2026-10-05T11:00:00+02:00', '2026-10-05T11:00:00Z']) {
    assert.equal(resolveAllegroPricePolicy({ ...input, now: new Date(date) }).source, 'SCHEDULE')
  }
  for (const date of ['2026-10-05T08:59:59.999Z', '2026-10-05T11:00:00.001Z']) {
    assert.equal(resolveAllegroPricePolicy({ ...input, now: new Date(date) }).source, 'BASE')
  }
})
test('equal target never creates a redundant write', () => {
  assert.equal(shouldWriteAllegroPrice(resolveAllegroPricePolicy({ ...fixture(), observedPriceMinor: 10000 })), false)
})

test('frontend consumes the identical backend result for the complete fixture matrix', () => {
  const fixtures = [fixture(), { ...fixture(), schedules: [schedule] },
    { ...fixture(), campaigns: [campaign], schedules: [schedule] },
    { ...fixture(), campaigns: [{ ...campaign, campaignStatus: 'WAITING_FOR_PUBLICATION' }] },
    { ...fixture(), campaigns: [campaign], priceLocked: true },
    { ...fixture(), observedPriceMinor: null },
    { ...fixture(), campaigns: [{ ...campaign, campaignStatus: 'UNRECOGNIZED' }] }]
  for (const input of fixtures) {
    const policy = resolveAllegroPricePolicy(input)
    const view = evaluateAllegroMismatch({ stockAvailable: 50, desiredStock: 50, stockAutoPaused: false,
      publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', priceMinor: input.observedPriceMinor, pricePolicy: policy }, 999999)
    // Even a stale frontend schedule/base value cannot override server policy.
    assert.equal(view.reasons.some(r => r.type === 'PRICE'), policy.comparison === 'MISMATCH')
    assert.equal(view.reasons.some(r => r.type === 'REMOTE_DATA_UNAVAILABLE'), policy.comparison === 'UNAVAILABLE')
    if (view.reasons.length) assert.equal(view.reasons[0].source, policy.source)
  }
})

test('unknown contract fails closed instead of manufacturing equality', () => {
  const view = evaluateAllegroMismatch({ stockAvailable: 50, desiredStock: 50, stockAutoPaused: false,
    publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', priceMinor: 10000, pricePolicy: null }, 10000)
  assert.equal(view.reasons[0].type, 'REMOTE_DATA_UNAVAILABLE')
})

test('PROCESSED applications, badge IDs, prices and dates survive repeated resolver calls', () => {
  const input = { ...fixture(), campaigns: [{ ...campaign, campaignStatus: 'WAITING_FOR_PUBLICATION' }] }
  const original = structuredClone(input)
  Object.freeze(input.campaigns[0])
  for (let i = 0; i < 10; i++) {
    assert.equal(shouldWriteAllegroPrice(resolveAllegroPricePolicy(input)), false)
  }
  assert.deepEqual(input, original)
})

test('same-start schedule tie has a stable ID winner', () => {
  const other = { ...schedule, id: 's0', promotionalPriceMinor: 8000 }
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [schedule, other] }).scheduleId, 's0')
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), schedules: [other, schedule] }).scheduleId, 's0')
})

test('campaign end resumes canonical schedule and then base without rewriting campaign', () => {
  const entry = { ...campaign, validTo: '2026-10-05T10:00:00Z' }
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry], schedules: [schedule] }).source, 'CAMPAIGN_POLICY')
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry], schedules: [schedule], now: new Date('2026-10-05T10:00:00.001Z') }).source, 'SCHEDULE')
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry], schedules: [schedule], now: new Date('2026-10-05T11:00:00.001Z') }).source, 'BASE')
  assert.equal(entry.campaignStatus, 'ACTIVE')
})

test('targeted remote observation only updates observed marketplace price', async () => {
  const input = { ...fixture(), priceLocked: true, campaigns: [campaign], schedules: [schedule] }
  const original = structuredClone(input)
  await reconcileAllegroObservation('offer', async () => ({ id: 'offer', publication: { status: 'ACTIVE', marketplaces: { base: { id: 'allegro-hu' } } }, stock: { available: 50 }, sellingMode: { price: { amount: '123.45', currency: 'HUF' } } }), async observation => {
    assert.equal(observation.priceMinor, 12345)
    assert.ok(!('desiredPriceMinor' in observation))
    assert.ok(!('priceLocked' in observation))
  })
  assert.deepEqual(input, original)
})

test('all price write decisions use the canonical policy; campaign routes remain outside it', () => {
  const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8')
  const single = source.slice(source.indexOf("allegroAuth.post('/push-price/"), source.indexOf("allegroAuth.post('/push-stock/"))
  assert.ok(single.indexOf('shouldWriteAllegroPrice') < single.indexOf('/sale/offer-price-change-commands/'))
  assert.match(single, /skipped: true, pricePolicy/)
  assert.match(single, /automatic = context.req.header/)
  const scheduler = source.slice(source.indexOf("'/process-price-schedules'"), source.indexOf("const priceChanged = pricePolicy"))
  assert.match(scheduler, /pricePolicy\?\.automaticWriteAllowed/)
  assert.match(scheduler, /X-Commerce-Hub-Price-Automation/)
  assert.match(source, /const priceChanged = pricePolicy \? shouldWriteAllegroPrice\(pricePolicy\) : false/)
  assert.doesNotMatch(source, /hasActiveAllegroCampaignForBulkPrice|effectiveDesiredPriceMinorForBulk|hasActiveAllegroCampaign =/)
  const policy = readFileSync(new URL('../src/allegro-price-policy.ts', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/allegro-price-policy-store.ts', import.meta.url), 'utf8')
  for (const text of [policy, store, single]) {
    assert.doesNotMatch(text, /\.update\(listingCampaigns\)|\.insert\(listingCampaigns\)|\.delete\(listingCampaigns\)|\/sale\/badges|\/push-stock|\/push-status|offer-publication-commands|offer-quantity-change-commands/)
  }
  assert.doesNotMatch(policy, /fetch\(|\.update\(|\.insert\(|\.delete\(/)
  assert.doesNotMatch(store, /\.update\(|\.insert\(|\.delete\(/)
  const home = readFileSync(new URL('../../web/src/pages/HomePage.tsx', import.meta.url), 'utf8')
  assert.match(home, /listing.pricePolicy\?\.expectedPriceMinor/)
  assert.doesNotMatch(home, /isPriceScheduleCurrentlyActive/)
})

test('waiting campaign owns price before its publication start', () => {
  const entry = { ...campaign, campaignStatus: 'WAITING_FOR_PUBLICATION', validFrom: '2026-10-10T00:00Z' }
  const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry] })
  assert.equal(result.source, 'CAMPAIGN_POLICY')
  assert.equal(result.writeAllowed, false)
})
test('in-flight REQUESTED application blocks writes even without a final badge', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [{ ...campaign, applicationStatus: 'REQUESTED', campaignStatus: 'PREPARED' }] })
  assert.equal(result.comparison, 'UNAVAILABLE')
  assert.equal(result.writeAllowed, false)
})
test('local unsubmitted preparation does not claim marketplace-price ownership', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [{ ...campaign, externalApplicationId: null, applicationStatus: 'PREPARED', campaignStatus: 'PREPARED' }], schedules: [schedule] })
  assert.equal(result.source, 'SCHEDULE')
})
test('declined campaign releases ownership without changing its rejection state', () => {
  const entry = { ...campaign, campaignStatus: 'DECLINED', rejectionReasons: ['BA104'] }
  assert.equal(resolveAllegroPricePolicy({ ...fixture(), campaigns: [entry] }).source, 'BASE')
  assert.deepEqual(entry.rejectionReasons, ['BA104'])
})
test('matching locked campaign target is not a false price mismatch', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), priceLocked: true, observedPriceMinor: 10000, campaigns: [campaign] })
  assert.equal(result.comparison, 'MATCH')
  assert.equal(result.writeAllowed, false)
})
test('single and bulk explicit decisions agree for every ownership mode', () => {
  for (const input of [fixture(), { ...fixture(), campaigns: [campaign] }, { ...fixture(), priceLocked: true }, { ...fixture(), schedules: [schedule] }]) {
    const single = resolveAllegroPricePolicy(input)
    const bulk = resolveAllegroPricePolicy(structuredClone(input))
    assert.deepEqual(single, bulk)
    assert.equal(shouldWriteAllegroPrice(single), shouldWriteAllegroPrice(bulk))
  }
})
test('an unknown second campaign prevents accepting the first campaign as sufficient evidence', () => {
  const result = resolveAllegroPricePolicy({ ...fixture(), campaigns: [campaign, { ...campaign, id: 'second', campaignStatus: 'SUBMISSION_UNKNOWN' }] })
  assert.equal(result.source, 'UNKNOWN')
  assert.equal(result.writeAllowed, false)
})
