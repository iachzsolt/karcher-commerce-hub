import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  serializeAutomationDetailsWithCursor,
  type InventoryRefreshCursor,
} from '../src/inventory-refresh-slice.ts'
import {
  classifyInventoryRefreshRun,
  cursorMatchesRun,
  resumeEligibleInventoryRefreshes,
  selectResumableInventoryRefreshRuns,
  type InventoryRefreshRunRow,
} from '../src/inventory-refresh-resume.ts'

const NOW = 1_000_000

function details(options: {
  runId?: string
  connectionId?: string
  nextAdvanceAt?: number | null
} = {}) {
  const cursor: InventoryRefreshCursor = {
    version: 1,
    runId: options.runId ?? 'run-1',
    connectionId: options.connectionId ?? 'connection-1',
    phase: 'AUTOMATION',
    planIndex: 0,
    plans: [],
    nextAdvanceAt: options.nextAdvanceAt ?? null,
    lastStopReason: null,
  }

  return serializeAutomationDetailsWithCursor({ version: 1, platforms: [] }, cursor)
}

function runRow(overrides: Partial<InventoryRefreshRunRow> = {}): InventoryRefreshRunRow {
  return {
    id: 'run-1',
    connectionId: 'connection-1',
    triggerType: 'MANUAL',
    status: 'RUNNING',
    automationDetailsJson: details(),
    ...overrides,
  }
}

function busyError() {
  const error = new Error('Inventory refresh is already running') as Error & { status: number }
  error.status = 409
  return error
}

/* ------------------------------------------------------------------ *
 * 1. RUNNING + sliced cursor + expired nextAdvanceAt + no lease
 * ------------------------------------------------------------------ */

void describe('self-resume eligibility', () => {
  void it('accepts a RUNNING sliced run whose cooldown already elapsed', () => {
    const row = runRow({ automationDetailsJson: details({ nextAdvanceAt: NOW - 1 }) })
    const eligibility = classifyInventoryRefreshRun(row, NOW)

    assert.equal(eligibility.resumable, true)
    assert.deepEqual(eligibility.resumable ? eligibility.target : null, {
      connectionId: 'connection-1',
      runId: 'run-1',
      nextAdvanceAt: NOW - 1,
    })
    assert.equal(cursorMatchesRun({
      version: 1,
      runId: 'run-1',
      connectionId: 'connection-1',
      phase: 'AUTOMATION',
      planIndex: 0,
      plans: [],
      nextAdvanceAt: NOW - 1,
      lastStopReason: null,
    }, row), true)
  })

  void it('treats a missing nextAdvanceAt as immediately resumable', () => {
    const row = runRow({ automationDetailsJson: details({ nextAdvanceAt: null }) })
    assert.equal(classifyInventoryRefreshRun(row, NOW).resumable, true)
  })

  /* -------------------------------------------------------------- *
   * 2. future nextAdvanceAt -> skipped
   * -------------------------------------------------------------- */

  void it('skips a run that is still cooling down', () => {
    const row = runRow({ automationDetailsJson: details({ nextAdvanceAt: NOW + 1 }) })
    const eligibility = classifyInventoryRefreshRun(row, NOW)

    assert.equal(eligibility.resumable, false)
    assert.equal(eligibility.resumable ? null : eligibility.reason, 'COOLDOWN')
  })

  /* -------------------------------------------------------------- *
   * 3. COMPLETED / terminal run -> skipped
   * -------------------------------------------------------------- */

  void it('skips every non-RUNNING status', () => {
    for (const status of ['COMPLETED', 'FAILED', 'IMPORT_ONLY', 'INTERRUPTED']) {
      const eligibility = classifyInventoryRefreshRun(runRow({ status }), NOW)

      assert.equal(eligibility.resumable, false, status)
      assert.equal(eligibility.resumable ? null : eligibility.reason, 'NOT_RUNNING', status)
    }
  })

  void it('skips a scheduled run', () => {
    const eligibility = classifyInventoryRefreshRun(runRow({ triggerType: 'SCHEDULED' }), NOW)

    assert.equal(eligibility.resumable, false)
    assert.equal(eligibility.resumable ? null : eligibility.reason, 'NOT_MANUAL')
  })

  /* -------------------------------------------------------------- *
   * 4. legacy RUNNING row without a cursor -> skipped
   * -------------------------------------------------------------- */

  void it('never resumes a legacy RUNNING row that has no sliced cursor', () => {
    const diagnosticsOnly = JSON.stringify({ version: 1, platforms: [] })
    const eligibility = classifyInventoryRefreshRun(
      runRow({ automationDetailsJson: diagnosticsOnly }),
      NOW,
    )

    assert.equal(eligibility.resumable, false)
    assert.equal(eligibility.resumable ? null : eligibility.reason, 'NO_CURSOR')

    const nullDetails = classifyInventoryRefreshRun(
      runRow({ automationDetailsJson: null }),
      NOW,
    )
    assert.equal(nullDetails.resumable, false)
    assert.equal(nullDetails.resumable ? null : nullDetails.reason, 'NO_CURSOR')
  })

  /* -------------------------------------------------------------- *
   * 5. corrupt cursor -> skipped, surfaced diagnostically
   * -------------------------------------------------------------- */

  void it('skips a corrupt cursor and reports it instead of resuming', async () => {
    const row = runRow({ automationDetailsJson: 'not-json' })

    assert.equal(
      classifyInventoryRefreshRun(row, NOW).resumable,
      false,
    )

    const selected = selectResumableInventoryRefreshRuns([row], NOW)
    assert.deepEqual(selected.eligible, [])
    assert.deepEqual(selected.skipped, [{ runId: 'run-1', reason: 'CORRUPT_CURSOR' }])

    const skipped: string[] = []
    let advanced = false

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [row],
      advance: async () => {
        advanced = true
      },
      now: () => NOW,
      onSkip: entry => skipped.push(entry.reason),
    })

    assert.equal(advanced, false)
    assert.equal(result.advanced.length, 0)
    assert.deepEqual(skipped, ['CORRUPT_CURSOR'])
  })

  void it('never advances a cursor that belongs to another run or connection', () => {
    const foreignRun = classifyInventoryRefreshRun(
      runRow({ automationDetailsJson: details({ runId: 'run-2' }) }),
      NOW,
    )
    assert.equal(foreignRun.resumable ? null : foreignRun.reason, 'RUN_MISMATCH')

    const foreignConnection = classifyInventoryRefreshRun(
      runRow({ automationDetailsJson: details({ connectionId: 'connection-2' }) }),
      NOW,
    )
    assert.equal(
      foreignConnection.resumable ? null : foreignConnection.reason,
      'RUN_MISMATCH',
    )
  })
})

