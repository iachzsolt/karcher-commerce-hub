/*
 * Remote-state verification, Allegro task diagnostics and the stock-command
 * diagnostic endpoint.
 *
 * No Neon, no Allegro: the database is an in-memory query-builder fake and
 * every Allegro interaction is an injected adapter.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import {
  authorizeStockCommandDiagnostic,
  evaluateSyncChunk,
  isValidStockCommandId,
  precheckStockCommandDiagnostic,
  sanitizeAllegroTask,
  sanitizeAllegroTaskList,
  unverifiedListings,
  type StockCommandOwnership,
} from '../src/allegro-remote-verification.ts'
import {
  syncAllegroInventoryRows,
  type AllegroInventorySyncRow,
} from '../src/allegro-inventory-sync.ts'
import {
  executeStockMutation,
  latestStockCommand,
  recordStockAudit,
  type StockAuditEvent,
  type StockMutationPorts,
} from '../src/inventory-mutation-journal.ts'
import {
  createEmptyBatchState,
  createSliceBudget,
  INVENTORY_REFRESH_SLICE_DEFAULTS,
  readInventoryRefreshCursor,
  serializeAutomationDetailsWithCursor,
  type InventoryRefreshCursor,
} from '../src/inventory-refresh-slice.ts'
import {
  executeInventoryRefreshSlice,
  type InventoryRefreshState,
} from '../src/inventory-refresh-workflow.ts'
import { runInventoryRefreshSlice } from '../src/platform-automation.ts'
import { buildInventoryAutomationDiagnostics } from '../src/inventory-automation-diagnostics.ts'
import { allegroAuth } from '../src/allegro-auth.ts'

const COMMAND_ID = 'c37c8fcf-5def-48a4-9252-7a70a0ed5fcb'

/* ------------------------------------------------------------------ *
 * In-memory database fake
 * ------------------------------------------------------------------ */

type JournalRow = { listingId: string; newValue: string; metadataJson: string }

/** Any drizzle chain resolves to `result`; inserts are captured. */
function fakeDatabase(options: { stockJournal?: JournalRow[] } = {}) {
  const inserted: Array<Record<string, unknown>> = []
  let updates = 0

  const chain = (result: unknown): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get: (_target, property) => {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        return () => proxy
      },
    })
    return proxy
  }

  const database = {
    select: (fields: Record<string, unknown>) => {
      // Stock-journal reconciliation selects metadataJson without oldValue.
      const isStockJournal = 'metadataJson' in fields && !('oldValue' in fields)
      return chain(isStockJournal ? options.stockJournal ?? [] : [])
    },
    insert: () => ({
      values: (values: unknown) => {
        inserted.push(...(Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>)
        return chain(undefined)
      },
    }),
    update: () => {
      updates += 1
      return chain([])
    },
  }

  return {
    database: database as unknown as Parameters<typeof syncAllegroInventoryRows>[0],
    inserted,
    updates: () => updates,
  }
}

function row(overrides: Partial<AllegroInventorySyncRow> = {}): AllegroInventorySyncRow {
  return {
    sku: '1.516-421.0',
    listingId: 'listing-a',
    offerId: '18673463241',
    targetStock: 169,
    remoteStock: 158,
    desiredStock: 169,
    stockLocked: false,
    stockAutoPaused: false,
    autoStockSync: true,
    publicationStatus: 'ACTIVE',
    desiredPublicationStatus: 'ACTIVE',
    duplicateOfferCount: 1,
    sourceMissing: false,
    ...overrides,
  }
}

function recordingAdapter() {
  const calls: string[] = []
  return {
    calls,
    adapter: {
      reconcileOwnership: async (listingId: string) => {
        calls.push(`reconcileOwnership:${listingId}`)
        return { cleared: false }
      },
      pushStock: async (listingId: string) => {
        calls.push(`pushStock:${listingId}`)
        return { ok: true, status: 200, details: { status: 'ok' } }
      },
      pushStatus: async (listingId: string) => {
        calls.push(`pushStatus:${listingId}`)
        return { ok: true, status: 200, details: { status: 'ok' } }
      },
      refresh: async () => ({ ok: true, details: null }),
    },
  }
}

function sliced() {
  return {
    slice: createSliceBudget(INVENTORY_REFRESH_SLICE_DEFAULTS, 0),
    sliceWait: async () => {},
    now: () => 0,
  }
}

/* ------------------------------------------------------------------ *
 * 1. Per-offer evaluation of /sync chunk responses
 * ------------------------------------------------------------------ */

