import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isDuplicateOpenPendingSyncEvent,
  isTerminalInventorySyncStatus,
  reconcilePendingSyncEvent,
  syncAllegroInventoryRows,
} from '../src/allegro-inventory-sync.ts'
import {
  reapStaleCatalogSyncRuns,
  selectRelatedImportForWrapper,
} from '../src/data-connections.ts'
import {
  aggregateListingStories,
  describeStoryDetail,
  summarizeRefreshRun,
  summarizeStories,
} from '../../web/src/utils/inventoryRefreshStories.ts'

void describe('pending sync reconciliation', () => {
  void it('closes a stock pending when remote already equals the target', () => {
    const confirmed = reconcilePendingSyncEvent(
      {
        listingId: 'listing-1',
        action: 'STOCK_UPDATE',
        status: 'PENDING',
        publicationStatus: 'ACTIVE',
        targetStock: 721,
        remoteStock: 406,
        fromStock: 406,
        toStock: 721,
        occurredAt: '2026-09-18T10:00:00.000Z',
      },
      {
        remoteStock: 721,
        publicationStatus: 'ACTIVE',
        targetStock: 721,
      },
      '2026-09-18T13:15:00.000Z',
    )

    assert.ok(confirmed)
    assert.equal(confirmed.newValue, 'SUCCESS')
    assert.equal(confirmed.oldValue, 'STOCK_UPDATE')
    const metadata = JSON.parse(
      confirmed.metadataJson,
    ) as Record<string, unknown>
    assert.equal(metadata['toStock'], 721)
    assert.equal(
      metadata['confirmedRemoteStock'],
      721,
    )
    assert.equal(metadata['reconciled'], true)
  })

  void it('keeps pending when remote does not match the target', () => {
    assert.equal(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-1',
          action: 'STOCK_UPDATE',
          status: 'PENDING',
          publicationStatus: 'ACTIVE',
          targetStock: 721,
          remoteStock: 406,
          fromStock: 406,
          toStock: 721,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: 500,
          publicationStatus: 'ACTIVE',
          targetStock: 721,
        },
        '2026-09-18T13:15:00.000Z',
      ),
      null,
    )
  })

  void it('never fabricates success from unknown remote state', () => {
    assert.equal(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-1',
          action: 'STOCK_UPDATE',
          status: 'PENDING',
          publicationStatus: 'ACTIVE',
          targetStock: 721,
          remoteStock: 406,
          fromStock: 406,
          toStock: 721,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: null,
          publicationStatus: 'ACTIVE',
          targetStock: 721,
        },
        '2026-09-18T13:15:00.000Z',
      ),
      null,
    )
  })

  void it('confirms an END pending only on ended publication', () => {
    const ended = reconcilePendingSyncEvent(
      {
        listingId: 'listing-2',
        action: 'END',
        status: 'PENDING',
        publicationStatus: 'ACTIVE',
        targetStock: 0,
        remoteStock: 334,
        fromStock: null,
        toStock: null,
        occurredAt: '2026-09-18T10:00:00.000Z',
      },
      {
        remoteStock: 0,
        publicationStatus: 'INACTIVE',
        targetStock: 0,
      },
      '2026-09-18T13:15:00.000Z',
    )
    assert.ok(ended)
    assert.equal(ended.newValue, 'SUCCESS')

    assert.equal(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-2',
          action: 'END',
          status: 'PENDING',
          publicationStatus: 'ACTIVE',
          targetStock: 0,
          remoteStock: 334,
          fromStock: null,
          toStock: null,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: 334,
          publicationStatus: 'ACTIVE',
          targetStock: 0,
        },
        '2026-09-18T13:15:00.000Z',
      ),
      null,
    )
  })

  void it('confirms an ACTIVATE pending only on active publication', () => {
    assert.ok(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-3',
          action: 'ACTIVATE',
          status: 'PENDING',
          publicationStatus: 'INACTIVE',
          targetStock: 18,
          remoteStock: 18,
          fromStock: null,
          toStock: null,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: 18,
          publicationStatus: 'ACTIVE',
          targetStock: 18,
        },
        '2026-09-18T13:15:00.000Z',
      ),
    )
    assert.equal(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-3',
          action: 'ACTIVATE',
          status: 'PENDING',
          publicationStatus: 'INACTIVE',
          targetStock: 18,
          remoteStock: 18,
          fromStock: null,
          toStock: null,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: 18,
          publicationStatus: 'ACTIVATING',
          targetStock: 18,
        },
        '2026-09-18T13:15:00.000Z',
      ),
      null,
    )
  })

  void it('confirms a finished reactivation without resending ACTIVATE', () => {
    const confirmed = reconcilePendingSyncEvent(
      {
        listingId: 'listing-3',
        action: 'NONE',
        status: 'REACTIVATION_IN_PROGRESS',
        publicationStatus: 'ACTIVATING',
        targetStock: 18,
        remoteStock: 18,
        fromStock: null,
        toStock: null,
        occurredAt: '2026-09-18T10:00:00.000Z',
      },
      {
        remoteStock: 18,
        publicationStatus: 'ACTIVE',
        targetStock: 18,
      },
      '2026-09-18T13:15:00.000Z',
    )
    assert.ok(confirmed)
    assert.equal(
      confirmed.oldValue,
      'REACTIVATION_CONFIRMED',
    )
  })

  void it('treats terminal statuses as already closed', () => {
    for (const status of [
      'SUCCESS',
      'FAILED',
      'NO_CHANGE',
      'MANUAL_INACTIVE',
      'SKIPPED',
    ]) {
      assert.equal(
        isTerminalInventorySyncStatus(status),
        true,
      )
      assert.equal(
        reconcilePendingSyncEvent(
          {
            listingId: 'listing-9',
            action: 'STOCK_UPDATE',
            status,
            publicationStatus: 'ACTIVE',
            targetStock: 721,
            remoteStock: 406,
            fromStock: 406,
            toStock: 721,
            occurredAt:
              '2026-09-18T10:00:00.000Z',
          },
          {
            remoteStock: 721,
            publicationStatus: 'ACTIVE',
            targetStock: 721,
          },
          '2026-09-18T13:15:00.000Z',
        ),
        null,
      )
    }

    assert.equal(
      isTerminalInventorySyncStatus('PENDING'),
      false,
    )
    assert.equal(
      isTerminalInventorySyncStatus(
        'REACTIVATION_IN_PROGRESS',
      ),
      false,
    )
  })

  void it('never invents FAILED or unknown actions', () => {
    assert.equal(
      reconcilePendingSyncEvent(
        {
          listingId: 'listing-9',
          action: 'SOMETHING_ELSE',
          status: 'PENDING',
          publicationStatus: 'ACTIVE',
          targetStock: 721,
          remoteStock: 721,
          fromStock: 406,
          toStock: 721,
          occurredAt: '2026-09-18T10:00:00.000Z',
        },
        {
          remoteStock: 100,
          publicationStatus: 'ACTIVE',
          targetStock: 721,
        },
        '2026-09-18T13:15:00.000Z',
      ),
      null,
    )
  })
})

