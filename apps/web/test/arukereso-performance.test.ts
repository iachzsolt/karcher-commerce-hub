import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateProducts,
  applyProductView,
  bucketKey,
  computeRatios,
  eachDateInRange,
  formatCount,
  formatMoney,
  formatRatioPercent,
  formatRoas,
  groupTrendPoints,
  last7CompletedDays,
  resolvePresetRange,
  sumDayRows,
  validateCustomRange,
  type PerformanceDayRow,
  METRIC_HELP,
} from '../src/utils/arukeresoPerformance.ts'

void describe(
  'arukereso performance presets',
  () => {
    // 2026-09-12 10:00 UTC is Saturday 12:00 in Budapest.
    const now = new Date(
      '2026-09-12T10:00:00.000Z',
    )

    void it(
      'resolves completed-day ranges excluding today',
      () => {
        assert.deepEqual(
          resolvePresetRange('yesterday', now),
          {
            from: '2026-09-11',
            to: '2026-09-11',
          },
        )
        assert.deepEqual(
          resolvePresetRange('last7', now),
          {
            from: '2026-09-05',
            to: '2026-09-11',
          },
        )
        assert.deepEqual(
          resolvePresetRange('last30', now),
          {
            from: '2026-08-13',
            to: '2026-09-11',
          },
        )
        assert.deepEqual(
          resolvePresetRange('month', now),
          {
            from: '2026-09-01',
            to: '2026-09-11',
          },
        )
      },
    )

    void it(
      'caps custom ranges at yesterday',
      () => {
        assert.deepEqual(
          validateCustomRange(
            '2026-09-05',
            '2026-09-11',
            '2026-09-12',
            366,
          ),
          {
            ok: true,
            dates: [
              '2026-09-05',
              '2026-09-06',
              '2026-09-07',
              '2026-09-08',
              '2026-09-09',
              '2026-09-10',
              '2026-09-11',
            ],
          },
        )

        const todayRejected = validateCustomRange(
          '2026-09-11',
          '2026-09-12',
          '2026-09-12',
          366,
        )
        assert.equal(todayRejected.ok, false)

        if (!todayRejected.ok) {
          assert.match(
            todayRejected.message,
            /tegnapi/,
          )
        }

        assert.equal(
          validateCustomRange(
            '2026-09-12',
            '2026-09-11',
            '2026-09-12',
            366,
          ).ok,
          false,
        )
        assert.equal(
          validateCustomRange(
            '2025-01-01',
            '2026-09-11',
            '2026-09-12',
            366,
          ).ok,
          false,
        )
        assert.equal(
          validateCustomRange('', '', '2026-09-12', 366)
            .ok,
          false,
        )
      },
    )

    void it(
      'generates the default last-7 completed days',
      () => {
        assert.deepEqual(
          last7CompletedDays('2026-09-12'),
          [
            '2026-09-05',
            '2026-09-06',
            '2026-09-07',
            '2026-09-08',
            '2026-09-09',
            '2026-09-10',
            '2026-09-11',
          ],
        )
        assert.deepEqual(
          eachDateInRange('2026-09-11', '2026-09-11'),
          ['2026-09-11'],
        )
        assert.deepEqual(
          eachDateInRange('2026-09-12', '2026-09-11'),
          [],
        )
      },
    )
  },
)

function sampleRows(): PerformanceDayRow[] {
  return [
    {
      date: '2026-09-10',
      productId: 'product-1',
      sku: '1.100-240.0',
      productName: 'Puzzi 8/1',
      normalizedProductCode: '11002400',
      productCardId: 'card-1',
      sourceProductName: 'Puzzi (11002400)',
      clickSource: 'search',
      matchStatus: 'MATCHED',
      visits: 100,
      costGross: 1000,
      costNet: 800,
      orders: 4,
      revenue: 5000,
    },
    {
      date: '2026-09-11',
      productId: 'product-1',
      sku: '1.100-240.0',
      productName: 'Puzzi 8/1',
      normalizedProductCode: '11002400',
      productCardId: 'card-1',
      sourceProductName: 'Puzzi (11002400)',
      clickSource: 'search',
      matchStatus: 'MATCHED',
      visits: 300,
      costGross: 3000,
      costNet: 2400,
      orders: 12,
      revenue: 15000,
    },
    {
      date: '2026-09-11',
      productId: null,
      sku: null,
      productName: null,
      normalizedProductCode: '99999999',
      productCardId: '',
      sourceProductName: 'Unknown (99999999)',
      clickSource: '',
      matchStatus: 'UNMATCHED',
      visits: 10,
      costGross: 0,
      costNet: 0,
      orders: 0,
      revenue: 0,
    },
  ]
}

