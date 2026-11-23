import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  DIAGNOSTIC_LOG_PREFIX,
  describeError,
  installGlobalErrorDiagnostics,
  logDiagnostic,
  redactDiagnosticText,
  setDiagnosticSink,
  summarizeInventoryCursor,
  tracePhase,
} from '../src/inventory-resume-diagnostics.js'
import type { InventoryRefreshCursor } from '../src/inventory-refresh-slice.js'

type Captured = { level: 'info' | 'error'; payload: Record<string, unknown> }

let captured: Captured[] = []
let restoreSink: () => void = () => {}

function parse(line: string) {
  assert.ok(line.startsWith(`${DIAGNOSTIC_LOG_PREFIX} `), line)
  return JSON.parse(line.slice(DIAGNOSTIC_LOG_PREFIX.length + 1)) as Record<string, unknown>
}

beforeEach(() => {
  captured = []
  restoreSink = setDiagnosticSink({
    info: line => captured.push({ level: 'info', payload: parse(line) }),
    error: line => captured.push({ level: 'error', payload: parse(line) }),
  })
})

afterEach(() => {
  restoreSink()
})

const runId = '2c1edbcf-a28c-478f-a354-f6620cb0648a'

describe('tracePhase', () => {
  void it('returns the action result and logs start/end with summary fields', async () => {
    const result = await tracePhase('resume.scan', { runId }, async () => [1, 2, 3], rows => ({
      runningRows: rows.length,
    }))

    assert.deepEqual(result, [1, 2, 3])
    assert.deepEqual(captured.map(entry => [entry.level, entry.payload.event]), [
      ['info', 'start'],
      ['info', 'end'],
    ])
    assert.equal(captured[1].payload.phase, 'resume.scan')
    assert.equal(captured[1].payload.runId, runId)
    assert.equal(captured[1].payload.runningRows, 3)
    assert.equal(typeof captured[1].payload.durationMs, 'number')
  })

  void it('rethrows the identical error object and logs name, message, status, phase and run id', async () => {
    class InventoryRefreshError extends Error {
      constructor(message: string, readonly status: number) {
        super(message)
        this.name = 'InventoryRefreshError'
      }
    }
    const original = new InventoryRefreshError('Inventory refresh execution lease lost', 409)

    await assert.rejects(
      tracePhase('resume.advance', { runId }, async () => {
        throw original
      }),
      error => error === original,
    )

    const errorLine = captured.find(entry => entry.level === 'error')
    assert.ok(errorLine)
    assert.equal(errorLine.payload.event, 'error')
    assert.equal(errorLine.payload.phase, 'resume.advance')
    assert.equal(errorLine.payload.runId, runId)
    assert.equal(errorLine.payload.errorName, 'InventoryRefreshError')
    assert.equal(errorLine.payload.errorMessage, 'Inventory refresh execution lease lost')
    assert.equal(errorLine.payload.errorStatus, 409)
    assert.equal(captured.some(entry => entry.payload.event === 'end'), false)
  })

  void it('captures synchronous throws and non-Error rejections without altering them', async () => {
    const thrown = { code: 'weird' }
    await assert.rejects(
      tracePhase('slice.lease-check', {}, () => {
        throw thrown
      }),
      error => error === thrown,
    )
    assert.equal(captured.at(-1)?.payload.errorName, 'NonError:object')
  })

  void it('ignores summarize failures and still returns the result', async () => {
    const result = await tracePhase('x', {}, async () => 'ok', () => {
      throw new Error('summary broke')
    })
    assert.equal(result, 'ok')
    assert.equal(captured.at(-1)?.payload.event, 'end')
  })
})

describe('logging safety', () => {
  void it('never throws when the sink throws', () => {
    restoreSink()
    restoreSink = setDiagnosticSink({
      info: () => {
        throw new Error('sink down')
      },
      error: () => {
        throw new Error('sink down')
      },
    })
    assert.doesNotThrow(() => logDiagnostic('x', 'info', { runId }))
    assert.doesNotThrow(() => logDiagnostic('x', 'error', { runId }))
  })

  void it('drops non-scalar fields so payloads cannot leak', () => {
    logDiagnostic('x', 'info', {
      runId,
      // Deliberately wrong type: objects and arrays must never be logged.
      payload: { listingIds: ['a', 'b'] } as unknown as string,
    })
    assert.equal('payload' in captured[0].payload, false)
    assert.equal(captured[0].payload.runId, runId)
  })

  void it('redacts credentials, bearer tokens and JWT-like strings', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'
    const text = redactDiagnosticText(
      `connect postgresql://user:secret@host.neon.tech/db failed; Authorization: Bearer abc.def.ghi; token ${jwt}; access_token=xyz123`,
    )
    assert.doesNotMatch(text, /secret/)
    assert.doesNotMatch(text, /abc\.def\.ghi/)
    assert.doesNotMatch(text, /xyz123/)
    assert.doesNotMatch(text, new RegExp(jwt.slice(0, 20)))
  })

  void it('truncates long messages and describes one cause level', () => {
    const error = new Error('x'.repeat(1000), { cause: new TypeError('fetch failed') })
    const described = describeError(error)
    assert.ok(described.errorMessage.length <= 301)
    assert.equal(described.causeName, 'TypeError')
    assert.equal(described.causeMessage, 'fetch failed')
  })
})

