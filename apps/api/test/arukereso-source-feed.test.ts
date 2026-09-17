import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  coordinateScheduledSourceFeedRefresh,
  downloadArukeresoSourceFeed,
  getBudapestCalendarMinute,
  getSourceFeedUtcCronPatterns,
  resolveSourceFeedConfiguration,
  shouldRunScheduledSourceFeedRefresh,
  SourceFeedRefreshError,
} from '../src/arukereso-source-feed.ts'
import {
  analyzeCatalogCsv,
  assertSnapshotSizeSafety,
  cmsIdentifierToSku,
  computeCatalogSnapshotDiff,
  createCatalogSourceFingerprint,
  createKeyedSerialExecutor,
  evaluateFeedEligibility,
  FEED_ELIGIBILITY_DEFAULT_SETTINGS,
  indexCatalogSearchEntries,
  matchesArukeresoProductSearch,
  normalizeArukeresoSearchNeedle,
  parseCatalogFeedSourceRow,
  parseDeliveryTimeDays,
  parseSemicolonCsv,
  runPostCatalogImportFeedHook,
  toCatalogFeedOutputRow,
} from '../src/arukereso.ts'

const remoteEnvironment = {
  ARUKERESO_SOURCE_FEED_URL:
    'https://source.example.test/catalog.csv',
  ARUKERESO_SOURCE_FEED_USERNAME: 'service-user',
  ARUKERESO_SOURCE_FEED_PASSWORD: 'service-secret',
  ARUKERESO_SOURCE_FEED_MAX_ATTEMPTS: '2',
}

const sourceRow = {
  Identifier: '10040620',
  EanCode: '4054278000000',
  Manufacturer: 'Kärcher',
  Name: 'Test product',
  Description: 'Description',
  Category: 'Category',
  ProductUrl: 'https://example.test/product',
  ImageUrl: 'https://example.test/image.jpg',
  ImageUrl2: '',
  Price: '12 990 Ft',
  NetPrice: '10 228,35 Ft',
  DeliveryCost: '1 490 Ft',
  DeliveryTime: '8 munkanap',
}

function fingerprint(overrides: Partial<typeof sourceRow> = {}) {
  const rawSource = { ...sourceRow, ...overrides }

  return createCatalogSourceFingerprint({
    rawSource,
    normalizedSku: '1.004-062.0',
    priceMinor: 1_299_000,
    netPriceMinor: 1_022_835,
    deliveryCostMinor: 149_000,
    deliveryTimeDays:
      Number.parseInt(rawSource.DeliveryTime, 10),
    matchStatus: 'MATCHED',
    matchMethod: 'SKU',
    matchedProductId: 'product-1',
  } as never)
}