void describe(
  'arukereso client aggregation',
  () => {
    void it(
      'sums rows and derives ratios from totals',
      () => {
        const sums = sumDayRows(sampleRows())

        assert.deepEqual(sums, {
          visits: 410,
          costGross: 4000,
          costNet: 3200,
          orders: 16,
          revenue: 20000,
        })
        assert.equal(
          computeRatios(sums).roas,
          5,
        )
        assert.equal(
          computeRatios({
            visits: 0,
            costGross: 0,
            costNet: 0,
            orders: 0,
            revenue: 0,
          }).cpc,
          null,
        )
      },
    )

    void it(
      'aggregates products without re-fetching',
      () => {
        const items = aggregateProducts(
          sampleRows(),
        )

        assert.equal(items.length, 2)

        const matched = items.find(
          (item) => item.productId === 'product-1',
        )
        assert.equal(matched?.sums.visits, 400)
        assert.equal(matched?.ratios.roas, 5)

        const unmatched = items.find(
          (item) => item.productId === null,
        )
        assert.equal(
          unmatched?.matchStatus,
          'UNMATCHED',
        )
      },
    )

    void it(
      'filters and sorts the loaded view locally',
      () => {
        const items = aggregateProducts(
          sampleRows(),
        )
        const base = {
          search: '',
          sort: 'cost',
          order: 'desc' as const,
          hasCost: false,
          hasOrders: false,
          hasRevenue: false,
        }

        assert.deepEqual(
          applyProductView(items, {
            ...base,
            search: 'puzzi',
          }).map((item) => item.key),
          ['p:product-1'],
        )
        assert.deepEqual(
          applyProductView(items, {
            ...base,
            hasRevenue: true,
          }).map((item) => item.key),
          ['p:product-1'],
        )
        assert.deepEqual(
          applyProductView(items, {
            ...base,
            sort: 'visits',
            order: 'asc',
          }).map((item) => item.key),
          ['u:99999999', 'p:product-1'],
        )
      },
    )

    void it(
      'groups trend buckets from loaded rows',
      () => {
        const buckets = groupTrendPoints(
          sampleRows(),
          'month',
        )

        assert.equal(buckets.length, 1)
        assert.equal(
          buckets[0]?.bucket,
          '2026-09',
        )
        assert.equal(
          buckets[0]?.sums.visits,
          410,
        )
        assert.equal(
          buckets[0]?.ratios.roas,
          5,
        )
        assert.equal(
          bucketKey('2026-09-11', 'week'),
          '2026-W37',
        )
      },
    )
  },
)

void describe(
  'arukereso metric help',
  () => {
    void it(
      'defines a Hungarian explanation for every KPI metric',
      () => {
        const keys = [
          'visits',
          'orders',
          'cost',
          'revenue',
          'roas',
          'crr',
          'cvr',
          'cpc',
          'aov',
        ]

        for (const key of keys) {
          assert.equal(
            typeof METRIC_HELP[key],
            'string',
          )
          assert.ok(
            (METRIC_HELP[key]?.trim().length ??
              0) > 0,
          )
        }
      },
    )

    void it(
      'expands abbreviations to full English names',
      () => {
        assert.match(
          METRIC_HELP.roas ?? '',
          /Return on Ad Spend/,
        )
        assert.match(
          METRIC_HELP.crr ?? '',
          /Cost Revenue Ratio/,
        )
        assert.match(
          METRIC_HELP.cvr ?? '',
          /Conversion Rate/,
        )
        assert.match(
          METRIC_HELP.cpc ?? '',
          /Cost per Click/,
        )
        assert.match(
          METRIC_HELP.aov ?? '',
          /Average Order Value/,
        )
      },
    )
  },
)

void describe(
  'arukereso performance formatting',
  () => {
    void it(
      'formats money, counts and ratios',
      () => {
        assert.equal(
          formatMoney(173391, null),
          '173 391 Ft',
        )
        assert.equal(formatMoney(null, null), '–')
        assert.equal(
          formatMoney(100, 'CZK'),
          '100 CZK',
        )
        assert.equal(formatCount(428), '428')
        assert.equal(formatCount(null), '–')
        assert.equal(formatRoas(20.14), '20,14×')
        assert.equal(formatRoas(null), '–')
        assert.equal(
          formatRatioPercent(4.96),
          '4,96%',
        )
        assert.equal(
          formatRatioPercent(null),
          '–',
        )
      },
    )
  },
)