describe('summarizeInventoryCursor', () => {
  void it('reports indexes and counts but never listing ids', () => {
    const listingIds = Array.from({ length: 30 }, (_, index) => `listing-${index}`)
    const cursor: InventoryRefreshCursor = {
      version: 1,
      runId,
      connectionId: '0302f4dd-5593-4b76-8008-e9ae9a48087d',
      phase: 'AUTOMATION',
      planIndex: 0,
      plans: [{
        kind: 'ALLEGRO',
        accountId: 'account-1',
        historyGroupId: 'history-1',
        batches: [listingIds.slice(0, 25), listingIds.slice(25)],
        batchIndex: 0,
        completedListingIds: [],
        partial: {} as never,
        completedBatches: [],
        skippedReason: null,
      }],
      nextAdvanceAt: null,
      lastStopReason: null,
    }

    const summary = summarizeInventoryCursor(cursor)
    assert.deepEqual(
      {
        planIndex: summary.planIndex,
        batchIndex: summary.batchIndex,
        batchCount: summary.batchCount,
        completedBatchCount: summary.completedBatchCount,
        currentBatchSize: summary.currentBatchSize,
        nextAdvanceAt: summary.nextAdvanceAt,
      },
      {
        planIndex: 0,
        batchIndex: 0,
        batchCount: 2,
        completedBatchCount: 0,
        currentBatchSize: 25,
        nextAdvanceAt: null,
      },
    )
    assert.doesNotMatch(JSON.stringify(summary), /listing-/)
    assert.equal(cursor.plans.length, 1, 'cursor must not be modified')
  })

  void it('handles a missing cursor', () => {
    assert.deepEqual(summarizeInventoryCursor(null), { cursorPresent: false })
  })
})

describe('installGlobalErrorDiagnostics', () => {
  void it('registers log-only listeners that never call preventDefault', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const installed = installGlobalErrorDiagnostics({
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners.set(type, listener)
      },
    })
    assert.equal(installed, true)
    assert.deepEqual([...listeners.keys()].sort(), ['error', 'unhandledrejection'])

    let prevented = false
    listeners.get('unhandledrejection')?.({
      reason: new RangeError('boom'),
      preventDefault: () => {
        prevented = true
      },
    })
    listeners.get('error')?.({
      error: new Error('uncaught'),
      preventDefault: () => {
        prevented = true
      },
    })

    assert.equal(prevented, false)
    const errors = captured.filter(entry => entry.level === 'error')
    assert.equal(errors[0].payload.phase, 'global.unhandledrejection')
    assert.equal(errors[0].payload.errorName, 'RangeError')
    assert.equal(errors[1].payload.phase, 'global.error')
  })

  void it('is a no-op without an event API (Node)', () => {
    assert.equal(installGlobalErrorDiagnostics({}), false)
    assert.equal(installGlobalErrorDiagnostics(null), false)
  })
})

describe('deno.ts cron diagnostics', () => {
  const deno = readFileSync(new URL('../src/deno.ts', import.meta.url), 'utf8')

  void it('logs cron failures with their phase and rethrows unchanged', () => {
    assert.match(deno, /catch \(error\) \{\s+logDiagnosticError\('cron', error, \{[\s\S]*?\}\)\s+throw error\s+\}/)
    assert.match(deno, /logDiagnostic\('cron', 'start'/)
    assert.match(deno, /logDiagnostic\('cron', 'end'/)
  })

  void it('installs global error diagnostics at module scope', () => {
    assert.match(deno, /^installGlobalErrorDiagnostics\(\)$/m)
    assert.doesNotMatch(deno, /\.preventDefault\(/)
  })
})
