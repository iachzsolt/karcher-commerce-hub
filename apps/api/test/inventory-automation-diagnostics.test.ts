import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildInventoryAutomationDiagnostics,
  formatInventoryAutomationFailure,
} from '../src/inventory-automation-diagnostics.ts'
import {
  syncAllegroInventoryRows,
  type AllegroInventorySyncRow,
} from '../src/allegro-inventory-sync.ts'
import {
  hasInventorySyncFailure,
} from '../src/platform-automation.ts'

function failedStockResult(sku = '2.863-061.0') {
  return {
    sku,
    listingId: `listing-${sku}`,
    offerId: `offer-${sku}`,
    action: 'STOCK_UPDATE',
    status: 'FAILED',
    remoteStock: 0,
    targetStock: 59,
    publicationStatus: 'ENDED',
    desiredPublicationStatus: 'ACTIVE',
    httpStatus: 502,
    details: {
      status: 'error',
      message: 'Allegro stock update failed',
      commandId: 'command-1',
      task: {
        status: 'FAIL',
        message: 'The offer is ended.',
        field: 'stock.available',
      },
      allegroResponse: 'raw-secret-response',
      authorization: 'Bearer secret-token',
    },
  }
}

function automationResult(results = [failedStockResult()]) {
  return {
    status: 'COMPLETED',
    results: [
      {
        platform: 'ALLEGRO',
        accountId: 'account-1',
        outcome: 'FAILED',
        ok: false,
        status: 200,
        details: {
          status: 'PARTIAL_FAILURE',
          historyGroupId: 'history-group-1',
          totalListings: 446,
          batchCount: 18,
          successfulBatches: 17,
          failedBatches: 1,
          batches: [
            {
              batchNumber: 6,
              listingCount: 25,
              ok: false,
              status: 200,
              details: {
                summary: {
                  selected: 25,
                  attempted: results.length,
                  stockUpdated: 0,
                  reactivated: 0,
                  autoPaused: 0,
                  unchanged: 24,
                  skipped: 0,
                  pending: 0,
                  failed: results.length,
                },
                refresh: { status: 'success' },
                results,
              },
            },
          ],
        },
      },
    ],
  }
}

void describe('inventory automation diagnostics', () => {
  void it(
    'keeps HTTP 200 with an internal failed summary classified as failure',
    () => {
      assert.equal(
        hasInventorySyncFailure({
          summary: { failed: 1 },
          refresh: { status: 'success' },
        }),
        true,
      )
      assert.equal(
        hasInventorySyncFailure({
          summary: { failed: 0 },
          refresh: { status: 'success' },
        }),
        false,
      )
    },
  )

  void it(
    'builds a business error instead of exposing HTTP 200',
    () => {
      const diagnostics =
        buildInventoryAutomationDiagnostics(
          automationResult(),
        )
      const message =
        formatInventoryAutomationFailure(diagnostics)

      assert.equal(
        message,
        'Az Allegro készletszinkron részben sikertelen: 446 ajánlatból 1 hibás (SKU: 2.863-061.0).',
      )
      assert.doesNotMatch(message, /HTTP 200/)
    },
  )

  void it(
    'preserves bounded listing diagnostics and excludes raw sensitive fields',
    () => {
      const diagnostics =
        buildInventoryAutomationDiagnostics(
          automationResult(),
        )
      const platform = diagnostics.platforms[0]
      const failure =
        platform?.failedListings.items[0]

      assert.deepEqual(failure, {
        listingId: 'listing-2.863-061.0',
        sku: '2.863-061.0',
        offerId: 'offer-2.863-061.0',
        action: 'STOCK_UPDATE',
        remoteStock: 0,
        targetStock: 59,
        remotePublicationStatus: 'ENDED',
        desiredPublicationStatus: 'ACTIVE',
        historyGroupId: 'history-group-1',
        batchIndex: 6,
        httpStatus: 502,
        taskStatus: 'FAIL',
        commandId: 'command-1',
        taskMessage: 'The offer is ended.',
        taskField: 'stock.available',
      })
      assert.equal(platform?.attempted, 1)
      assert.equal(platform?.failed, 1)

      const persisted = JSON.stringify(diagnostics)
      assert.doesNotMatch(persisted, /raw-secret-response/)
      assert.doesNotMatch(persisted, /secret-token/)
      assert.doesNotMatch(persisted, /allegroResponse/)
      assert.doesNotMatch(persisted, /authorization/)
    },
  )

  void it(
    'bounds failed SKU examples in the user-facing message',
    () => {
      const results = Array.from(
        { length: 12 },
        (_, index) => failedStockResult(`SKU-${index + 1}`),
      )
      const message = formatInventoryAutomationFailure(
        buildInventoryAutomationDiagnostics(
          automationResult(results),
        ),
      )

      assert.match(message, /SKU-1, SKU-2, SKU-3/)
      assert.match(message, /és további 9/)
      assert.doesNotMatch(message, /SKU-4/)
    },
  )
})

void describe('inventory skip protections', () => {
  void it(
    'keeps manual inactive and duplicate SKU listings skipped',
    async () => {
      const rows: AllegroInventorySyncRow[] = [
        {
          sku: 'MANUAL',
          listingId: 'listing-manual',
          offerId: 'offer-manual',
          targetStock: 8,
          remoteStock: 0,
          desiredStock: 8,
          stockLocked: false,
          stockAutoPaused: false,
          publicationStatus: 'ENDED',
          desiredPublicationStatus: 'INACTIVE',
          duplicateOfferCount: 1,
          sourceMissing: false,
        },
        {
          sku: 'DUPLICATE',
          listingId: 'listing-duplicate',
          offerId: 'offer-duplicate',
          targetStock: 5,
          remoteStock: 1,
          desiredStock: 5,
          stockLocked: false,
          stockAutoPaused: false,
          publicationStatus: 'ACTIVE',
          desiredPublicationStatus: 'ACTIVE',
          duplicateOfferCount: 2,
          sourceMissing: false,
        },
      ]
      const database = {
        insert: () => ({
          values: () => Promise.resolve(),
        }),
      } as unknown as Parameters<
        typeof syncAllegroInventoryRows
      >[0]
      const unexpectedWrite = async () => {
        throw new Error('A protected listing was written')
      }
      const result = await syncAllegroInventoryRows(
        database,
        rows,
        {
          pushStock: unexpectedWrite,
          pushStatus: unexpectedWrite,
          refresh: async () => {
            throw new Error('A protected listing was refreshed')
          },
        },
      )

      assert.equal(result.summary.attempted, 0)
      assert.equal(result.summary.skipped, 2)
      assert.deepEqual(
        result.results.map((item) => item.status),
        ['MANUAL_INACTIVE', 'DUPLICATE_SKU'],
      )
    },
  )
})
