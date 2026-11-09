import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  STOCK_CHECK_EVENT,
  STOCK_LEGACY_PENDING_DELAY_MS,
  STOCK_OPERATION_EVENT,
  executeStockMutation,
  isTerminalStockCommand,
  isUnresolvedStockCommand,
  latestStockCommand,
  parseRetryAfterMs,
  recordStockAudit,
  resolveStockExecutionMode,
  STOCK_RATE_LIMIT_FALLBACK_MS,
  type StockAuditEvent,
  type StockCommand,
  type StockCommandStatus,
  type StockCommandTaskState,
  type StockDispatchResult,
  type StockMutationInput,
  type StockMutationPorts,
} from '../src/inventory-mutation-journal.ts'

function input(overrides: Partial<StockMutationInput> = {}): StockMutationInput {
  return {
    listingId: 'listing-1',
    offerId: 'offer-1',
    desiredStock: 5,
    observedStock: 0,
    runId: 'run-1',
    batchIndex: 1,
    ...overrides,
  }
}

function command(overrides: Partial<StockCommand> = {}): StockCommand {
  return {
    commandId: 'cmd-prior',
    status: 'ATTEMPTED',
    offerId: 'offer-1',
    fromStock: 0,
    toStock: 5,
    runId: 'run-1',
    batchIndex: 1,
    ...overrides,
  }
}

type Harness = {
  ports: StockMutationPorts
  journal: StockAuditEvent[]
  dispatched: string[]
  newIds: string[]
  order: string[]
  refreshes: number[]
  waits: number[]
}

function harness(options: {
  latest?: StockCommand | null
  observed?: number | null
  observedSeq?: Array<number | null>
  task?: StockCommandTaskState | (() => StockCommandTaskState)
  dispatch?: (commandId: string) => Promise<StockDispatchResult>
  failRecordFor?: StockCommandStatus[]
  assertOwned?: () => Promise<void>
} = {}): Harness {
  const journal: StockAuditEvent[] = []
  const dispatched: string[] = []
  const newIds: string[] = []
  const order: string[] = []
  const waits: number[] = []
  const refreshes: number[] = []
  const observedSeq = [...(options.observedSeq ?? [])]
  let counter = 0

  const readObservedStock = async () => {
    if (observedSeq.length > 0) return observedSeq.shift() ?? null
    return options.observed ?? null
  }

  const ports: StockMutationPorts = {
    latestCommand: async () => options.latest ?? null,
    record: async event => {
      order.push(`record:${event.status}`)
      if (options.failRecordFor?.includes(event.status)) {
        throw new Error('journal write failed')
      }
      journal.push(event)
    },
    readCommandTask: async () => {
      const task = options.task
      return typeof task === 'function' ? task() : task ?? 'PENDING'
    },
    readObservedStock,
    refreshObservation: async () => {
      refreshes.push(1)
      order.push('refresh')
    },
    dispatch: async commandId => {
      dispatched.push(commandId)
      order.push(`dispatch:${commandId}`)
      if (options.dispatch) return options.dispatch(commandId)
      return { kind: 'ACCEPTED', httpStatus: 201 }
    },
    assertOwned: options.assertOwned ?? (async () => undefined),
    newCommandId: () => {
      counter += 1
      const id = `cmd-${counter}`
      newIds.push(id)
      return id
    },
    onDispatch: () => {
      order.push('onDispatch')
    },
    wait: async ms => {
      waits.push(ms)
    },
    pollAttempts: 1,
    pollIntervalMs: 0,
  }

  return {
    ports,
    journal,
    dispatched,
    newIds,
    order,
    refreshes,
    waits,
  }
}

