/*
 * Publication intent, auto-pause ownership and publication journal recovery
 * against real PostgreSQL (PGlite) with every repository migration applied.
 *
 * Real code under test: migration 0029 (constraints + trigger), the intent
 * CAS functions, the publication store/journal, executePublicationOperation
 * and syncAllegroInventoryRows. Only Allegro is faked, including crashes
 * right after a journal write.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import { eq } from 'drizzle-orm'
import { listingDesiredStates } from '@karcher-commerce-hub/database'
import {
  createTestDatabase,
  journal,
  readDesired,
  seedListing,
  setRemotePublication,
  type SeededListing,
  type TestDatabase,
} from './support/postgres.ts'
import {
  beginAutomaticActivateIntent,
  beginAutomaticEndIntent,
  classifyPublicationOwnership,
  confirmAutomaticEndOwnership,
  manualPublicationIntent,
  revertAutomaticEndIntent,
} from '../src/allegro-publication-intent.ts'
import {
  createPublicationLeaseStore,
  latestPublicationCommand,
  persistPublicationObservation,
  publicationCommandAttemptedAt,
  readPublicationSnapshot,
  recordPublicationAudit,
  savePublicationIntent,
} from '../src/allegro-publication-store.ts'
import {
  executePublicationOperation,
  type PublicationAdapter,
  type PublicationAudit,
  type PublicationResult,
} from '../src/allegro-publication-operation.ts'
import { lookupPublicationTask, publicationCommandDiagnostic, type PublicationTaskLookup } from '../src/allegro-publication-task.ts'
import { applyAllegroDesiredStock, syncAllegroInventoryRows, type AllegroInventorySyncRow } from '../src/allegro-inventory-sync.ts'
import { createSliceBudget, INVENTORY_REFRESH_SLICE_DEFAULTS } from '../src/inventory-refresh-slice.ts'
import { resolveDesiredStockUpdate } from '../src/allegro-stock-lock.ts'

let t: TestDatabase

before(async () => {
  t = await createTestDatabase()
})

after(async () => {
  await t.close()
})

/* ------------------------------------------------------------------ *
 * Fake Allegro publication API (with crash injection)
 * ------------------------------------------------------------------ */

type SendBehavior = 'APPLY' | 'APPLY_THEN_LOSE_RESPONSE' | 'ACCEPT_WITHOUT_EFFECT' | 'RATE_LIMITED'
type TaskBehavior = 'NORMAL' | 'RATE_LIMITED' | 'TIMEOUT' | 'AUTH_FAILED' | 'UPSTREAM_ERROR'

class FakeAllegro {
  remote = new Map<string, string>()
  /** `applied`: Allegro actually executed this command (its task reports SUCCESS). */
  puts: Array<{ commandId: string; action: string; applied: boolean }> = []
  sendBehavior: SendBehavior = 'APPLY'
  taskBehavior: TaskBehavior = 'NORMAL'
  /** Task lookups answered 'NEW' even for an applied command (task report lags the offer state). */
  taskLag = 0

