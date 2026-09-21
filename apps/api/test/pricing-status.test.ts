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
  analyzeUnmatchedSkus,
  applyPricingItemSearch,
  arukeresoApi,
  buildPricingIngressAudit,
  collapsePricingItemRows,
  computePricingDiagnostics,
  computePricingImportDiagnostics,
  derivePricingItemFeedState,
  readPricingIngressAudit,
  recordPricingIngressAudit,
  setPricingIngressAuditStore,
  summarizePricingSourceRows,
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

void describe(
  'summarizePricingSourceRows',
  () => {
    void it(
      'counts parsed rows, statuses and samples without secrets',
      () => {
        const result =
          summarizePricingSourceRows([
            {
              identifier: '1.111-111.0',
              dataStatus: 'HAS_COMPETITOR',
            },
            {
              identifier: ' 2.222-222.0 ',
              dataStatus: 'NO_COMPETITOR',
            },
            {
              identifier: '2.222-222.0',
              dataStatus: 'PARTIAL_MARKET_DATA',
            },
            {
              identifier: '',
              dataStatus: 'HAS_COMPETITOR',
            },
            {
              identifier: null,
              dataStatus: null,
            },
          ])

        assert.equal(result.parsedRows, 5)
        assert.equal(result.validSkuRows, 3)
        assert.equal(result.uniqueSkus, 2)
        assert.deepEqual(
          result.statusBreakdown,
          {
            hasCompetitor: 2,
            noCompetitor: 1,
            partialMarketData: 2,
          },
        )
        assert.deepEqual(result.sampleSkus, [
          '1.111-111.0',
          '2.222-222.0',
        ])

        const serialized =
          JSON.stringify(result)
        assert.ok(
          !/token|secret|password|credential|iban|swift/i.test(
            serialized,
          ),
        )
      },
    )
  },
)