void describe('history presentation', () => {
  function storyInput(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: 'event-1',
      listingId: 'listing-1',
      offerId: '18767261257',
      sku: '2.640-729.0',
      listingName: 'Test offer',
      action: 'STOCK_UPDATE',
      status: 'SUCCESS',
      occurredAt: '2026-09-18T13:15:00.000Z',
      metadata: {
        publicationStatus: 'ACTIVE',
        targetStock: 721,
        remoteStock: 406,
        fromStock: 406,
        toStock: 721,
      },
      ...overrides,
    } as never
  }

  void it('drops a stale pending once a newer terminal event exists', () => {
    const stories = aggregateListingStories([
      storyInput({
        id: 'event-pending',
        status: 'PENDING',
        occurredAt: '2026-09-18T10:00:00.000Z',
      }),
      storyInput({
        id: 'event-latest',
        action: 'NONE',
        status: 'NO_CHANGE',
        occurredAt: '2026-09-18T13:15:00.000Z',
      }),
    ])

    assert.equal(stories.length, 1)
    assert.equal(
      stories[0]?.businessResult,
      'STOCK_UPDATED',
    )
  })

  void it('keeps a genuinely pending newest event pending', () => {
    const stories = aggregateListingStories([
      storyInput({
        status: 'PENDING',
        occurredAt: '2026-09-18T13:15:00.000Z',
      }),
    ])

    assert.equal(
      stories[0]?.businessResult,
      'PENDING',
    )
    assert.equal(
      stories[0]?.statusLabel,
      'FELDOLGOZÁS ALATT',
    )
    assert.deepEqual(describeStoryDetail(stories[0]!), [
      'Készletmódosítás: 406 → 721 db',
      'Ajánlat jelenlegi státusza: Aktív',
    ])
  })

  void it('labels stock-only success with confirmed wording', () => {
    const stories = aggregateListingStories([
      storyInput(),
    ])

    assert.equal(
      stories[0]?.statusLabel,
      'KÉSZLET FRISSÍTVE',
    )
    assert.deepEqual(describeStoryDetail(stories[0]!), [
      'Készlet: 406 → 721 db',
      'Ajánlat: aktív maradt',
    ])
  })

  void it('labels automatic deactivation with stock and transition', () => {
    const stories = aggregateListingStories([
      storyInput({
        action: 'END',
        metadata: {
          publicationStatus: 'ACTIVE',
          targetStock: 0,
          remoteStock: 334,
          fromStock: 334,
          toStock: 0,
        },
      }),
    ])

    assert.equal(
      stories[0]?.businessResult,
      'AUTO_PAUSED',
    )
    assert.equal(
      stories[0]?.statusLabel,
      'LEKAPCSOLVA',
    )
    assert.deepEqual(describeStoryDetail(stories[0]!), [
      'Készlet: 334 → 0 db',
      'Ajánlat: ACTIVE → INACTIVE',
    ])
  })

  void it('labels automatic reactivation distinctly', () => {
    const stories = aggregateListingStories([
      storyInput({
        action: 'ACTIVATE',
        metadata: {
          publicationStatus: 'INACTIVE',
          targetStock: 18,
          remoteStock: 18,
          fromStock: 0,
          toStock: 18,
        },
      }),
    ])

    assert.equal(
      stories[0]?.businessResult,
      'ACTIVATED',
    )
    assert.equal(
      stories[0]?.statusLabel,
      'VISSZAKAPCSOLVA',
    )
    assert.equal(
      stories[0]?.resultLabel,
      'Ajánlat automatikusan visszakapcsolva',
    )
  })

  void it('labels no-action explicitly', () => {
    const stories = aggregateListingStories([
      storyInput({
        action: 'NONE',
        status: 'NO_CHANGE',
        metadata: {
          targetStock: 5,
          remoteStock: 5,
          fromStock: 5,
          toStock: 5,
        },
      }),
    ])

    assert.equal(
      stories[0]?.businessResult,
      'NO_ACTION',
    )
    assert.equal(
      stories[0]?.statusLabel,
      'NINCS TEENDŐ',
    )
    assert.deepEqual(describeStoryDetail(stories[0]!), [
      'Készlet már megfelelő',
      'Aktuális készlet: 5 db',
    ])
  })

  void it('labels failures with HIBA and keeps the error', () => {
    const stories = aggregateListingStories([
      storyInput({
        action: 'STOCK_UPDATE',
        status: 'FAILED',
        metadata: {
          publicationStatus: 'ACTIVE',
          targetStock: 721,
          remoteStock: 406,
          fromStock: 406,
          toStock: 721,
          taskMessage: 'Allegro rejected the command',
        },
      }),
    ])

    assert.equal(
      stories[0]?.statusLabel,
      'HIBA',
    )
  })

  void it('leaves manual-inactive protection wording unchanged', () => {
    const stories = aggregateListingStories([
      storyInput({
        action: 'SKIP',
        status: 'MANUAL_INACTIVE',
      }),
    ])

    assert.equal(
      stories[0]?.businessResult,
      'MANUAL_SKIPPED',
    )
    assert.equal(
      stories[0]?.resultLabel,
      'Manuálisan inaktív — kihagyva',
    )
  })

  void it('classifies summary counters without double counting', () => {
    const summary = summarizeStories(
      aggregateListingStories([
        storyInput({ listingId: 'updated' }),
        storyInput({
          listingId: 'paused',
          id: 'event-paused',
          action: 'END',
          metadata: {
            publicationStatus: 'ACTIVE',
            targetStock: 0,
            remoteStock: 3,
            fromStock: 3,
            toStock: 0,
          },
        }),
        storyInput({
          listingId: 'pending',
          id: 'event-pending',
          status: 'PENDING',
        }),
        storyInput({
          listingId: 'idle',
          id: 'event-idle',
          action: 'NONE',
          status: 'NO_CHANGE',
          metadata: {
            targetStock: 5,
            remoteStock: 5,
            fromStock: 5,
            toStock: 5,
          },
        }),
      ]),
    )

    assert.equal(summary.affected, 3)
    assert.equal(summary.stockUpdated, 1)
    assert.equal(summary.autoPaused, 1)
    assert.equal(summary.pending, 1)
    assert.equal(summary.noAction, 1)
    assert.equal(summary.failed, 0)
  })

  void it('keeps an older wrapper bound to its own import', () => {
    const children = [
      {
        id: 'import-a',
        connectionId: 'conn-1',
        rowsImported: 5910,
        changedItemCount: 69,
        startedAt: new Date('2026-09-18T13:01:00.000Z'),
      },
      {
        id: 'import-b',
        connectionId: 'conn-1',
        rowsImported: 5912,
        changedItemCount: 3,
        startedAt: new Date('2026-09-18T15:01:00.000Z'),
      },
    ]
    const wrapperA = {
      connectionId: 'conn-1',
      startedAt: new Date('2026-09-18T13:00:00.000Z'),
      finishedAt: null,
    }
    const wrapperB = {
      connectionId: 'conn-1',
      startedAt: new Date('2026-09-18T15:00:00.000Z'),
      finishedAt: new Date('2026-09-18T15:04:00.000Z'),
    }

    assert.equal(
      selectRelatedImportForWrapper(
        wrapperA,
        new Date('2026-09-18T15:00:00.000Z'),
        children,
      )?.id,
      'import-a',
    )
    assert.equal(
      selectRelatedImportForWrapper(
        wrapperB,
        null,
        children,
      )?.id,
      'import-b',
    )
  })

  void it('maps the production-shaped 5910/69 orphan correctly', () => {
    const related = selectRelatedImportForWrapper(
      {
        connectionId: 'conn-1',
        startedAt: new Date('2026-09-18T13:00:00.000Z'),
        finishedAt: null,
      },
      null,
      [
        {
          id: 'import-a',
          connectionId: 'conn-1',
          rowsImported: 5910,
          changedItemCount: 69,
          startedAt: new Date(
            '2026-09-18T13:01:00.000Z',
          ),
        },
      ],
    )

    assert.ok(related)
    assert.equal(related.rowsImported, 5910)
    assert.equal(related.changedItemCount, 69)
  })

  void it('shows no authoritative import without a matching child', () => {
    assert.equal(
      selectRelatedImportForWrapper(
        {
          connectionId: 'conn-1',
          startedAt: new Date('2026-09-18T13:00:00.000Z'),
          finishedAt: null,
        },
        new Date('2026-09-18T15:00:00.000Z'),
        [],
      ),
      null,
    )
    assert.equal(
      selectRelatedImportForWrapper(
        {
          connectionId: 'conn-1',
          startedAt: new Date('2026-09-18T16:00:00.000Z'),
          finishedAt: null,
        },
        null,
        [
          {
            id: 'import-a',
            connectionId: 'conn-1',
            startedAt: new Date(
              '2026-09-18T13:01:00.000Z',
            ),
          },
        ],
      ),
      null,
    )
  })

  void it('never associates imports across connections', () => {
    assert.equal(
      selectRelatedImportForWrapper(
        {
          connectionId: 'conn-1',
          startedAt: new Date('2026-09-18T13:00:00.000Z'),
          finishedAt: null,
        },
        null,
        [
          {
            id: 'import-other',
            connectionId: 'conn-2',
            startedAt: new Date(
              '2026-09-18T13:01:00.000Z',
            ),
          },
        ],
      ),
      null,
    )
  })

  void it('respects a finished wrapper window against stray children', () => {
    const wrapper = {
      connectionId: 'conn-1',
      startedAt: new Date('2026-09-18T13:00:00.000Z'),
      finishedAt: new Date('2026-09-18T13:20:00.000Z'),
    }
    const children = [
      {
        id: 'import-own',
        connectionId: 'conn-1',
        startedAt: new Date('2026-09-18T13:01:00.000Z'),
      },
      {
        id: 'import-stray',
        connectionId: 'conn-1',
        startedAt: new Date('2026-09-18T13:25:00.000Z'),
      },
    ]

    assert.equal(
      selectRelatedImportForWrapper(
        wrapper,
        new Date('2026-09-18T15:00:00.000Z'),
        children,
      )?.id,
      'import-own',
    )
    assert.equal(
      selectRelatedImportForWrapper(
        {
          ...wrapper,
          startedAt: new Date(
            '2026-09-18T13:22:00.000Z',
          ),
        },
        new Date('2026-09-18T15:00:00.000Z'),
        children,
      ),
      null,
    )
  })

  void it('maps an interrupted wrapper run distinctly', () => {
    assert.deepEqual(
      summarizeRefreshRun({
        status: 'INTERRUPTED',
        importStatus: null,
      }).overall,
      'interrupted',
    )
    assert.deepEqual(
      summarizeRefreshRun({
        status: 'COMPLETED',
        importStatus: 'SUCCESS',
      }).overall,
      'success',
    )
    assert.deepEqual(
      summarizeRefreshRun({
        status: 'RUNNING',
        importStatus: null,
      }).overall,
      'running',
    )
  })
})

