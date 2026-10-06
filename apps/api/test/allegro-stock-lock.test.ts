import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDesiredStockUpdate } from '../src/allegro-stock-lock.js'

const SRC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
)

function readSource(name: string) {
  return readFileSync(join(SRC_DIR, name), 'utf8')
}

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

function routeBlock(
  source: string,
  startMarker: string,
  endMarkers: string[],
) {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, startMarker)

  let end = source.length

  for (const marker of endMarkers) {
    const at = source.indexOf(marker, start + 1)

    if (at >= 0 && at < end) {
      end = at
    }
  }

  return source.slice(start, end)
}

void test('stock edit while unlocked remains unlocked', () => {
  assert.deepEqual(
    resolveDesiredStockUpdate(
      { stockAutoPaused: false },
      120,
    ),
    { desiredStock: 120 },
  )
})

void test('stock edit while locked remains locked', () => {
  const result = resolveDesiredStockUpdate(
    { stockAutoPaused: false },
    120,
  )

  assert.equal(result.desiredStock, 120)
  assert.ok(!('stockLocked' in result))
})

void test('positive stock on an auto-paused listing still takes over without touching the lock', () => {
  const result = resolveDesiredStockUpdate(
    { stockAutoPaused: true },
    50,
  )

  assert.deepEqual(result, {
    desiredStock: 50,
    desiredPublicationStatus: 'ACTIVE',
    stockAutoPaused: false,
  })
})

void test('zero stock on an auto-paused listing only updates the quantity', () => {
  assert.deepEqual(
    resolveDesiredStockUpdate(
      { stockAutoPaused: true },
      0,
    ),
    { desiredStock: 0 },
  )
})

void test('PATCH desired-stock never writes stockLocked', () => {
  const source = stripComments(readSource('index.ts'))
  const block = routeBlock(
    source,
    "app.patch('/allegro/listings/:id/desired-stock'",
    ["app.patch('/allegro/listings/:id/stock-lock'"],
  )

  assert.ok(block.includes('resolveDesiredStockUpdate'))
  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(block))
})

void test('PATCH stock-lock is the only explicit lock writer', () => {
  const source = stripComments(readSource('index.ts'))
  const block = routeBlock(
    source,
    "app.patch('/allegro/listings/:id/stock-lock'",
    [
      "app.patch('/allegro/listings/:id/auto-stock-sync'",
      "app.patch('/allegro/listings/:id/desired-status'",
    ],
  )
  const flat = block.replace(/\s+/g, ' ')

  assert.ok(flat.includes('stockLocked: body.stockLocked'))
  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(block))
})

void test('price edit does not change the stock lock', () => {
  const source = stripComments(readSource('index.ts'))
  const block = routeBlock(
    source,
    "app.patch('/allegro/listings/:id/desired-price'",
    ["app.patch('/allegro/listings/:id/price-lock'"],
  )

  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(block))
})

void test('publication edit does not change the stock lock', () => {
  const source = stripComments(readSource('index.ts'))
  const block = routeBlock(
    source,
    "app.patch('/allegro/listings/:id/desired-status'",
    ['app.post(', 'app.get(', 'app.patch(', 'app.delete('],
  )

  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(block))
})

void test('schedule, refresh and reconcile paths do not write the stock lock', () => {
  const authSource = stripComments(
    readSource('allegro-auth.ts'),
  )

  // The single remaining boolean write is the insert-only
  // import initialization (onConflictDoNothing).
  const booleanWrites = [
    ...authSource.matchAll(/stockLocked\s*:\s*(true|false)/g),
  ]
  assert.equal(booleanWrites.length, 1)

  const syncSource = stripComments(
    readSource('allegro-inventory-sync.ts'),
  )
  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(syncSource))

  const ownershipSource = stripComments(
    readSource('allegro-stock-ownership.ts'),
  )
  assert.ok(!/stockLocked\s*:\s*(true|false)/.test(ownershipSource))
})

void test('discard preserves an explicit lock instead of clearing it', () => {
  const source = stripComments(readSource('index.ts'))
  const block = routeBlock(
    source,
    "'/allegro/listings/discard-desired-differences'",
    ['Discarding desired differences failed:'],
  )
  const flat = block.replace(/\s+/g, ' ')

  assert.ok(!/stockLocked\s*:\s*false/.test(block))
  assert.ok(flat.includes('case when'))
  assert.ok(flat.includes('stockLocked'))
})

void test('automation never invents a manual lock', () => {
  const source = stripComments(
    readSource('allegro-inventory-sync.ts'),
  )

  assert.ok(!/stockLocked\s*:\s*true/.test(source))
})

void test('HomePage changes the lock only through the explicit checkbox action', () => {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'web',
      'src',
      'pages',
      'HomePage.tsx',
    ),
    'utf8',
  )
  const fetchers = [
    ...source.matchAll(/\/stock-lock/g),
  ]

  assert.equal(fetchers.length, 1)
  assert.ok(source.includes('updateStockLock'))
})