/* ------------------------------------------------------------------ *
 * 6. frontend advance and scheduler race -> lease admits one executor
 * ------------------------------------------------------------------ */

void describe('concurrency', () => {
  void it('lets exactly one executor mutate when both race for the lease', async () => {
    const row = runRow({ automationDetailsJson: details({ nextAdvanceAt: NOW - 1 }) })
    let leaseHeld = false
    let leasesAcquired = 0
    let mutations = 0

    const advance = async () => {
      if (leaseHeld) throw busyError()

      leaseHeld = true
      leasesAcquired += 1
      mutations += 1
      await Promise.resolve()
      leaseHeld = false
    }

    const options = {
      scan: async () => [row],
      advance,
      now: () => NOW,
      limit: 1,
    }

    const [frontend, scheduler] = await Promise.all([
      resumeEligibleInventoryRefreshes(options),
      resumeEligibleInventoryRefreshes(options),
    ])

    assert.equal(leasesAcquired, 1, 'only one executor obtained the lease')
    assert.equal(mutations, 1, 'only one mutation path ran')
    assert.equal(frontend.advanced.length + scheduler.advanced.length, 1)
    assert.deepEqual(
      [...frontend.skipped, ...scheduler.skipped].map(entry => entry.reason),
      ['BUSY'],
    )
    assert.deepEqual([...frontend.failed, ...scheduler.failed], [])
  })

  void it('records a lost lease race as a skip, never as an error', async () => {
    const skipped: string[] = []
    const failures: string[] = []

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [runRow()],
      advance: async () => {
        throw busyError()
      },
      now: () => NOW,
      onSkip: entry => skipped.push(entry.reason),
      onError: entry => failures.push(entry.message),
    })

    assert.deepEqual(result.advanced, [])
    assert.deepEqual(skipped, ['BUSY'])
    assert.deepEqual(failures, [])
    assert.deepEqual(result.failed, [])
  })
})

/* ------------------------------------------------------------------ *
 * 7. one scheduler tick = at most one slice per run
 * ------------------------------------------------------------------ */

void describe('tick scope', () => {
  void it('advances an eligible run exactly once per tick, even if it stays RUNNING', async () => {
    let calls = 0
    const row = runRow()

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [row],
      advance: async () => {
        calls += 1
        return { status: 'RUNNING' }
      },
      now: () => NOW,
    })

    assert.equal(calls, 1, 'one slice per tick, never a whole refresh')
    assert.deepEqual(result.advanced, ['run-1'])
  })

  void it('bounds how many runs one tick touches', async () => {
    const rows = [
      runRow({ id: 'run-1' }),
      runRow({ id: 'run-2', automationDetailsJson: details({ runId: 'run-2' }) }),
      runRow({ id: 'run-3', automationDetailsJson: details({ runId: 'run-3' }) }),
    ]
    const advanced: string[] = []

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => rows,
      advance: async target => {
        advanced.push(target.runId)
      },
      now: () => NOW,
      limit: 2,
    })

    assert.deepEqual(advanced, ['run-1', 'run-2'])
    assert.equal(result.eligible, 3)
    assert.equal(result.advanced.length, 2)
  })

  void it('reports a genuine advance failure without inventing progress', async () => {
    const failures: string[] = []

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [runRow()],
      advance: async () => {
        throw new Error('slice transport failed')
      },
      now: () => NOW,
      onError: entry => failures.push(entry.message),
    })

    assert.deepEqual(result.advanced, [])
    assert.deepEqual(failures, ['slice transport failed'])
    assert.equal(result.failed.length, 1)
  })
})

/* ------------------------------------------------------------------ *
 * 8. terminal run -> no later scheduler advance
 * ------------------------------------------------------------------ */

void describe('terminal runs', () => {
  void it('stops touching a run once it is terminal', async () => {
    let advanced = false
    const completed = runRow({ status: 'COMPLETED' })

    const result = await resumeEligibleInventoryRefreshes({
      scan: async () => [completed],
      advance: async () => {
        advanced = true
      },
      now: () => NOW,
    })

    assert.equal(advanced, false)
    assert.deepEqual(result.advanced, [])
    assert.deepEqual(result.skipped, [{ runId: 'run-1', reason: 'NOT_RUNNING' }])
  })
})
