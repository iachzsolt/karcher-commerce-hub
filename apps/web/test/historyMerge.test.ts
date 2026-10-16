import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  hasActiveHistoryRows,
  mergeHistoryEvents,
  mergeHistoryRuns,
} from '../src/utils/historyMerge.ts'

/*
 * Active-row merge for History background polling.
 * Pure row-list functions only; no browser APIs, so
 * these run under plain node:test. Effect wiring
 * (visibility gate, fallback reload, manual refresh)
 * is covered by code review of AllegroHistoryPage.
 */

type TestEvent = {
  id: string
  occurredAt: string
  eventType: string
  newValue: string | null
}

type TestRun = {
  id: string
  startedAt: string
  status: string
}

const OLD_COMPLETED: TestEvent = {
  id: 'ev-old',
  occurredAt: '2026-10-01T10:00:00.000Z',
  eventType: 'SYNC',
  newValue: 'SUCCESS',
}

const OLD_RUN: TestRun = {
  id: 'run-old',
  startedAt: '2026-10-01T10:00:00.000Z',
  status: 'COMPLETED',
}

void describe('history active-row merge', () => {
  void it('initial full load equals the incoming window in order', () => {
    const incoming: TestEvent[] = [
      {
        ...OLD_COMPLETED,
        id: 'ev-2',
        occurredAt: '2026-10-02T10:00:00.000Z',
      },
      { ...OLD_COMPLETED, id: 'ev-1' },
    ]
    assert.deepEqual(
      mergeHistoryEvents([], incoming).map(
        (row) => row.id,
      ),
      ['ev-2', 'ev-1'],
    )
  })

  void it('merges only the active subset without touching history', () => {
    const merged = mergeHistoryEvents(
      [OLD_COMPLETED],
      [
        {
          id: 'ev-new',
          occurredAt: '2026-10-16T10:00:00.000Z',
          eventType: 'SYNC',
          newValue: 'PENDING',
        },
      ],
    )
    assert.deepEqual(
      merged.map((row) => row.id),
      ['ev-new', 'ev-old'],
    )
    assert.equal(
      merged.find((row) => row.id === 'ev-old'),
      OLD_COMPLETED,
    )
  })

  void it('PENDING -> COMPLETED updates the same row', () => {
    const merged = mergeHistoryEvents(
      [
        {
          id: 'ev-1',
          occurredAt: '2026-10-16T10:00:00.000Z',
          eventType: 'SYNC',
          newValue: 'PENDING',
        },
      ],
      [
        {
          id: 'ev-1',
          occurredAt: '2026-10-16T10:05:00.000Z',
          eventType: 'SYNC',
          newValue: 'SUCCESS',
        },
      ],
    )
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.newValue, 'SUCCESS')
  })

  void it('RUNNING -> FAILED updates the same run', () => {
    const merged = mergeHistoryRuns<TestRun>(
      [
        {
          id: 'run-1',
          startedAt: '2026-10-16T10:00:00.000Z',
          status: 'RUNNING',
        },
      ],
      [
        {
          id: 'run-1',
          startedAt: '2026-10-16T10:00:00.000Z',
          status: 'FAILED',
        },
      ],
    )
    assert.equal(merged.length, 1)
    assert.equal(merged[0]?.status, 'FAILED')
  })

  void it('inserts a newly active row', () => {
    const merged = mergeHistoryRuns(
      [OLD_RUN],
      [
        {
          id: 'run-new',
          startedAt: '2026-10-16T10:00:00.000Z',
          status: 'RUNNING',
        },
      ],
    )
    assert.deepEqual(
      merged.map((row) => row.id),
      ['run-new', 'run-old'],
    )
  })

  void it('preserves completed historical rows', () => {
    const merged = mergeHistoryRuns([OLD_RUN], [])
    assert.deepEqual(merged, [OLD_RUN])
  })

  void it('overlap duplicates collapse to one row', () => {
    const merged = mergeHistoryEvents(
      [OLD_COMPLETED],
      [{ ...OLD_COMPLETED }],
    )
    assert.deepEqual(
      merged.map((row) => row.id),
      ['ev-old'],
    )
  })

  void it('keeps newest-first order across merges', () => {
    const merged = mergeHistoryEvents(
      [
        {
          ...OLD_COMPLETED,
          id: 'ev-b',
          occurredAt: '2026-10-02T10:00:00.000Z',
        },
      ],
      [
        {
          ...OLD_COMPLETED,
          id: 'ev-c',
          occurredAt: '2026-10-03T10:00:00.000Z',
        },
        {
          ...OLD_COMPLETED,
          id: 'ev-a',
          occurredAt: '2026-10-01T10:00:00.000Z',
        },
      ],
    )
    assert.deepEqual(
      merged.map((row) => row.id),
      ['ev-c', 'ev-b', 'ev-a'],
    )
  })

  void it('detects when nothing active remains', () => {
    assert.equal(
      hasActiveHistoryRows({
        events: [OLD_COMPLETED],
        catalogRuns: [OLD_RUN],
        inventoryRuns: [OLD_RUN],
      }),
      false,
    )
    assert.equal(
      hasActiveHistoryRows({
        events: [
          {
            eventType: 'SYNC',
            newValue: 'PENDING',
          },
        ],
        catalogRuns: [],
        inventoryRuns: [],
      }),
      true,
    )
    assert.equal(
      hasActiveHistoryRows({
        events: [],
        catalogRuns: [{ status: 'RUNNING' }],
        inventoryRuns: [],
      }),
      true,
    )
    assert.equal(
      hasActiveHistoryRows({
        events: [],
        catalogRuns: [],
        inventoryRuns: [{ status: 'RUNNING' }],
      }),
      true,
    )
  })
})
