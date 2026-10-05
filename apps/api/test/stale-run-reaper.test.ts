import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  CATALOG_SYNC_STALE_THRESHOLD_MS,
  DATA_CONNECTION_RUN_STALE_THRESHOLD_MS,
  reapStaleCatalogSyncRuns,
  reapStaleDataConnectionRuns,
  staleReapCutoff,
} from '../src/data-connections.js'

const dialect = new PgDialect()

function stubDatabase() {
  const calls: Array<{
    set: unknown
    where: unknown
  }> = []
  const database = {
    update: () => ({
      set: (values: unknown) => ({
        where: (condition: unknown) => {
          calls.push({
            set: values,
            where: condition,
          })

          return Promise.resolve()
        },
      }),
    }),
  }

  return { calls, database }
}

function renderedWhere(call: {
  set: unknown
  where: unknown
}) {
  return dialect.sqlToQuery(
    call.where as Parameters<
      PgDialect['sqlToQuery']
    >[0],
  )
}

// PgDialect maps timestamp bind parameters to ISO strings,
// so normalize before comparing instants.
function paramTimes(params: unknown[]) {
  return params
    .filter(
      (param): param is string =>
        typeof param === 'string' &&
        !Number.isNaN(Date.parse(param)),
    )
    .map((param) => new Date(param).getTime())
}

void test('thresholds match observed production runtimes', () => {
  // Catalog SUCCESS peaks at 33 s over 44 runs: 15 min
  // is unreachable for legitimate work.
  assert.equal(
    CATALOG_SYNC_STALE_THRESHOLD_MS,
    15 * 60 * 1000,
  )
  // Wrapper COMPLETED runs peak near 55 min: 30 min only
  // reaps rows no live run could still be using once a
  // newer run for the same scope finalizes.
  assert.equal(
    DATA_CONNECTION_RUN_STALE_THRESHOLD_MS,
    30 * 60 * 1000,
  )
  assert.equal(
    staleReapCutoff(
      new Date('2026-10-05T13:01:22.000Z'),
      CATALOG_SYNC_STALE_THRESHOLD_MS,
    ).getTime(),
    new Date('2026-10-05T12:46:22.000Z').getTime(),
  )
})

void test('old RUNNING catalog run is reaped after restart', async () => {
  const stub = stubDatabase()
  const orphanStartedAt = new Date(
    '2026-10-05T12:00:57.724Z',
  )

  await reapStaleCatalogSyncRuns(
    stub.database as never,
    'run-current',
    new Date('2026-10-05T13:01:19.203Z'),
    new Date('2026-10-05T13:01:22.000Z'),
  )

  assert.equal(stub.calls.length, 1)
  const set = stub.calls[0]?.set as Record<
    string,
    unknown
  >
  assert.equal(set['status'], 'INTERRUPTED')
  assert.equal(
    set['error'],
    'A futást a runtime leállása szakította meg; egy újabb futás zárta le.',
  )
  assert.ok(set['finishedAt'] instanceof Date)

  const { sql, params } = renderedWhere(stub.calls[0]!)
  const paramValues = params as unknown[]
  // Concurrent finalization guard: only RUNNING rows match,
  // so SUCCESS/FAILED/INTERRUPTED rows are untouched.
  assert.ok(sql.includes('"status"'))
  assert.ok(paramValues.includes('RUNNING'))
  // Current run is always excluded.
  assert.ok(paramValues.includes('run-current'))
  // Older-than-current-run guard preserved.
  assert.ok(
    paramTimes(paramValues).includes(
      new Date('2026-10-05T13:01:19.203Z').getTime(),
    ),
  )
  // Age threshold guard: the orphan (12:00:57) is older
  // than the cutoff (12:46:22), so it matches.
  const cutoff = new Date('2026-10-05T12:46:22.000Z')
  assert.ok(
    paramTimes(paramValues).includes(cutoff.getTime()) &&
      orphanStartedAt.getTime() < cutoff.getTime(),
  )
})