  taskResponse(commandId: string, offerId: string): Response {
    if (this.taskBehavior === 'TIMEOUT') throw new DOMException('timeout', 'TimeoutError')
    if (this.taskBehavior === 'RATE_LIMITED') return new Response('{}', { status: 429 })
    if (this.taskBehavior === 'AUTH_FAILED') return new Response('{}', { status: 401 })
    if (this.taskBehavior === 'UPSTREAM_ERROR') return new Response(JSON.stringify({ errors: [{ code: 'SERVICE_UNAVAILABLE' }] }), { status: 503 })
    const put = this.puts.find(entry => entry.commandId === commandId)
    if (!put) return new Response(JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'Command not found' }] }), { status: 404 })
    // The task reports what the COMMAND did, independent of later remote changes.
    if (this.taskLag > 0) {
      this.taskLag -= 1
      return new Response(JSON.stringify({ tasks: [{ offer: { id: offerId }, status: 'NEW' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ tasks: [{ offer: { id: offerId }, status: put.applied ? 'SUCCESS' : 'NEW' }] }), { status: 200 })
  }

  /** A previously accepted command takes effect later. */
  complete(offerId: string) {
    const put = this.puts.at(-1)!
    put.applied = true
    this.remote.set(offerId, put.action === 'END' ? 'ENDED' : 'ACTIVE')
  }
}

function target(s: SeededListing) {
  return { listingId: s.listingId, offerId: s.offerId, accountId: s.accountId }
}

/** Real publication operation on PGlite; `crashAfter` aborts the "process" right after that journal status is written. */
async function runPublication(s: SeededListing, allegro: FakeAllegro, options: {
  crashAfter?: string
  attempts?: number
} = {}): Promise<PublicationResult | 'CRASHED' | null> {
  const snapshot = await readPublicationSnapshot(t.db, s.listingId, s.accountId, s.environment)
  if (!snapshot) return null
  const lookups = new Map<string, PublicationTaskLookup>()
  let crashed = false
  const audit = async (event: PublicationAudit) => {
    if (crashed) throw new Error('CRASHED')
    await recordPublicationAudit(t.db, target(s), event)
    if (options.crashAfter && event.status === options.crashAfter) {
      crashed = true
      throw new Error('CRASHED')
    }
  }
  const adapter: PublicationAdapter = {
    leases: createPublicationLeaseStore(t.db),
    readLocal: () => readPublicationSnapshot(t.db, s.listingId, s.accountId, s.environment),
    readRemote: async () => {
      const status = allegro.remote.get(s.offerId)
      if (!status) throw new Error('Allegro publication GET: HTTP 404')
      return { status, observedAt: new Date() }
    },
    persistObservation: observation => persistPublicationObservation(t.db, target(s), observation),
    latestCommand: () => latestPublicationCommand(t.db, target(s)),
    audit,
    campaignSafe: async () => true,
    send: async (action, commandId) => {
      if (crashed) throw new Error('CRASHED')
      if (allegro.sendBehavior === 'RATE_LIMITED') return { accepted: false, reason: 'RATE_LIMITED' }
      allegro.puts.push({ commandId, action, applied: allegro.sendBehavior !== 'ACCEPT_WITHOUT_EFFECT' })
      if (allegro.sendBehavior !== 'ACCEPT_WITHOUT_EFFECT') {
        allegro.remote.set(s.offerId, action === 'END' ? 'ENDED' : 'ACTIVE')
      }
      if (allegro.sendBehavior === 'APPLY_THEN_LOSE_RESPONSE') throw new Error('socket hang up')
      return { accepted: true }
    },
    task: async commandId => {
      const lookup = await lookupPublicationTask(async () => allegro.taskResponse(commandId, s.offerId), s.offerId)
      lookups.set(commandId, lookup)
      return lookup.state
    },
    describeCommand: async (command, ambiguous) => publicationCommandDiagnostic({
      command,
      lastLookup: lookups.get(command.commandId) ?? null,
      ambiguousDispatch: ambiguous,
      attemptedAt: await publicationCommandAttemptedAt(t.db, target(s), command.commandId),
    }),
    wait: async () => {},
  }
  const action = snapshot.desiredPublication === 'INACTIVE' ? 'END' : 'ACTIVATE'
  const result = await executePublicationOperation(target(s), adapter, {
    action,
    intentVersion: snapshot.intentVersion,
    publicationIntentId: snapshot.publicationIntentId ?? null,
    attempts: options.attempts ?? 2,
  })
  return crashed ? 'CRASHED' : result
}

const scope = (s: SeededListing) => ({ accountId: s.accountId, environment: s.environment })

async function attemptedCount(s: SeededListing) {
  return (await journal(t.pg, s.listingId)).filter(event => event.event_type === 'PUBLICATION_OPERATION' && event.new_value === 'ATTEMPTED').length
}

/* ------------------------------------------------------------------ *
 * Inventory integration (real syncAllegroInventoryRows on PGlite)
 * ------------------------------------------------------------------ */

async function inventoryRow(s: SeededListing, targetStock: number): Promise<AllegroInventorySyncRow> {
  const desired = await readDesired(t.pg, s.listingId)
  const { rows } = await t.pg.query<{ publication_status: string; stock_available: number }>(
    'select publication_status, stock_available from listing_remote_states where listing_id = $1', [s.listingId])
  return {
    sku: `SKU-${s.offerId}`,
    listingId: s.listingId,
    offerId: s.offerId,
    targetStock,
    remoteStock: rows[0].stock_available,
    desiredStock: targetStock,
    stockLocked: desired.stock_locked,
    stockAutoPaused: desired.stock_auto_paused,
    autoStockSync: true,
    publicationStatus: rows[0].publication_status,
    desiredPublicationStatus: desired.desired_publication_status,
    publicationIntentSource: desired.publication_intent_source,
    publicationIntentId: desired.publication_intent_id,
    duplicateOfferCount: 1,
    sourceMissing: false,
  }
}

async function runInventory(s: SeededListing, allegro: FakeAllegro, targetStock: number, options: {
  pushStatus?: (listingId: string) => Promise<{ ok: boolean; status: number; details: Record<string, unknown> }>
  withScope?: boolean
} = {}) {
  const calls: string[] = []
  const pushStatus = options.pushStatus ?? (async (listingId: string) => {
    calls.push(`pushStatus:${listingId}`)
    const result = await runPublication(s, allegro)
    if (result === null || result === 'CRASHED') return { ok: false, status: 502, details: { status: 'error' } }
    const ok = result.outcome === 'FIXED' || result.outcome === 'ALREADY_FIXED'
    const status = ok ? 200 : result.outcome === 'PENDING_TIMEOUT' ? 202 : result.outcome === 'SKIPPED_SAFETY' ? 409
      : result.outcome === 'FAILED' && result.reason === 'RATE_LIMITED' ? 429 : 502
    return { ok, status, details: { ...result, status: ok ? 'ok' : 'error' } }
  })
  const result = await syncAllegroInventoryRows(t.db, [await inventoryRow(s, targetStock)], {
    pushStock: async listingId => { calls.push(`pushStock:${listingId}`); return { ok: true, status: 200, details: { status: 'ok' } } },
    pushStatus: async listingId => { const response = await pushStatus(listingId); calls.push(`status:${response.status}`); return response },
    reconcileOwnership: async listingId => { calls.push(`reconcileOwnership:${listingId}`); return { cleared: false } },
    refresh: async () => ({ ok: true, details: null }),
  }, {
    slice: createSliceBudget(INVENTORY_REFRESH_SLICE_DEFAULTS, 0),
    sliceWait: async () => {},
    now: () => 0,
    remoteUnverified: new Map(),
    ...(options.withScope === false ? {} : { publicationOwnership: scope(s) }),
  })
  return { result, calls, outcome: result.results[0] }
}

function allegroFor(s: SeededListing, status = 'ACTIVE') {
  const allegro = new FakeAllegro()
  allegro.remote.set(s.offerId, status)
  return allegro
}

/* ------------------------------------------------------------------ *
 * 1–2. Migration, legacy rows, trigger and constraints
 * ------------------------------------------------------------------ */

void describe('migration 0029 and legacy rows', () => {
  void it('leaves pre-existing rows without intent and grants no new ownership', async () => {
    const legacy = await createTestDatabase({ stopBefore: '0029_publication_intent' })
    try {
      const autoPaused = await seedListing(legacy.pg, { desiredPublicationStatus: 'INACTIVE', stockAutoPaused: true, remotePublicationStatus: 'ENDED' })
      const manualLike = await seedListing(legacy.pg, { desiredPublicationStatus: 'INACTIVE', stockAutoPaused: false, remotePublicationStatus: 'ENDED' })
      await legacy.migrateRest()

      const pausedRow = await readDesired(legacy.pg, autoPaused.listingId)
      const manualRow = await readDesired(legacy.pg, manualLike.listingId)
      assert.equal(pausedRow.publication_intent_source, null)
      assert.equal(pausedRow.publication_intent_id, null)
      assert.equal(classifyPublicationOwnership({ stockAutoPaused: true, desiredPublicationStatus: 'INACTIVE' }), 'LEGACY_AUTO_PAUSED')
      assert.equal(classifyPublicationOwnership({ stockAutoPaused: manualRow.stock_auto_paused, desiredPublicationStatus: manualRow.desired_publication_status }), 'UNRESOLVED')
    } finally {
      await legacy.close()
    }
  })

  void it('rejects invalid intent sources and inconsistent intent metadata', async () => {
    const s = await seedListing(t.pg)
    await assert.rejects(
      t.pg.query(`update listing_desired_states set publication_intent_source='ROBOT', publication_intent_id=gen_random_uuid(), publication_intent_at=now() where listing_id=$1`, [s.listingId]),
      /publication_intent_source_check/,
    )
    await assert.rejects(
      t.pg.query(`update listing_desired_states set publication_intent_source='MANUAL', publication_intent_at=now() where listing_id=$1`, [s.listingId]),
      /publication_intent_consistency_check/,
    )
  })

  void it('clears the intent when an unaware writer changes the publication status (fail closed)', async () => {
    const s = await seedListing(t.pg)
    assert.ok(await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null }))
    await t.db.update(listingDesiredStates).set({ desiredPublicationStatus: 'ACTIVE' }).where(eq(listingDesiredStates.listingId, s.listingId))
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.publication_intent_source, null)
    assert.equal(row.publication_intent_id, null)
  })

  void it('clears the intent when an unaware writer changes the auto-pause flag', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    await t.pg.query('update listing_desired_states set stock_auto_paused = true where listing_id = $1', [s.listingId])
    assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_source, null)
  })

  void it('preserves the intent on stock-only and price-only updates (inventory overwriting updated_by)', async () => {
    const s = await seedListing(t.pg, { desiredStock: 3 })
    await savePublicationIntent(t.db, s.listingId, 'INACTIVE')
    const before = await readDesired(t.pg, s.listingId)

    // Real inventory desired-stock writer: sets updated_by = COMMERCE_HUB_INVENTORY.
    await applyAllegroDesiredStock(t.db, [{
      sku: 'x', listingId: s.listingId, offerId: s.offerId, targetStock: 9, remoteStock: 3, desiredStock: 3,
      stockLocked: false, stockAutoPaused: false, autoStockSync: true, publicationStatus: 'ACTIVE',
      desiredPublicationStatus: 'INACTIVE', duplicateOfferCount: 1, sourceMissing: false,
    }])
    await t.pg.query('update listing_desired_states set regular_price_minor = 12345, price_locked = true where listing_id = $1', [s.listingId])

    const after = await readDesired(t.pg, s.listingId)
    assert.equal(after.updated_by, 'COMMERCE_HUB_INVENTORY', 'the author column was overwritten')
    assert.equal(after.publication_intent_source, 'MANUAL', 'but the publication intent was not')
    assert.equal(after.publication_intent_id, before.publication_intent_id)
    assert.equal(classifyPublicationOwnership({
      stockAutoPaused: after.stock_auto_paused, desiredPublicationStatus: after.desired_publication_status,
      publicationIntentSource: after.publication_intent_source, publicationIntentId: after.publication_intent_id,
    }), 'MANUAL')
  })
})