void describe('stock command journal ordering', () => {
  void it('persists ATTEMPTED before the PUT is dispatched', async () => {
    const h = harness({ observed: 0, task: 'SUCCESS' })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'UPDATED')
    assert.deepEqual(
      h.journal.map(event => event.status),
      ['ATTEMPTED', 'PENDING', 'SUCCESS'],
    )

    const attemptedAt = h.order.indexOf('record:ATTEMPTED')
    const onDispatchAt = h.order.indexOf('onDispatch')
    const dispatchAt = h.order.indexOf('dispatch:cmd-1')

    assert.ok(attemptedAt >= 0)
    assert.ok(attemptedAt < onDispatchAt, 'ATTEMPTED must precede onDispatch')
    assert.ok(onDispatchAt < dispatchAt, 'onDispatch must precede the PUT')
    assert.deepEqual(h.dispatched, ['cmd-1'])
  })

  void it('never dispatches when the durable intent cannot be persisted', async () => {
    const h = harness({ observed: 0, failRecordFor: ['ATTEMPTED'] })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'JOURNAL_UNAVAILABLE')
    assert.equal(h.dispatched.length, 0)
    assert.equal(h.order.includes('onDispatch'), false)
    assert.equal(h.journal.length, 0)
  })
})

void describe('unresolved commands block new command identities', () => {
  for (const status of ['ATTEMPTED', 'PENDING', 'DISPATCH_RESULT_UNKNOWN'] as const) {
    void it(`an unresolved ${status} command prevents a new commandId`, async () => {
      const h = harness({ latest: command({ status }), task: 'PENDING' })

      const outcome = await executeStockMutation(input(), h.ports)

      assert.equal(outcome.status, 'PENDING')
      assert.equal(outcome.commandId, 'cmd-prior')
      assert.equal(h.newIds.length, 0, 'no new commandId may be generated')
      assert.equal(h.dispatched.length, 0, 'no PUT may be dispatched')
    })
  }

  void it('a remapped offer does not reuse the old command', async () => {
    const h = harness({
      latest: command({ status: 'ATTEMPTED', offerId: 'offer-other' }),
      observed: 0,
      task: 'SUCCESS',
    })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'UPDATED')
    assert.equal(h.newIds.length, 1)
    assert.deepEqual(h.dispatched, ['cmd-1'])
  })

  void it('a terminal SUCCESS journal permits a legitimate new attempt', async () => {
    const h = harness({
      latest: command({ status: 'SUCCESS', commandId: 'cmd-old' }),
      observed: 0,
      task: 'SUCCESS',
    })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'UPDATED')
    assert.equal(h.newIds.length, 1)
    assert.deepEqual(h.dispatched, ['cmd-1'])
  })
})

void describe('lease loss between journal persistence and PUT', () => {
  void it('prevents dispatch and leaves the ATTEMPTED command recoverable', async () => {
    let assertions = 0
    const h = harness({
      observed: 0,
      assertOwned: async () => {
        assertions += 1
        if (assertions === 1) {
          throw new Error('Inventory execution lease lost; no further writes permitted')
        }
      },
    })

    await assert.rejects(
      () => executeStockMutation(input(), h.ports),
      /lease lost/,
    )

    assert.equal(h.dispatched.length, 0, 'no PUT after lease loss')
    assert.equal(h.order.includes('onDispatch'), false)

    const attempted = h.journal.find(event => event.status === 'ATTEMPTED')
    assert.ok(attempted?.commandId, 'ATTEMPTED command must remain durable')

    // Resume: the stored command was never accepted, so it is re-dispatched as-is.
    const resume = harness({ latest: command({ commandId: attempted.commandId, status: 'ATTEMPTED' }), task: 'ABSENT' })

    await executeStockMutation(input(), resume.ports)

    assert.deepEqual(resume.dispatched, [attempted.commandId])
    assert.equal(resume.newIds.length, 0)
  })
})