void describe('evaluateSyncChunk', () => {
  const ids = ['o1', 'o2', 'o3']

  void it('verifies offers whose values did not change (verification is not change detection)', () => {
    const result = evaluateSyncChunk(ids, {
      ok: true,
      status: 200,
      body: { imported: 3, verification: { verifiedOfferIds: ids, unverified: [] } },
    })
    assert.ok([...result.values()].every(entry => entry.verified))
  })

  void it('marks every offer unverified when the whole chunk fails', () => {
    const result = evaluateSyncChunk(ids, { ok: false, status: 500, body: null })
    for (const id of ids) {
      assert.deepEqual(result.get(id), { verified: false, reason: 'SYNC_HTTP_ERROR', httpStatus: 500 })
    }
  })

  void it('never infers verification from a 2xx response without a per-offer report', () => {
    const result = evaluateSyncChunk(ids, { ok: true, status: 200, body: { status: 'ok', imported: 3 } })
    assert.ok([...result.values()].every(entry => !entry.verified && entry.reason === 'SYNC_RESPONSE_INVALID'))
  })

  void it('keeps the specific reason for missing offers, HU data and SKU in a partial chunk', () => {
    const result = evaluateSyncChunk(['o1', 'o2', 'o3', 'o4'], {
      ok: true,
      status: 200,
      body: {
        verification: {
          verifiedOfferIds: ['o1'],
          verified: [{ offerId: 'o1', listingId: 'l1' }],
          unverified: [
            { offerId: 'o2', reason: 'OFFER_NOT_RETURNED' },
            { offerId: 'o3', reason: 'MISSING_HU_MARKETPLACE' },
            { offerId: 'o4', reason: 'MISSING_SKU' },
          ],
        },
      },
    })
    assert.deepEqual(result.get('o1'), { verified: true, listingId: 'l1' })
    assert.deepEqual(result.get('o2'), { verified: false, reason: 'OFFER_NOT_RETURNED' })
    assert.deepEqual(result.get('o3'), { verified: false, reason: 'MISSING_HU_MARKETPLACE' })
    assert.deepEqual(result.get('o4'), { verified: false, reason: 'MISSING_SKU' })
  })

  void it('treats an offer absent from both lists, or an unknown reason, as not verified', () => {
    const result = evaluateSyncChunk(['o1', 'o2'], {
      ok: true,
      status: 200,
      body: { verification: { verifiedOfferIds: [], unverified: [{ offerId: 'o2', reason: 'SOMETHING_NEW' }] } },
    })
    assert.deepEqual(result.get('o1'), { verified: false, reason: 'NOT_VERIFIED' })
    assert.deepEqual(result.get('o2'), { verified: false, reason: 'NOT_VERIFIED' })
  })

  void it('maps offers onto listings and never verifies a listing without an offer id', () => {
    const offers = evaluateSyncChunk(['o1', 'o2'], {
      ok: true,
      status: 200,
      body: {
        verification: {
          verifiedOfferIds: ['o1'],
          verified: [{ offerId: 'o1', listingId: 'l1' }],
          unverified: [{ offerId: 'o2', reason: 'MISSING_SKU' }],
        },
      },
    })
    const unverified = unverifiedListings([
      { listingId: 'l1', offerId: 'o1' },
      { listingId: 'l2', offerId: 'o2' },
      { listingId: 'l3', offerId: null },
      { listingId: 'l4', offerId: 'o-not-requested' },
    ], offers)
    assert.deepEqual([...unverified], [
      ['l2', 'MISSING_SKU'],
      ['l3', 'MISSING_OFFER_ID'],
      ['l4', 'NOT_VERIFIED'],
    ])
  })
})

/* ------------------------------------------------------------------ *
 * 2. /sync and /inventory-sync wiring (source-level, no I/O possible)
 * ------------------------------------------------------------------ */

