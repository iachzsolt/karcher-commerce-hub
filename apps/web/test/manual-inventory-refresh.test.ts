import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createManualInventoryRefreshAction,
  fetchResumableInventoryRun,
  isTerminalInventoryRun,
  readInventoryRunNextAdvanceAt,
  type ManualInventoryRequest,
  type ManualInventoryRun,
} from '../src/utils/manualInventoryRefresh.ts'
import { createInventoryRefreshLoop } from '../src/utils/manualInventoryRefreshLoop.ts'

const BASE = '/api'
const CONNECTION = 'connection-1'
const RUN_ID = 'run-1'
const COLLECTION_URL = `${BASE}/data-connections/${CONNECTION}/full-inventory-refresh`
const ADVANCE_URL = `${COLLECTION_URL}/${RUN_ID}/advance`
const RUN_URL = `${COLLECTION_URL}/${RUN_ID}`

type Call = { url: string; method: string; body: string | null }

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function inventoryRun(overrides: Partial<ManualInventoryRun> = {}): ManualInventoryRun {
  return { runId: RUN_ID, status: 'RUNNING', ...overrides }
}

/** Persisted cursor with a cooldown, as stored in automationDetailsJson. */
function cursorJson(nextAdvanceAt: number) {
  return JSON.stringify({
    version: 1,
    platforms: [],
    cursor: { version: 1, nextAdvanceAt },
  })
}

function scriptedFetch(
  handler: (call: Call) => Response | Promise<Response>,
) {
  const calls: Call[] = []

  const request = (async (url: string, init?: { method?: string; body?: string }) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
    }
    calls.push(call)
    return handler(call)
  }) as unknown as ManualInventoryRequest

  return { calls, request }
}

function actionWith(request: ManualInventoryRequest) {
  return createManualInventoryRefreshAction(BASE, request, () => RUN_ID)
}

/**
 * Every await in these tests is a microtask, so a bounded microtask
 * drain is enough to let the loop finish without real timers.
 */
async function drain(loop: { running: boolean }, ticks = 500) {
  for (let index = 0; index < ticks && loop.running; index += 1) {
    await Promise.resolve()
  }
  assert.equal(loop.running, false, 'loop should have stopped')
}

function loopHarness(
  action: ReturnType<typeof createManualInventoryRefreshAction>,
) {
  const runs: ManualInventoryRun[] = []
  const errors: string[] = []
  const notices: string[] = []
  let clock = 1_000_000
  const sleeps: number[] = []

  const loop = createInventoryRefreshLoop({
    client: {
      get active() {
        return action.active
      },
      observe: () => action.observe(),
      advance: () => action.advance(),
    },
    onRun: run => runs.push(run),
    onError: message => errors.push(message),
    onNotice: message => notices.push(message),
    now: () => clock,
    sleep: async ms => {
      sleeps.push(ms)
      clock += ms
    },
    pollIntervalMs: 1_000,
  })

  return { loop, runs, errors, notices, sleeps, clock: () => clock }
}

/* ------------------------------------------------------------------ *
 * A. start is exactly one POST and is never retried
 * ------------------------------------------------------------------ */