void describe('process restart after dispatch', () => {
  void it('polls the exact stored command and performs no new PUT while it is pending', async () => {
    /*
     * Simulate a crash immediately after the PUT leaves the
     * process: the post-dispatch journal write never lands.
     */
    const first = harness({
      observed: 0,
      dispatch: async () => {
        throw new Error('process died before the response was persisted')
      },
      failRecordFor: ['DISPATCH_RESULT_UNKNOWN'],
    })

    await assert.rejects(() => executeStockMutation(input(), first.ports))

    const persisted = first.journal.find(event => event.status === 'ATTEMPTED')
    assert.ok(persisted?.commandId, 'ATTEMPTED must survive the crash')
    assert.equal(first.journal.filter(event => event.status === 'DISPATCH_RESULT_UNKNOWN').length, 0)

    const restart = harness({
      latest: command({ commandId: persisted.commandId, status: 'ATTEMPTED' }),
      task: 'PENDING',
    })

    const outcome = await executeStockMutation(input(), restart.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.equal(outcome.commandId, persisted.commandId)
    assert.equal(restart.dispatched.length, 0, 'no second PUT while the command is pending')
    assert.equal(restart.newIds.length, 0)
  })

  void it('reconciles the stored command to SUCCESS without re-sending it', async () => {
    const restart = harness({
      latest: command({ status: 'PENDING', commandId: 'cmd-stored' }),
      task: 'SUCCESS',
    })

    const outcome = await executeStockMutation(input(), restart.ports)

    assert.equal(outcome.status, 'UPDATED')
    assert.equal(outcome.commandId, 'cmd-stored')
    assert.equal(restart.dispatched.length, 0)
    assert.equal(restart.newIds.length, 0)
    assert.deepEqual(
      restart.journal.map(event => event.status),
      ['SUCCESS'],
    )
    assert.equal(restart.journal[0]?.reason, 'RECONCILED_AFTER_RESTART')
  })

  void it('re-dispatches the same commandId when Allegro never accepted it', async () => {
    const restart = harness({
      latest: command({ status: 'ATTEMPTED', commandId: 'cmd-stored' }),
      task: 'ABSENT',
    })

    const outcome = await executeStockMutation(input(), restart.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.deepEqual(restart.dispatched, ['cmd-stored'])
    assert.equal(restart.newIds.length, 0, 'the stored identity is reused, not replaced')
  })
})

void describe('dispatch outcomes', () => {
  void it('stops as RATE_LIMITED and consumes the dispatch slot', async () => {
    const h = harness({
      observed: 0,
      dispatch: async () => ({ kind: 'RATE_LIMITED', httpStatus: 429, retryAfterMs: 60_000 }),
    })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'RATE_LIMITED')
    assert.equal(h.order.includes('onDispatch'), true, 'the attempt consumed a write slot')
    const terminal = h.journal.at(-1)
    assert.equal(terminal?.status, 'FAILED')
    assert.equal(terminal?.reason, 'RATE_LIMITED')
  })

  void it('records DISPATCH_RESULT_UNKNOWN when the PUT throws', async () => {
    const h = harness({
      observed: 0,
      dispatch: async () => {
        throw new Error('socket hang up')
      },
    })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'UNKNOWN')
    assert.equal(h.journal.at(-1)?.status, 'DISPATCH_RESULT_UNKNOWN')
    assert.equal(h.newIds.length, 1)
  })

  void it('records FAILED when Allegro rejects the command', async () => {
    const h = harness({
      observed: 0,
      dispatch: async () => ({ kind: 'REJECTED', httpStatus: 422, reason: 'validation' }),
    })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'FAILED')
    assert.equal(h.journal.at(-1)?.status, 'FAILED')
  })

  void it('skips without a command when observed stock already matches', async () => {
    const h = harness({ observed: 5 })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'SKIPPED')
    assert.equal(h.newIds.length, 0)
    assert.equal(h.dispatched.length, 0)
    assert.equal(h.journal.length, 0)
  })

  void it('cancels before send when the pre-dispatch re-check matches', async () => {
    const h = harness({ observedSeq: [0, 5] })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'SKIPPED')
    assert.equal(h.order.includes('onDispatch'), false, 'no write slot consumed')
    assert.equal(h.dispatched.length, 0)
    assert.equal(h.journal.at(-1)?.status, 'CANCELLED_BEFORE_SEND')
  })
})