void describe('/sync verification wiring', () => {
  const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8')
  const syncRoute = source.slice(source.indexOf("allegroAuth.post('/sync'"), source.indexOf("allegroAuth.post('/push-price/"))

  void it('refreshes last_synced_at on every persisted offer, changed or not', () => {
    const upsert = syncRoute.slice(syncRoute.indexOf('.insert(listingRemoteStates)'))
    assert.match(upsert, /lastSyncedAt: now,[\s\S]*onConflictDoUpdate[\s\S]*lastSyncedAt: now,/)
  })

  void it('reports an offer as verified only after its remote state writes completed', () => {
    const remoteUpsert = syncRoute.indexOf('.insert(listingRemoteStates)')
    const desiredInsert = syncRoute.indexOf('.insert(listingDesiredStates)')
    const verified = syncRoute.indexOf('verification.verifiedOfferIds.push(offer.id)')
    const identity = syncRoute.indexOf('verification.verified.push({ offerId: offer.id, listingId: listing.id })')
    assert.ok(remoteUpsert > 0 && desiredInsert > remoteUpsert && verified > desiredInsert)
    assert.ok(identity > desiredInsert, 'the persisted listing id is reported after the writes')
  })

  void it('binds verification to rows of the session account only', () => {
    const inventorySync = source.slice(source.indexOf("allegroAuth.post('/inventory-sync'"))
    assert.match(inventorySync, /accountId:\s+currentSession!\.platformAccountId/)
    assert.match(inventorySync, /unverifiedListings\(rows, offerVerification\)/)
  })

  void it('keeps the all-or-nothing 409 for existing callers and opts the inventory refresh into partial mode', () => {
    assert.match(syncRoute, /if \(!allowPartial\) \{[\s\S]*?409/)
    const inventorySync = source.slice(source.indexOf("allegroAuth.post('/inventory-sync'"))
    assert.match(inventorySync, /offerIds: chunkOfferIds,\s+partial: true,/)
    assert.match(inventorySync, /evaluateSyncChunk\(chunkOfferIds/)
  })
})

/* ------------------------------------------------------------------ *
 * 3. Mutation gate in syncAllegroInventoryRows
 * ------------------------------------------------------------------ */

void describe('no mutation on unverified remote state', () => {
  void it('blocks a stock update that would rely on stale cached stock and reports it explicitly', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(db.database, [row()], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'OFFER_NOT_RETURNED']]),
    })

    assert.deepEqual(recorder.calls, [])
    assert.equal(db.updates(), 0)
    assert.equal(result.summary.skipped, 1)
    assert.equal(result.summary.unchanged, 0, 'never silently reported as unchanged')
    assert.equal(result.summary.stockUpdated, 0)
    const reported = result.results[0]
    assert.equal(reported.status, 'REMOTE_UNVERIFIED')
    assert.equal(reported.reason, 'OFFER_NOT_RETURNED')
    assert.deepEqual(result.slice?.processedListingIds, ['listing-a'], 'the batch can still complete')
  })

  void it('never reactivates or pushes stock for an unverified auto-paused ENDED offer (production case)', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [row({
      stockAutoPaused: true,
      publicationStatus: 'ENDED',
      desiredPublicationStatus: 'INACTIVE',
    })], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'SYNC_HTTP_ERROR']]),
    })

    assert.deepEqual(recorder.calls, [])
    assert.equal(db.updates(), 0, 'desired publication is not flipped to ACTIVE')
  })

  void it('lets a freshly verified offer continue while another offer of the unit is unverified', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(db.database, [
      row({ listingId: 'listing-verified', offerId: 'o-verified', remoteStock: 5, targetStock: 9 }),
      row({ listingId: 'listing-stale', offerId: 'o-stale', remoteStock: 5, targetStock: 9 }),
    ], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-stale', 'MISSING_HU_MARKETPLACE']]),
    })

    assert.deepEqual(recorder.calls, ['pushStock:listing-verified'])
    assert.equal(result.summary.stockUpdated, 1)
    assert.equal(result.summary.skipped, 1)
  })

  void it('keeps LEGACY behavior unchanged when no verification was performed', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [row()], recorder.adapter, sliced())

    assert.deepEqual(recorder.calls, ['pushStock:listing-a'])
  })

  void it('counts unverified listings separately in run diagnostics', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()
    const result = await syncAllegroInventoryRows(db.database, [row()], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'MISSING_SKU']]),
    })

    const diagnostics = buildInventoryAutomationDiagnostics({
      results: [{
        platform: 'ALLEGRO', accountId: 'a', outcome: 'SUCCESS', ok: true, status: 200,
        details: { batches: [{ details: { summary: result.summary, results: result.results } }] },
      }],
    })
    assert.equal(diagnostics.platforms[0].skipBreakdown.remoteUnverified, 1)
    assert.equal(diagnostics.platforms[0].skipBreakdown.other, 0)
  })
})

void describe('existing unresolved commands and freshness', () => {
  const journal = (listingId: string): JournalRow => ({
    listingId,
    newValue: 'PENDING',
    metadataJson: JSON.stringify({ commandId: COMMAND_ID, offerId: '18673463241', toStock: 158, fromStock: 100 }),
  })

  void it('reconciles an unresolved command from a verified observation', async () => {
    const db = fakeDatabase({ stockJournal: [journal('listing-a')] })
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [row({ targetStock: 158, remoteStock: 158 })], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map(),
    })

    const closed = db.inserted.filter(event => event.eventType === 'STOCK_OPERATION')
    assert.equal(closed.length, 1)
    assert.equal(closed[0].newValue, 'SUCCESS')
    assert.equal(JSON.parse(String(closed[0].metadataJson)).commandId, COMMAND_ID, 'same command id')
    assert.deepEqual(recorder.calls, [], 'no new mutation')
  })

  void it('does not close a command from a stale observation and dispatches nothing', async () => {
    const db = fakeDatabase({ stockJournal: [journal('listing-a')] })
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [row({ targetStock: 158, remoteStock: 158 })], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'OFFER_NOT_RETURNED']]),
    })

    assert.equal(db.inserted.filter(event => event.eventType === 'STOCK_OPERATION').length, 0,
      'the command stays unresolved for a later verified run')
    assert.deepEqual(recorder.calls, [])
  })
})

