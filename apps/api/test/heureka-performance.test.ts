import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  arukeresoPerformanceApi,
  enrichHeurekaRows,
  extractProductCode,
  fetchWithRetry,
  isCompletedDay,
  isValidDateParam,
  matchProductCode,
  normalizeHeurekaRow,
  normalizeHubSku,
} from '../src/arukereso-performance.ts'

void describe(
  'heureka date validation',
  () => {
    void it(
      'accepts calendar dates and rejects the rest',
      () => {
        assert.equal(
          isValidDateParam('2026-09-11'),
          true,
        )
        assert.equal(
          isValidDateParam('2026-13-40'),
          false,
        )
        assert.equal(
          isValidDateParam('11.09.2026'),
          false,
        )
        assert.equal(
          isValidDateParam(null),
          false,
        )
      },
    )
  },
)

void describe(
  'heureka product-code extraction',
  () => {
    void it(
      'extracts the trailing numeric code',
      () => {
        assert.equal(
          extractProductCode(
            'Kärcher - Permetextrakciós tisztító Puzzi 8/1 (11002400)',
          ),
          '11002400',
        )
        assert.equal(
          extractProductCode('Name (13679020)  '),
          '13679020',
        )
      },
    )

    void it(
      'extracts all observed real Heureka names',
      () => {
        assert.equal(
          extractProductCode(
            'Kärcher - Permetextrakciós tisztító Puzzi 8/1 (11002400)',
          ),
          '11002400',
        )
        assert.equal(
          extractProductCode(
            'Kärcher - Gőztisztító SC 5 Deluxe Signature Line (15134910)',
          ),
          '15134910',
        )
        assert.equal(
          extractProductCode(
            'Kärcher - Magasnyomású mosó HD 7/18-4 M Classic (13679020)',
          ),
          '13679020',
        )
        assert.equal(
          extractProductCode(
            'Kärcher - Magasnyomású mosó K 4 Power Control Go! Further (13243120)',
          ),
          '13243120',
        )
      },
    )

    void it(
      'rejects missing or non-numeric codes',
      () => {
        assert.equal(
          extractProductCode('Name without code'),
          null,
        )
        assert.equal(
          extractProductCode('Name (abc)'),
          null,
        )
        assert.equal(extractProductCode(null), null)
        assert.equal(extractProductCode(42), null)
      },
    )
  },
)

void describe(
  'heureka SKU matching',
  () => {
    void it(
      'normalizes Hub SKUs to digits only',
      () => {
        assert.equal(
          normalizeHubSku('1.100-240.0'),
          '11002400',
        )
        assert.equal(
          normalizeHubSku('1.513-491.0'),
          '15134910',
        )
        assert.equal(
          normalizeHubSku('1.367-902.0'),
          '13679020',
        )
        assert.equal(
          normalizeHubSku('1.324-312.0'),
          '13243120',
        )
      },
    )

    void it(
      'matches exactly and never fuzzily',
      () => {
        const productByCode = new Map([
          ['11002400', 'product-1'],
        ])

        assert.equal(
          matchProductCode('11002400', productByCode),
          'product-1',
        )
        assert.equal(
          matchProductCode('99999999', productByCode),
          null,
        )
        assert.equal(
          matchProductCode(null, productByCode),
          null,
        )
        // Near-miss codes must not match.
        assert.equal(
          matchProductCode('1100240', productByCode),
          null,
        )
      },
    )

    void it(
      'enriches day rows with exact matches only',
      () => {
        const items = enrichHeurekaRows(
          [
            normalizeHeurekaRow({
              shop_item: {
                id: '',
                name: 'Kärcher Puzzi (11002400)',
              },
              visits: { total: 10 },
            }),
            normalizeHeurekaRow({
              shop_item: {
                id: '',
                name: 'Unknown gadget (99999999)',
              },
              visits: { total: 3 },
            }),
            normalizeHeurekaRow({
              shop_item: { id: '', name: 'No code' },
              visits: { total: 1 },
            }),
          ],
          [
            {
              id: 'product-1',
              sku: '1.100-240.0',
              name: 'Puzzi 8/1',
            },
          ],
        )

        assert.equal(items.length, 3)
        assert.equal(
          items[0]?.matchStatus,
          'MATCHED',
        )
        assert.equal(
          items[0]?.productId,
          'product-1',
        )
        assert.equal(items[0]?.sku, '1.100-240.0')
        assert.equal(
          items[1]?.matchStatus,
          'UNMATCHED',
        )
        assert.equal(items[1]?.productId, null)
        assert.equal(
          items[2]?.matchStatus,
          'UNMATCHED',
        )
      },
    )
  },
)