void describe('execution mode compatibility', () => {
  void it('resolves only SLICED explicitly, defaulting everything else to LEGACY', () => {
    assert.equal(resolveStockExecutionMode('SLICED'), 'SLICED')
    assert.equal(resolveStockExecutionMode('LEGACY'), 'LEGACY')
    assert.equal(resolveStockExecutionMode(undefined), 'LEGACY')
    assert.equal(resolveStockExecutionMode(null), 'LEGACY')
    assert.equal(resolveStockExecutionMode(''), 'LEGACY')
    assert.equal(resolveStockExecutionMode('sliced'), 'LEGACY')
    assert.equal(STOCK_LEGACY_PENDING_DELAY_MS, 4_000)
  })

  void it('LEGACY keeps the historical 202 PENDING trailing reconciliation', async () => {
    const h = harness({ observed: 0, task: 'PENDING' })

    const outcome = await executeStockMutation(
      input({ executionMode: 'LEGACY' }),
      h.ports,
    )

    assert.equal(outcome.status, 'PENDING')
    // refresh -> 4000 ms -> refresh, exactly as before
    assert.equal(h.refreshes.length, 2)
    assert.deepEqual(h.waits, [0, STOCK_LEGACY_PENDING_DELAY_MS])
  })

  void it('defaults to LEGACY when executionMode is omitted', async () => {
    const h = harness({ observed: 0, task: 'PENDING' })

    const outcome = await executeStockMutation(input(), h.ports)

    assert.equal(outcome.status, 'PENDING')
    assert.equal(h.refreshes.length, 2)
    assert.deepEqual(h.waits, [0, STOCK_LEGACY_PENDING_DELAY_MS])
  })

  void it('SLICED skips the trailing delay and refresh entirely', async () => {
    const h = harness({ observed: 0, task: 'PENDING' })

    const outcome = await executeStockMutation(
      input({ executionMode: 'SLICED' }),
      h.ports,
    )

    assert.equal(outcome.status, 'PENDING')
    assert.equal(h.refreshes.length, 0, 'no trailing reconciliation refresh')
    assert.deepEqual(h.waits, [0], 'only the poll interval, never 4000 ms')
  })

  void it('applies the same split to a recovered unresolved command', async () => {
    const legacy = harness({
      latest: command({ status: 'PENDING', commandId: 'cmd-stored' }),
      task: 'PENDING',
    })

    const legacyOutcome = await executeStockMutation(
      input({ executionMode: 'LEGACY' }),
      legacy.ports,
    )

    assert.equal(legacyOutcome.status, 'PENDING')
    assert.equal(legacyOutcome.commandId, 'cmd-stored')
    assert.equal(legacy.refreshes.length, 2)
    assert.deepEqual(legacy.waits, [STOCK_LEGACY_PENDING_DELAY_MS])

    const sliced = harness({
      latest: command({ status: 'PENDING', commandId: 'cmd-stored' }),
      task: 'PENDING',
    })

    const slicedOutcome = await executeStockMutation(
      input({ executionMode: 'SLICED' }),
      sliced.ports,
    )

    assert.equal(slicedOutcome.status, 'PENDING')
    assert.equal(slicedOutcome.commandId, 'cmd-stored')
    assert.equal(sliced.refreshes.length, 0)
    assert.deepEqual(sliced.waits, [])
  })

  void it('does not add the legacy delay to a confirmed or skipped outcome', async () => {
    const confirmed = harness({ observed: 0, task: 'SUCCESS' })
    await executeStockMutation(input({ executionMode: 'LEGACY' }), confirmed.ports)
    assert.equal(confirmed.waits.includes(STOCK_LEGACY_PENDING_DELAY_MS), false)

    const skipped = harness({ observed: 5 })
    await executeStockMutation(input({ executionMode: 'LEGACY' }), skipped.ports)
    assert.deepEqual(skipped.waits, [])
    assert.equal(skipped.refreshes.length, 0)
  })
})

void describe('status predicates', () => {
  void it('classifies unresolved and terminal statuses', () => {
    for (const status of ['ATTEMPTED', 'PENDING', 'DISPATCH_RESULT_UNKNOWN']) {
      assert.equal(isUnresolvedStockCommand(status), true)
      assert.equal(isTerminalStockCommand(status), false)
    }

    for (const status of ['SUCCESS', 'FAILED', 'CANCELLED_BEFORE_SEND']) {
      assert.equal(isUnresolvedStockCommand(status), false)
      assert.equal(isTerminalStockCommand(status), true)
    }
  })
})

