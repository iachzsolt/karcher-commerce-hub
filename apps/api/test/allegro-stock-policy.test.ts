import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { resolveAllegroStockPolicy, evaluateAutoPauseOwnership, type StockPolicyInput } from '../src/allegro-stock-policy.js'
import { reconcileStockOwnership } from '../src/allegro-stock-ownership.js'
import { syncAllegroInventoryRows, applyAllegroDesiredStock } from '../src/allegro-inventory-sync.js'
import { evaluateAllegroMismatch, effectiveAllegroStock } from '../../web/src/utils/allegroMismatch.js'
import { reconcileAllegroObservation } from '../src/allegro-remote-observation.js'

const input = (): StockPolicyInput => ({ observedStock: 50, desiredStock: 50, publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', stockAutoPaused: false, stockLocked: false, autoStockSync: true, duplicateOfferCount: 1 })
const event = { id: '11111111-1111-4111-8111-111111111111', action: 'ACTIVATE', status: 'SUCCESS', occurredAt: new Date() }
const view = (state: StockPolicyInput) => evaluateAllegroMismatch({ stockAvailable: state.observedStock,
  desiredStock: state.desiredStock, stockAutoPaused: state.stockAutoPaused, publicationStatus: state.publicationStatus,
  desiredPublicationStatus: state.desiredPublicationStatus, priceMinor: 10000,
  stockPolicy: resolveAllegroStockPolicy(state),
}, 10000)

for (const stockLocked of [true, false]) {
  for (const observedStock of [50, 20]) {
    test(`raw quantity comparison: locked=${stockLocked}, observed=${observedStock}`, () => {
      const state = { ...input(), stockLocked, observedStock }
      const before = { ...state }
      assert.equal(view(state).reasons.some(r => r.type === 'STOCK'), observedStock !== 50)
      assert.deepEqual(state, before)
    })
  }
}
test('ENDED matching quantity creates publication mismatch only', () => {
  const result = view({ ...input(), publicationStatus: 'ENDED' })
  assert.deepEqual(result.reasons.map(r => r.type), ['PUBLICATION'])
})
test('ENDED different quantity creates two genuine mismatches', () => {
  assert.deepEqual(view({ ...input(), publicationStatus: 'ENDED', observedStock: 20 }).reasons.map(r => r.type), ['STOCK', 'PUBLICATION'])
})
test('manual inactive listing suppresses quantity action while retaining raw observation', () => {
  const state = { ...input(), desiredPublicationStatus: 'INACTIVE', publicationStatus: 'ENDED', observedStock: 20 }
  assert.equal(resolveAllegroStockPolicy(state).observedStock, 20)
  assert.equal(resolveAllegroStockPolicy(state).comparison, 'SUPPRESSED')
  assert.deepEqual(view(state).reasons, [])
})
test('auto-pause on ACTIVE is an ownership warning, not synthetic stock zero', () => {
  const policy = resolveAllegroStockPolicy({ ...input(), stockAutoPaused: true })
  assert.equal(policy.comparison, 'MATCH')
  assert.equal(policy.sellableStock, 50)
  assert.equal(policy.ownership, 'UNRESOLVED')
})
test('sellable quantity is separate from Allegro observed quantity', () => {
  const policy = resolveAllegroStockPolicy({ ...input(), publicationStatus: 'ENDED' })
  assert.equal(policy.observedStock, 50)
  assert.equal(policy.sellableStock, 0)
  assert.equal(effectiveAllegroStock({ stockAvailable: 50, desiredStock: 50, publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', priceMinor: 10000, stockAutoPaused: true }), 50)
})
test('locked override ignores a zero source in comparison', () => {
  const state = { ...input(), stockLocked: true, sourceStock: 0 }
  assert.equal(view(state).hasDifference, false)
  assert.equal(state.desiredStock, 50)
})
test('unlocked desired zero and observed positive is a real difference', () => {
  assert.equal(view({ ...input(), desiredStock: 0 }).reasons[0].type, 'STOCK')
})
test('structured stock reason includes ownership and guard metadata and raw quantity', () => {
  const reason = view({ ...input(), observedStock: 20, stockLocked: true, autoStockSync: false, duplicateOfferCount: 2, stockAutoPaused: true }).reasons[0]
  assert.equal(reason.remote, 20)
  assert.deepEqual(reason.stock, { locked: true, autoSync: false, duplicateGuard: true, autoPaused: true })
})
test('unknown observation is not converted to zero', () => {
  assert.equal(view({ ...input(), observedStock: null }).reasons[0].type, 'REMOTE_DATA_UNAVAILABLE')
})
test('fresh ACTIVE equality plus terminal activation evidence can prove stale ownership', () => {
  assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true }, event, true).clear, true)
})
test('cached ACTIVE is insufficient for ownership cleanup', () => {
  assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true }, event, false).clear, false)
})
test('pending ACTIVATE and in-progress reactivation preserve ownership', () => {
  for (const status of ['PENDING', 'REACTIVATION_IN_PROGRESS']) {
    assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true }, { ...event, status }, true).reason, 'TRANSITION_PENDING')
  }
})
test('missing, failed, and unrelated completion evidence remains ambiguous', () => {
  for (const latest of [null, { ...event, status: null }, { ...event, status: 'FAILED' }, { ...event, action: 'END' }, { ...event, action: 'STOCK_UPDATE' }]) {
    assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true }, latest, true).clear, false)
  }
})
test('inactive desired intent, wrong quantity, and ACTIVATING are not clearable', () => {
  for (const changed of [{ desiredPublicationStatus: 'INACTIVE' }, { observedStock: 20 }, { publicationStatus: 'ACTIVATING' }, { desiredStock: 0 }]) {
    assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true, ...changed }, event, true).clear, false)
  }
})
test('manual inactive is never adopted by ownership reconciliation', () => {
  assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: false, desiredPublicationStatus: 'INACTIVE', publicationStatus: 'ENDED' }, event, true).reason, 'NOT_AUTOMATION_OWNED')
})
test('locks, duplicate SKU and disabled automation preserve ambiguous ownership', () => {
  for (const changed of [{ stockLocked: true }, { autoStockSync: false }, { duplicateOfferCount: 2 }]) {
    assert.equal(evaluateAutoPauseOwnership({ ...input(), stockAutoPaused: true, ...changed }, event, true).reason, 'AUTOMATION_GUARD')
  }
})