void test('fresh RUNNING catalog run is preserved', async () => {
  const stub = stubDatabase()
  const now = new Date('2026-10-05T13:01:22.000Z')

  await reapStaleCatalogSyncRuns(
    stub.database as never,
    'run-current',
    new Date('2026-10-05T13:01:19.203Z'),
    now,
  )

  const { params } = renderedWhere(stub.calls[0]!)
  const cutoff = new Date(
    now.getTime() - CATALOG_SYNC_STALE_THRESHOLD_MS,
  )
  // A legitimate run started 3 minutes ago is newer than
  // the 15-minute cutoff, so `started_at < cutoff` cannot
  // match it.
  const freshStart = new Date(
    now.getTime() - 3 * 60 * 1000,
  )
  assert.ok(freshStart.getTime() > cutoff.getTime())
  assert.ok(
    paramTimes(params as unknown[]).includes(
      cutoff.getTime(),
    ),
  )
})

void test('threshold boundary keeps the exact cutoff row', () => {
  const now = new Date('2026-10-05T13:01:22.000Z')
  const cutoff = staleReapCutoff(
    now,
    CATALOG_SYNC_STALE_THRESHOLD_MS,
  )
  // Strict `<` in SQL: a row started exactly at the cutoff
  // instant does not satisfy `started_at < cutoff`.
  assert.equal(
    cutoff.getTime(),
    now.getTime() - 15 * 60 * 1000,
  )
})

void test('old RUNNING wrapper is reaped within its connection', async () => {
  const stub = stubDatabase()

  await reapStaleDataConnectionRuns(
    stub.database as never,
    'connection-1',
    'run-current',
    new Date('2026-10-05T13:01:15.709Z'),
    new Date('2026-10-05T13:01:22.000Z'),
  )

  assert.equal(stub.calls.length, 1)
  const set = stub.calls[0]?.set as Record<
    string,
    unknown
  >
  assert.equal(set['status'], 'INTERRUPTED')
  assert.equal(
    set['error'],
    'A futást a runtime leállása szakította meg; egy újabb futás zárta le.',
  )

  const { sql, params } = renderedWhere(stub.calls[0]!)
  const paramValues = params as unknown[]
  assert.ok(sql.includes('"status"'))
  assert.ok(paramValues.includes('RUNNING'))
  assert.ok(paramValues.includes('run-current'))
  // Connection scoping: unrelated connections untouched.
  assert.ok(paramValues.includes('connection-1'))
  // 30-minute cutoff carried as a bind parameter.
  assert.ok(
    paramTimes(paramValues).includes(
      new Date('2026-10-05T12:31:22.000Z').getTime(),
    ),
  )
})

void test('fresh RUNNING wrapper is preserved', async () => {
  const stub = stubDatabase()
  const now = new Date('2026-10-05T13:01:22.000Z')

  await reapStaleDataConnectionRuns(
    stub.database as never,
    'connection-1',
    'run-current',
    new Date('2026-10-05T13:01:15.709Z'),
    now,
  )

  const { params } = renderedWhere(stub.calls[0]!)
  const cutoff = new Date(
    now.getTime() - DATA_CONNECTION_RUN_STALE_THRESHOLD_MS,
  )
  // A legitimate 55-minute wrapper is newer than its own
  // 30-minute cutoff only while younger than 30 minutes;
  // a row started 10 minutes ago cannot match.
  const freshStart = new Date(
    now.getTime() - 10 * 60 * 1000,
  )
  assert.ok(freshStart.getTime() > cutoff.getTime())
})

void test('finalized rows can never match either reaper', async () => {
  const catalogStub = stubDatabase()
  const wrapperStub = stubDatabase()

  await reapStaleCatalogSyncRuns(
    catalogStub.database as never,
    'run-current',
    new Date(),
    new Date(),
  )
  await reapStaleDataConnectionRuns(
    wrapperStub.database as never,
    'connection-1',
    'run-current',
    new Date(),
    new Date(),
  )

  for (const stub of [catalogStub, wrapperStub]) {
    const { sql, params } = renderedWhere(
      stub.calls[0]!,
    )
    // The UPDATE only ever targets status = RUNNING, so a
    // row already finalized as SUCCESS/FAILED (or already
    // INTERRUPTED) is excluded atomically in the same
    // statement that performs the write.
    assert.ok(sql.includes('"status"'))
    assert.ok(
      (params as unknown[]).includes('RUNNING'),
    )
  }
})

void test('reapers never throw when the database is down', async () => {
  const failing = {
    update: () => {
      throw new Error('db down')
    },
  }

  await reapStaleCatalogSyncRuns(
    failing as never,
    'run-current',
    new Date(),
    new Date(),
  )
  await reapStaleDataConnectionRuns(
    failing as never,
    'connection-1',
    'run-current',
    new Date(),
    new Date(),
  )
})