void describe('Arukereso source feed download', () => {
  void it('downloads UTF-8 CSV with an Authorization header', async () => {
    let authorization: string | null = null
    const csv = 'Identifier;Price\n10040620;12990\n'
    const result = await downloadArukeresoSourceFeed({
      environment: remoteEnvironment,
      fetchImplementation: async (_url, init) => {
        authorization = new Headers(init?.headers).get(
          'Authorization',
        )
        return new Response(csv, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv;charset=UTF-8',
          },
        })
      },
    })

    assert.equal(result, csv)
    assert.match(authorization ?? '', /^Basic /)
    assert.equal(
      Buffer.from(
        (authorization ?? '').slice('Basic '.length),
        'base64',
      ).toString('utf8'),
      'service-user:service-secret',
    )
  })

  void it('fails closed when credentials are missing', () => {
    assert.throws(
      () =>
        resolveSourceFeedConfiguration({
          ARUKERESO_SOURCE_FEED_URL:
            remoteEnvironment.ARUKERESO_SOURCE_FEED_URL,
        }),
      (error: unknown) =>
        error instanceof SourceFeedRefreshError &&
        error.code === 'FAILED_CONFIGURATION' &&
        !error.message.includes('service-secret'),
    )
  })

  void it('rejects credentials embedded in the source URL', () => {
    assert.throws(
      () =>
        resolveSourceFeedConfiguration({
          ...remoteEnvironment,
          ARUKERESO_SOURCE_FEED_URL:
            'https://embedded-user:embedded-secret@source.example.test/catalog.csv',
        }),
      (error: unknown) =>
        error instanceof SourceFeedRefreshError &&
        error.code === 'FAILED_CONFIGURATION' &&
        !error.message.includes('embedded-user') &&
        !error.message.includes('embedded-secret'),
    )
  })

  void it('retries a transient HTTP failure with a bounded count', async () => {
    let attempts = 0
    const result = await downloadArukeresoSourceFeed({
      environment: remoteEnvironment,
      retryDelay: async () => undefined,
      fetchImplementation: async () => {
        attempts += 1
        return attempts === 1
          ? new Response('', { status: 503 })
          : new Response('csv', {
              status: 200,
              headers: { 'Content-Type': 'text/csv' },
            })
      },
    })

    assert.equal(result, 'csv')
    assert.equal(attempts, 2)
  })

  void it('rejects non-CSV responses without exposing secrets', async () => {
    await assert.rejects(
      downloadArukeresoSourceFeed({
        environment: remoteEnvironment,
        fetchImplementation: async () =>
          new Response('<html>login</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
      }),
      (error: unknown) =>
        error instanceof SourceFeedRefreshError &&
        error.code === 'FAILED_DOWNLOAD' &&
        !error.message.includes('service-user') &&
        !error.message.includes('service-secret'),
    )
  })

  void it('rejects responses above the configured size cap', async () => {
    await assert.rejects(
      downloadArukeresoSourceFeed({
        environment: {
          ...remoteEnvironment,
          ARUKERESO_SOURCE_FEED_MAX_BYTES: '3',
        },
        fetchImplementation: async () =>
          new Response('four', {
            status: 200,
            headers: { 'Content-Type': 'text/csv' },
          }),
      }),
      (error: unknown) =>
        error instanceof SourceFeedRefreshError &&
        error.code === 'FAILED_DOWNLOAD',
    )
  })
})

