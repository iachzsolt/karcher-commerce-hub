import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { executePublicationOperation, withPublicationLease, publicationLeaseName, PUBLICATION_LEASE_MS, PUBLICATION_FRESH_MS,
  type PublicationAdapter, type PublicationAudit, type PublicationCommand, type PublicationSnapshot, type PublicationLeaseStore } from '../src/allegro-publication-operation.js'
import { createPublicationLeaseStore, persistPublicationObservation, savePublicationIntent } from '../src/allegro-publication-store.js'
import { needsInactivePublicationVerification, INACTIVE_PUBLICATION_STALE_MS } from '../../web/src/utils/publicationFreshness.js'

const target = { listingId: '11111111-1111-4111-8111-111111111111', offerId: '18673481333', accountId: '22222222-2222-4222-8222-222222222222' }
const now = new Date('2026-10-14T12:00:00Z')
function memoryLease() {
  let clock = now.getTime()
  const entries = new Map<string, { owner: string; expires: number }>()
  const store: PublicationLeaseStore = {
    acquire: async (name, owner) => {
      if ((entries.get(name)?.expires ?? 0) > clock) return false
      entries.set(name, { owner, expires: clock + PUBLICATION_LEASE_MS })
      return true
    },
    renew: async (name, owner) => {
      const entry = entries.get(name)
      if (!entry || entry.owner !== owner || entry.expires <= clock) return false
      entry.expires = clock + PUBLICATION_LEASE_MS
      return true
    },
    release: async (name, owner) => { if (entries.get(name)?.owner === owner) entries.delete(name) },
  }
  return { store, entries, advance: (ms: number) => { clock += ms } }
}
function fixture(statuses = ['ACTIVE', 'ENDED']) {
  const lease = memoryLease()
  let snapshot: PublicationSnapshot = { ...target, desiredPublication: 'INACTIVE', intentVersion: 'v1',
    cachedPublication: 'ENDED', observedAt: new Date('2026-10-01Z'), duplicateCount: 1, productActive: true, campaignBlocked: false }
  const audits: PublicationAudit[] = []
  const persisted: string[] = []
  const sent: string[] = []
  let reads = 0, waits = 0
  let previous: PublicationCommand | null = null
  const adapter: PublicationAdapter = {
    leases: lease.store, readLocal: async () => snapshot,
    readRemote: async () => ({ status: statuses[Math.min(reads++, statuses.length - 1)], observedAt: now }),
    persistObservation: async observation => { persisted.push(observation.status) },
    latestCommand: async () => previous,
    audit: async event => {
      audits.push(event)
      if (event.commandId) previous = { commandId: event.commandId, action: event.action, status: event.status }
    },
    campaignSafe: async () => true,
    send: async (action, commandId) => { sent.push(`${action}:${commandId}`); return { accepted: true } },
    task: async () => 'PENDING', wait: async () => { waits++ },
  }
  return { lease, adapter, audits, persisted, sent, get reads() { return reads }, get waits() { return waits },
    snapshot, replace: (value: Partial<PublicationSnapshot>) => { snapshot = { ...snapshot, ...value } },
    previous: (value: PublicationCommand) => { previous = value } }
}
const execute = (f: ReturnType<typeof fixture>, remediation = false) => executePublicationOperation(target, f.adapter, { action: 'END', intentVersion: 'v1', now, remediation })