/* ------------------------------------------------------------------ *
 * 3–7. CAS, manual writers and concurrency
 * ------------------------------------------------------------------ */

void describe('intent CAS and manual writers', () => {
  void it('creates an automatic END intent once and reuses it while pending', async () => {
    const s = await seedListing(t.pg)
    const first = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    assert.ok(first)
    const again = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: first })
    assert.equal(again, first, 'pending automatic END keeps its intent id')
    const stale = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    assert.equal(stale, null, 'stale expectation is refused')
  })

  void it('refuses automatic END over manual, unresolved, locked or disabled state', async () => {
    const manual = await seedListing(t.pg)
    await savePublicationIntent(t.db, manual.listingId, 'INACTIVE')
    const m = await readDesired(t.pg, manual.listingId)
    assert.equal(await beginAutomaticEndIntent(t.db, manual.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: m.publication_intent_id }), null)

    const legacy = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE' })
    assert.equal(await beginAutomaticEndIntent(t.db, legacy.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: null }), null)

    const locked = await seedListing(t.pg, { stockLocked: true })
    assert.equal(await beginAutomaticEndIntent(t.db, locked.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null }), null)

    const disabled = await seedListing(t.pg, { autoStockSync: false })
    assert.equal(await beginAutomaticEndIntent(t.db, disabled.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null }), null)
  })

  void it('records a new MANUAL intent even for a same-value manual decision', async () => {
    const s = await seedListing(t.pg)
    const automatic = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    await savePublicationIntent(t.db, s.listingId, 'INACTIVE')
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.desired_publication_status, 'INACTIVE')
    assert.equal(row.publication_intent_source, 'MANUAL')
    assert.notEqual(row.publication_intent_id, automatic)
  })

  void it('ACCEPT, DISCARD and takeover update shapes record a MANUAL intent', async () => {
    for (const shape of [
      (id: string) => t.db.update(listingDesiredStates).set({ desiredPublicationStatus: 'INACTIVE', ...manualPublicationIntent(), updatedBy: 'COMMERCE_HUB_ACCEPT' }).where(eq(listingDesiredStates.listingId, id)),
      (id: string) => t.db.update(listingDesiredStates).set({ desiredPublicationStatus: 'ACTIVE', ...manualPublicationIntent(), updatedBy: 'COMMERCE_HUB_DISCARD' }).where(eq(listingDesiredStates.listingId, id)),
    ]) {
      const s = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE' })
      await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: null })
      await shape(s.listingId)
      assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_source, 'MANUAL')
    }

    // Takeover: positive desired stock on an auto-paused listing.
    const paused = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE', stockAutoPaused: true })
    const update = resolveDesiredStockUpdate({ stockAutoPaused: true } as never, 7)
    await t.db.update(listingDesiredStates).set({ ...update, ...('desiredPublicationStatus' in update ? manualPublicationIntent() : {}) })
      .where(eq(listingDesiredStates.listingId, paused.listingId))
    const row = await readDesired(t.pg, paused.listingId)
    assert.equal(row.stock_auto_paused, false)
    assert.equal(row.publication_intent_source, 'MANUAL')
  })

  void it('every publication intent writer in the source records a MANUAL intent or uses the CAS functions', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    assert.match(index, /desiredPublicationStatus:\s+nextDesiredPublicationStatus,\s+\/\/[^\n]*\n\s+\.\.\.manualPublicationIntent\(now\)/)
    // DISCARD writes the status column only together with a new MANUAL intent.
    assert.match(index, /\.\.\.\(publicationChanged\s+\?\s+\{\s+desiredPublicationStatus:\s+nextPublicationStatus,\s+\.\.\.manualPublicationIntent\(now\),\s+\}\s+:\s+\{\}\)/)
    const discard = index.slice(index.indexOf("'/allegro/listings/discard-desired-differences'"), index.indexOf('Discarding desired differences failed:'))
    assert.equal((discard.match(/desiredPublicationStatus:\s+nextPublicationStatus/g) ?? []).length, 1, 'no unconditional status write in DISCARD')
    assert.match(index, /'desiredPublicationStatus' in desiredStockUpdate\s+\?\s+manualPublicationIntent\(\)/)
    const store = readFileSync(new URL('../src/allegro-publication-store.ts', import.meta.url), 'utf8')
    assert.match(store, /publication_intent_source='MANUAL',publication_intent_id=gen_random_uuid\(\)/)
    const inventory = readFileSync(new URL('../src/allegro-inventory-sync.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(inventory, /\.set\(\{\s*desiredPublicationStatus/, 'no unguarded inventory publication writer')
  })

  void it('a manual decision racing an automatic intent always wins (CAS interleavings)', async () => {
    for (const manualFirst of [true, false]) {
      const s = await seedListing(t.pg)
      const pending = manualFirst
        ? [savePublicationIntent(t.db, s.listingId, 'ACTIVE'), beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })]
        : [beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null }), savePublicationIntent(t.db, s.listingId, 'ACTIVE')]
      await Promise.all(pending)
      const row = await readDesired(t.pg, s.listingId)
      assert.equal(row.publication_intent_source, 'MANUAL', `manualFirst=${manualFirst}`)
      assert.equal(row.desired_publication_status, 'ACTIVE')
    }
  })
})