void describe('duplicate open pending suppression', () => {
  void it('suppresses an identical still-open pair', () => {
    assert.equal(
      isDuplicateOpenPendingSyncEvent(
        {
          oldValue: 'NONE',
          newValue: 'REACTIVATION_IN_PROGRESS',
        },
        'NONE',
        'REACTIVATION_IN_PROGRESS',
      ),
      true,
    )
    assert.equal(
      isDuplicateOpenPendingSyncEvent(
        {
          oldValue: 'ACTIVATE',
          newValue: 'PENDING',
        },
        'ACTIVATE',
        'PENDING',
      ),
      true,
    )
  })

  void it('allows emission after any terminal event', () => {
    for (const terminal of [
      'SUCCESS',
      'FAILED',
      'NO_CHANGE',
    ]) {
      assert.equal(
        isDuplicateOpenPendingSyncEvent(
          {
            oldValue: 'NONE',
            newValue: terminal,
          },
          'NONE',
          'REACTIVATION_IN_PROGRESS',
        ),
        false,
      )
    }
  })

  void it('allows emission when the pair differs', () => {
    assert.equal(
      isDuplicateOpenPendingSyncEvent(
        {
          oldValue: 'ACTIVATE',
          newValue: 'PENDING',
        },
        'NONE',
        'REACTIVATION_IN_PROGRESS',
      ),
      false,
    )
    assert.equal(
      isDuplicateOpenPendingSyncEvent(
        {
          oldValue: 'NONE',
          newValue: 'SUCCESS',
        },
        'NONE',
        'SUCCESS',
      ),
      false,
    )
    assert.equal(
      isDuplicateOpenPendingSyncEvent(
        null,
        'NONE',
        'REACTIVATION_IN_PROGRESS',
      ),
      false,
    )
  })

  function activatingRow() {
    return {
      sku: 'ACTIVATING',
      listingId: 'listing-activating',
      offerId: 'offer-activating',
      targetStock: 5,
      remoteStock: 5,
      desiredStock: 5,
      stockLocked: false,
      stockAutoPaused: true,
      publicationStatus: 'ACTIVATING',
      desiredPublicationStatus: 'ACTIVE',
      duplicateOfferCount: 1,
      sourceMissing: false,
    }
  }

  function stubDatabase(
    latestEvents: Array<{
      listingId: string
      oldValue: string | null
      newValue: string | null
    }>,
  ) {
    const inserted: unknown[] = []
    const terminal = (rows: unknown[]) => ({
      limit: () => Promise.resolve(rows),
      then: (
        resolve: (value: unknown) => unknown,
      ) =>
        Promise.resolve(rows).then(resolve),
    })

    return {
      inserted,
      database: {
        select: (fields: Record<string, unknown>) => {
          const rows =
            'metadataJson' in fields
              ? []
              : latestEvents
          const chain = {
            from: () => ({
              where: () => ({
                orderBy: () => terminal(rows),
              }),
            }),
          }

          return chain
        },
        insert: () => ({
          values: (values: unknown) => {
            inserted.push(values)

            return Promise.resolve()
          },
        }),
        update: () => {
          throw new Error(
            'unexpected database update',
          )
        },
      } as unknown as Parameters<
        typeof syncAllegroInventoryRows
      >[0],
    }
  }

  const silentAdapter = {
    pushStock: async () => {
      throw new Error('pushStock must not run')
    },
    pushStatus: async () => {
      throw new Error('pushStatus must not run')
    },
    refresh: async () => {
      throw new Error('refresh must not run')
    },
  }

  void it('does not insert a duplicate pending reactivation row', async () => {
    const stub = stubDatabase([
      {
        listingId: 'listing-activating',
        oldValue: 'NONE',
        newValue: 'REACTIVATION_IN_PROGRESS',
      },
    ])
    const result = await syncAllegroInventoryRows(
      stub.database,
      [activatingRow()],
      silentAdapter,
    )

    assert.equal(result.summary.pending, 1)
    assert.deepEqual(stub.inserted, [])
  })

  void it('inserts a reactivation row after a terminal event', async () => {
    const stub = stubDatabase([
      {
        listingId: 'listing-activating',
        oldValue: 'NONE',
        newValue: 'SUCCESS',
      },
    ])
    const result = await syncAllegroInventoryRows(
      stub.database,
      [activatingRow()],
      silentAdapter,
    )

    assert.equal(result.summary.pending, 1)
    assert.equal(stub.inserted.length, 1)
    assert.deepEqual(
      (
        stub.inserted[0] as Array<{
          oldValue: string
          newValue: string
        }>
      ).map((row) => ({
        oldValue: row.oldValue,
        newValue: row.newValue,
      })),
      [
        {
          oldValue: 'NONE',
          newValue: 'REACTIVATION_IN_PROGRESS',
        },
      ],
    )
  })

  void it('still inserts when the guard lookup fails', async () => {
    const failing = {
      select: () => {
        throw new Error('lookup failed')
      },
      insert: () => ({
        values: () => Promise.resolve(),
      }),
      update: () => {
        throw new Error(
          'unexpected database update',
        )
      },
    } as unknown as Parameters<
      typeof syncAllegroInventoryRows
    >[0]
    const result = await syncAllegroInventoryRows(
      failing,
      [activatingRow()],
      silentAdapter,
    )

    assert.equal(result.summary.pending, 1)
  })
})

