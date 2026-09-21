import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import {
  applyPricingItemSearch,
  arukeresoApi,
  collapsePricingItemRows,
  computePricingDiagnostics,
  computePricingImportDiagnostics,
  derivePricingItemFeedState,
} from '../src/arukereso.ts'
import type { AccessVariables } from '../src/access-auth.ts'

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

void describe(
  'computePricingImportDiagnostics',
  () => {
    function mixedInput() {
      return {
        sourceRows: [
          {
            productId: 'p1',
            sourceItemKey: 'k1',
            identifier: '1.111-111.0',
          },
          {
            productId: 'p1',
            sourceItemKey: 'k2',
            identifier: '1.111-111.0',
          },
          {
            productId: null,
            sourceItemKey: 'k3',
            identifier: ' 2.222-222.0 ',
          },
          {
            productId: 'p3',
            sourceItemKey: 'k4',
            identifier: '3.333-333.0',
          },
          {
            productId: null,
            sourceItemKey: 'k5',
            identifier: '9.999-999.0',
          },
          {
            productId: null,
            sourceItemKey: 'k6',
            identifier: '',
          },
          {
            productId: null,
            sourceItemKey: 'k7',
            identifier: null,
          },
          {
            productId: 'p4',
            sourceItemKey: 'k8',
            identifier: '4.444-444.0',
          },
        ],
        hubProducts: [
          {
            id: 'p1',
            sku: '1.111-111.0',
            active: true,
          },
          {
            id: 'p2',
            sku: '2.222-222.0',
            active: true,
          },
          {
            id: 'p3',
            sku: '3.333-333.0',
            active: false,
          },
          {
            id: 'p4',
            sku: '4.444-444.0',
            active: true,
          },
          {
            id: 'p5',
            sku: '4.444-444.0',
            active: true,
          },
        ],
      }
    }

    void it(
      'reconciles every row into exactly one bucket',
      () => {
        const result =
          computePricingImportDiagnostics(
            mixedInput(),
          )

        assert.equal(result.sourceRows, 8)
        assert.equal(result.blankSourceSkus, 2)
        assert.equal(
          result.duplicateSourceSkuRows,
          1,
        )
        assert.deepEqual(
          result.duplicateSourceSkus,
          ['1.111-111.0'],
        )
        assert.equal(result.uniqueSourceSkus, 5)
        assert.equal(result.hubProducts, 5)
        assert.equal(result.matchedSourceSkus, 4)
        assert.equal(
          result.unmatchedSourceSkusCount,
          1,
        )
        assert.deepEqual(
          result.unmatchedSourceSkus,
          ['9.999-999.0'],
        )
        assert.equal(
          result.matchedButExcludedCount,
          3,
        )
        assert.deepEqual(
          result.matchedButExcluded,
          [
            {
              sku: '2.222-222.0',
              reason: 'STALE_UNLINKED_ROW',
            },
            {
              sku: '3.333-333.0',
              reason: 'PRODUCT_INACTIVE',
            },
            {
              sku: '4.444-444.0',
              reason: 'AMBIGUOUS_PRODUCT_SKU',
            },
          ],
        )
        assert.equal(result.currentPricingRows, 4)
        assert.equal(result.linkedProducts, 1)

        // Exact row equation: blank + duplicate extras +
        // distinct identifiers = all rows.
        assert.equal(
          result.blankSourceSkus +
            result.duplicateSourceSkuRows +
            result.uniqueSourceSkus,
          result.sourceRows,
        )
        assert.equal(
          result.matchedSourceSkus +
            result.unmatchedSourceSkusCount,
          result.uniqueSourceSkus,
        )
      },
    )

    void it(
      'matches production sync semantics exactly',
      () => {
        // Sync trims but never folds case: padded matches,
        // case-differing does not.
        const result =
          computePricingImportDiagnostics({
            sourceRows: [
              {
                productId: null,
                sourceItemKey: 'k1',
                identifier: '  abc-1 ',
              },
              {
                productId: null,
                sourceItemKey: 'k2',
                identifier: 'ABC-1',
              },
            ],
            hubProducts: [
              {
                id: 'p1',
                sku: 'abc-1',
                active: true,
              },
            ],
          })

        assert.equal(result.matchedSourceSkus, 1)
        assert.deepEqual(
          result.unmatchedSourceSkus,
          ['ABC-1'],
        )
      },
    )

    void it(
      'caps unmatched lists at 200 with full counts',
      () => {
        const sourceRows = Array.from(
          { length: 250 },
          (_, index) => ({
            productId: null,
            sourceItemKey: `k${index}`,
            identifier: `9.${String(index).padStart(3, '0')}-999.0`,
          }),
        )
        const result =
          computePricingImportDiagnostics({
            sourceRows,
            hubProducts: [],
          })

        assert.equal(
          result.unmatchedSourceSkusCount,
          250,
        )
        assert.equal(
          result.unmatchedSourceSkus.length,
          200,
        )
        assert.equal(result.matchedSourceSkus, 0)
        assert.equal(result.linkedProducts, 0)
      },
    )

    void it(
      'returns identifiers only, never secrets or prices',
      () => {
        const result =
          computePricingImportDiagnostics(
            mixedInput(),
          )
        const serialized = JSON.stringify(result)

        assert.ok(
          !/token|secret|password|price|competitor/i.test(
            serialized,
          ),
        )
      },
    )
  },
)

void describe(
  'pricing diagnostics route',
  () => {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
    )

    void it(
      'rejects anonymous callers before touching the database',
      async () => {
        const response =
          await arukeresoApi.request(
            '/pricing/diagnostics',
          )

        assert.equal(response.status, 403)
        assert.deepEqual(
          await response.json(),
          {
            status: 'error',
            message:
              'Administrator permission is required.',
          },
        )
      },
    )

    void it(
      'is never transport-public',
      () => {
        const source = readFileSync(
          join(
            repoRoot,
            'apps/api/src/access-auth.ts',
          ),
          'utf8',
        )
        const start = source.indexOf(
          'const PUBLIC_PATHS = new Set([',
        )
        const block = source.slice(
          start,
          source.indexOf('])', start),
        )

        assert.ok(
          !block.includes('pricing/diagnostics'),
        )
      },
    )

    if (!process.env.DATABASE_URL) {
      void it(
        'fails closed for ADMIN without database configuration',
        async () => {
          const app = new Hono<{
            Variables: AccessVariables
          }>()
          app.use('*', async (context, next) => {
            context.set('commerceHubUser', {
              email: 'admin@example.com',
              role: 'ADMIN',
              subject: null,
            })
            await next()
          })
          app.route('/arukereso', arukeresoApi)

          const response = await app.request(
            '/arukereso/pricing/diagnostics',
          )

          // ADMIN passes auth; only the missing database
          // stops it — no pricing sync token involved.
          assert.equal(response.status, 503)
        },
      )
    }
  },
)