/* ------------------------------------------------------------------ *
 * 8–15. Ownership evidence, interruptions and journal recovery
 * ------------------------------------------------------------------ */

void describe('ownership evidence and interruption recovery', () => {
  void it('confirms ownership after a successful END with matching command and intent', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    const { result, outcome } = await runInventory(s, allegro, 0)

    assert.equal(outcome.status, 'SUCCESS')
    assert.equal(result.summary.autoPaused, 1)
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.stock_auto_paused, true)
    assert.equal(row.publication_intent_source, 'AUTOMATIC')
    assert.equal(allegro.puts.length, 1)
    assert.ok((await journal(t.pg, s.listingId)).some(event => event.event_type === 'OWNERSHIP' && event.new_value === 'true'))
  })

  void it('1: interruption before intent persistence leaves nothing to recover', async () => {
    const s = await seedListing(t.pg)
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.publication_intent_id, null)
    assert.equal((await journal(t.pg, s.listingId)).length, 0)
    const { outcome } = await runInventory(s, allegroFor(s), 0)
    assert.equal(outcome.status, 'SUCCESS')
  })

  void it('2: interruption after intent, before journal — END retried with the same intent, ENDED never claimed', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })

    // Externally ended meanwhile: no command evidence, never claimed.
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)

    // Still ACTIVE with zero target: the END runs and keeps the same intent.
    await setRemotePublication(t.pg, s.listingId, 'ACTIVE')
    const allegro = allegroFor(s)
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'SUCCESS')
    assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_id, intent)
  })

  void it('2b: interruption after intent, stock returns above zero — intent reverted, no END', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    const { calls } = await runInventory(s, allegro, 6)
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.desired_publication_status, 'ACTIVE')
    assert.equal(row.publication_intent_source, 'AUTOMATIC')
    assert.equal(allegro.puts.length, 0)
    assert.ok(!calls.some(call => call.startsWith('pushStatus')))
  })

  void it('3/9: interruption after ATTEMPTED, before dispatch — task 404 keeps the command, no replay, no new command id', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    assert.equal(await runPublication(s, allegro, { crashAfter: 'ATTEMPTED' }), 'CRASHED')
    assert.equal(allegro.puts.length, 0)

    const recovery = await runPublication(s, allegro)
    assert.ok(recovery && recovery !== 'CRASHED')
    assert.equal(recovery.outcome, 'PENDING_TIMEOUT')
    assert.equal(recovery.diagnostic?.taskState, 'TASK_NOT_FOUND')
    assert.equal(recovery.diagnostic?.intentId, (await readDesired(t.pg, s.listingId)).publication_intent_id)
    assert.ok((recovery.diagnostic?.commandAgeMs ?? -1) >= 0)
    assert.equal(allegro.puts.length, 0, 'never resent')
    assert.equal(await attemptedCount(s), 1, 'no replacement command id')
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })

  void it('4: interruption after dispatch, before response — read back, single command, ownership confirmed', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'APPLY_THEN_LOSE_RESPONSE'
    const first = await runPublication(s, allegro, { crashAfter: 'PENDING' })
    assert.equal(first, 'CRASHED')

    allegro.sendBehavior = 'APPLY'
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'SUCCESS')
    assert.equal(outcome.reason, 'AUTOMATIC_OWNERSHIP_CONFIRMED')
    assert.equal(allegro.puts.length, 1, 'exactly one remote command')
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, true)
  })

  void it('5: interruption after remote completion, before ownership persistence — confirmed from journal', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    const done = await runPublication(s, allegro)
    assert.ok(done && done !== 'CRASHED' && done.outcome === 'FIXED')
    // Crash here: confirmation never ran.
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)

    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), true)
    assert.equal(allegro.puts.length, 1)
  })

  void it('6: a manual change during pending automation invalidates every later ownership update', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
    const pending = await runPublication(s, allegro)
    assert.ok(pending && pending !== 'CRASHED' && pending.outcome === 'PENDING_TIMEOUT')

    await savePublicationIntent(t.db, s.listingId, 'INACTIVE') // same value, user decision
    allegro.complete(s.offerId) // our command completes later
    await setRemotePublication(t.pg, s.listingId, 'ENDED')

    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
    const { calls, outcome } = await runInventory(s, allegro, 6)
    assert.equal(outcome.status, 'MANUAL_INACTIVE')
    assert.ok(!calls.some(call => call.startsWith('pushStatus')), 'no automatic reactivation')
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })

  void it('8/11: an ENDED offer without automatic END evidence is never claimed', async () => {
    const s = await seedListing(t.pg, { remotePublicationStatus: 'ENDED' })
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s, 'ENDED')
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'OWNERSHIP_UNRESOLVED')
    assert.equal(allegro.puts.length, 0)
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })

  void it('12: stale journal intentId never confirms the current intent', async () => {
    const s = await seedListing(t.pg)
    const oldIntent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    await runPublication(s, allegro) // SUCCESS bound to oldIntent
    await savePublicationIntent(t.db, s.listingId, 'ACTIVE')
    const manual = await readDesired(t.pg, s.listingId)
    const newIntent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: manual.publication_intent_id })
    assert.ok(newIntent && newIntent !== oldIntent)
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, newIntent, scope(s)), false)
  })

  void it('12b: evidence journaled after the current intent but bound to another intent never confirms', async () => {
    const s = await seedListing(t.pg)
    const current = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    // Same listing, offer, account and action, newer than the intent — only the intentId differs.
    for (const status of ['ATTEMPTED', 'SUCCESS']) {
      await recordPublicationAudit(t.db, target(s), {
        action: 'END', status, commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        intentId: '99999999-9999-4999-8999-999999999999',
        ...(status === 'SUCCESS' ? { commandEvidence: 'ALLEGRO_TASK_SUCCESS' as const } : {}),
      })
    }
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, current!, scope(s)), false)

    // Positive control: the same evidence bound to the current intent confirms.
    for (const status of ['ATTEMPTED', 'SUCCESS']) {
      await recordPublicationAudit(t.db, target(s), {
        action: 'END', status, commandId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', intentId: current,
        ...(status === 'SUCCESS' ? { commandEvidence: 'ALLEGRO_TASK_SUCCESS' as const } : {}),
      })
    }
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, current!, scope(s)), true)
  })

  void it('15: HTTP 202/PENDING does not confirm ownership', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
    const { outcome, result } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'PENDING')
    assert.equal(result.summary.autoPaused, 0)
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.stock_auto_paused, false)
    assert.equal(classifyPublicationOwnership({
      stockAutoPaused: row.stock_auto_paused, desiredPublicationStatus: row.desired_publication_status,
      publicationIntentSource: row.publication_intent_source, publicationIntentId: row.publication_intent_id,
    }), 'PENDING_AUTOMATIC', 'pending, never manual')
  })

  void it('10: source stock back above zero while a command is unresolved — no revert, no END, no replay', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
    await runPublication(s, allegro) // unresolved command
    const { outcome, calls } = await runInventory(s, allegro, 8)
    assert.equal(outcome.status, 'PUBLICATION_COMMAND_UNRESOLVED')
    assert.equal((await readDesired(t.pg, s.listingId)).desired_publication_status, 'INACTIVE')
    assert.equal(allegro.puts.length, 1)
    assert.ok(!calls.some(call => call.startsWith('pushStatus')))
    assert.equal(await revertAutomaticEndIntent(t.db, s.listingId, (await readDesired(t.pg, s.listingId)).publication_intent_id!), false)
  })

  void it('11: identity mismatch (other account / environment) never confirms; stock lock blocks the intent', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    await runPublication(s, allegroFor(s))
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const other = await seedListing(t.pg)
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, { accountId: other.accountId, environment: 'PRODUCTION' }), false)
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, { accountId: s.accountId, environment: 'SANDBOX' }), false)
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), true)
    assert.equal(await readPublicationSnapshot(t.db, s.listingId, other.accountId, 'PRODUCTION'), null, 'snapshot scoped to account')

    const locked = await seedListing(t.pg, { stockLocked: true })
    const { outcome } = await runInventory(locked, allegroFor(locked), 0)
    assert.equal(outcome.status, 'STOCK_LOCKED')
    assert.equal((await readDesired(t.pg, locked.listingId)).publication_intent_id, null)
  })

  void it('11b: duplicate SKU protection is unchanged and records no intent', async () => {
    const s = await seedListing(t.pg)
    const row = { ...(await inventoryRow(s, 0)), duplicateOfferCount: 2 }
    const result = await syncAllegroInventoryRows(t.db, [row], {
      pushStock: async () => ({ ok: true, status: 200, details: {} }),
      pushStatus: async () => { throw new Error('must not run') },
      refresh: async () => ({ ok: true, details: null }),
    }, { slice: createSliceBudget(INVENTORY_REFRESH_SLICE_DEFAULTS, 0), sliceWait: async () => {}, now: () => 0, remoteUnverified: new Map(), publicationOwnership: scope(s) })
    assert.equal(result.results[0].status, 'DUPLICATE_SKU')
    assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_id, null)
  })

  void it('13/12: rate limit, timeout and ambiguous outcomes never resend or close a command', async () => {
    // Rate-limited PUT: not accepted, terminal FAILED, HTTP 429 for the slice stop.
    const limited = await seedListing(t.pg)
    const limitedAllegro = allegroFor(limited)
    limitedAllegro.sendBehavior = 'RATE_LIMITED'
    const { calls } = await runInventory(limited, limitedAllegro, 0)
    assert.ok(calls.includes('status:429'))
    assert.equal(limitedAllegro.puts.length, 0)
    assert.equal((await readDesired(t.pg, limited.listingId)).stock_auto_paused, false)

    // Ambiguous dispatch + unreadable task states: one command, kept unresolved.
    for (const taskBehavior of ['RATE_LIMITED', 'TIMEOUT', 'AUTH_FAILED', 'UPSTREAM_ERROR'] as const) {
      const s = await seedListing(t.pg)
      await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
      const allegro = allegroFor(s)
      allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
      allegro.taskBehavior = taskBehavior
      const first = await runPublication(s, allegro)
      const second = await runPublication(s, allegro)
      assert.ok(first && first !== 'CRASHED' && first.outcome === 'PENDING_TIMEOUT', taskBehavior)
      assert.ok(second && second !== 'CRASHED' && second.outcome === 'PENDING_TIMEOUT', taskBehavior)
      assert.equal(second.diagnostic?.taskState, taskBehavior === 'AUTH_FAILED' ? 'AUTH_FAILED' : taskBehavior === 'UPSTREAM_ERROR' ? 'UPSTREAM_ERROR' : taskBehavior)
      assert.equal(allegro.puts.length, 1, `${taskBehavior}: no resend`)
      assert.equal(await attemptedCount(s), 1, `${taskBehavior}: no replacement id`)
    }

    const ambiguous = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, ambiguous.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const ambiguousAllegro = allegroFor(ambiguous)
    ambiguousAllegro.sendBehavior = 'APPLY_THEN_LOSE_RESPONSE'
    ambiguousAllegro.remote.set(ambiguous.offerId, 'ACTIVE')
    ambiguousAllegro.taskBehavior = 'TIMEOUT'
    // Remote effect not visible yet: verification times out, command stays unresolved.
    const originalSet = ambiguousAllegro.remote.set.bind(ambiguousAllegro.remote)
    ambiguousAllegro.remote.set = (key: string, value: string) => (value === 'ENDED' ? ambiguousAllegro.remote : originalSet(key, value))
    const outcome = await runPublication(ambiguous, ambiguousAllegro)
    assert.ok(outcome && outcome !== 'CRASHED' && outcome.outcome === 'PENDING_TIMEOUT')
    assert.equal(outcome.diagnostic?.taskState, 'TIMEOUT')
    assert.equal(ambiguousAllegro.puts.length, 1)
  })

  void it('14: never reactivates manually inactive or unresolved legacy offers automatically', async () => {
    const manual = await seedListing(t.pg, { remotePublicationStatus: 'ENDED' })
    await savePublicationIntent(t.db, manual.listingId, 'INACTIVE')
    const legacy = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE', remotePublicationStatus: 'ENDED' })

    for (const s of [manual, legacy]) {
      const allegro = allegroFor(s, 'ENDED')
      const { outcome, calls } = await runInventory(s, allegro, 9)
      assert.equal(outcome.status, 'MANUAL_INACTIVE')
      assert.equal(allegro.puts.length, 0)
      assert.ok(!calls.some(call => call.startsWith('pushStatus') || call.startsWith('pushStock')))
    }
  })

  void it('confirmed automatic ownership reactivates with an AUTOMATIC intent once stock returns', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    await runInventory(s, allegro, 0) // END + confirmed ownership
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const { calls } = await runInventory(s, allegro, 4)
    assert.ok(calls.some(call => call.startsWith('pushStatus')))
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.desired_publication_status, 'ACTIVE')
    assert.equal(row.publication_intent_source, 'AUTOMATIC')
    assert.equal(allegro.puts.filter(put => put.action === 'ACTIVATE').length, 1)
  })

  void it('without the ownership scope nothing is ever confirmed (fail closed)', async () => {
    const s = await seedListing(t.pg)
    const { outcome } = await runInventory(s, allegroFor(s), 0, { withScope: false })
    assert.equal(outcome.status, 'OWNERSHIP_UNRESOLVED')
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })

  void it('legacy auto-pause keeps its reactivation behavior without new privileges', async () => {
    const s = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE', stockAutoPaused: true, remotePublicationStatus: 'ENDED' })
    const allegro = allegroFor(s, 'ENDED')
    const intent = await beginAutomaticActivateIntent(t.db, s.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: null })
    assert.ok(intent, 'legacy auto-paused listings may still be reactivated, as before')
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.stock_auto_paused, true, 'auto-pause flag is not granted or changed by the intent')
    assert.equal(allegro.puts.length, 0)
  })
})