void describe('catalog snapshot validation and changes', () => {
  void it('normalizes CMS Identifier to Hub SKU', () => {
    assert.equal(cmsIdentifierToSku('10040620'), '1.004-062.0')
    assert.equal(cmsIdentifierToSku('invalid'), null)
  })

  void it('rejects malformed quoted CSV', () => {
    assert.throws(() => parseSemicolonCsv('A;"unterminated'))
  })

  void it('rejects a missing required header before database access', async () => {
    await assert.rejects(
      analyzeCatalogCsv('Identifier;Price\n10040620;12990\n'),
      /fejlece nem megfelelo/,
    )
  })

  void it('models A/B/C to A/C/D replacement without retaining B', () => {
    const result = computeCatalogSnapshotDiff(
      [
        { sourceItemKey: 'A', sourceFingerprint: 'a' },
        { sourceItemKey: 'B', sourceFingerprint: 'b' },
        { sourceItemKey: 'C', sourceFingerprint: 'c-old' },
      ],
      [
        { sourceItemKey: 'A', sourceFingerprint: 'a' },
        { sourceItemKey: 'C', sourceFingerprint: 'c-new' },
        { sourceItemKey: 'D', sourceFingerprint: 'd' },
      ],
    )

    assert.deepEqual(result, {
      added: 1,
      removed: 1,
      changed: 1,
      unchanged: 1,
      changedItemCount: 3,
    })
  })

  void it('detects source Price and DeliveryTime changes', () => {
    const original = fingerprint()

    assert.notEqual(
      fingerprint({ Price: '13 990 Ft' }),
      original,
    )
    assert.notEqual(
      fingerprint({ DeliveryTime: '43 munkanap' }),
      original,
    )
  })

  void it('detects an identical snapshot as NO_CHANGE input', () => {
    assert.equal(
      computeCatalogSnapshotDiff(
        [{ sourceItemKey: 'A', sourceFingerprint: 'a' }],
        [{ sourceItemKey: 'A', sourceFingerprint: 'a' }],
      ).changedItemCount,
      0,
    )
  })

  void it('rejects a catastrophic relative row drop', () => {
    const previous = process.env.ARUKERESO_SNAPSHOT_MIN_RATIO
    process.env.ARUKERESO_SNAPSHOT_MIN_RATIO = '0.6'

    try {
      assert.throws(() =>
        assertSnapshotSizeSafety({
          source: 'CATALOG',
          previousRows: 3_400,
          incomingRows: 300,
        }),
      )
    } finally {
      if (previous === undefined) {
        delete process.env.ARUKERESO_SNAPSHOT_MIN_RATIO
      } else {
        process.env.ARUKERESO_SNAPSHOT_MIN_RATIO = previous
      }
    }
  })

  void it('uses independent catalog and pricing thresholds with legacy fallback', () => {
    const variableNames = [
      'ARUKERESO_SNAPSHOT_MIN_RATIO',
      'ARUKERESO_CATALOG_SNAPSHOT_MIN_RATIO',
      'ARUKERESO_PRICING_SNAPSHOT_MIN_RATIO',
    ] as const
    const previous = Object.fromEntries(
      variableNames.map((name) => [name, process.env[name]]),
    )

    process.env.ARUKERESO_SNAPSHOT_MIN_RATIO = '0.6'
    process.env.ARUKERESO_CATALOG_SNAPSHOT_MIN_RATIO = '0.85'
    delete process.env.ARUKERESO_PRICING_SNAPSHOT_MIN_RATIO

    try {
      assert.throws(() =>
        assertSnapshotSizeSafety({
          source: 'CATALOG',
          previousRows: 1_000,
          incomingRows: 800,
        }),
      )
      assert.doesNotThrow(() =>
        assertSnapshotSizeSafety({
          source: 'PRICING',
          previousRows: 1_000,
          incomingRows: 800,
        }),
      )

      process.env.ARUKERESO_PRICING_SNAPSHOT_MIN_RATIO = '0.9'
      assert.throws(() =>
        assertSnapshotSizeSafety({
          source: 'PRICING',
          previousRows: 1_000,
          incomingRows: 800,
        }),
      )
    } finally {
      for (const name of variableNames) {
        const value = previous[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})

void describe('catalog refresh orchestration', () => {
  void it('requests exactly one CATALOG_SYNC generation after change', async () => {
    const triggers: string[] = []
    const result = await runPostCatalogImportFeedHook(
      { changed: true },
      async (trigger) => {
        triggers.push(trigger)
        return { status: 'ok', runId: 'feed-run' }
      },
    )

    assert.deepEqual(triggers, ['CATALOG_SYNC'])
    assert.deepEqual(result, {
      status: 'ok',
      runId: 'feed-run',
    })
  })

  void it('requests zero generations for NO_CHANGE', async () => {
    let calls = 0
    const result = await runPostCatalogImportFeedHook(
      { changed: false },
      async () => {
        calls += 1
        return { status: 'ok' }
      },
    )

    assert.equal(calls, 0)
    assert.deepEqual(result, { status: 'NOT_REQUESTED' })
  })

  void it('isolates downstream generation failure from source success', async () => {
    const result = await runPostCatalogImportFeedHook(
      { changed: true },
      async () => {
        throw new Error('internal secret detail')
      },
      false,
    )

    assert.deepEqual(result, {
      status: 'FAILED',
      error: 'Feed generation failed.',
    })
  })

  void it('serializes overlapping refresh work for one connection', async () => {
    const runSerial = createKeyedSerialExecutor()
    const events: string[] = []
    let release = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = runSerial('catalog', async () => {
      events.push('first-start')
      await gate
      events.push('first-end')
    })
    const second = runSerial('catalog', async () => {
      events.push('second-start')
    })

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ['first-start'])
    release()
    await Promise.all([first, second])
    assert.deepEqual(events, [
      'first-start',
      'first-end',
      'second-start',
    ])
  })
})

void describe('commercial source authority', () => {
  void it('preserves source commercial fields and DeliveryTime when included', () => {
    const source = parseCatalogFeedSourceRow(
      JSON.stringify(sourceRow),
      'catalog-item',
    )
    const output = toCatalogFeedOutputRow({
      source,
      sku: '1.004-062.0',
      stockQuantity: 0,
      result: { included: true },
    } as never)

    assert.equal(output.Price, sourceRow.Price)
    assert.equal(output.NetPrice, sourceRow.NetPrice)
    assert.equal(output.DeliveryCost, sourceRow.DeliveryCost)
    assert.equal(output.DeliveryTime, '8 munkanap')
  })

  void it('uses DeliveryTime=NO only for downstream exclusion', () => {
    const source = parseCatalogFeedSourceRow(
      JSON.stringify(sourceRow),
      'catalog-item',
    )
    const output = toCatalogFeedOutputRow({
      source,
      sku: '1.004-062.0',
      result: { included: false },
    } as never)

    assert.equal(output.DeliveryTime, 'NO')
  })
})

void describe('Budapest source refresh schedule', () => {
  void it('uses 06:45 Budapest time in winter and summer', () => {
    assert.deepEqual(
      getBudapestCalendarMinute(
        new Date('2026-01-15T05:45:00.000Z'),
      ),
      { date: '2026-01-15', time: '06:45' },
    )
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-07-15T04:45:00.000Z'),
        {},
      ).shouldRun,
      true,
    )
  })

  void it('allows delayed delivery and a spring DST skipped minute', () => {
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-07-15T04:46:00.000Z'),
        {},
      ).shouldRun,
      true,
    )
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-03-29T01:30:00.000Z'),
        { ARUKERESO_SOURCE_FEED_REFRESH_TIME: '02:30' },
      ).shouldRun,
      true,
    )
  })

  void it('does not run before the Budapest target window', () => {
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-07-15T04:44:00.000Z'),
        {},
      ).shouldRun,
      false,
    )
  })

  void it('includes the exact two-hour boundary but not the next minute', () => {
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-07-15T06:45:00.000Z'),
        {},
      ).shouldRun,
      true,
    )
    assert.equal(
      shouldRunScheduledSourceFeedRefresh(
        new Date('2026-07-15T06:46:00.000Z'),
        {},
      ).shouldRun,
      false,
    )
  })

  void it('registers both DST candidates and the UTC fallback', () => {
    assert.deepEqual(getSourceFeedUtcCronPatterns({}), [
      '45 4 * * *',
      '45 5 * * *',
      '45 6 * * *',
    ])
  })
})

