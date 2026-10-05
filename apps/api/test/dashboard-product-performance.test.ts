import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildAllProductsAnalysis,
  buildDashboardCampaignPerformance,
} from '../src/allegro-auth.js'

function lineItem(partial: {
  offerId?: string
  boughtAt?: string
  quantity?: number
  price?: string
  campaign?: boolean
}) {
  return {
    quantity: partial.quantity ?? 1,
    boughtAt: partial.boughtAt ?? '2026-10-10T10:00:00Z',
    offer: partial.offerId ? { id: partial.offerId, name: partial.offerId } : {},
    discounts: partial.campaign ? [{ type: 'CAMPAIGN' }] : [],
    price: { amount: partial.price ?? '100.00', currency: 'HUF' },
  }
}

function order(id: string, items: ReturnType<typeof lineItem>[]) {
  return { id, lineItems: items }
}

test('aggregates every offer in range, campaign and non-campaign split', () => {
  const analysis = buildAllProductsAnalysis([
    order('o1', [
      lineItem({ offerId: 'A', quantity: 2, price: '100.00', campaign: true }),
      lineItem({ offerId: 'B', quantity: 1, price: '50.00' }),
    ]),
    order('o2', [lineItem({ offerId: 'A', quantity: 1, price: '100.00' })]),
  ])

  assert.equal(analysis.campaignId, 'ALL_PRODUCTS')
  assert.equal(analysis.offerCount, 2)
  const a = analysis.products.find((p) => p.offerId === 'A')!
  const b = analysis.products.find((p) => p.offerId === 'B')!
  assert.equal(a.campaignOrders, 1)
  assert.equal(a.outsideOrders, 1)
  assert.equal(a.campaignUnits, 2)
  assert.equal(a.campaignRevenueMinor, 20000)
  assert.equal(a.outsideRevenueMinor, 10000)
  assert.equal(b.campaignOrders, 0)
  assert.equal(b.outsideUnits, 1)
  assert.equal(analysis.totals.totalOrders, 2)
  assert.equal(analysis.totals.totalUnits, 4)
  assert.equal(analysis.totals.totalRevenueMinor, 35000)
})

test('an order with both line types counts once in combined totals', () => {
  const analysis = buildAllProductsAnalysis([
    order('o1', [
      lineItem({ offerId: 'A', campaign: true }),
      lineItem({ offerId: 'A' }),
    ]),
  ])

  assert.equal(analysis.totals.campaignOrders, 1)
  assert.equal(analysis.totals.outsideOrders, 1)
  assert.equal(analysis.totals.totalOrders, 1)
})

test('skips lines without an offer and tolerates zero quantities', () => {
  const analysis = buildAllProductsAnalysis([
    order('o1', [
      lineItem({ quantity: 2 }),
      lineItem({ offerId: 'A', quantity: 0 }),
    ]),
  ])

  assert.equal(analysis.offerCount, 1)
  const a = analysis.products.find((p) => p.offerId === 'A')!
  assert.equal(a.outsideOrders, 1)
  assert.equal(a.outsideUnits, 0)
  assert.equal(a.outsideRevenueMinor, 0)
})

test('empty order list yields an empty but present analysis', () => {
  const analysis = buildAllProductsAnalysis([])

  assert.equal(analysis.campaignId, 'ALL_PRODUCTS')
  assert.equal(analysis.offerCount, 0)
  assert.equal(analysis.products.length, 0)
  assert.equal(analysis.totals.totalOrders, 0)
  assert.equal(analysis.totals.totalRevenueMinor, 0)
})

test('specific campaign in Oct 1-31 range: window attributes, range is not clamped', () => {
  const membership = {
    externalCampaignId: 'C1',
    campaignName: 'October campaign',
    campaignStatus: 'ACTIVE',
    externalListingId: 'OFFER-1',
    listingName: 'Offer 1',
    validFrom: new Date('2026-10-05T00:00:00Z'),
    validTo: new Date('2026-10-18T23:59:59Z'),
    campaignPriceMinor: 9000,
    referencePriceMinor: 10000,
  }
  const result = buildDashboardCampaignPerformance(
    [
      order('early', [
        lineItem({ offerId: 'OFFER-1', boughtAt: '2026-10-03T10:00:00Z', campaign: true }),
      ]),
      order('mid-discount', [
        lineItem({ offerId: 'OFFER-1', boughtAt: '2026-10-10T10:00:00Z', campaign: true }),
      ]),
      order('mid-plain', [
        lineItem({ offerId: 'OFFER-1', boughtAt: '2026-10-10T12:00:00Z' }),
      ]),
      order('late', [
        lineItem({ offerId: 'OFFER-1', boughtAt: '2026-10-20T10:00:00Z', campaign: true }),
      ]),
    ],
    [membership],
    new Date('2026-10-01T00:00:00Z'),
    new Date('2026-10-31T23:59:59Z'),
    new Date('2026-09-01T00:00:00Z'),
  )
  const analysis = result.analyses.find((entry) => entry.campaignId === 'C1')!

  assert.ok(analysis)
  assert.equal(analysis.products.length, 1)
  assert.equal(analysis.products[0].campaignOrders, 1)
  assert.equal(analysis.products[0].outsideOrders, 3)
  assert.equal(analysis.totals.campaignOrders, 1)
  assert.equal(analysis.totals.outsideOrders, 3)
})