void describe(
  'pricing ingress audit',
  () => {
    function okResult() {
      return {
        ok: true as const,
        validItems: [
          { sku: 'a-1' },
          { sku: 'a-2' },
        ],
        summary: {
          rows: 6,
          matchedRows: 2,
          unmatchedRows: 1,
          validMatchedRows: 2,
          invalidMatchedRows: 0,
          duplicateSkuRows: 2,
          hasCompetitor: 0,
          noCompetitor: 0,
          partialMarketData: 0,
        },
        unmatchedSample: ['u-1'],
        unmatchedItems: [
          {
            rowIndex: 4,
            sku: 'u-1',
            name: null,
            ean: null,
            index: 1,
            medianIndex: 1,
            averageIndex: 1,
            priceIndexBps: 10000,
            medianIndexBps: 10000,
            averageIndexBps: 10000,
            marketStatus: 'HAS_COMPETITOR' as const,
          },
        ],
        invalidRows: [
          {
            rowIndex: 0,
            sku: '',
            errors: ['INVALID_SKU'],
          },
        ],
        duplicateRows: [
          { rowIndex: 2, sku: 'd-1' },
          { rowIndex: 3, sku: 'd-1' },
        ],
      }
    }

    void it(
      'reconciles raw = normalized + dropped with real reasons',
      () => {
        const audit = buildPricingIngressAudit(
          '/pricing/sync',
          {
            items: [{}, {}, {}, {}, {}, {}],
          },
          okResult() as never,
          '2026-09-20T10:00:00.000Z',
        )

        assert.equal(audit.endpoint, '/pricing/sync')
        assert.equal(audit.rawItems, 6)
        assert.equal(audit.normalizedItems, 2)
        assert.equal(audit.acceptedItems, 2)
        assert.equal(audit.droppedItems, 4)
        assert.deepEqual(audit.dropReasons, {
          blankSku: 1,
          invalidRow: 0,
          invalidField: 0,
          duplicateSku: 2,
          unmatched: 1,
          other: 0,
        })
        assert.deepEqual(audit.droppedSkus, [
          'd-1',
          'u-1',
        ])

        const serialized = JSON.stringify(audit)
        assert.ok(
          !/token|secret|password|credential|price|competitor|median|average/i.test(
            serialized,
          ),
        )
      },
    )

    void it(
      'caps dropped SKUs at 200 on failure results',
      () => {
        const invalidRows = Array.from(
          { length: 250 },
          (_, index) => ({
            rowIndex: index,
            sku: `bad-${index}`,
            errors: ['INVALID_INDEX'],
          }),
        )
        const audit = buildPricingIngressAudit(
          '/pricing/reconcile',
          { items: invalidRows },
          {
            ok: false,
            message: 'nope',
            summary: {
              rows: 250,
              matchedRows: 0,
              unmatchedRows: 0,
              validMatchedRows: 0,
              invalidMatchedRows: 250,
              duplicateSkuRows: 0,
              hasCompetitor: 0,
              noCompetitor: 0,
              partialMarketData: 0,
            },
            invalidRows,
            duplicateSkus: [],
          } as never,
        )

        assert.equal(audit.rawItems, 250)
        assert.equal(audit.normalizedItems, 0)
        assert.equal(audit.droppedItems, 250)
        assert.equal(
          audit.dropReasons.invalidField,
          250,
        )
        assert.equal(audit.droppedSkus.length, 200)
      },
    )

    void it(
      'records technical-only audits and never throws',
      async () => {
        const written: unknown[] = []
        setPricingIngressAuditStore({
          get: async () => null,
          set: async (_, value) => {
            written.push(value)
          },
        })

        try {
          await recordPricingIngressAudit(
            '/pricing/sync',
            { items: [{}, {}] },
            okResult() as never,
          )
        } finally {
          setPricingIngressAuditStore(null)
        }

        assert.equal(written.length, 1)
        const entry = written[0] as Record<
          string,
          unknown
        >
        assert.deepEqual(
          Object.keys(entry).sort(),
          [
            'acceptedItems',
            'dropReasons',
            'droppedItems',
            'droppedSkuReasons',
            'droppedSkus',
            'endpoint',
            'normalizedItems',
            'rawItems',
            'receivedAt',
          ].sort(),
        )
        assert.deepEqual(
          (entry as Record<string, unknown>)[
            'droppedSkuReasons'
          ],
          { 'd-1': 'duplicateSku', 'u-1': 'unmatched' },
        )

        setPricingIngressAuditStore({
          get: async () => {
            throw new Error('kv down')
          },
          set: async () => {
            throw new Error('kv down')
          },
        })

        try {
          // Audit failure must never break pricing sync.
          await recordPricingIngressAudit(
            '/pricing/sync',
            { items: [{}] },
            okResult() as never,
          )
          assert.equal(
            await readPricingIngressAudit(),
            null,
          )
        } finally {
          setPricingIngressAuditStore(null)
        }
      },
    )
  },
)

void describe(
  'pricing source-diagnostics route',
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
            '/pricing/source-diagnostics',
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
          !block.includes('pricing/source-diagnostics'),
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
            '/arukereso/pricing/source-diagnostics',
          )

          assert.equal(response.status, 503)
        },
      )
    }
  },
)

