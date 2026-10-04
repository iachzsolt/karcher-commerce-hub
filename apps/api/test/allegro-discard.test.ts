import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveDiscardStock } from '../src/allegro-discard.js'

const manual = {
  stockLocked: true,
  desiredStock: 50,
  hasInventorySource: true,
  sourceStock: 0,
  stockAutoPaused: false,
  remoteStock: 50,
}

test('locked manual 50 survives discard with source zero', () => {
  const before = { ...manual }
  assert.equal(resolveDiscardStock(manual), 50)
  assert.deepEqual(manual, before)
})

test('locked manual target survives a real remote stock difference', () => {
  const input = { ...manual, remoteStock: 20 }
  const desired = resolveDiscardStock(input)
  assert.equal(desired, 50)
  assert.notEqual(desired, input.remoteStock)
  assert.equal(input.stockLocked, true)
})

test('locked stock also wins over missing source, auto-pause, and unknown remote stock', () => {
  assert.equal(resolveDiscardStock({ ...manual, sourceStock: undefined, stockAutoPaused: true, remoteStock: null }), 50)
  assert.equal(resolveDiscardStock({ ...manual, hasInventorySource: false, remoteStock: 20 }), 50)
  assert.equal(resolveDiscardStock({ ...manual, desiredStock: null }), null)
  assert.equal(resolveDiscardStock({ ...manual, desiredStock: 0, sourceStock: 100 }), 0)
})

test('unlocked stock retains source priority and missing-SKU zero behavior', () => {
  assert.equal(resolveDiscardStock({ ...manual, stockLocked: false }), 0)
  assert.equal(resolveDiscardStock({ ...manual, stockLocked: false, sourceStock: 12 }), 12)
  assert.equal(resolveDiscardStock({ ...manual, stockLocked: false, sourceStock: undefined }), 0)
})

test('unlocked stock without source retains auto-pause and remote fallback behavior', () => {
  const input = { ...manual, stockLocked: false, hasInventorySource: false }
  assert.equal(resolveDiscardStock({ ...input, stockAutoPaused: true }), 0)
  assert.equal(resolveDiscardStock({ ...input, remoteStock: 20 }), 20)
  assert.equal(resolveDiscardStock({ ...input, remoteStock: null }), 50)
  assert.equal(resolveDiscardStock({ ...input, remoteStock: null, desiredStock: null }), null)
})

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const start = source.indexOf("'/allegro/listings/discard-desired-differences'")
const discard = source.slice(start, source.indexOf('Discarding desired differences failed:', start))

test('discard integration reads the lock, preserves it, and guards concurrent manual edits', () => {
  assert.match(discard, /stockLocked:\s+listingDesiredStates\.stockLocked/)
  assert.match(discard, /resolveDiscardStock\(\{\s+stockLocked: row.stockLocked/)
  const update = discard.slice(discard.indexOf('.update(listingDesiredStates)'))
  assert.doesNotMatch(update, /stockLocked\s*:/)
  assert.match(update, /case when \$\{listingDesiredStates.stockLocked\}\s+then \$\{listingDesiredStates.desiredStock\}\s+else \$\{nextStock\} end/)
})

test('publication, price protection and campaign boundaries retain existing discard semantics', () => {
  assert.match(discard, /if \(row.stockAutoPaused\) \{\s+nextPublicationStatus = 'INACTIVE'/)
  assert.match(discard, /row.publicationStatus === 'ACTIVE' \|\|/)
  assert.match(discard, /row.publicationStatus === 'ENDED'/)
  assert.match(discard, /desiredPublicationStatus:\s+nextPublicationStatus/)
  assert.match(discard, /priceLocked:\s+priceProtected\s+\? row.priceLocked\s+: false/)
  assert.doesNotMatch(discard, /\.(update|insert|delete)\(listingCampaigns\)/)
  assert.doesNotMatch(discard, /\.(update|insert|delete)\(listingRemoteStates\)/)
  assert.doesNotMatch(discard, /stockAutoPaused:\s*(true|false)/)
  assert.doesNotMatch(discard, /allegroAuth\.request|submitOfferToAllegroCampaign/)
})

test('explicit stock-lock endpoint remains the separate way to release ownership', () => {
  const start = source.indexOf("app.patch('/allegro/listings/:id/stock-lock'")
  const end = source.indexOf("app.patch('/allegro/listings/:id/auto-stock-sync'", start)
  const unlock = source.slice(start, end)
  assert.match(unlock, /typeof body.stockLocked !==\s+'boolean'/)
  assert.match(unlock, /stockLocked:\s+body.stockLocked/)
})