function createScheduledRefreshHarness() {
  const successfulDates = new Set<string>()
  let activeExecutions = 0
  let maxActiveExecutions = 0
  let refreshCalls = 0
  let successfulMarks = 0
  let promotionCalls = 0
  let feedGenerationCalls = 0
  const runSerial = createKeyedSerialExecutor()

  return {
    get state() {
      return {
        dailySuccessful: successfulDates.size > 0,
        maxActiveExecutions,
        refreshCalls,
        successfulMarks,
        promotionCalls,
        feedGenerationCalls,
      }
    },
    input(
      now: Date,
      refresh: () => Promise<string>,
    ) {
      return {
        now,
        environment: {},
        hasSuccessfulDailyRefresh: async (schedule: {
          date: string
        }) => successfulDates.has(schedule.date),
        withExecutionLock: (action: (
          assertOwned: () => Promise<void>,
        ) => Promise<{
          status: 'SUCCESS' | 'ALREADY_SUCCESSFUL'
          result?: string
        }>) =>
          runSerial('scheduled-refresh', async () => {
            activeExecutions += 1
            maxActiveExecutions = Math.max(
              maxActiveExecutions,
              activeExecutions,
            )
            try {
              return await action(async () => undefined)
            } finally {
              activeExecutions -= 1
            }
          }),
        refresh: async () => {
          refreshCalls += 1
          const result = await refresh()
          promotionCalls += 1
          feedGenerationCalls += 1
          return result
        },
        markDailyRefreshSuccessful: async (schedule: {
          date: string
        }) => {
          successfulMarks += 1
          successfulDates.add(schedule.date)
        },
      }
    },
  }
}