function fakeDatabase(latest = event, changed = true) {
  const queries: string[] = []
  const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => [latest] }
  return { queries, database: {
    select: () => chain,
    execute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
      queries.push(new PgDialect().sqlToQuery(query).sql)
      return { rows: changed ? [{ listing_id: 'listing' }] : [] }
    },
  } }
}
const snapshot = () => ({ ...input(), listingId: '11111111-1111-4111-8111-111111111111', stockAutoPaused: true, version: '{}', desiredUpdatedAt: new Date(0) })
const observation = () => ({ publicationStatus: 'ACTIVE', stockAvailable: 50, lastSyncedAt: new Date() })
test('guarded cleanup changes only flag and emits atomic evidence audit', async () => {
  const { database, queries } = fakeDatabase()
  const result = await reconcileStockOwnership(database as never, snapshot(), observation())
  assert.equal(result.cleared, true)
  assert.match(queries[0], /set stock_auto_paused=false/)
  assert.match(queries[0], /to_jsonb\(d\)=/)
  assert.match(queries[0], /e.id.*from allegro_change_events/s)
  assert.match(queries[0], /run.status='RUNNING'/)
  assert.match(queries[0], /insert into allegro_change_events/)
  assert.doesNotMatch(queries[0], /set (desired_stock|stock_locked|desired_publication_status|price|regular_price|updated_at)/)
})
test('concurrent state or running transition makes cleanup a no-op', async () => {
  const { database } = fakeDatabase(event, false)
  assert.equal((await reconcileStockOwnership(database as never, snapshot(), observation())).cleared, false)
})
test('pending event prevents even attempting the ownership UPDATE', async () => {
  const { database, queries } = fakeDatabase({ ...event, status: 'PENDING' })
  assert.equal((await reconcileStockOwnership(database as never, snapshot(), observation())).cleared, false)
  assert.deepEqual(queries, [])
})
test('an earlier activation cannot prove completion of newer lifecycle intent', async () => {
  const { database, queries } = fakeDatabase(event)
  const result = await reconcileStockOwnership(database as never, { ...snapshot(), desiredUpdatedAt: new Date(event.occurredAt.getTime() + 1) }, observation())
  assert.equal(result.reason, 'INTENT_CHANGED_SINCE_EVIDENCE')
  assert.deepEqual(queries, [])
})