void describe(
  'heureka empty day',
  () => {
    void it(
      'treats empty conversions as zero rows',
      () => {
        const items = enrichHeurekaRows([], [])

        assert.deepEqual(items, [])
      },
    )
  },
)

void describe(
  'heureka fetch retry',
  () => {
    void it(
      'retries temporary 5xx errors with backoff',
      async () => {
        let calls = 0
        const response = await fetchWithRetry(
          async () => {
            calls += 1

            if (calls < 3) {
              return {
                ok: false,
                status: 521,
                json: async () => ({}),
                text: async () => '',
              }
            }

            return {
              ok: true,
              status: 200,
              json: async () => ({ conversions: [] }),
              text: async () => '',
            }
          },
          'https://example.invalid',
          {},
          3,
        )

        assert.equal(response.ok, true)
        assert.equal(calls, 3)
      },
    )

    void it(
      'never retries client errors and gives up',
      async () => {
        let clientCalls = 0
        const clientResponse = await fetchWithRetry(
          async () => {
            clientCalls += 1

            return {
              ok: false,
              status: 401,
              json: async () => ({}),
              text: async () => '',
            }
          },
          'https://example.invalid',
          {},
          3,
        )

        assert.equal(clientCalls, 1)
        assert.equal(clientResponse.status, 401)

        let serverCalls = 0

        await assert.rejects(
          fetchWithRetry(
            async () => {
              serverCalls += 1

              throw new Error('socket hang up')
            },
            'https://example.invalid',
            {},
            3,
          ),
        )
        assert.equal(serverCalls, 3)
      },
    )
  },
)

void describe(
  'heureka day endpoint',
  () => {
    const apiKeyEnv = 'ARUKERESO_REPORTS_API_KEY'

    void it(
      'rejects invalid dates without touching secrets',
      async () => {
        const response =
          await arukeresoPerformanceApi.request(
            '/day?date=not-a-date',
          )
        const body = (await response.json()) as {
          status?: string
        }

        assert.equal(response.status, 400)
        assert.equal(body.status, 'error')
      },
    )

    void it(
      'rejects today and future days defensively',
      async () => {
        assert.equal(
          isCompletedDay('2026-09-11', '2026-09-12'),
          true,
        )
        assert.equal(
          isCompletedDay('2026-09-12', '2026-09-12'),
          false,
        )
        assert.equal(
          isCompletedDay('2999-01-01', '2026-09-12'),
          false,
        )

        const response =
          await arukeresoPerformanceApi.request(
            '/day?date=2999-01-01',
          )
        const body = (await response.json()) as {
          status?: string
          message?: string
        }

        assert.equal(response.status, 400)
        assert.equal(body.status, 'error')
        assert.match(
          body.message ?? '',
          /lezárt napokra/,
        )
      },
    )

    void it(
      'requires configuration without exposing the key',
      async () => {
        const previousKey = process.env[apiKeyEnv]
        const previousDatabaseUrl =
          process.env.DATABASE_URL
        const canary = 'canary-secret-value-12345'
        process.env[apiKeyEnv] = canary
        delete process.env.DATABASE_URL

        try {
          const response =
            await arukeresoPerformanceApi.request(
              '/day?date=2026-09-11',
            )
          const text = await response.text()

          assert.equal(response.status, 503)
          assert.equal(
            text.includes(canary),
            false,
          )
        } finally {
          if (previousKey === undefined) {
            delete process.env[apiKeyEnv]
          } else {
            process.env[apiKeyEnv] = previousKey
          }

          if (previousDatabaseUrl !== undefined) {
            process.env.DATABASE_URL =
              previousDatabaseUrl
          }
        }
      },
    )
  },
)