void describe('manual refresh start', () => {
  void it('sends exactly one start POST with the client run id', async () => {
    const { calls, request } = scriptedFetch(() => json({ run: inventoryRun() }))
    const action = actionWith(request)
    const started: string[] = []

    const run = await action.start(CONNECTION, runId => started.push(runId))

    assert.equal(run?.status, 'RUNNING')
    assert.deepEqual(started, [RUN_ID])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, COLLECTION_URL)
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { confirm: true, runId: RUN_ID })
  })

  /* -------------------------------------------------------------- *
   * 1. 503 keeps the generated run id
   * -------------------------------------------------------------- */

  void it('keeps the generated run id when the start answers 503', async () => {
    const { calls, request } = scriptedFetch(() => json({ message: 'unavailable' }, 503))
    const action = actionWith(request)

    await assert.rejects(() => action.start(CONNECTION, () => undefined), /unavailable/)

    assert.equal(calls.length, 1, 'the start POST is not retried')
    /*
     * Production evidence: a 503 start still had a live RUNNING run in the
     * database, so the id must survive.
     */
    assert.deepEqual(action.active, { connectionId: CONNECTION, runId: RUN_ID })
  })

  /* -------------------------------------------------------------- *
   * 2. other 5xx statuses keep the generated run id
   * -------------------------------------------------------------- */

  void it('keeps the generated run id for every uncertain 5xx start', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { calls, request } = scriptedFetch(() => json({ message: 'upstream' }, status))
      const action = actionWith(request)

      await assert.rejects(() => action.start(CONNECTION, () => undefined), /upstream/)

      assert.equal(calls.length, 1, `${status}: the start POST is not retried`)
      assert.equal(action.active?.runId, RUN_ID, `${status}: the run id is kept`)
    }
  })

  /* -------------------------------------------------------------- *
   * 3. transport failure keeps the generated run id
   * -------------------------------------------------------------- */

  void it('keeps the generated run id when the start request fails in transport', async () => {
    const { calls, request } = scriptedFetch(() => {
      throw new Error('network down')
    })
    const action = actionWith(request)

    await assert.rejects(() => action.start(CONNECTION, () => undefined), /network down/)

    assert.equal(calls.length, 1)
    assert.equal(action.active?.runId, RUN_ID)
  })

  void it('keeps the generated run id when a successful start has an unreadable body', async () => {
    const { request } = scriptedFetch(
      () => new Response('not-json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    const action = actionWith(request)

    await assert.rejects(() => action.start(CONNECTION, () => undefined), /nem ismert/)

    assert.equal(action.active?.runId, RUN_ID)
  })

  /* -------------------------------------------------------------- *
   * 4./5./6. uncertain start -> GET first -> RUNNING resumes the loop
   * -------------------------------------------------------------- */

  void it('observes before anything else after an uncertain start and resumes on RUNNING', async () => {
    let startPosts = 0
    let advances = 0

    const { calls, request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL && call.method === 'POST') {
        startPosts += 1
        throw new Error('gateway timeout')
      }
      if (call.url === ADVANCE_URL) {
        advances += 1
        return json({ status: 'ok', run: inventoryRun({ status: 'COMPLETED' }) })
      }
      return json({ status: 'ok', run: inventoryRun() })
    })

    const action = actionWith(request)

    await assert.rejects(() => action.start(CONNECTION, () => undefined), /gateway timeout/)
    assert.equal(action.active?.runId, RUN_ID, 'the uncertain start keeps the id')

    const { loop } = loopHarness(action)
    calls.length = 0
    loop.start()
    await drain(loop)

    assert.equal(startPosts, 1, 'the start POST is never repeated')
    assert.equal(calls[0].method, 'GET', 'the targeted GET is the first follow-up action')
    assert.equal(calls[0].url, RUN_URL)
    assert.equal(advances, 1, 'a RUNNING run resumes the observe/advance loop')
  })

  /* -------------------------------------------------------------- *
   * 7. a genuine 404 on the follow-up GET releases the run id
   * -------------------------------------------------------------- */

  void it('releases the run id when the follow-up GET is a genuine 404', async () => {
    const { request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) throw new Error('network down')
      return json({ message: 'not found' }, 404)
    })
    const action = actionWith(request)

    await assert.rejects(() => action.start(CONNECTION, () => undefined), /network down/)
    assert.equal(action.active?.runId, RUN_ID)

    await assert.rejects(() => action.observe(), /nem található/)
    assert.equal(action.active, null, 'a missing run releases the id')
  })

  /* -------------------------------------------------------------- *
   * 8. definitive rejections still release the run id
   * -------------------------------------------------------------- */

  void it('releases the run id for a definitive start rejection', async () => {
    for (const status of [400, 403, 404, 409]) {
      const { calls, request } = scriptedFetch(() => json({ message: 'rejected' }, status))
      const action = actionWith(request)

      await assert.rejects(() => action.start(CONNECTION, () => undefined), /rejected/)

      assert.equal(calls.length, 1, `${status}: the start POST is not retried`)
      assert.equal(action.active, null, `${status}: the run id is released`)
    }
  })

  void it('never sends a second start while one is active', async () => {
    const { calls, request } = scriptedFetch(() => json({ run: inventoryRun() }))
    const action = actionWith(request)

    await action.start(CONNECTION, () => undefined)
    const second = await action.start(CONNECTION, () => undefined)

    assert.equal(second, null)
    assert.equal(calls.length, 1)
  })
})