void describe('scheduled source refresh retry semantics', () => {
  void it('retries at 07:45 CEST after the 06:45 attempt fails', async () => {
    const harness = createScheduledRefreshHarness()

    await assert.rejects(
      coordinateScheduledSourceFeedRefresh(
        harness.input(
          new Date('2026-07-15T04:45:00.000Z'),
          async () => {
            throw new Error('download failed')
          },
        ),
      ),
      /download failed/,
    )
    assert.equal(harness.state.dailySuccessful, false)
    assert.equal(harness.state.successfulMarks, 0)

    const retry = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-15T05:45:00.000Z'),
        async () => 'retried',
      ),
    )

    assert.equal(retry.status, 'SUCCESS')
    assert.equal(harness.state.refreshCalls, 2)
    assert.equal(harness.state.promotionCalls, 1)
    assert.equal(harness.state.feedGenerationCalls, 1)
  })

  void it('skips later CEST candidates after success', async () => {
    const harness = createScheduledRefreshHarness()
    await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-15T04:45:00.000Z'),
        async () => 'success',
      ),
    )

    const second = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-15T05:45:00.000Z'),
        async () => 'must-not-run',
      ),
    )
    const fallback = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-15T06:45:00.000Z'),
        async () => 'must-not-run',
      ),
    )

    assert.equal(second.status, 'ALREADY_SUCCESSFUL')
    assert.equal(fallback.status, 'ALREADY_SUCCESSFUL')
    assert.equal(harness.state.refreshCalls, 1)
    assert.equal(harness.state.successfulMarks, 1)
  })

  void it('does not let one Budapest date suppress the next day', async () => {
    const harness = createScheduledRefreshHarness()
    await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-15T04:45:00.000Z'),
        async () => 'first-day',
      ),
    )
    const nextDay = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-07-16T04:45:00.000Z'),
        async () => 'next-day',
      ),
    )

    assert.equal(nextDay.status, 'SUCCESS')
    assert.equal(harness.state.refreshCalls, 2)
    assert.equal(harness.state.successfulMarks, 2)
  })

  void it('skips 05:45 CET local, then retries at 07:45 after failure', async () => {
    const harness = createScheduledRefreshHarness()
    const early = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-01-15T04:45:00.000Z'),
        async () => 'must-not-run',
      ),
    )
    assert.equal(early.status, 'INELIGIBLE')

    await assert.rejects(
      coordinateScheduledSourceFeedRefresh(
        harness.input(
          new Date('2026-01-15T05:45:00.000Z'),
          async () => {
            throw new Error('download failed')
          },
        ),
      ),
      /download failed/,
    )

    const retry = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-01-15T06:45:00.000Z'),
        async () => 'retried',
      ),
    )
    assert.equal(retry.status, 'SUCCESS')
    assert.equal(harness.state.refreshCalls, 2)
    assert.equal(harness.state.successfulMarks, 1)
  })

  void it('skips the 07:45 CET candidate after success', async () => {
    const harness = createScheduledRefreshHarness()
    await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-01-15T05:45:00.000Z'),
        async () => 'success',
      ),
    )
    const fallback = await coordinateScheduledSourceFeedRefresh(
      harness.input(
        new Date('2026-01-15T06:45:00.000Z'),
        async () => 'must-not-run',
      ),
    )

    assert.equal(fallback.status, 'ALREADY_SUCCESSFUL')
    assert.equal(harness.state.refreshCalls, 1)
  })

  void it('serializes simultaneous candidates and rechecks success inside the lock', async () => {
    const harness = createScheduledRefreshHarness()
    let release = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const now = new Date('2026-07-15T04:45:00.000Z')
    const first = coordinateScheduledSourceFeedRefresh(
      harness.input(now, async () => {
        await gate
        return 'success'
      }),
    )
    const second = coordinateScheduledSourceFeedRefresh(
      harness.input(now, async () => 'must-not-run'),
    )

    await new Promise<void>((resolve) => setImmediate(resolve))
    release()
    const results = await Promise.all([first, second])

    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ['ALREADY_SUCCESSFUL', 'SUCCESS'],
    )
    assert.equal(harness.state.maxActiveExecutions, 1)
    assert.equal(harness.state.refreshCalls, 1)
    assert.equal(harness.state.promotionCalls, 1)
    assert.equal(harness.state.feedGenerationCalls, 1)
  })
})