/* ------------------------------------------------------------------ *
 * 4. Original Allegro task errors
 * ------------------------------------------------------------------ */

void describe('Allegro task diagnostics', () => {
  const failedTask = {
    offer: { id: '18673463241' },
    field: 'stock',
    status: 'FAIL',
    message: 'Offer is not active',
    scheduledAt: '2026-11-23T14:10:00.000Z',
    finishedAt: '2026-11-23T14:10:02.000Z',
    errors: [{
      code: 'OFFER_NOT_ACTIVE',
      message: 'Cannot change quantity of an ended offer',
      userMessage: 'Az ajánlat nem aktív',
      path: 'offer.stock',
      details: null,
      metadata: { internal: 'dropped' },
    }],
    unexpected: 'dropped',
  }

  void it('keeps Allegro status, message and error codes and drops unknown fields', () => {
    const sanitized = sanitizeAllegroTask(failedTask)
    assert.equal(sanitized.status, 'FAIL')
    assert.equal(sanitized.message, 'Offer is not active')
    assert.equal(sanitized.errors[0].code, 'OFFER_NOT_ACTIVE')
    assert.equal(sanitized.errors[0].userMessage, 'Az ajánlat nem aktív')
    assert.equal('unexpected' in sanitized, false)
    assert.equal('metadata' in sanitized.errors[0], false)
    assert.equal(sanitizeAllegroTaskList({ tasks: [failedTask] }).length, 1)
  })

  void it('bounds oversized values', () => {
    const sanitized = sanitizeAllegroTask({ status: 'FAIL', message: 'x'.repeat(5_000), errors: Array(50).fill({}) })
    assert.ok((sanitized.message ?? '').length <= 501)
    assert.equal(sanitized.errors.length, 10)
  })

  function ports(options: {
    task: 'FAILED' | 'SUCCESS'
    dispatch?: StockMutationPorts['dispatch']
    describe?: StockMutationPorts['describeTask']
  }) {
    const journalEvents: StockAuditEvent[] = []
    const puts: string[] = []
    const value: StockMutationPorts = {
      latestCommand: async () => null,
      record: async event => { journalEvents.push(event) },
      readCommandTask: async () => options.task,
      readObservedStock: async () => 158,
      refreshObservation: async () => {},
      dispatch: options.dispatch ?? (async commandId => {
        puts.push(commandId)
        return { kind: 'ACCEPTED', httpStatus: 201 }
      }),
      assertOwned: async () => {},
      newCommandId: () => COMMAND_ID,
      describeTask: options.describe,
      wait: async () => {},
      pollAttempts: 1,
      pollIntervalMs: 0,
    }
    return { value, journalEvents, puts }
  }

  const input = {
    listingId: 'listing-a', offerId: '18673463241', desiredStock: 169, observedStock: 158,
    runId: 'run-1', batchIndex: 13, executionMode: 'SLICED' as const,
  }

  void it('records the original task error with an explicit async-failure kind', async () => {
    const harness = ports({ task: 'FAILED', describe: () => sanitizeAllegroTask(failedTask) })
    const outcome = await executeStockMutation(input, harness.value)

    assert.equal(outcome.status, 'FAILED')
    assert.ok(outcome.status === 'FAILED')
    assert.equal(outcome.failureKind, 'ALLEGRO_TASK_FAILED')
    assert.equal(outcome.httpStatus, 502, 'unchanged synthetic status for existing callers')
    assert.equal(outcome.allegroTask?.errors[0].code, 'OFFER_NOT_ACTIVE')
    const failed = harness.journalEvents.find(event => event.status === 'FAILED')
    assert.equal(failed?.reason, 'ALLEGRO_TASK_FAILED')
    assert.equal(failed?.allegroTask?.message, 'Offer is not active')
    assert.deepEqual(harness.puts, [COMMAND_ID], 'exactly one PUT, no retry')
  })

  void it('distinguishes a rejected PUT (real HTTP status) from an async task failure', async () => {
    const harness = ports({
      task: 'SUCCESS',
      dispatch: async () => ({
        kind: 'REJECTED', httpStatus: 422, reason: 'Allegro rejected the stock change command',
        allegroResponse: '{"errors":[{"code":"VALIDATION_ERROR"}]}',
      }),
    })
    const outcome = await executeStockMutation(input, harness.value)

    assert.ok(outcome.status === 'FAILED')
    assert.equal(outcome.failureKind, 'ALLEGRO_COMMAND_REJECTED')
    assert.equal(outcome.httpStatus, 422)
    assert.match(outcome.allegroResponse ?? '', /VALIDATION_ERROR/)
  })

  void it('never lets a diagnostics failure change the mutation outcome', async () => {
    const harness = ports({ task: 'FAILED', describe: () => { throw new Error('boom') } })
    const outcome = await executeStockMutation(input, harness.value)
    assert.ok(outcome.status === 'FAILED')
    assert.equal(outcome.allegroTask, null)
  })

  void it('keeps existing journal events byte-compatible and readers working', async () => {
    const db = fakeDatabase()
    await recordStockAudit(db.database, 'listing-a', { status: 'SUCCESS', commandId: COMMAND_ID, toStock: 5 })
    await recordStockAudit(db.database, 'listing-a', {
      status: 'FAILED', commandId: COMMAND_ID, toStock: 5,
      failureKind: 'ALLEGRO_TASK_FAILED', allegroTask: sanitizeAllegroTask(failedTask),
    })

    const success = JSON.parse(String(db.inserted[0].metadataJson))
    assert.deepEqual(Object.keys(success).sort(), [
      'batchIndex', 'commandId', 'fromStock', 'observedStock', 'offerId', 'reason', 'runId', 'taskStatus', 'toStock',
    ])
    const failure = JSON.parse(String(db.inserted[1].metadataJson))
    assert.equal(failure.allegroTask.errors[0].code, 'OFFER_NOT_ACTIVE')

    // The existing reader still parses a row carrying the new fields.
    const reader = {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [{
        status: 'FAILED', metadata: db.inserted[1].metadataJson,
      }] }) }) }) }),
    } as unknown as Parameters<typeof latestStockCommand>[0]
    const command = await latestStockCommand(reader, 'listing-a')
    assert.equal(command?.commandId, COMMAND_ID)
    assert.equal(command?.status, 'FAILED')
  })
})