void describe(
  'analyzeUnmatchedSkus',
  () => {
    function catalog() {
      return {
        hubProducts: [
          {
            id: 'p-exact',
            sku: '1.008-057.0',
            active: true,
          },
          {
            id: 'p-pad',
            sku: '2.111-111.0',
            active: true,
          },
          {
            id: 'p-punct',
            sku: '31112222',
            active: true,
          },
          {
            id: 'p-case',
            sku: 'abc-1',
            active: true,
          },
          {
            id: 'p-digits',
            sku: 'K 555-666',
            active: true,
          },
          {
            id: 'p-off',
            sku: '9.999-999.0',
            active: false,
          },
          {
            id: 'p-amb-a',
            sku: '7.777-777.0',
            active: true,
          },
          {
            id: 'p-amb-b',
            sku: '77777770',
            active: true,
          },
        ],
        identifiers: [
          {
            productId: 'p-pad',
            type: 'EAN',
            value: '4061234567890',
          },
        ],
        catalogRows: [
          {
            productId: 'p-case',
            identifier: 'ABC-1-CMS',
            matchStatus: 'MATCHED',
          },
        ],
      }
    }

    void it(
      'classifies exact, normalized, inactive, ambiguous and absent',
      () => {
        const { items, summary } =
          analyzeUnmatchedSkus({
            sourceSkus: [
              '1.008-057.0',
              '  2.111-111.0  ',
              '3.111-2222',
              'ABC-1',
              '555666',
              '9 999 9990',
              '7 777 7770',
              '0.000-000.0',
              '4061234567890',
              'ABC-1-CMS',
            ],
            ...catalog(),
          })

        const bySku = new Map(
          items.map((item) => [
            item.sourceSku,
            item,
          ]),
        )

        // Exact production hit stays separate.
        assert.deepEqual(
          bySku.get('1.008-057.0')?.exactMatch,
          {
            productId: 'p-exact',
            sku: '1.008-057.0',
            active: true,
          },
        )
        assert.deepEqual(
          bySku.get('1.008-057.0')?.candidates,
          [],
        )

        // Whitespace-only difference.
        assert.equal(
          bySku.get('  2.111-111.0  ')?.exactMatch,
          null,
        )
        assert.ok(
          bySku
            .get('  2.111-111.0  ')
            ?.candidates.some(
              (candidate) =>
                candidate.sku === '2.111-111.0' &&
                candidate.matchType === 'TRIMMED',
            ),
        )

        // Dots/hyphens difference.
        assert.ok(
          bySku
            .get('3.111-2222')
            ?.candidates.some(
              (candidate) =>
                candidate.sku === '31112222' &&
                candidate.matchType ===
                  'PUNCTUATION_NORMALIZED',
            ),
        )

        // Case-only difference is never exact.
        assert.equal(
          bySku.get('ABC-1')?.exactMatch,
          null,
        )
        assert.ok(
          bySku
            .get('ABC-1')
            ?.candidates.some(
              (candidate) =>
                candidate.sku === 'abc-1' &&
                candidate.matchType ===
                  'OTHER_SAFE_NORMALIZATION',
            ),
        )

        // Digits-only fallback.
        assert.ok(
          bySku
            .get('555666')
            ?.candidates.some(
              (candidate) =>
                candidate.sku === 'K 555-666' &&
                candidate.matchType === 'DIGITS_ONLY',
            ),
        )

        // Present but inactive (spaced form, so no
        // exact hit; the normalized candidate is
        // inactive-only).
        const off = bySku.get('9 999 9990')
        assert.equal(off?.exactMatch, null)
        assert.ok(
          (off?.candidates.length ?? 0) > 0,
        )
        assert.ok(
          off?.candidates.every(
            (candidate) =>
              candidate.active === false,
          ),
        )

        // Two products behind one normalized form
        // (neither is an exact hit).
        const amb = bySku.get('7 777 7770')
        assert.equal(amb?.exactMatch, null)
        assert.equal(amb?.ambiguous, true)
        assert.equal(
          amb?.candidates.filter(
            (candidate) =>
              candidate.matchType ===
              'PUNCTUATION_NORMALIZED',
          ).length,
          2,
        )

        // Truly absent.
        const missing = bySku.get('0.000-000.0')
        assert.equal(missing?.exactMatch, null)
        assert.deepEqual(
          missing?.candidates,
          [],
        )
        assert.equal(missing?.ambiguous, false)

        // Identifier + catalog sources are searched too.
        const ean = bySku.get('4061234567890')
        assert.equal(ean?.exactMatch, null)
        assert.ok(
          ean?.candidates.some(
            (candidate) =>
              candidate.source ===
                'product-identifier:EAN' &&
              candidate.matchType === 'TRIMMED',
          ) ?? false,
        )
        const cms = bySku.get('ABC-1-CMS')
        assert.ok(
          cms?.candidates.some(
            (candidate) =>
              candidate.source ===
                'cms-catalog' &&
              candidate.catalogMatchStatus ===
                'MATCHED',
          ) ?? false,
        )

        // Disjoint summary partition.
        assert.deepEqual(summary, {
          totalUnmatched: 10,
          exactElsewhere: 1,
          normalizedCandidateFound: 6,
          noCatalogCandidate: 1,
          inactiveOnly: 1,
          ambiguousCandidates: 1,
        })
      },
    )

    void it(
      'never auto-links and exposes no prices or secrets',
      () => {
        const { items, summary } =
          analyzeUnmatchedSkus({
            sourceSkus: ['ABC-1'],
            ...catalog(),
          })

        for (const item of items) {
          assert.equal(
            (item as Record<string, unknown>)[
              'productId'
            ] ?? null,
            null,
          )
        }

        const serialized = JSON.stringify({
          items,
          summary,
        })
        assert.ok(
          !/token|secret|password|credential|price|competitor|median|average|iban|swift/i.test(
            serialized,
          ),
        )
      },
    )
  },
)

