import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildInventorySyncRequest } from '../src/platform-automation.ts'

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