void describe('catalog sync stale-run reaper', () => {
  function stubDatabase() {
    const updates: Array<{
      set: unknown
      where: unknown
    }> = []
    const database = {
      update: () => ({
        set: (values: unknown) => ({
          where: (condition: unknown) => {
            updates.push({
              set: values,
              where: condition,
            })

            return Promise.resolve()
          },
        }),
      }),
    }

    return { updates, database }
  }

  void it('marks a stale RUNNING run INTERRUPTED', async () => {
    const stub = stubDatabase()

    await reapStaleCatalogSyncRuns(
      stub.database as never,
      'run-current',
      new Date('2026-09-20T10:00:00.000Z'),
    )

    assert.equal(stub.updates.length, 1)
    const set = stub.updates[0]?.set as Record<
      string,
      unknown
    >
    assert.equal(set['status'], 'INTERRUPTED')
    assert.equal(
      typeof set['error'],
      'string',
    )
    assert.ok(set['finishedAt'] instanceof Date)
  })

  void it('never throws when the reap fails', async () => {
    const failing = {
      update: () => {
        throw new Error('db down')
      },
    }

    await reapStaleCatalogSyncRuns(
      failing as never,
      'run-current',
      new Date(),
    )
  })

  void it('keeps the guard clauses intact in source', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        'src',
        'data-connections.ts',
      ),
      'utf8',
    )
    assert.ok(
      source.includes(
        'export async function reapStaleCatalogSyncRuns',
      ),
    )

    // Current run excluded, only older RUNNING rows are
    // ever marked INTERRUPTED (identifiers below are
    // unique to the reaper; whitespace normalized since
    // calls may wrap lines).
    const flat = source
      .replace(/\s+/g, ' ')
      .replace(/\( /g, '(')
    assert.ok(
      flat.includes('ne(catalogSyncRuns.id,'),
    )
    assert.ok(
      flat.includes(
        'lt(catalogSyncRuns.startedAt,',
      ),
    )
    assert.ok(
      flat.includes(
        "eq(catalogSyncRuns.status, 'RUNNING')",
      ),
    )
    assert.ok(
      flat.includes("status: 'INTERRUPTED'"),
    )
  })
})