void describe('commercial validation: delivery parsing and zero-price safety', () => {
  void it('parses 85, 889 and 1000 munkanap', () => {
    assert.equal(parseDeliveryTimeDays('85 munkanap'), 85)
    assert.equal(parseDeliveryTimeDays('889 munkanap'), 889)
    assert.equal(parseDeliveryTimeDays('1000 munkanap'), 1000)
    assert.equal(parseDeliveryTimeDays('85'), 85)
  })

  void it('keeps integer overflow invalid', () => {
    assert.equal(
      parseDeliveryTimeDays('2147483648 munkanap'),
      null,
    )
    assert.equal(
      parseDeliveryTimeDays('99999999999 munkanap'),
      null,
    )
    assert.equal(parseDeliveryTimeDays(''), null)
    assert.equal(parseDeliveryTimeDays('azonnal'), null)
  })

  void it('accepts a mixed snapshot with Price=0 without snapshot rejection', async () => {
    const header =
      'Identifier;EanCode;Manufacturer;Name;Description;Category;ProductUrl;ImageUrl;ImageUrl2;Price;NetPrice;DeliveryCost;DeliveryTime'
    const row = (
      identifier: string,
      ean: string,
      price: string,
      deliveryTime: string,
    ) =>
      [
        identifier,
        ean,
        'Kärcher',
        `Product ${identifier}`,
        'Description',
        'Category',
        `https://example.test/${identifier}`,
        'https://example.test/image.jpg',
        '',
        price,
        price,
        'Ingyenes',
        deliveryTime,
      ].join(';')
    const csv = [
      header,
      row('26451800', '4054278000001', '0', '85 munkanap'),
      row('28528027', '4054278000002', '224500', '1000 munkanap'),
      row('54530500', '4054278000003', '8100', '889 munkanap'),
    ].join('\n')

    const analysis = await analyzeCatalogCsv(csv, {
      hubProducts: [],
      hubIdentifiers: [],
    })

    assert.equal(analysis.summary.invalidRows, 0)
    assert.equal(analysis.summary.zeroPriceRows, 1)
    assert.equal(analysis.summary.validRows, 3)

    const validItems = analysis.allItems.filter(
      (item) => item.errors.length === 0,
    )
    assert.equal(validItems.length, 3)

    const zeroPriceItem = analysis.allItems.find(
      (item) => item.identifier === '26451800',
    )
    assert.ok(zeroPriceItem)
    assert.deepEqual(zeroPriceItem.errors, [])
    assert.equal(zeroPriceItem.priceMinor, 0)
    assert.equal(zeroPriceItem.rawSource.Price, '0')
    assert.equal(
      zeroPriceItem.rawSource.DeliveryTime,
      '85 munkanap',
    )
  })

  void it('blocks zero-price rows from active feed, even with FORCE_INCLUDE', () => {
    const pricingRow = {
      priceIndexBps: 10000,
      medianIndexBps: null,
      averageIndexBps: null,
      dataStatus: 'HAS_COMPETITOR',
      observedAt: new Date(),
    }
    const now = new Date()

    const blocked = evaluateFeedEligibility({
      pricingRow,
      stockQuantity: 5,
      override: 'INHERIT',
      settings: FEED_ELIGIBILITY_DEFAULT_SETTINGS,
      now,
      catalogPriceMinor: 0,
    })
    assert.equal(blocked.included, false)
    assert.equal(blocked.decision, 'EXCLUDED')
    assert.equal(
      blocked.reasonCode,
      'FEED_BLOCKED_INVALID_CATALOG_PRICE',
    )

    const forced = evaluateFeedEligibility({
      pricingRow,
      stockQuantity: 5,
      override: 'FORCE_INCLUDE',
      settings: FEED_ELIGIBILITY_DEFAULT_SETTINGS,
      now,
      catalogPriceMinor: 0,
    })
    assert.equal(forced.included, false)
    assert.equal(
      forced.reasonCode,
      'FEED_BLOCKED_INVALID_CATALOG_PRICE',
    )

    const missing = evaluateFeedEligibility({
      pricingRow,
      stockQuantity: 5,
      override: 'FORCE_INCLUDE',
      settings: FEED_ELIGIBILITY_DEFAULT_SETTINGS,
      now,
      catalogPriceMinor: null,
    })
    assert.equal(missing.included, false)
    assert.equal(
      missing.reasonCode,
      'FEED_BLOCKED_INVALID_CATALOG_PRICE',
    )
  })

  void it('keeps positive-price rows on the existing eligibility path', () => {
    const now = new Date()
    const result = evaluateFeedEligibility({
      pricingRow: {
        priceIndexBps: 10000,
        medianIndexBps: null,
        averageIndexBps: null,
        dataStatus: 'HAS_COMPETITOR',
        observedAt: now,
      },
      stockQuantity: 5,
      override: 'INHERIT',
      settings: FEED_ELIGIBILITY_DEFAULT_SETTINGS,
      now,
      catalogPriceMinor: 1299000,
    })

    assert.equal(result.included, true)
    assert.equal(
      result.reasonCode,
      'FEED_ELIGIBLE_PRICING_RULES',
    )
  })

  void it('preserves raw 889 and 1000 munkanap values in outgoing data', () => {
    for (const deliveryTime of [
      '889 munkanap',
      '1000 munkanap',
    ]) {
      const source = parseCatalogFeedSourceRow(
        JSON.stringify({ ...sourceRow, DeliveryTime: deliveryTime }),
        'catalog-item',
      )
      assert.equal(source.DeliveryTime, deliveryTime)

      const active = toCatalogFeedOutputRow({
        source,
        sku: '1.004-062.0',
        result: { included: true },
      } as never)
      assert.equal(active.DeliveryTime, deliveryTime)

      const excluded = toCatalogFeedOutputRow({
        source,
        sku: '1.004-062.0',
        result: { included: false },
      } as never)
      assert.equal(excluded.DeliveryTime, 'NO')
    }
  })
})