void describe(
  'pricing unmatched-catalog-diagnostics route',
  () => {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
    )

    function adminApp() {
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

      return app
    }

    void it(
      'rejects anonymous callers before touching state',
      async () => {
        const response =
          await arukeresoApi.request(
            '/pricing/unmatched-catalog-diagnostics',
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
          !block.includes(
            'pricing/unmatched-catalog-diagnostics',
          ),
        )
      },
    )

    if (!process.env.DATABASE_URL) {
      void it(
        'fails closed for ADMIN without database configuration',
        async () => {
          setPricingIngressAuditStore({
            get: async () => ({
              receivedAt:
                '2026-09-20T10:00:00.000Z',
              endpoint: '/pricing/sync',
              rawItems: 1,
              normalizedItems: 0,
              acceptedItems: 0,
              droppedItems: 1,
              dropReasons: {
                blankSku: 0,
                invalidRow: 0,
                invalidField: 0,
                duplicateSku: 0,
                unmatched: 1,
                other: 0,
              },
              droppedSkus: ['9.999-999.0'],
              droppedSkuReasons: {
                '9.999-999.0': 'unmatched',
              },
            }),
            set: async () => {},
          })

          try {
            const response = await adminApp().request(
              '/arukereso/pricing/unmatched-catalog-diagnostics',
            )

            // ADMIN passes auth and finds the audit;
            // only the missing database stops it.
            assert.equal(response.status, 503)
          } finally {
            setPricingIngressAuditStore(null)
          }
        },
      )
    }
  },
)

void describe(
  'pricing ingress-diagnostics route',
  () => {
    const repoRoot = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
    )

    function adminApp() {
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

      return app
    }

    void it(
      'rejects anonymous callers before touching state',
      async () => {
        const response =
          await arukeresoApi.request(
            '/pricing/ingress-diagnostics',
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
      'returns 404 when no push has been audited yet',
      async () => {
        setPricingIngressAuditStore({
          get: async () => null,
          set: async () => {},
        })

        try {
          const response = await adminApp().request(
            '/arukereso/pricing/ingress-diagnostics',
          )

          assert.equal(response.status, 404)
        } finally {
          setPricingIngressAuditStore(null)
        }
      },
    )

    void it(
      'returns the latest technical audit to ADMIN',
      async () => {
        const audit = buildPricingIngressAudit(
          '/pricing/sync',
          { items: [{}, {}] },
          {
            ok: true,
            validItems: [{ sku: 'a-1' }],
            summary: {
              rows: 2,
              matchedRows: 1,
              unmatchedRows: 1,
              validMatchedRows: 1,
              invalidMatchedRows: 0,
              duplicateSkuRows: 0,
              hasCompetitor: 0,
              noCompetitor: 0,
              partialMarketData: 0,
            },
            unmatchedSample: [],
            unmatchedItems: [],
            invalidRows: [],
            duplicateRows: [],
          } as never,
          '2026-09-20T10:00:00.000Z',
        )
        setPricingIngressAuditStore({
          get: async () => audit,
          set: async () => {},
        })

        try {
          const response = await adminApp().request(
            '/arukereso/pricing/ingress-diagnostics',
          )

          assert.equal(response.status, 200)
          assert.deepEqual(
            await response.json(),
            { status: 'ok', ...audit },
          )
        } finally {
          setPricingIngressAuditStore(null)
        }
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
          !block.includes('pricing/ingress-diagnostics'),
        )
      },
    )
  },
)