/* ------------------------------------------------------------------ *
 * B. RUNNING response retains the active run id
 * ------------------------------------------------------------------ */

void describe('active run retention', () => {
  void it('retains the run id while the persisted run is RUNNING', async () => {
    const { request } = scriptedFetch(() => json({ run: inventoryRun() }))
    const action = actionWith(request)

    await action.start(CONNECTION, () => undefined)

    assert.deepEqual(action.active, { connectionId: CONNECTION, runId: RUN_ID })
  })

  void it('releases the run id only for a terminal run', async () => {
    for (const status of ['COMPLETED', 'FAILED', 'IMPORT_ONLY', 'INTERRUPTED']) {
      assert.equal(isTerminalInventoryRun({ status }), true, status)
    }
    assert.equal(isTerminalInventoryRun({ status: 'RUNNING' }), false)
    assert.equal(isTerminalInventoryRun(null), false)

    const { request } = scriptedFetch(() => json({ run: inventoryRun({ status: 'COMPLETED' }) }))
    const action = actionWith(request)

    await action.start(CONNECTION, () => undefined)

    assert.equal(action.active, null)
  })
})

/* ------------------------------------------------------------------ *
 * C. RUNNING observe issues exactly one advance
 * ------------------------------------------------------------------ */

void describe('advance loop', () => {
  void it('issues one advance after observing a RUNNING run, then stops', async () => {
    let gets = 0
    let advances = 0

    const { calls, request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        return json({ status: 'ok', run: inventoryRun() })
      }

      gets += 1
      return json({
        status: 'ok',
        run: inventoryRun(
          gets === 1 ? {} : { status: 'COMPLETED', finishedAt: '2026-11-09T10:00:00.000Z' },
        ),
      })
    })

    const action = actionWith(request)
    const { loop } = loopHarness(action)

    await action.start(CONNECTION, () => undefined)
    calls.length = 0
    loop.start()
    await drain(loop)

    assert.equal(advances, 1)
    assert.deepEqual(
      calls.map(call => call.url),
      [RUN_URL, ADVANCE_URL, RUN_URL],
    )
  })

  /* -------------------------------------------------------------- *
   * D. single flight
   * -------------------------------------------------------------- */

  void it('never issues two advances for concurrent advance calls', async () => {
    const { calls, request } = scriptedFetch(call =>
      call.url === ADVANCE_URL
        ? json({ status: 'ok', run: inventoryRun() })
        : json({ status: 'ok', run: inventoryRun() }),
    )
    const action = actionWith(request)

    await action.start(CONNECTION, () => undefined)
    calls.length = 0

    const [first, second] = await Promise.all([action.advance(), action.advance()])

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(first, second, 'concurrent callers share one outcome')
  })

  void it('never issues two advances for concurrent loop starts', async () => {
    let advances = 0
    let gets = 0

    const { request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        return json({ status: 'ok', run: inventoryRun({ status: 'COMPLETED' }) })
      }

      gets += 1
      return json({ status: 'ok', run: inventoryRun() })
    })

    const action = actionWith(request)
    const { loop } = loopHarness(action)

    await action.start(CONNECTION, () => undefined)
    loop.start()
    loop.start()
    await drain(loop)

    assert.equal(advances, 1)
    assert.equal(gets, 1)
  })

  /* -------------------------------------------------------------- *
   * E. uncertain advance always observes first
   * -------------------------------------------------------------- */

  void it('observes before advancing again after an uncertain advance', async () => {
    let advances = 0

    const { calls, request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        if (advances === 1) throw new Error('network down')
        return json({ status: 'ok', run: inventoryRun({ status: 'COMPLETED' }) })
      }

      return json({ status: 'ok', run: inventoryRun() })
    })

    const action = actionWith(request)
    const { loop, errors, sleeps } = loopHarness(action)

    await action.start(CONNECTION, () => undefined)
    calls.length = 0
    loop.start()
    await drain(loop)

    assert.deepEqual(
      calls.map(call => `${call.method} ${call.url}`),
      [`GET ${RUN_URL}`, `POST ${ADVANCE_URL}`, `GET ${RUN_URL}`, `POST ${ADVANCE_URL}`],
      'an uncertain advance must be followed by an observe, never by another advance',
    )
    assert.equal(errors.length, 1)
    assert.match(errors[0], /network down/)
    assert.equal(sleeps[0], 1_000, 'normal polling delay before re-observing')
    assert.equal(action.active, null, 'terminal run releases the id')
  })

  /* -------------------------------------------------------------- *
   * F. 503 keeps the run
   * -------------------------------------------------------------- */

  void it('keeps the active run after a 503 advance and resumes', async () => {
    let advances = 0
    let activeAtError: string | null = null

    const { request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        if (advances === 1) return json({ message: 'unavailable' }, 503)
        return json({ status: 'ok', run: inventoryRun({ status: 'COMPLETED' }) })
      }

      return json({ status: 'ok', run: inventoryRun() })
    })

    const action = actionWith(request)

    let clock = 1_000_000
    const loop = createInventoryRefreshLoop({
      client: {
        get active() {
          return action.active
        },
        observe: () => action.observe(),
        advance: () => action.advance(),
      },
      onRun: () => undefined,
      onError: () => {
        activeAtError = action.active?.runId ?? null
      },
      now: () => clock,
      sleep: async ms => {
        clock += ms
      },
      pollIntervalMs: 1_000,
    })

    await action.start(CONNECTION, () => undefined)
    loop.start()
    await drain(loop)

    assert.equal(activeAtError, RUN_ID, '503 must not clear the active run')
    assert.equal(advances, 2, 'the loop resumed after the transient failure')
    assert.equal(action.active, null, 'terminal run releases the id')
  })

  /* -------------------------------------------------------------- *
   * G. 409 cooldown is not fatal
   * -------------------------------------------------------------- */

  void it('treats a 409 cooldown as non-fatal and keeps the run', async () => {
    let advances = 0
    let gets = 0
    let activeAtNotice: string | null = null
    let clock = 1_000_000

    const { request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        if (advances === 1) {
          return json({ status: 'error', message: 'Inventory refresh is cooling down' }, 409)
        }
        return json({ status: 'ok', run: inventoryRun({ status: 'COMPLETED' }) })
      }

      gets += 1
      // Second observation exposes the persisted cooldown in the cursor.
      return json({
        status: 'ok',
        run:
          gets === 2
            ? inventoryRun({ automationDetailsJson: cursorJson(clock + 5_000) })
            : inventoryRun(),
      })
    })

    const action = actionWith(request)

    const errors: string[] = []
    const sleeps: number[] = []
    const loop = createInventoryRefreshLoop({
      client: {
        get active() {
          return action.active
        },
        observe: () => action.observe(),
        advance: () => action.advance(),
      },
      onRun: () => undefined,
      onError: message => errors.push(message),
      onNotice: () => {
        activeAtNotice = action.active?.runId ?? null
      },
      now: () => clock,
      sleep: async ms => {
        sleeps.push(ms)
        clock += ms
      },
      pollIntervalMs: 1_000,
    })

    await action.start(CONNECTION, () => undefined)
    loop.start()
    await drain(loop)

    assert.equal(activeAtNotice, RUN_ID, '409 must not clear the active run')
    assert.deepEqual(errors, [], 'cooldown is not an error state')
    assert.equal(advances, 2, 'the loop advanced again after the cooldown')
    assert.ok(sleeps.includes(5_000), 'persisted cooldown was honoured')
    assert.equal(action.active, null)
  })

  /* -------------------------------------------------------------- *
   * H. terminal observation stops the loop
   * -------------------------------------------------------------- */

  void it('stops on a terminal observation and clears the run', async () => {
    const { calls, request } = scriptedFetch(call =>
      call.url === COLLECTION_URL
        ? json({ status: 'ok', run: inventoryRun() })
        : json({
            status: 'ok',
            run: inventoryRun({ status: 'COMPLETED', finishedAt: '2026-11-09T10:00:00.000Z' }),
          }),
    )
    const action = actionWith(request)
    const { loop, runs } = loopHarness(action)

    await action.start(CONNECTION, () => undefined)
    calls.length = 0
    loop.start()
    await drain(loop)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    assert.equal(runs.at(-1)?.status, 'COMPLETED')
    assert.equal(action.active, null)
  })

  /* -------------------------------------------------------------- *
   * I. repeated polling never repeats the start POST
   * -------------------------------------------------------------- */

  void it('never repeats the start POST while polling the same run', async () => {
    let advances = 0
    let gets = 0

    const { calls, request } = scriptedFetch(call => {
      if (call.url === COLLECTION_URL) return json({ status: 'ok', run: inventoryRun() })
      if (call.url === ADVANCE_URL) {
        advances += 1
        return json({ status: 'ok', run: inventoryRun() })
      }

      gets += 1
      // Five polling rounds, then a terminal run.
      return json({ status: 'ok', run: inventoryRun(gets >= 6 ? { status: 'COMPLETED' } : {}) })
    })

    const action = actionWith(request)
    const { loop } = loopHarness(action)

    await action.start(CONNECTION, () => undefined)
    loop.start()
    await drain(loop)

    const startPosts = calls.filter(call => call.method === 'POST' && call.url === COLLECTION_URL)
    assert.equal(startPosts.length, 1, 'exactly one start POST for the whole session')
    assert.equal(advances, 5)
    assert.equal(gets, 6)
    assert.equal(action.active, null)
  })
})

