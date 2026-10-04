import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { evaluateAllegroMismatch, convergeAllegroListings } from '../../web/src/utils/allegroMismatch.js'
import { reconcileAllegroObservation, observationFromOffer } from '../src/allegro-remote-observation.js'
import { allegroAuth } from '../src/allegro-auth.js'

const listing = { stockAvailable: 50, desiredStock: 50, stockAutoPaused: false, publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', priceMinor: 10000, stockLocked: true }
for (const [desired, remote, mismatch] of [['ACTIVE', 'ACTIVE', false], ['ACTIVE', 'ACTIVATING', false], ['ACTIVE', 'ENDED', true], ['INACTIVE', 'ENDED', false]] as const) {
  test(`publication ${desired}/${remote}`, () => {
    const result = evaluateAllegroMismatch({ ...listing, desiredPublicationStatus: desired, publicationStatus: remote }, 10000)
    assert.equal(result.reasons.some(r => r.type === 'PUBLICATION'), mismatch)
  })
}
test('stock mismatch remains real with or without a manual lock', () => {
  for (const stockLocked of [true, false]) {
    const value = { ...listing, stockLocked, stockAvailable: 20 }
    assert.deepEqual(evaluateAllegroMismatch(value, 10000).reasons, [{ type: 'STOCK', field: 'stock', desired: 50, remote: 20 }])
  }
  assert.equal(evaluateAllegroMismatch(listing, 10000).hasDifference, false)
})
test('intentionally inactive stock is suppressed', () => {
  assert.deepEqual(evaluateAllegroMismatch({ ...listing, desiredPublicationStatus: 'INACTIVE', publicationStatus: 'ENDED', stockAvailable: 20 }, 10000).reasons, [])
})
test('price and multiple mismatch reasons retain existing comparison semantics', () => {
  assert.deepEqual(evaluateAllegroMismatch(listing, 20000).reasons, [{ type: 'PRICE', field: 'price', desired: 20000, remote: 10000 }])
  const reasons = evaluateAllegroMismatch({ ...listing, publicationStatus: 'ENDED' }, 20000).reasons
  assert.deepEqual(reasons.map(r => r.type), ['PRICE', 'STOCK', 'PUBLICATION'])
})
test('unknown values and fetch failure are distinct from confirmed mismatches', () => {
  const result = evaluateAllegroMismatch({ ...listing, publicationStatus: 'UNKNOWN', stockAvailable: null, priceMinor: null }, 10000)
  assert.equal(result.reasons.length, 3)
  assert.ok(result.reasons.every(r => r.type === 'REMOTE_DATA_UNAVAILABLE'))
  assert.equal(evaluateAllegroMismatch(listing, 10000, true).reasons[0].field, 'observation')
  assert.equal(evaluateAllegroMismatch({ ...listing, desiredStock: null }, null).hasDifference, false)
})
test('auto-paused effective stock semantics stay intact', () => {
  assert.equal(evaluateAllegroMismatch({ ...listing, stockAutoPaused: true }, 10000).reasons[0].remote, 0)
})

const offer = { id: 'offer', publication: { status: 'ACTIVE', marketplaces: { base: { id: 'allegro-hu' } } }, stock: { available: 50 }, sellingMode: { price: { amount: '100.00', currency: 'HUF' } } }
test('targeted observation updates only remote fields and preserves manual intent', async () => {
  const desired = { desiredStock: 50, stockLocked: true, priceLocked: true, desiredPrice: 10000, desiredPublication: 'INACTIVE', stockAutoPaused: true, autoStockSync: false }
  const before = { ...desired }
  const campaigns = [{ status: 'WAITING_FOR_PUBLICATION' }]
  let remote = { publicationStatus: 'ENDED', stockAvailable: 20 }
  const calls: string[] = []
  await reconcileAllegroObservation('offer', async id => { calls.push(id); return offer }, async observation => {
    assert.deepEqual(Object.keys(observation).sort(), ['currency', 'lastSyncedAt', 'priceMinor', 'publicationStatus', 'stockAvailable', 'updatedAt'])
    remote = observation
  })
  assert.deepEqual(calls, ['offer'])
  assert.equal(remote.publicationStatus, 'ACTIVE')
  assert.equal(remote.stockAvailable, 50)
  assert.deepEqual(desired, before)
  assert.deepEqual(campaigns, [{ status: 'WAITING_FOR_PUBLICATION' }])
})
test('marketplace price uses HU additional price when HU is not base', () => {
  const result = observationFromOffer({ ...offer, publication: { status: 'ACTIVE', marketplaces: { base: { id: 'allegro-pl' } } }, additionalMarketplaces: { 'allegro-hu': { sellingMode: { price: { amount: '250.25', currency: 'HUF' } } } } })
  assert.equal(result.priceMinor, 25025)
  assert.equal(observationFromOffer({ id: 'offer' }).priceMinor, null)
})
test('404 and mismatched offer identity never persist a fabricated observation', async () => {
  await assert.rejects(reconcileAllegroObservation('offer', async () => { throw Error('404') }, async () => assert.fail('persisted')), /404/)
  await assert.rejects(reconcileAllegroObservation('other', async () => offer, async () => assert.fail('persisted')), /identity/)
})
test('convergence reads Allegro before DB and stops immediately once matching', async () => {
  const calls: string[] = []
  const result = await convergeAllegroListings({ targets: ['id'], attempts: 6,
    reconcile: async () => { calls.push('GET Allegro') }, reload: async () => { calls.push('DB'); return [listing] },
    matches: rows => !evaluateAllegroMismatch(rows[0], 10000).hasDifference,
    wait: async () => { calls.push('wait') },
  })
  assert.equal(result.converged, true)
  assert.deepEqual(calls, ['GET Allegro', 'DB'])
})
test('real mismatches stay visible and convergence remains bounded', async () => {
  let reads = 0
  let waits = 0
  const result = await convergeAllegroListings({ targets: ['id'], attempts: 6,
    reconcile: async () => { reads++ }, reload: async () => [{ ...listing, stockAvailable: 20 }],
    matches: rows => !evaluateAllegroMismatch(rows[0], 10000).hasDifference,
    wait: async () => { waits++ },
  })
  assert.equal(result.converged, false)
  assert.equal(reads, 6)
  assert.equal(waits, 5)
})
test('unavailable authoritative read cannot be mistaken for convergence', async () => {
  const result = await convergeAllegroListings({ targets: ['id'], attempts: 2,
    reconcile: async () => { throw Error('503') }, reload: async () => [listing], matches: () => true, wait: async () => {},
  })
  assert.equal(result.converged, false)
})
test('route and manual control boundaries prohibit Allegro writes and desired updates', () => {
  const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8')
  const route = source.slice(source.indexOf("allegroAuth.post('/reconcile-listings'"), source.indexOf("allegroAuth.get(\n  '/offer-debug"))
  assert.match(route, /method: 'GET'/)
  assert.match(route, /body.listingIds.length > 10/)
  assert.match(route, /targets.length !== ids.length/)
  assert.match(route, /eq\(platformListings.accountId, session.platformAccountId\)/)
  assert.match(route, /set: observation/)
  assert.doesNotMatch(route, /listingDesiredStates|listingCampaigns|push-stock|push-price|push-status|sale\/badges/)
  const web = readFileSync(new URL('../../web/src/pages/HomePage.tsx', import.meta.url), 'utf8')
  const manual = web.slice(web.indexOf('const reconcileRemoteListings'), web.indexOf('const waitForListingConvergence'))
  assert.match(manual, /reconcile-listings/)
  assert.doesNotMatch(manual, /push-stock|push-price|push-status/)
})

test('HTTP route rejects empty, oversized, and malformed targeting before remote work', async () => {
  for (const listingIds of [[], Array(11).fill('11111111-1111-4111-8111-111111111111'), ['not-a-uuid']]) {
    const response = await allegroAuth.request('/reconcile-listings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingIds }),
    })
    assert.equal(response.status, 400)
  }
})

test('HTTP route rejects malformed JSON without initializing a remote session', async () => {
  const response = await allegroAuth.request('/reconcile-listings', { method: 'POST', body: '{' })
  assert.equal(response.status, 400)
})

test('convergence drops completed targets while continuing only remaining observations', async () => {
  const reads: string[][] = []
  const result = await convergeAllegroListings({ targets: ['a', 'b'], attempts: 6,
    reconcile: async ids => { reads.push([...ids]) },
    reload: async () => reads.length === 1 ? ['a'] : ['a', 'b'],
    matches: (rows, id) => rows.includes(id), wait: async () => {},
  })
  assert.equal(result.converged, true)
  assert.deepEqual(reads, [['a', 'b'], ['b']])
})

test('unavailable price is not fabricated as zero or converted from a different currency', () => {
  for (const price of [{ amount: '', currency: 'HUF' }, { amount: '100', currency: 'PLN' }, { amount: '-1', currency: 'HUF' }]) {
    assert.equal(observationFromOffer({ ...offer, sellingMode: { price } }).priceMinor, null)
  }
})
