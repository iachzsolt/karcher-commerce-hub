import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildInventorySyncRequest } from '../src/platform-automation.ts'
import { recordStockAudit, type StockAuditEvent } from '../src/inventory-mutation-journal.ts'

void describe('scheduled inventory-sync request shape', () => {
  void it('omits executionMode so the scheduled path keeps LEGACY semantics', () => {
    const payload = buildInventorySyncRequest({
      connectionId: 'connection-1',
      listingIds: ['listing-1', 'listing-2'],
      historyGroupId: 'history-1',
      batchIndex: 1,
    })

    assert.equal('executionMode' in payload, false)
    assert.deepEqual(payload, {
      confirm: true,
      connectionId: 'connection-1',
      listingIds: ['listing-1', 'listing-2'],
      historyGroupId: 'history-1',
      batchIndex: 1,
      executionLease: undefined,
    })
  })

  void it('forwards executionMode only when the caller sets it explicitly', () => {
    const sliced = buildInventorySyncRequest({
      connectionId: 'connection-1',
      listingIds: ['listing-1'],
      historyGroupId: 'history-1',
      batchIndex: 2,
      executionLease: { name: 'inventory-refresh:connection-1', ownerId: 'owner-1' },
      executionMode: 'SLICED',
    })

    assert.equal(sliced.executionMode, 'SLICED')
    assert.equal(sliced.confirm, true)
    assert.equal(sliced.batchIndex, 2)
    assert.deepEqual(sliced.executionLease, {
      name: 'inventory-refresh:connection-1',
      ownerId: 'owner-1',
    })

    const legacy = buildInventorySyncRequest({
      connectionId: 'connection-1',
      listingIds: ['listing-1'],
      historyGroupId: 'history-1',
      batchIndex: 1,
      executionMode: 'LEGACY',
    })

    assert.equal(legacy.executionMode, 'LEGACY')
  })
})

/* ------------------------------------------------------------------ *
 * Journal metadata for sliced stock mutations
 * ------------------------------------------------------------------ */

function fakeInsertDatabase() {
  const inserted: Array<Record<string, unknown>> = []

  const database = {
    insert: () => ({
      values: async (value: Record<string, unknown>) => {
        inserted.push(value)
      },
    }),
  }

  return {
    database: database as unknown as Parameters<typeof recordStockAudit>[0],
    inserted,
  }
}

function auditEvent(overrides: Partial<StockAuditEvent> = {}): StockAuditEvent {
  return {
    status: 'PENDING',
    commandId: 'cmd-1',
    offerId: 'offer-1',
    fromStock: 0,
    toStock: 5,
    ...overrides,
  }
}

function metadataOf(value: Record<string, unknown> | undefined) {
  return JSON.parse(String(value?.metadataJson)) as Record<string, unknown>
}

void describe('stock journal execution metadata', () => {
  /* 15. sliced stock journal includes runId */
  void it('persists runId on a sliced stock journal event', async () => {
    const { database, inserted } = fakeInsertDatabase()

    await recordStockAudit(
      database,
      'listing-a',
      auditEvent({ runId: 'run-1', batchIndex: 3 }),
    )

    assert.equal(inserted.length, 1)
    assert.equal(metadataOf(inserted[0]).runId, 'run-1')
  })

  /* 16. sliced stock journal includes batchIndex */
  void it('persists batchIndex on a sliced stock journal event', async () => {
    const { database, inserted } = fakeInsertDatabase()

    await recordStockAudit(
      database,
      'listing-a',
      auditEvent({ runId: 'run-1', batchIndex: 7 }),
    )

    assert.equal(metadataOf(inserted[0]).batchIndex, 7)
  })

  /* 17. legacy call still works with absent metadata */
  void it('keeps legacy journal events metadata-free and the request shape unchanged', async () => {
    const { database, inserted } = fakeInsertDatabase()

    await recordStockAudit(database, 'listing-a', auditEvent())

    const metadata = metadataOf(inserted[0])
    assert.equal(metadata.runId, null)
    assert.equal(metadata.batchIndex, null)
    assert.equal(metadata.commandId, 'cmd-1')

    const legacy = buildInventorySyncRequest({
      connectionId: 'connection-1',
      listingIds: ['listing-1'],
      historyGroupId: 'history-1',
      batchIndex: 1,
      executionMode: 'LEGACY',
    })

    assert.equal('runId' in legacy, false, 'legacy callers send no run identity')

    const sliced = buildInventorySyncRequest({
      connectionId: 'connection-1',
      listingIds: ['listing-1'],
      historyGroupId: 'history-1',
      batchIndex: 1,
      executionMode: 'SLICED',
      runId: 'run-1',
    })

    assert.equal(sliced.runId, 'run-1')
    assert.equal(sliced.batchIndex, 1)
  })
})