/* ------------------------------------------------------------------ *
 * Pre-commit safety review regressions
 * ------------------------------------------------------------------ */

async function latestSuccess(s: SeededListing) {
  return (await journal(t.pg, s.listingId))
    .filter(event => event.event_type === 'PUBLICATION_OPERATION' && event.new_value === 'SUCCESS').at(-1)
}

void describe('safety review: ownership evidence', () => {
  void it('R1: remote ENDED by another actor while our END is unresolved is journaled REMOTE_STATE_ONLY and never confers ownership', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
    const pending = await runPublication(s, allegro)
    assert.ok(pending && pending !== 'CRASHED' && pending.outcome === 'PENDING_TIMEOUT')

    allegro.remote.set(s.offerId, 'ENDED') // manual END in Allegro / sell-out, NOT our command
    const settled = await runPublication(s, allegro)
    assert.ok(settled && settled !== 'CRASHED' && settled.outcome === 'FIXED', 'the publication goal itself is met')
    const success = await latestSuccess(s)
    assert.equal(success?.metadata.commandEvidence, 'REMOTE_STATE_ONLY')
    assert.equal(success?.metadata.intentId, intent)

    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'OWNERSHIP_UNRESOLVED')
    assert.equal(allegro.puts.length, 1, 'no further command')
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })

  void it('R1b: a command that never reached Allegro (task 404) plus an external END never confers ownership', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    assert.equal(await runPublication(s, allegro, { crashAfter: 'ATTEMPTED' }), 'CRASHED')
    allegro.remote.set(s.offerId, 'ENDED')
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'OWNERSHIP_UNRESOLVED')
    assert.equal((await latestSuccess(s))?.metadata.commandEvidence, 'REMOTE_STATE_ONLY')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
    assert.equal(allegro.puts.length, 0, 'never resent')
  })

  void it('R2: a stale remote observation never authorizes confirmation, even with valid task evidence', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const allegro = allegroFor(s)
    const done = await runPublication(s, allegro)
    assert.ok(done && done !== 'CRASHED' && done.outcome === 'FIXED')
    assert.equal((await latestSuccess(s))?.metadata.commandEvidence, 'ALLEGRO_TASK_SUCCESS')

    await t.pg.query(`update listing_remote_states set publication_status = 'ENDED', updated_at = now() - interval '20 minutes' where listing_id = $1`, [s.listingId])
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
    await setRemotePublication(t.pg, s.listingId, 'ACTIVE') // fresh, but reactivated meanwhile
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), true)
  })

  void it('R1c: a task report lagging the offer state is re-checked within the bounded window, without resending', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    allegro.taskLag = 1
    const { outcome } = await runInventory(s, allegro, 0)
    assert.equal(outcome.status, 'SUCCESS')
    assert.equal((await latestSuccess(s))?.metadata.commandEvidence, 'ALLEGRO_TASK_SUCCESS')
    assert.equal(allegro.puts.length, 1)
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, true)
  })

  void it('R2b: a SUCCESS of another action or listing never counts as END evidence', async () => {
    const s = await seedListing(t.pg)
    const other = await seedListing(t.pg, { accountId: s.accountId, platformId: s.platformId })
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const evidence = { commandEvidence: 'ALLEGRO_TASK_SUCCESS' as const, intentId: intent }
    for (const status of ['ATTEMPTED', 'SUCCESS']) {
      await recordPublicationAudit(t.db, target(s), { action: 'ACTIVATE', status, commandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ...evidence })
      await recordPublicationAudit(t.db, target(other), { action: 'END', status, commandId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', ...evidence })
    }
    assert.equal(await confirmAutomaticEndOwnership(t.db, s.listingId, intent!, scope(s)), false)
  })
})