void describe('retry-after parsing', () => {
  void it('falls back to 60 seconds when the header is missing', () => {
    assert.equal(parseRetryAfterMs(null), STOCK_RATE_LIMIT_FALLBACK_MS)
    assert.equal(STOCK_RATE_LIMIT_FALLBACK_MS, 60_000)
  })

  void it('parses delta-seconds and HTTP dates', () => {
    assert.equal(parseRetryAfterMs('30'), 30_000)
    assert.equal(parseRetryAfterMs('0'), 0)

    const future = new Date(Date.now() + 10_000).toUTCString()
    const parsed = parseRetryAfterMs(future)
    assert.ok(parsed > 0 && parsed <= 11_000, `unexpected ${parsed}`)
  })
})

void describe('journal persistence', () => {
  function stubDatabase(rows: Array<{ status: string; metadata: string }>) {
    const inserted: unknown[] = []
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve(rows),
            }),
          }),
        }),
      }),
      insert: () => ({
        values: (values: unknown) => {
          inserted.push(values)
          return Promise.resolve()
        },
      }),
    }
    return { database, inserted }
  }

  void it('reads the latest command with its metadata', async () => {
    const { database } = stubDatabase([
      {
        status: 'PENDING',
        metadata: JSON.stringify({
          commandId: 'cmd-9',
          offerId: 'offer-1',
          fromStock: 0,
          toStock: 5,
          runId: 'run-1',
          batchIndex: 2,
        }),
      },
    ])

    const command = await latestStockCommand(
      database as unknown as Parameters<typeof latestStockCommand>[0],
      'listing-1',
    )

    assert.deepEqual(command, {
      commandId: 'cmd-9',
      status: 'PENDING',
      offerId: 'offer-1',
      fromStock: 0,
      toStock: 5,
      runId: 'run-1',
      batchIndex: 2,
    })
  })

  void it('returns null for an unreadable or commandless row', async () => {
    for (const rows of [
      [],
      [{ status: 'PENDING', metadata: 'not-json' }],
      [{ status: 'PENDING', metadata: '{}' }],
      [{ status: 'UNKNOWN_STATUS', metadata: JSON.stringify({ commandId: 'cmd-1' }) }],
    ]) {
      const { database } = stubDatabase(rows)
      const result = await latestStockCommand(
        database as unknown as Parameters<typeof latestStockCommand>[0],
        'listing-1',
      )
      assert.equal(result, null)
    }
  })

  void it('writes STOCK_OPERATION for commands and STOCK_CHECK for checks', async () => {
    const { database, inserted } = stubDatabase([])

    await recordStockAudit(
      database as unknown as Parameters<typeof recordStockAudit>[0],
      'listing-1',
      { status: 'ATTEMPTED', commandId: 'cmd-1', offerId: 'offer-1', fromStock: 0, toStock: 5 },
    )
    await recordStockAudit(
      database as unknown as Parameters<typeof recordStockAudit>[0],
      'listing-1',
      { status: 'SUCCESS', reason: 'RECONCILED' },
    )

    const rows = inserted as Array<Record<string, unknown>>
    assert.equal(rows[0]?.eventType, STOCK_OPERATION_EVENT)
    assert.equal(rows[0]?.oldValue, 'STOCK_UPDATE')
    assert.equal(rows[0]?.newValue, 'ATTEMPTED')
    assert.equal(rows[1]?.eventType, STOCK_CHECK_EVENT)
    assert.equal(rows[1]?.newValue, 'SUCCESS')

    const metadata = JSON.parse(rows[0]?.metadataJson as string) as Record<string, unknown>
    assert.equal(metadata.commandId, 'cmd-1')
    assert.equal(metadata.toStock, 5)
  })

  void it('propagates insert failures so the caller can abort the dispatch', async () => {
    const database = {
      insert: () => ({
        values: () => Promise.reject(new Error('db down')),
      }),
    }

    await assert.rejects(
      () =>
        recordStockAudit(
          database as unknown as Parameters<typeof recordStockAudit>[0],
          'listing-1',
          { status: 'ATTEMPTED', commandId: 'cmd-1' },
        ),
      /db down/,
    )
  })
})
