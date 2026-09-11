import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPricingItemSearch,
  collapsePricingItemRows,
  computePricingDiagnostics,
  derivePricingItemFeedState,
} from '../src/arukereso.ts'

void describe(
  'computePricingDiagnostics',
  () => {
    void it(
      'reports NO_DATA without pricing rows',
      () => {
        const result =
          computePricingDiagnostics({
            rows: [],
            candidateProductIds: null,
          })

        assert.equal(result.totalRows, 0)
        assert.equal(result.currentRows, 0)
        assert.equal(
          result.latestObservedAt,
          null,
        )
        assert.deepEqual(
          result.dataStatusCounts,
          {
            hasCompetitor: 0,
            noCompetitor: 0,
            partialMarketData: 0,
          },
        )
        assert.equal(result.coverage, null)
        assert.equal(
          result.pricingStatus,
          'NO_DATA',
        )
      },
    )

    void it(
      'counts current rows, statuses and latest observation',
      () => {
        const result =
          computePricingDiagnostics({
            rows: [
              {
                productId: 'product-1',
                dataStatus: 'HAS_COMPETITOR',
                observedAt: new Date(
                  '2026-09-10T10:00:00.000Z',
                ),
              },
              {
                productId: 'product-2',
                dataStatus: 'NO_COMPETITOR',
                observedAt: new Date(
                  '2026-09-10T12:30:00.000Z',
                ),
              },
              {
                productId: 'product-3',
                dataStatus: 'UNKNOWN',
                observedAt: null,
              },
              {
                productId: null,
                dataStatus: 'HAS_COMPETITOR',
                observedAt: new Date(
                  '2026-09-10T13:00:00.000Z',
                ),
              },
            ],
            candidateProductIds: null,
          })

        assert.equal(result.totalRows, 4)
        assert.equal(result.currentRows, 3)
        assert.equal(
          result.latestObservedAt,
          '2026-09-10T12:30:00.000Z',
        )
        assert.deepEqual(
          result.dataStatusCounts,
          {
            hasCompetitor: 1,
            noCompetitor: 1,
            partialMarketData: 1,
          },
        )
        assert.equal(result.coverage, null)
        assert.equal(
          result.pricingStatus,
          'HAS_DATA',
        )
      },
    )

    void it(
      'reports HAS_DATA with informational coverage',
      () => {
        const result =
          computePricingDiagnostics({
            rows: [
              {
                productId: 'product-1',
                dataStatus: 'HAS_COMPETITOR',
                observedAt: new Date(
                  '2026-09-10T10:00:00.000Z',
                ),
              },
            ],
            candidateProductIds: [
              'product-1',
              'product-2',
              'product-3',
            ],
          })

        assert.deepEqual(result.coverage, {
          candidateProducts: 3,
          withCurrentPricing: 1,
          missingCurrentPricing: 2,
          percent: 33.3,
        })
        assert.equal(
          result.pricingStatus,
          'HAS_DATA',
        )
      },
    )

    void it(
      'reports HAS_DATA for full coverage',
      () => {
        const result =
          computePricingDiagnostics({
            rows: [
              {
                productId: 'product-1',
                dataStatus: 'HAS_COMPETITOR',
                observedAt: new Date(
                  '2026-09-10T10:00:00.000Z',
                ),
              },
              {
                productId: 'product-2',
                dataStatus: 'NO_COMPETITOR',
                observedAt: null,
              },
            ],
            candidateProductIds: [
              'product-1',
              'product-2',
            ],
          })

        assert.deepEqual(result.coverage, {
          candidateProducts: 2,
          withCurrentPricing: 2,
          missingCurrentPricing: 0,
          percent: 100,
        })
        assert.equal(
          result.pricingStatus,
          'HAS_DATA',
        )
      },
    )

    void it(
      'reports HAS_DATA for an empty candidate set',
      () => {
        const result =
          computePricingDiagnostics({
            rows: [
              {
                productId: 'product-1',
                dataStatus: 'HAS_COMPETITOR',
                observedAt: null,
              },
            ],
            candidateProductIds: [],
          })

        assert.deepEqual(result.coverage, {
          candidateProducts: 0,
          withCurrentPricing: 0,
          missingCurrentPricing: 0,
          percent: 0,
        })
        assert.equal(
          result.pricingStatus,
          'HAS_DATA',
        )
      },
    )
  },
)

void describe(
  'pricing item helpers',
  () => {
    const rows = [
      {
        productId: 'product-1',
        sku: '1.628-376.0',
        productName: 'Magasnyomású mosó',
        priceIndexBps: 12670,
        medianIndexBps: 10490,
        averageIndexBps: 10783,
        dataStatus: 'HAS_COMPETITOR',
        observedAt: new Date(
          '2026-09-10T10:00:00.000Z',
        ),
      },
      {
        productId: 'product-1',
        sku: '1.628-376.0',
        productName: 'Magasnyomású mosó',
        priceIndexBps: 12000,
        medianIndexBps: 10000,
        averageIndexBps: 10000,
        dataStatus: 'HAS_COMPETITOR',
        observedAt: new Date(
          '2026-09-10T12:00:00.000Z',
        ),
      },
      {
        productId: null,
        sku: null,
        productName: null,
        priceIndexBps: null,
        medianIndexBps: null,
        averageIndexBps: null,
        dataStatus: null,
        observedAt: null,
      },
      {
        productId: 'product-2',
        sku: '1.512-600.0',
        productName: 'Gőztisztító',
        priceIndexBps: null,
        medianIndexBps: null,
        averageIndexBps: null,
        dataStatus: 'NO_COMPETITOR',
        observedAt: null,
      },
    ]

    void it(
      'collapses duplicates to the latest observation',
      () => {
        const collapsed =
          collapsePricingItemRows(rows)

        assert.equal(collapsed.length, 2)
        assert.equal(
          collapsed[0]?.priceIndexBps,
          12000,
        )
      },
    )

    void it(
      'searches by partial SKU and product name',
      () => {
        const collapsed =
          collapsePricingItemRows(rows)

        assert.deepEqual(
          applyPricingItemSearch(
            collapsed,
            '1.628',
          ).map((item) => item.productId),
          ['product-1'],
        )
        assert.deepEqual(
          applyPricingItemSearch(
            collapsed,
            'GŐZTISZTÍTÓ',
          ).map((item) => item.productId),
          ['product-2'],
        )
        assert.deepEqual(
          applyPricingItemSearch(
            collapsed,
            '  ',
          ).length,
          2,
        )
        assert.deepEqual(
          applyPricingItemSearch(
            collapsed,
            'no-such-sku',
          ),
          [],
        )
      },
    )

    void it(
      'derives conservative feed states',
      () => {
        assert.equal(
          derivePricingItemFeedState({
            catalogMatched: true,
          }),
          'IN_FEED',
        )
        assert.equal(
          derivePricingItemFeedState({
            catalogMatched: false,
          }),
          'NOT_IN_FEED',
        )
        assert.equal(
          derivePricingItemFeedState({
            catalogMatched: null,
          }),
          'UNKNOWN',
        )
      },
    )
  },
)