void describe('safety review: pending END while stock returns', () => {
  void it('C: END pending → stock positive → original END completes → verified run confirms and recovers the offer', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'

    // 1-3: zero stock, END dispatched, Allegro PENDING.
    const first = await runInventory(s, allegro, 0)
    assert.equal(first.outcome.status, 'PENDING')
    const intent = (await readDesired(t.pg, s.listingId)).publication_intent_id

    // 4: stock positive while the END is unresolved: no conflicting command, no stock write, no revert.
    const second = await runInventory(s, allegro, 5)
    assert.equal(second.outcome.status, 'PUBLICATION_COMMAND_UNRESOLVED')
    assert.ok(!second.calls.some(call => call.startsWith('pushStatus') || call.startsWith('pushStock')))
    assert.equal(allegro.puts.length, 1)
    assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_id, intent)

    // 5: the original END completes afterwards; next verified run.
    allegro.complete(s.offerId)
    allegro.sendBehavior = 'APPLY'
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    await runInventory(s, allegro, 5)

    const events = await journal(t.pg, s.listingId)
    assert.ok(events.some(event => event.event_type === 'OWNERSHIP' && event.new_value === 'true' && event.metadata.intentId === intent),
      'ownership confirmed from task evidence of the original command')
    assert.deepEqual(allegro.puts.map(put => put.action), ['END', 'ACTIVATE'], 'one END, then one recovery ACTIVATE')
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.desired_publication_status, 'ACTIVE')
    assert.equal(row.publication_intent_source, 'AUTOMATIC')
    assert.notEqual(row.publication_intent_id, intent)
  })

  void it('C-manual: a manual decision before the late completion takes precedence', async () => {
    const s = await seedListing(t.pg)
    const allegro = allegroFor(s)
    allegro.sendBehavior = 'ACCEPT_WITHOUT_EFFECT'
    await runInventory(s, allegro, 0)
    // Same-value manual decision.
    await savePublicationIntent(t.db, s.listingId, 'INACTIVE')
    allegro.complete(s.offerId)
    allegro.sendBehavior = 'APPLY'
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const { outcome, calls } = await runInventory(s, allegro, 5)
    assert.equal(outcome.status, 'MANUAL_INACTIVE')
    assert.ok(!calls.some(call => call.startsWith('pushStatus')))
    assert.deepEqual(allegro.puts.map(put => put.action), ['END'])
    assert.equal((await readDesired(t.pg, s.listingId)).stock_auto_paused, false)
  })
})

