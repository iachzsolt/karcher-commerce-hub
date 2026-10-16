import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseHistorySinceParam } from '../src/history-range.ts'

/*
 * ?since= background-poll narrowing for the history
 * listings. The pure parser is unit-tested directly;
 * endpoint wiring is asserted against source (repo
 * precedent), keeping the full-window default intact.
 */

void describe('parseHistorySinceParam', () => {
  void it('absent means full window', () => {
    assert.deepEqual(parseHistorySinceParam(undefined), {
      ok: true,
      since: null,
    })
    assert.deepEqual(parseHistorySinceParam(''), {
      ok: true,
      since: null,
    })
  })

  void it('accepts ISO timestamps', () => {
    const parsed = parseHistorySinceParam(
      '2026-10-16T10:00:00.000Z',
    )
    assert.equal(parsed.ok, true)

    if (!parsed.ok) {
      throw new Error('unreachable')
    }

    assert.equal(
      parsed.since?.toISOString(),
      '2026-10-16T10:00:00.000Z',
    )
  })

  void it('rejects non-timestamps', () => {
    for (const value of ['yesterday', '2026-13-45', '   ']) {
      const parsed = parseHistorySinceParam(value)
      assert.equal(parsed.ok, false)
    }
  })
})

void describe('history since wiring', () => {
  const source = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'src',
      'index.ts',
    ),
    'utf8',
  ).replace(/\s+/g, '')

  void it('event history narrows by occurredAt when since is present', () => {
    assert.ok(
      source.includes(
        'gte(allegroChangeEvents.occurredAt,since)',
      ),
    )
  })

  void it('run listings keep RUNNING rows in since mode', () => {
    assert.ok(
      source.includes(
        "eq(catalogSyncRuns.status,'RUNNING')",
      ),
    )
    assert.ok(
      source.includes(
        "eq(dataConnectionRuns.status,'RUNNING')",
      ),
    )
  })

  void it('run listings include recently finished rows in since mode', () => {
    assert.ok(
      source.includes(
        'gte(catalogSyncRuns.finishedAt,since)',
      ),
    )
    assert.ok(
      source.includes(
        'gte(dataConnectionRuns.finishedAt,since,)',
      ),
    )
  })

  void it('full window is unchanged without since', () => {
    // Every since filter is conditional; the default
    // query path has no since predicate.
    assert.ok(source.includes('since?or('))
    assert.ok(
      source.includes(
        'since?gte(allegroChangeEvents.occurredAt,since)',
      ),
    )
  })
})