void describe('arukereso product search', () => {
  const matchedProduct = {
    sku: '2.645-180.0',
    identifier: '26451800',
    eanCode: '4039784577602',
    names: ['Kärcher HT 3.400', 'HT 3.400 magasnyomású'],
  }
  const otherProduct = {
    sku: '2.852-802.7',
    identifier: '28528027',
    eanCode: '4054278000000',
    names: ['Kärcher Other'],
  }

  void it('normalizes empty queries to unfiltered', () => {
    assert.equal(normalizeArukeresoSearchNeedle(null), null)
    assert.equal(normalizeArukeresoSearchNeedle(''), null)
    assert.equal(normalizeArukeresoSearchNeedle('   '), null)
    assert.equal(
      normalizeArukeresoSearchNeedle('  HT 3.400 '),
      'ht 3.400',
    )
  })

  void it('finds the product by dotted SKU', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('2.645-180.0'),
      ),
      true,
    )
  })

  void it('finds the mapped SKU by source Identifier', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('26451800'),
      ),
      true,
    )
  })

  void it('bridges SKU and Identifier formats in both directions', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        {
          sku: '2.645-180.0',
          identifier: null,
          eanCode: null,
          names: [],
        },
        normalizeArukeresoSearchNeedle('26451800'),
      ),
      true,
    )
    assert.equal(
      matchesArukeresoProductSearch(
        {
          sku: 'unrelated-sku',
          identifier: '26451800',
          eanCode: null,
          names: [],
        },
        normalizeArukeresoSearchNeedle('2.645-180.0'),
      ),
      true,
    )
  })

  void it('finds the product by EAN', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('4039784577602'),
      ),
      true,
    )
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('845776'),
      ),
      true,
    )
  })

  void it('keeps product and source name search working', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('HT 3.400'),
      ),
      true,
    )
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('magasnyomású'),
      ),
      true,
    )
  })

  void it('leaves empty search unfiltered', () => {
    for (const query of [null, '', '   '] as const) {
      assert.equal(
        matchesArukeresoProductSearch(
          matchedProduct,
          normalizeArukeresoSearchNeedle(query),
        ),
        true,
      )
      assert.equal(
        matchesArukeresoProductSearch(
          otherProduct,
          normalizeArukeresoSearchNeedle(query),
        ),
        true,
      )
    }
  })

  void it('returns zero for non-matching search', () => {
    const needle = normalizeArukeresoSearchNeedle(
      'zzz-no-such-product',
    )
    assert.equal(
      matchesArukeresoProductSearch(matchedProduct, needle),
      false,
    )
    assert.equal(
      matchesArukeresoProductSearch(otherProduct, needle),
      false,
    )
  })

  void it('does not cross-match distinct SKU/Identifier pairs', () => {
    assert.equal(
      matchesArukeresoProductSearch(
        otherProduct,
        normalizeArukeresoSearchNeedle('2.645-180.0'),
      ),
      false,
    )
    assert.equal(
      matchesArukeresoProductSearch(
        otherProduct,
        normalizeArukeresoSearchNeedle('26451800'),
      ),
      false,
    )
    assert.equal(
      matchesArukeresoProductSearch(
        matchedProduct,
        normalizeArukeresoSearchNeedle('28528027'),
      ),
      false,
    )
  })

  void it('drops unmatched catalog rows from the Products search index', () => {
    const index = indexCatalogSearchEntries([
      {
        productId: 'product-1',
        identifier: '26451800',
        eanCode: '4039784577602',
        name: 'HT 3.400',
      },
      {
        productId: null,
        identifier: '99999999',
        eanCode: '4999999999999',
        name: 'Catalog only',
      },
    ])

    assert.equal(index.size, 1)
    assert.deepEqual(index.get('product-1'), {
      identifier: '26451800',
      eanCode: '4039784577602',
      name: 'HT 3.400',
    })
  })

  void it('filters before paginating', () => {
    const rows: Array<{
      sku: string
      identifier: string | null
      eanCode: string | null
      names: Array<string | null>
    }> = Array.from({ length: 60 }, (_, position) => ({
      sku: `1.000-${String(position).padStart(3, '0')}.0`,
      identifier: `1000000${position}`,
      eanCode: null,
      names: [],
    }))
    rows.push({
      sku: '2.645-180.0',
      identifier: '26451800',
      eanCode: '4039784577602',
      names: ['HT 3.400'],
    })

    const needle =
      normalizeArukeresoSearchNeedle('26451800')
    const filtered = rows.filter((row) =>
      matchesArukeresoProductSearch(row, needle),
    )
    assert.equal(filtered.length, 1)

    const firstPage = filtered.slice(0, 50)
    assert.equal(firstPage.length, 1)
    assert.equal(firstPage[0]?.sku, '2.645-180.0')

    const sliceFirst = rows
      .slice(0, 50)
      .filter((row) =>
        matchesArukeresoProductSearch(row, needle),
      )
    assert.equal(sliceFirst.length, 0)
  })

  void it('combines search with existing status filters', () => {
    const needle =
      normalizeArukeresoSearchNeedle('26451800')
    const matches = (
      row: typeof matchedProduct,
      inFeed: boolean,
      feedState: string | null,
    ) =>
      matchesArukeresoProductSearch(row, needle) &&
      (feedState === null ||
        (feedState === 'IN_FEED' ? inFeed : !inFeed))

    assert.equal(
      matches(matchedProduct, true, 'IN_FEED'),
      true,
    )
    assert.equal(
      matches(matchedProduct, false, 'IN_FEED'),
      false,
    )
    assert.equal(
      matches(otherProduct, true, 'IN_FEED'),
      false,
    )
  })
})
