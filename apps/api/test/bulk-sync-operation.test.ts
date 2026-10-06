import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBulkFinishMessage,
  chunkIds,
  formatBulkProgress,
  isBackgroundRefreshAllowed,
} from '../../web/src/utils/bulkSyncOperation.js'

const HOME_PAGE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'src',
  'pages',
  'HomePage.tsx',
)

function homeSource() {
  return readFileSync(HOME_PAGE, 'utf8').replace(
    /\r\n/g,
    '\n',
  )
}

function runnerBlock() {
  const source = homeSource()
  const start = source.indexOf('const runBulkSyncOperation')
  assert.ok(start >= 0)
  const end = source.indexOf(
    '\n  const saveAllDesiredChanges',
    start,
  )
  assert.ok(end > start)

  return source.slice(start, end)
}

void test('write batches accumulate listing-level progress without resetting', () => {
  const chunks = chunkIds(['a', 'b', 'c', 'd', 'e'], 2)

  assert.deepEqual(chunks, [['a', 'b'], ['c', 'd'], ['e']])
  assert.equal(
    formatBulkProgress({ done: 25, total: 87, phase: 'write' }),
    'Szinkronizálás folyamatban… 25 / 87',
  )
  assert.equal(
    formatBulkProgress({ done: 50, total: 87, phase: 'write' }),
    'Szinkronizálás folyamatban… 50 / 87',
  )
  assert.equal(
    formatBulkProgress({ done: 87, total: 87, phase: 'check' }),
    'Allegro állapotok ellenőrzése…',
  )
})

void test('background refresh skips operation-owned listings only', () => {
  const owned = new Set(['a', 'b'])

  assert.equal(isBackgroundRefreshAllowed('a', owned), false)
  assert.equal(isBackgroundRefreshAllowed('b', owned), false)
  assert.equal(isBackgroundRefreshAllowed('c', owned), true)
  assert.equal(
    isBackgroundRefreshAllowed('c', new Set()),
    true,
  )
})

void test('partial write failure produces a partial-failure summary', () => {
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 84,
      skipped: 0,
      failed: 3,
      pending: 0,
      errors: ['sku-1: boom'],
      refreshWarning: '',
      campaignBlocked: false,
      saved: false,
    }),
    'Szinkronizálás befejezve. 84 sikeres, 3 sikertelen.\n\nHibák:\nsku-1: boom',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 1,
      skipped: 0,
      failed: 1,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: true,
    }),
    'Mentve, de az Allegro szinkronizálás sikertelen.',
  )
})

void test('pending convergence finishes only after the retry cycle', () => {
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 82,
      skipped: 0,
      failed: 0,
      pending: 5,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: true,
    }),
    'Mentve. Szinkronizálás befejezve. 82 ajánlat frissült, 5 Allegro-frissítés még folyamatban.',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 82,
      skipped: 0,
      failed: 0,
      pending: 5,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: false,
    }),
    'Szinkronizálás befejezve. 82 ajánlat frissült, 5 Allegro-frissítés még folyamatban.',
  )
})

void test('genuine remainder and empty outcomes stay explicit', () => {
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 3,
      skipped: 0,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '\n\nMegjegyzés: x',
      campaignBlocked: false,
      saved: true,
    }),
    'Szinkronizálva, de eltérés maradt.\n\nMegjegyzés: x',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 0,
      skipped: 5,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: true,
    }),
    'Mentve, de nem szinkronizálható: nincs végrehajtható módosítás.',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 0,
      skipped: 5,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: false,
    }),
    'Szinkronizálás befejezve: nincs végrehajtható módosítás.',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 5,
      skipped: 0,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: true,
    }),
    'Mentve és szinkronizálva.',
  )
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 5,
      skipped: 0,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: false,
      saved: false,
    }),
    'Szinkronizálás befejezve. 5 sikeres.',
  )
})

void test('campaign-blocked price stays a distinct saved-but-blocked outcome', () => {
  assert.equal(
    buildBulkFinishMessage({
      succeeded: 2,
      skipped: 0,
      failed: 0,
      pending: 0,
      errors: [],
      refreshWarning: '',
      campaignBlocked: true,
      saved: true,
    }),
    'Mentve, de aktív kampány miatt az ár nem módosítható az Allegro-n.',
  )
})

void test('bulk runner writes, then reconciles, then converges, then reloads once', () => {
  const block = runnerBlock()
  const writeFetch = block.indexOf('/sync-selected')
  const reconcileCall = block.indexOf('await reconcileRemoteListings(ids)')
  const convergenceCall = block.indexOf('await waitForListingConvergence(')
  const finalReload = block.indexOf(
    'finalRows = await reloadAllegroListings()',
  )
  const summaryReturn = block.indexOf(
    'refreshWarning,\n        finalRows,',
  )

  for (const index of [
    writeFetch,
    reconcileCall,
    convergenceCall,
    finalReload,
    summaryReturn,
  ]) {
    assert.ok(index >= 0)
  }

  assert.ok(writeFetch < reconcileCall)
  assert.ok(reconcileCall < convergenceCall)
  assert.ok(convergenceCall < finalReload)
  assert.ok(finalReload < summaryReturn)
  assert.ok(!block.includes('window.alert'))
})

void test('bulk runner keeps one loading state and owns its ids end to end', () => {
  const block = runnerBlock()

  assert.ok(block.includes('bulkOpIdsRef.current = new Set(ids)'))
  assert.ok(
    block.includes(
      "setBulkProgress({ done: 0, total: ids.length, phase: 'write' })",
    ),
  )
  assert.ok(
    block.includes(
      "setBulkProgress({ done: ids.length, total: ids.length, phase: 'check' })",
    ),
  )
  assert.ok(block.includes('bulkOpIdsRef.current = new Set()'))
  assert.ok(block.includes('setBulkProgress(null)'))
})

void test('bulk runner sends no duplicate writes and touches no other dimensions', () => {
  const block = runnerBlock()
  const writeFetches = [
    ...block.matchAll(/auth\/allegro\/sync-selected/g),
  ]

  assert.equal(writeFetches.length, 1)
  assert.ok(!block.includes('/push-price'))
  assert.ok(!block.includes('/push-stock'))
  assert.ok(!block.includes('/push-status'))
  assert.ok(!block.includes('sale/badges'))
  assert.ok(!block.includes('campaign'))
  assert.ok(!block.includes('stockLocked'))
})

void test('save and bulk-sync funnels share the runner without early completion', () => {
  const source = homeSource()

  assert.ok(source.includes('await runBulkSyncOperation('))
  assert.ok(
    source.includes('await runBulkSyncOperation(\n        changedListings,'),
  )

  const saveCall =
    source.indexOf('saveAllDesiredChanges(true)')
  assert.ok(saveCall >= 0)
})

void test('background freshness yields to explicit bulk ownership', () => {
  const source = homeSource()

  assert.ok(
    source.includes(
      'isBackgroundRefreshAllowed(listing.id, bulkOpIdsRef.current)',
    ),
  )
})

void test('per-listing reconcile ownership prevents double refresh', () => {
  const source = homeSource()

  assert.ok(source.includes('remoteInFlightIds'))
  assert.ok(
    source.includes(
      'const actionable = ids.filter(',
    ),
  )
})

void test('bulk saves skip intermediate reloads and reload once', () => {
  const source = homeSource()

  assert.ok(
    source.includes('await saveDesiredPrice(listing, { skipReload: true })'),
  )
  assert.ok(
    source.includes('await saveDesiredStock(listing, { skipReload: true })'),
  )
  assert.ok(
    source.includes('await saveDesiredStatus(listing, { skipReload: true })'),
  )
})