void describe('safety review: guard trigger column semantics and rollback', () => {
  void it('a same-value status write by an unaware writer (previous app version) clears the automatic intent', async () => {
    const s = await seedListing(t.pg)
    await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    // Exactly the pre-0029 savePublicationIntent SET list (main): same value, no intent columns.
    await t.pg.query(`update listing_desired_states set desired_publication_status='INACTIVE', stock_auto_paused=false,
      updated_by='COMMERCE_HUB_UI', updated_at=now() where listing_id=$1`, [s.listingId])
    const row = await readDesired(t.pg, s.listingId)
    assert.equal(row.publication_intent_id, null)
    assert.equal(classifyPublicationOwnership({
      stockAutoPaused: row.stock_auto_paused, desiredPublicationStatus: row.desired_publication_status,
      publicationIntentSource: row.publication_intent_source, publicationIntentId: row.publication_intent_id,
    }), 'UNRESOLVED')

    // After re-deploy: never reverted or reactivated automatically.
    const allegro = allegroFor(s, 'ENDED')
    await setRemotePublication(t.pg, s.listingId, 'ENDED')
    const { outcome } = await runInventory(s, allegro, 7)
    assert.equal(outcome.status, 'MANUAL_INACTIVE')
    assert.equal(allegro.puts.length, 0)
  })

  void it('lock, flag, price and stock-only DISCARD writes keep the intent; a repeated pending END is a read', async () => {
    const s = await seedListing(t.pg)
    const intent = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: null })
    const before = await readDesired(t.pg, s.listingId)

    const again = await beginAutomaticEndIntent(t.db, s.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: intent })
    assert.equal(again, intent)
    await t.db.update(listingDesiredStates).set({ regularPriceMinor: 999, desiredStock: 2, priceLocked: false, updatedBy: 'COMMERCE_HUB_DISCARD' })
      .where(eq(listingDesiredStates.listingId, s.listingId))
    await t.db.update(listingDesiredStates).set({ priceLocked: true, updatedBy: 'COMMERCE_HUB_UI' }).where(eq(listingDesiredStates.listingId, s.listingId))
    await t.db.update(listingDesiredStates).set({ autoStockSync: true, updatedBy: 'COMMERCE_HUB_UI' }).where(eq(listingDesiredStates.listingId, s.listingId))

    const after = await readDesired(t.pg, s.listingId)
    assert.equal(after.publication_intent_id, intent)
    assert.equal(after.publication_intent_source, 'AUTOMATIC')
    assert.equal(after.publication_intent_at?.getTime(), before.publication_intent_at?.getTime(), 'intent time unchanged, evidence window intact')
  })

  void it('a repeated pending automatic activation keeps its intent', async () => {
    const s = await seedListing(t.pg, { desiredPublicationStatus: 'INACTIVE', stockAutoPaused: true, remotePublicationStatus: 'ENDED' })
    const first = await beginAutomaticActivateIntent(t.db, s.listingId, { desiredPublicationStatus: 'INACTIVE', publicationIntentId: null })
    assert.ok(first)
    const again = await beginAutomaticActivateIntent(t.db, s.listingId, { desiredPublicationStatus: 'ACTIVE', publicationIntentId: first })
    assert.equal(again, first)
    assert.equal((await readDesired(t.pg, s.listingId)).publication_intent_id, first)
  })
})