for (const actual of [50, 20]) {
  test(`targeted observation preserves intent and leaves only real differences: remote=${actual}`, async () => {
    const state = { ...input(), observedStock: 10, stockLocked: true }
    await reconcileAllegroObservation('offer', async () => ({ id: 'offer', publication: { status: 'ACTIVE', marketplaces: { base: { id: 'allegro-hu' } } }, stock: { available: actual }, sellingMode: { price: { amount: '100', currency: 'HUF' } } }), async observed => { state.observedStock = observed.stockAvailable! })
    assert.equal(state.stockLocked, true)
    assert.equal(state.desiredStock, 50)
    assert.equal(view(state).hasDifference, actual !== 50)
  })
}
test('inventory guards prevent any quantity/publication command or desired overwrite', async () => {
  const rows = [
    { stockLocked: true }, { duplicateOfferCount: 2 }, { autoStockSync: false },
    { publicationStatus: 'ENDED', stockAutoPaused: false, desiredPublicationStatus: 'INACTIVE' },
    { publicationStatus: 'ENDED', stockAutoPaused: false, desiredPublicationStatus: 'ENDED' },
  ].map((override, i) => ({ sku: `test-${i}`, listingId: `listing-${i}`, offerId: `offer-${i}`, targetStock: 50,
    remoteStock: 20, desiredStock: 50, stockLocked: false, stockAutoPaused: false, autoStockSync: true,
    publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', duplicateOfferCount: 1, sourceMissing: false, ...override }))
  const database = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
    insert: () => ({ values: async () => {} }), update: () => assert.fail('Desired-state mutation') }
  const result = await syncAllegroInventoryRows(database as never, rows, {
    pushStock: async () => assert.fail('Stock command'), pushStatus: async () => assert.fail('Publication command'),
    refresh: async () => assert.fail('Unexpected refresh'),
  })
  assert.equal(result.summary.skipped, 5)
  assert.equal(result.summary.attempted, 0)
  const disabled = await applyAllegroDesiredStock(database as never, [rows[2]])
  assert.equal(disabled.summary.automationDisabled, 1)
})
test('zero-source externally ended listing is not adopted either', async () => {
  const database = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }), insert: () => ({ values: async () => {} }), update: () => assert.fail('Adoption') }
  const result = await syncAllegroInventoryRows(database as never, [{ sku: 'legacy', listingId: 'id', offerId: 'offer', targetStock: 0,
    remoteStock: 50, desiredStock: 0, stockLocked: false, stockAutoPaused: false, autoStockSync: true,
    publicationStatus: 'ENDED', desiredPublicationStatus: 'ENDED', duplicateOfferCount: 1, sourceMissing: false }], {
    pushStock: async () => assert.fail('stock'), pushStatus: async () => assert.fail('publication'), refresh: async () => assert.fail('refresh'),
  })
  assert.equal(result.results[0].status, 'OWNERSHIP_UNRESOLVED')
})
test('manual inactive intent is protected even before its remote END is observed', async () => {
  const database = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }), insert: () => ({ values: async () => {} }), update: () => assert.fail('Manual intent overwritten') }
  const result = await syncAllegroInventoryRows(database as never, [{ sku: 'manual', listingId: 'id', offerId: 'offer', targetStock: 0,
    remoteStock: 50, desiredStock: 0, stockLocked: false, stockAutoPaused: false, autoStockSync: true,
    publicationStatus: 'ACTIVE', desiredPublicationStatus: 'INACTIVE', duplicateOfferCount: 1, sourceMissing: false }], {
    pushStock: async () => assert.fail('stock'), pushStatus: async () => assert.fail('publication'), refresh: async () => assert.fail('refresh'),
  })
  assert.equal(result.results[0].status, 'MANUAL_INACTIVE')
})
test('ACTIVE inventory pass delegates ownership checks rather than clearing from cached state', async () => {
  const database = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }), insert: () => ({ values: async () => {} }), update: () => assert.fail('Unproven cleanup') }
  let checks = 0
  const result = await syncAllegroInventoryRows(database as never, [{ sku: 'owned', listingId: 'id', offerId: 'offer', targetStock: 50,
    remoteStock: 50, desiredStock: 50, stockLocked: false, stockAutoPaused: true, autoStockSync: true,
    publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE', duplicateOfferCount: 1, sourceMissing: false }], {
    reconcileOwnership: async () => { checks++; return { cleared: false } },
    pushStock: async () => assert.fail('stock'), pushStatus: async () => assert.fail('publication'), refresh: async () => assert.fail('refresh'),
  })
  assert.equal(checks, 1)
  assert.equal(result.results[0].status, 'OWNERSHIP_RECONCILIATION_REQUIRED')
})
test('comparison and ownership modules contain no remote, campaign, or price mutations', () => {
  for (const file of ['allegro-stock-policy.ts', 'allegro-stock-ownership.ts']) {
    const text = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /fetch\(|allegroAuth|pushStock|pushStatus|listingCampaigns|listingPrice|sale\/badges/)
  }
  const text = readFileSync(new URL('../src/allegro-inventory-sync.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(text, /stockAutoPaused:\s*false|action: 'ADOPT_AUTO_PAUSE'/)
})