/* ------------------------------------------------------------------ *
 * 5. Diagnostic endpoint: authorization and account isolation
 * ------------------------------------------------------------------ */

void describe('stock-command task diagnostic authorization', () => {
  const session = { platformAccountId: 'account-1', environment: 'PRODUCTION' }
  const owned: StockCommandOwnership = {
    listingId: 'listing-a', offerId: '18673463241', accountId: 'account-1', environment: 'PRODUCTION',
  }

  void it('validates command ids strictly', () => {
    assert.equal(isValidStockCommandId(COMMAND_ID), true)
    for (const bad of ['', 'abc', `${COMMAND_ID}/../x`, `${COMMAND_ID}?x=1`, COMMAND_ID.replace(/-/g, '')]) {
      assert.equal(isValidStockCommandId(bad), false, bad)
    }
  })

  void it('requires an administrator before any I/O', () => {
    assert.deepEqual(precheckStockCommandDiagnostic({ role: 'VIEWER', commandId: COMMAND_ID }),
      { allowed: false, status: 403, reason: 'ADMIN_REQUIRED' })
    assert.deepEqual(precheckStockCommandDiagnostic({ role: null, commandId: COMMAND_ID }),
      { allowed: false, status: 403, reason: 'ADMIN_REQUIRED' })
    assert.deepEqual(precheckStockCommandDiagnostic({ role: 'ADMIN', commandId: 'nope' }),
      { allowed: false, status: 400, reason: 'INVALID_COMMAND_ID' })
    assert.equal(precheckStockCommandDiagnostic({ role: 'ADMIN', commandId: COMMAND_ID }), null)
  })

  void it('allows only commands journaled for the connected account and environment', () => {
    assert.deepEqual(
      authorizeStockCommandDiagnostic({ role: 'ADMIN', commandId: COMMAND_ID, session, journalMatches: [owned] }),
      { allowed: true, command: owned },
    )
    for (const journalMatches of [
      [],
      [{ ...owned, accountId: 'account-2' }],
      [{ ...owned, environment: 'SANDBOX' }],
      [owned, { ...owned, listingId: 'listing-b' }],
    ]) {
      assert.deepEqual(
        authorizeStockCommandDiagnostic({ role: 'ADMIN', commandId: COMMAND_ID, session, journalMatches }),
        { allowed: false, status: 404, reason: 'COMMAND_NOT_FOUND' },
      )
    }
    assert.equal(
      authorizeStockCommandDiagnostic({ role: 'ADMIN', commandId: COMMAND_ID, session: null, journalMatches: [owned] }).allowed,
      false,
    )
  })

  function appAs(role: 'ADMIN' | 'VIEWER' | null) {
    const app = new Hono()
    app.use('*', async (context, next) => {
      if (role) context.set('commerceHubUser' as never, { email: 'x@example.com', role, subject: null } as never)
      await next()
    })
    app.route('/', allegroAuth)
    return app
  }

  void it('route: rejects viewers and anonymous callers with 403', async () => {
    for (const role of ['VIEWER', null] as const) {
      const response = await appAs(role).request(`/stock-command-tasks/${COMMAND_ID}`)
      assert.equal(response.status, 403)
      assert.deepEqual(await response.json(), { status: 'error', reason: 'ADMIN_REQUIRED' })
    }
  })

  void it('route: rejects a malformed command id with 400 before touching Allegro', async () => {
    const response = await appAs('ADMIN').request('/stock-command-tasks/not-a-uuid')
    assert.equal(response.status, 400)
  })

  void it('route: is GET-only', async () => {
    const response = await appAs('ADMIN').request(`/stock-command-tasks/${COMMAND_ID}`, { method: 'POST' })
    assert.equal(response.status, 404)
  })

  void it('route: queries Allegro only with GET and only on the tasks resource', () => {
    const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8')
    const route = source.slice(
      source.indexOf("'/stock-command-tasks/:commandId'"),
      source.indexOf("'/open-offer/:offerId'"),
    )
    assert.equal((route.match(/allegroFetch\(/g) ?? []).length, 1)
    assert.match(route, /method: 'GET'/)
    assert.match(route, /\/sale\/offer-quantity-change-commands\/\$\{encodeURIComponent\(commandId\)\}\/tasks/)
    assert.doesNotMatch(route, /method: '(PUT|POST|PATCH|DELETE)'/)
    assert.doesNotMatch(route, /\.insert\(|\.update\(|\.delete\(|recordStockAudit/)
  })
})

/* ------------------------------------------------------------------ *
 * 6. B2: verification identity integrity
 * ------------------------------------------------------------------ */

void describe('verification identity (B2)', () => {
  const report = (verified: unknown) => evaluateSyncChunk(['o1'], {
    ok: true,
    status: 200,
    body: { verification: { verifiedOfferIds: ['o1'], verified, unverified: [] } },
  })

  void it('accepts verification only for the exact persisted listing', () => {
    const offers = report([{ offerId: 'o1', listingId: 'listing-a' }])
    assert.deepEqual([...unverifiedListings([{ listingId: 'listing-a', offerId: 'o1' }], offers)], [])
  })

  void it('fails closed on a mismatched listing identity (e.g. another account)', () => {
    // Same Allegro offer id, but /sync persisted another account's listing.
    const offers = report([{ offerId: 'o1', listingId: 'listing-of-account-2' }])
    assert.deepEqual(
      [...unverifiedListings([{ listingId: 'listing-a', offerId: 'o1' }], offers)],
      [['listing-a', 'VERIFICATION_IDENTITY_MISMATCH']],
    )
  })

  void it('fails closed on a missing or malformed listing identity', () => {
    const malformed: unknown[] = [
      undefined,
      [],
      [{ offerId: 'o1' }],
      [{ offerId: 'o1', listingId: '' }],
      [{ offerId: 'o1', listingId: 7 }],
      'bad',
    ]
    for (const verified of malformed) {
      assert.deepEqual(
        [...unverifiedListings([{ listingId: 'listing-a', offerId: 'o1' }], report(verified))],
        [['listing-a', 'VERIFICATION_IDENTITY_MISSING']],
        JSON.stringify(verified),
      )
    }
  })

  void it('treats two different persisted listings for one offer as unproven identity', () => {
    const offers = report([
      { offerId: 'o1', listingId: 'listing-a' },
      { offerId: 'o1', listingId: 'listing-b' },
    ])
    assert.deepEqual(
      [...unverifiedListings([{ listingId: 'listing-a', offerId: 'o1' }], offers)],
      [['listing-a', 'VERIFICATION_IDENTITY_MISSING']],
    )
  })

  void it('isolates accounts and environments: a refresh of another listing never authorizes a mutation', async () => {
    const offers = report([{ offerId: 'o1', listingId: 'listing-of-sandbox-account' }])
    const unverified = unverifiedListings([{ listingId: 'listing-a', offerId: 'o1' }], offers)
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [row({ listingId: 'listing-a', offerId: 'o1' })], recorder.adapter, {
      ...sliced(),
      remoteUnverified: unverified,
    })

    assert.deepEqual(recorder.calls, [])
  })

  void it('never verifies an offer that is both reported verified and unverified', () => {
    const offers = evaluateSyncChunk(['o1'], {
      ok: true,
      status: 200,
      body: {
        verification: {
          verifiedOfferIds: ['o1'],
          verified: [{ offerId: 'o1', listingId: 'listing-a' }],
          unverified: [{ offerId: 'o1', reason: 'MISSING_SKU' }],
        },
      },
    })
    assert.deepEqual(offers.get('o1'), { verified: false, reason: 'MISSING_SKU' })
  })
})

/* ------------------------------------------------------------------ *
 * 7. B1: zero target stock without verified remote state
 * ------------------------------------------------------------------ */

void describe('zero-stock safety and visibility (B1)', () => {
  const zero = (overrides: Partial<AllegroInventorySyncRow> = {}) =>
    row({ targetStock: 0, remoteStock: 7, ...overrides })

  for (const publicationStatus of ['ACTIVE', 'ACTIVATING'] as const) {
    void it(`reports an unverified ${publicationStatus} offer with zero target as FAILED and sends nothing`, async () => {
      const db = fakeDatabase()
      const recorder = recordingAdapter()

      const result = await syncAllegroInventoryRows(db.database, [zero({ publicationStatus })], recorder.adapter, {
        ...sliced(),
        remoteUnverified: new Map([['listing-a', 'SYNC_HTTP_ERROR']]),
      })

      assert.deepEqual(recorder.calls, [], 'no END, no stock push')
      assert.equal(db.updates(), 0, 'no desired-state or auto-pause write')
      assert.equal(result.summary.failed, 1)
      assert.equal(result.summary.skipped, 0)
      assert.equal(result.summary.autoPaused, 0)
      const reported = result.results[0]
      assert.equal(reported.status, 'FAILED')
      assert.equal(reported.reason, 'REMOTE_UNVERIFIED_ZERO_STOCK')
      assert.equal(reported.verificationReason, 'SYNC_HTTP_ERROR', 'original verification reason kept')
      assert.deepEqual(result.slice?.processedListingIds, ['listing-a'])
    })
  }

  void it('does not report a manual INACTIVE intent as a zero-stock failure (verified path skips it too)', async () => {
    const recorder = recordingAdapter()
    const unverified = await syncAllegroInventoryRows(
      fakeDatabase().database,
      [zero({ desiredPublicationStatus: 'INACTIVE' })],
      recorder.adapter,
      { ...sliced(), remoteUnverified: new Map([['listing-a', 'SYNC_HTTP_ERROR']]) },
    )
    const verified = await syncAllegroInventoryRows(
      fakeDatabase().database,
      [zero({ desiredPublicationStatus: 'INACTIVE' })],
      recorder.adapter,
      { ...sliced(), remoteUnverified: new Map() },
    )

    assert.deepEqual(recorder.calls, [])
    assert.equal(unverified.summary.failed, 0)
    assert.equal(unverified.results[0].status, 'REMOTE_UNVERIFIED')
    assert.equal(verified.results[0].status, 'MANUAL_INACTIVE')
  })

  void it('keeps the existing automatic END for a verified ACTIVE offer with zero target', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(db.database, [zero()], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map(),
    })

    assert.deepEqual(recorder.calls, ['pushStatus:listing-a'])
    assert.equal(result.summary.autoPaused, 1)
    assert.equal(result.summary.failed, 0)
  })

  void it('sends nothing and does not fail for an unverified ENDED offer with zero target', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(
      db.database,
      [zero({ publicationStatus: 'ENDED', stockAutoPaused: true })],
      recorder.adapter,
      { ...sliced(), remoteUnverified: new Map([['listing-a', 'OFFER_NOT_RETURNED']]) },
    )

    assert.deepEqual(recorder.calls, [])
    assert.equal(result.summary.failed, 0)
    assert.equal(result.results[0].status, 'REMOTE_UNVERIFIED')
  })

  void it('keeps the gate for an unverified positive-stock offer (skip, not failure)', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(db.database, [row({ targetStock: 12, remoteStock: 7 })], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'MISSING_SKU']]),
    })

    assert.deepEqual(recorder.calls, [])
    assert.equal(result.summary.failed, 0)
    assert.equal(result.summary.skipped, 1)
  })

  void it('dispatches nothing for an unresolved command of an unverified zero-stock offer', async () => {
    const db = fakeDatabase({
      stockJournal: [{
        listingId: 'listing-a',
        newValue: 'ATTEMPTED',
        metadataJson: JSON.stringify({ commandId: COMMAND_ID, offerId: '18673463241', toStock: 7 }),
      }],
    })
    const recorder = recordingAdapter()

    await syncAllegroInventoryRows(db.database, [zero()], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-a', 'SYNC_HTTP_ERROR']]),
    })

    assert.deepEqual(recorder.calls, [])
    assert.equal(
      db.inserted.filter(event => event.eventType === 'STOCK_OPERATION').length,
      0,
      'the command is neither re-sent nor closed from stale state',
    )
  })

  void it('continues processing other verified listings in the same unit', async () => {
    const db = fakeDatabase()
    const recorder = recordingAdapter()

    const result = await syncAllegroInventoryRows(db.database, [
      zero({ listingId: 'listing-zero', offerId: 'o-zero' }),
      row({ listingId: 'listing-ok', offerId: 'o-ok', remoteStock: 5, targetStock: 9 }),
    ], recorder.adapter, {
      ...sliced(),
      remoteUnverified: new Map([['listing-zero', 'OFFER_NOT_RETURNED']]),
    })

    assert.deepEqual(recorder.calls, ['pushStock:listing-ok'])
    assert.equal(result.summary.failed, 1)
    assert.equal(result.summary.stockUpdated, 1)
  })

  void it('propagates the failure through the execution unit, the batch and the run', async () => {
    const rows = new Map<string, AllegroInventorySyncRow>([
      ['listing-zero', zero({ listingId: 'listing-zero', offerId: 'o-zero', sku: 'ZERO-SKU' })],
      ['listing-ok', row({ listingId: 'listing-ok', offerId: 'o-ok', remoteStock: 5, targetStock: 9 })],
    ])
    const recorder = recordingAdapter()
    const unitReports: Array<{ failed: number }> = []

    // The real per-unit decision logic behind a fake in-process /inventory-sync.
    const transport = async (body: string) => {
      const request = JSON.parse(body) as { listingIds: string[] }
      const result = await syncAllegroInventoryRows(
        fakeDatabase().database,
        request.listingIds.map(id => rows.get(id)!),
        recorder.adapter,
        { ...sliced(), remoteUnverified: new Map([['listing-zero', 'SYNC_HTTP_ERROR']]) },
      )
      unitReports.push({ failed: result.slice!.summary.failed })
      return new Response(JSON.stringify({ status: 'ok', slice: result.slice }), { status: 200 })
    }

    const cursor: InventoryRefreshCursor = {
      version: 1,
      runId: 'run-1',
      connectionId: 'connection-1',
      phase: 'AUTOMATION',
      planIndex: 0,
      plans: [{
        kind: 'ALLEGRO',
        accountId: 'account-1',
        historyGroupId: 'history-1',
        batches: [['listing-zero', 'listing-ok']],
        batchIndex: 0,
        completedListingIds: [],
        partial: createEmptyBatchState(),
        completedBatches: [],
        skippedReason: null,
      }],
      nextAdvanceAt: null,
      lastStopReason: null,
    }
    const persisted: InventoryRefreshState[] = []

    const run = await executeInventoryRefreshSlice({
      trigger: 'SCHEDULED',
      runId: 'run-1',
      cursor,
      state: {
        status: 'RUNNING',
        importStatus: 'SUCCESS',
        rowsImported: 2,
        changedItemCount: 2,
        automationDetailsJson: serializeAutomationDetailsWithCursor({ version: 1, platforms: [] }, cursor),
        error: null,
        finishedAt: null,
      },
      assertOwned: async () => {},
      persist: async state => { persisted.push(state) },
      advance: next => runInventoryRefreshSlice('connection-1', next, {
        executionLease: { name: 'inventory-refresh:connection-1', ownerId: 'owner-1' },
        assertOwned: async () => {},
        transport,
        now: () => 0,
      }),
    })

    const plan = cursor.plans[0]
    assert.ok(plan.kind === 'ALLEGRO')
    assert.deepEqual(unitReports, [{ failed: 1 }], 'execution unit summary')
    assert.equal(plan.completedBatches[0].ok, false, 'batch summary')
    assert.equal((plan.completedBatches[0].details as { summary: { failed: number } }).summary.failed, 1)
    assert.equal(run.status, 'FAILED', 'run status')
    assert.match(run.error ?? '', /ZERO-SKU/, 'run error names the SKU')

    const finalState = persisted.at(-1)!
    assert.equal(readInventoryRefreshCursor(finalState.automationDetailsJson), null)
    // The persisted details already are the run diagnostics the history UI reads.
    const diagnostics = JSON.parse(finalState.automationDetailsJson!) as ReturnType<typeof buildInventoryAutomationDiagnostics>
    assert.equal(diagnostics.platforms[0].failed, 1)
    assert.equal(diagnostics.platforms[0].failedBatches, 1)
    const failedListing = diagnostics.platforms[0].failedListings.items[0]
    assert.equal(failedListing.sku, 'ZERO-SKU')
    assert.match(failedListing.taskMessage ?? '', /REMOTE_UNVERIFIED_ZERO_STOCK/)
    assert.match(failedListing.taskMessage ?? '', /SYNC_HTTP_ERROR/)
    assert.deepEqual(recorder.calls, ['pushStock:listing-ok'], 'only the verified listing was mutated')
  })
})