/* ------------------------------------------------------------------ *
 * Cooldown parsing
 * ------------------------------------------------------------------ */

void describe('run cooldown', () => {
  void it('prefers the advance response over the persisted cursor', () => {
    assert.equal(
      readInventoryRunNextAdvanceAt(inventoryRun({ advance: { nextAdvanceAt: 42 } })),
      42,
    )
  })

  void it('falls back to the persisted cursor', () => {
    assert.equal(
      readInventoryRunNextAdvanceAt(inventoryRun({ automationDetailsJson: cursorJson(7_000) })),
      7_000,
    )
  })

  void it('never throws on a missing or corrupt payload', () => {
    assert.equal(readInventoryRunNextAdvanceAt(null), null)
    assert.equal(readInventoryRunNextAdvanceAt(inventoryRun()), null)
    assert.equal(readInventoryRunNextAdvanceAt(inventoryRun({ automationDetailsJson: 'not-json' })), null)
    assert.equal(
      readInventoryRunNextAdvanceAt(
        inventoryRun({ automationDetailsJson: JSON.stringify({ cursor: { nextAdvanceAt: 'soon' } }) }),
      ),
      null,
    )
  })
})

/* ------------------------------------------------------------------ *
 * Reload adoption (backend self-resume is the real fix)
 * ------------------------------------------------------------------ */