test('atomic guard allows one operation and rejects a simultaneous operation', async () => {
  const f = fixture()
  let unblock!: () => void
  const gate = new Promise<void>(resolve => { unblock = resolve })
  const running = withPublicationLease(f.lease.store, target, async () => { await gate; return 'done' })
  await Promise.resolve()
  assert.equal(await withPublicationLease(f.lease.store, target, async () => assert.fail('overlap')), null)
  unblock()
  assert.equal(await running, 'done')
  assert.equal(f.lease.entries.size, 0)
})
test('expired lease is recoverable; former owner cannot release successor', async () => {
  const lease = memoryLease(), name = publicationLeaseName(target)
  assert.equal(await lease.store.acquire(name, 'old'), true)
  lease.advance(PUBLICATION_LEASE_MS + 1)
  assert.equal(await lease.store.acquire(name, 'new'), true)
  assert.equal(await lease.store.renew(name, 'old'), false)
  await lease.store.release(name, 'old')
  assert.equal(lease.entries.get(name)?.owner, 'new')
})
test('different listing/offer scopes operate concurrently', async () => {
  const lease = memoryLease()
  assert.equal(await lease.store.acquire(publicationLeaseName(target), 'a'), true)
  assert.equal(await lease.store.acquire(publicationLeaseName({ ...target, listingId: 'other', offerId: 'other' }), 'b'), true)
  assert.equal(lease.entries.size, 2)
})
test('lease loss before dispatch stops the operation; finally never removes a new owner', async () => {
  const f = fixture()
  f.adapter.leases.renew = async () => false
  assert.equal((await execute(f)).reason, 'PUBLICATION_LEASE_LOST')
  assert.equal(f.sent.length, 0)
  assert.equal(f.lease.entries.size, 0)
})
for (const cached of ['ENDED', 'INACTIVE']) {
  test(`stale cached ${cached} cannot suppress an authoritative ACTIVE END`, async () => {
    const f = fixture(); f.replace({ cachedPublication: cached })
    const result = await execute(f)
    assert.equal(result.outcome, 'FIXED')
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0], /^END:/)
    assert.deepEqual(f.persisted, ['ACTIVE', 'ENDED'])
    assert.equal(f.lease.entries.size, 0)
  })
}
test('stale cached ENDED with authoritative ENDED is an audited no-op', async () => {
  const f = fixture(['ENDED'])
  assert.equal((await execute(f)).outcome, 'ALREADY_FIXED')
  assert.equal(f.sent.length, 0)
  assert.ok(f.audits.some(e => e.status === 'AUTHORITATIVE_MATCH'))
})
test('fresh matching observation avoids unnecessary GET and write', async () => {
  const f = fixture(); f.replace({ observedAt: new Date(now.getTime() - 1000) })
  assert.equal((await execute(f)).outcome, 'ALREADY_FIXED')
  assert.equal(f.reads, 0)
  assert.equal(f.sent.length, 0)
})
test('exact stale threshold forces an authoritative observation', async () => {
  const f = fixture(['ENDED']); f.replace({ observedAt: new Date(now.getTime() - PUBLICATION_FRESH_MS) })
  await execute(f)
  assert.equal(f.reads, 1)
})
for (const [changed, reason] of [
  [{ desiredPublication: 'ACTIVE' }, 'DESIRED_INTENT_CHANGED'],
  [{ intentVersion: 'new' }, 'DESIRED_INTENT_CHANGED'],
  [{ offerId: 'different' }, 'MAPPING_OR_SCOPE_CHANGED'],
  [{ duplicateCount: 2 }, 'DUPLICATE_SKU'],
  [{ campaignBlocked: true }, 'CAMPAIGN_OWNERSHIP'],
  [{ freshManualIntent: true }, 'FRESH_MANUAL_INTENT'],
  [{ legacyPublicationPending: true }, 'LEGACY_PUBLICATION_PENDING'],
] as Array<[Partial<PublicationSnapshot>, string]>) {
  test(`strict remediation skips ${reason}`, async () => {
    const f = fixture(); f.replace(changed)
    assert.equal((await execute(f, true)).reason, reason)
    assert.equal(f.sent.length, 0)
    assert.equal(f.lease.entries.size, 0)
  })
}
test('intent changing during GET prevents dispatch and publication persistence', async () => {
  const f = fixture()
  f.adapter.readRemote = async () => { f.replace({ desiredPublication: 'ACTIVE', intentVersion: 'new' }); return { status: 'ACTIVE', observedAt: now } }
  assert.equal((await execute(f, true)).outcome, 'SKIPPED_SAFETY')
  assert.equal(f.sent.length, 0)
  assert.deepEqual(f.persisted, [])
})
test('occupied guard prevents both explicit action and remediation', async () => {
  for (const strict of [false, true]) {
    const f = fixture(); await f.lease.store.acquire(publicationLeaseName(target), 'other')
    assert.equal((await execute(f, strict)).reason, 'PUBLICATION_OPERATION_BUSY')
    assert.equal(f.reads, 0)
    assert.equal(f.sent.length, 0)
  }
})
test('live remote badge blocks remediation even when local campaigns appear terminal', async () => {
  const f = fixture(); f.adapter.campaignSafe = async () => false
  assert.equal((await execute(f, true)).reason, 'CAMPAIGN_OWNERSHIP')
  assert.equal(f.sent.length, 0)
})
test('authoritative inactive state immediately before write yields ALREADY_FIXED', async () => {
  const f = fixture(['ACTIVE', 'INACTIVE'])
  assert.equal((await execute(f, true)).outcome, 'ALREADY_FIXED')
  assert.equal(f.sent.length, 0)
})
test('404 or GET timeout sends no command and releases guard', async () => {
  for (const reason of ['HTTP 404', 'Timeout']) {
    const f = fixture(); f.adapter.readRemote = async () => { throw new Error(reason) }
    assert.equal((await execute(f, true)).outcome, 'REMOTE_UNAVAILABLE')
    assert.equal(f.sent.length, 0)
    assert.equal(f.lease.entries.size, 0)
  }
})
test('async END is polled to authoritative completion with exactly one command', async () => {
  const f = fixture(['ACTIVE', 'ACTIVE', 'ACTIVE', 'ENDED'])
  const result = await execute(f)
  assert.equal(result.outcome, 'FIXED')
  assert.equal(f.sent.length, 1)
  assert.equal(f.waits, 2)
  assert.equal(f.persisted.at(-1), 'ENDED')
  assert.ok(f.audits.some(e => e.status === 'PENDING'))
})
test('bounded timeout releases lease but retains pending command ID to prevent blind resend', async () => {
  const f = fixture(['ACTIVE'])
  const first = await execute(f)
  assert.equal(first.outcome, 'PENDING_TIMEOUT')
  assert.equal(f.waits, 5)
  assert.equal(f.sent.length, 1)
  assert.equal(f.lease.entries.size, 0)
  const second = await execute(f)
  assert.equal(second.commandId, first.commandId)
  assert.equal(f.sent.length, 1)
})
test('runtime-restart ATTEMPTED journal is recovered read-only without a new command', async () => {
  const f = fixture(['ENDED']); f.previous({ action: 'END', status: 'ATTEMPTED', commandId: 'known-command' })
  assert.equal((await execute(f)).outcome, 'FIXED')
  assert.equal(f.sent.length, 0)
})
test('known pending command can be verified despite its inventory PENDING mirror', async () => {
  const f = fixture(['ENDED']); f.replace({ legacyPublicationPending: true })
  f.previous({ action: 'END', status: 'PENDING', commandId: 'known-command' })
  assert.equal((await execute(f)).outcome, 'FIXED')
  assert.equal(f.sent.length, 0)
})
test('unknown PUT outcome polls instead of resending', async () => {
  const f = fixture()
  let puts = 0
  f.adapter.send = async () => { puts++; throw new Error('network timeout after dispatch') }
  assert.equal((await execute(f)).outcome, 'FIXED')
  assert.equal(puts, 1)
  assert.equal(f.lease.entries.size, 0)
})
test('definitive command/task failure releases guard and records failure', async () => {
  const rejected = fixture(); rejected.adapter.send = async () => ({ accepted: false, reason: 'HTTP 422' })
  assert.equal((await execute(rejected)).outcome, 'FAILED')
  assert.equal(rejected.lease.entries.size, 0)
  const task = fixture(['ACTIVE']); task.adapter.task = async () => 'FAILED'
  assert.equal((await execute(task)).outcome, 'FAILED')
  assert.equal(task.sent.length, 1)
  assert.equal(task.lease.entries.size, 0)
})
test('opposite unresolved command cannot be bypassed by a new END', async () => {
  const f = fixture(['ACTIVE']); f.previous({ action: 'ACTIVATE', status: 'PENDING', commandId: 'older' })
  assert.equal((await execute(f)).outcome, 'PENDING_TIMEOUT')
  assert.equal(f.sent.length, 0)
})
test('unknown journal status fails closed instead of authorizing another command', async () => {
  const f = fixture(['ACTIVE']); f.previous({ action: 'END', status: 'UNKNOWN', commandId: 'older' })
  assert.equal((await execute(f)).outcome, 'PENDING_TIMEOUT')
  assert.equal(f.sent.length, 0)
})
test('freshness includes stale compliant inactive listings and excludes fresh ones', () => {
  assert.equal(INACTIVE_PUBLICATION_STALE_MS, PUBLICATION_FRESH_MS)
  const row = { offerId: target.offerId, desiredPublicationStatus: 'INACTIVE', publicationStatus: 'ENDED', lastSyncedAt: '2026-10-01Z' }
  assert.equal(needsInactivePublicationVerification(row, now.getTime()), true)
  assert.equal(needsInactivePublicationVerification({ ...row, publicationObservedAt: now.toISOString() }, now.getTime()), false)
  assert.equal(needsInactivePublicationVerification({ ...row, desiredPublicationStatus: 'ACTIVE' }, now.getTime()), false)
})
test('SQL guard acquisition is conditional; renewal/release require the same owner', async () => {
  const captures: unknown[] = []
  const where: unknown[] = []
  const database = { insert: () => ({ values: () => ({ onConflictDoUpdate: (config: unknown) => { captures.push(config); return { returning: async () => [{ ownerId: 'owner' }] } } }) }),
    update: () => ({ set: () => ({ where: (guard: unknown) => { where.push(guard); return { returning: async () => [] } } }) }),
    delete: () => ({ where: async (guard: unknown) => { where.push(guard) } }) }
  const store = createPublicationLeaseStore(database as never)
  assert.equal(await store.acquire('listing-key', 'owner'), true)
  await store.renew('listing-key', 'owner'); await store.release('listing-key', 'owner')
  const dialect = new PgDialect()
  const guard = dialect.sqlToQuery((captures[0] as { setWhere: never }).setWhere)
  assert.match(guard.sql, /locked_until.*<= now\(\)/)
  for (const condition of where) {
    const q = dialect.sqlToQuery(condition as never)
    assert.match(q.sql, /owner_id/)
    assert.ok(q.params.includes('owner'))
  }
})
test('publication persistence touches no quantity, price, ownership, schedule or campaign fields', async () => {
  const captured: string[] = []
  const db = { execute: async (statement: never) => { captured.push(new PgDialect().sqlToQuery(statement).sql); return { rows: [{ listing_id: target.listingId }] } } }
  await persistPublicationObservation(db as never, target, { status: 'ENDED', observedAt: now })
  const q = captured[0]
  assert.match(q, /set publication_status=\$\d+, updated_at=\$\d+/)
  assert.doesNotMatch(q, /set (stock|price|desired|regular|auto)|update listing_desired|listing_campaigns|listing_price_schedules/)
  assert.match(q, /EXTERNAL_REACTIVATION/)
  assert.doesNotMatch(q, /last_synced_at=/)
})
test('intent save audit is atomic and preserves existing explicit takeover semantics only', async () => {
  let query = ''
  const db = { execute: async (statement: never) => { query = new PgDialect().sqlToQuery(statement).sql; return { rows: [] } } }
  await savePublicationIntent(db as never, target.listingId, 'INACTIVE')
  assert.match(query, /PUBLICATION_INTENT_SAVED/)
  assert.match(query, /stock_auto_paused=false/)
  assert.doesNotMatch(query, /stock_locked=|desired_stock=|regular_price_minor=|price_locked=|listing_campaigns/)
})
test('inventory, row, bulk and remediation use the single guarded publication dispatcher', () => {
  const source = readFileSync(new URL('../src/allegro-auth.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const dispatcher = source.slice(source.indexOf('export async function executeAllegroPublicationTarget'), source.indexOf("allegroAuth.post(\n  '/stop-price-schedule"))
  assert.match(dispatcher, /executePublicationOperation\(target/)
  assert.match(dispatcher, /assertAllegroWriteSafety\(\)/)
  assert.equal((source.match(/method: 'PUT', signal: AbortSignal.timeout\(10000\)/g) ?? []).length, 1)
  assert.match(source, /postAllegro\(\s*'\/push-status\//)
  assert.match(source, /`\/push-status\/\$\{encodeURIComponent/)
  assert.match(source, /executeAllegroPublicationTarget\(row\)/)
  assert.doesNotMatch(dispatcher, /push-stock|push-price|finishOffer|submitOffer|method: 'POST'/)
  assert.match(dispatcher, /publication: \{ action: publicationAction \}/)
})