const RESUMABLE_URL = `${COLLECTION_URL}/resumable`

void describe('reload adoption', () => {
  /* 18. reload with a valid existing RUNNING sliced run -> adopt/observe */
  void it('adopts an existing RUNNING sliced run by observing it', async () => {
    const resumable = { connectionId: CONNECTION, runId: RUN_ID, nextAdvanceAt: 42 }

    const { calls, request } = scriptedFetch(call => {
      if (call.url === RESUMABLE_URL) return json({ status: 'ok', run: resumable })
      if (call.url === ADVANCE_URL) {
        return json({ status: 'ok', run: inventoryRun() })
      }
      return json({ status: 'ok', run: inventoryRun() })
    })

    const found = await fetchResumableInventoryRun(BASE, CONNECTION, request)
    assert.deepEqual(found, resumable)

    const action = actionWith(request)
    const adopted = await action.adopt(found!.connectionId, found!.runId)

    assert.equal(adopted?.status, 'RUNNING')
    assert.deepEqual(action.active, { connectionId: CONNECTION, runId: RUN_ID })
    assert.equal(calls[0].url, RESUMABLE_URL)
    assert.equal(calls[1].url, RUN_URL, 'adoption observes the existing run')

    // The adopted run can still be driven by this tab.
    const outcome = await action.advance()
    assert.equal(outcome.kind, 'ADVANCED')
    assert.equal(calls.at(-1)?.url, ADVANCE_URL)
  })

  /* 19. reload never sends another start POST */
  void it('never POSTs a start during reload recovery', async () => {
    const { calls, request } = scriptedFetch(call => {
      if (call.url === RESUMABLE_URL) {
        return json({
          status: 'ok',
          run: { connectionId: CONNECTION, runId: RUN_ID, nextAdvanceAt: null },
        })
      }
      return json({ status: 'ok', run: inventoryRun() })
    })

    const action = actionWith(request)
    const found = await fetchResumableInventoryRun(BASE, CONNECTION, request)

    await action.adopt(found!.connectionId, found!.runId)

    const startPosts = calls.filter(
      call => call.method === 'POST' && call.url === COLLECTION_URL,
    )
    assert.deepEqual(startPosts, [], 'recovery must never create a second run')
  })

  void it('never replaces a run this tab is already tracking', async () => {
    const { calls, request } = scriptedFetch(() => json({ status: 'ok', run: inventoryRun() }))
    const action = actionWith(request)

    await action.start(CONNECTION, () => undefined)
    calls.length = 0

    const adopted = await action.adopt('connection-2', 'run-2')

    assert.equal(adopted, null)
    assert.deepEqual(action.active, { connectionId: CONNECTION, runId: RUN_ID })
    assert.deepEqual(calls, [], 'no observation of an unrelated run')
  })

  /* 20. no existing run -> normal idle state */
  void it('stays idle when the backend reports no resumable run', async () => {
    const { calls, request } = scriptedFetch(() => json({ status: 'ok', run: null }))

    const found = await fetchResumableInventoryRun(BASE, CONNECTION, request)
    assert.equal(found, null)

    const action = actionWith(request)
    const outcome = await action.advance()

    assert.deepEqual(outcome, { kind: 'NO_ACTIVE_RUN' })
    assert.equal(action.active, null)
    assert.equal(calls.length, 1, 'only the read-only lookup was sent')
    assert.equal(calls[0].method, 'GET')
  })

  void it('treats an unreachable or malformed lookup as no candidate', async () => {
    const failing = scriptedFetch(() => {
      throw new Error('network down')
    })
    assert.equal(
      await fetchResumableInventoryRun(BASE, CONNECTION, failing.request),
      null,
    )

    const unavailable = scriptedFetch(() => json({ message: 'nope' }, 503))
    assert.equal(
      await fetchResumableInventoryRun(BASE, CONNECTION, unavailable.request),
      null,
    )

    const malformed = scriptedFetch(() => json({ status: 'ok', run: { runId: 42 } }))
    assert.equal(
      await fetchResumableInventoryRun(BASE, CONNECTION, malformed.request),
      null,
    )
  })
})
