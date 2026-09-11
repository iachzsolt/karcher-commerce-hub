import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateListingStories,
  attachRelatedDayEvents,
  summarizeRefreshRun,
  summarizeStories,
  type StoryEventInput,
} from '../src/utils/inventoryRefreshStories.ts'

function syncEvent(
  overrides: Partial<StoryEventInput> & {
    listingId: string
  },
): StoryEventInput {
  return {
    id: `${overrides.listingId}-${overrides.action ?? 'NONE'}`,
    offerId: 'offer-1',
    sku: '1.000-000.0',
    listingName: 'Teszt ajánlat',
    action: 'NONE',
    status: 'NO_CHANGE',
    occurredAt: '2026-09-10T10:00:00.000Z',
    metadata: null,
    ...overrides,
  }
}

function stockMetadata(
  fromStock: number | null,
  toStock: number | null,
) {
  return {
    historyGroupId: 'group-1',
    publicationStatus: null,
    targetStock: toStock,
    remoteStock: fromStock,
    fromStock,
    toStock,
  }
}

void describe(
  'aggregateListingStory',
  () => {
    void it(
      'collapses STOCK_UPDATE only into one business row',
      () => {
        const [story] = aggregateListingStories([
          syncEvent({
            listingId: 'listing-1',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            metadata: stockMetadata(4, 9),
          }),
        ])

        assert.equal(story?.businessResult, 'STOCK_UPDATED')
        assert.equal(story?.stockFrom, 4)
        assert.equal(story?.stockTo, 9)
        assert.equal(story?.status, 'success')
        assert.equal(story?.eventCount, 1)
      },
    )

    void it(
      'merges STOCK_UPDATE and ACTIVATE into one activated row',
      () => {
        const [story] = aggregateListingStories([
          syncEvent({
            id: 'listing-2-stock',
            listingId: 'listing-2',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            occurredAt:
              '2026-09-10T10:00:00.000Z',
            metadata: stockMetadata(0, 12),
          }),
          syncEvent({
            id: 'listing-2-activate',
            listingId: 'listing-2',
            action: 'ACTIVATE',
            status: 'SUCCESS',
            occurredAt:
              '2026-09-10T10:01:00.000Z',
            metadata: stockMetadata(null, null),
          }),
        ])

        assert.equal(story?.businessResult, 'ACTIVATED')
        assert.equal(
          story?.resultLabel,
          'Automatikusan aktiválva',
        )
        assert.equal(story?.stockFrom, 0)
        assert.equal(story?.stockTo, 12)
        assert.equal(story?.eventCount, 2)
      },
    )

    void it(
      'merges stock to zero and END into one auto-paused row',
      () => {
        const [story] = aggregateListingStories([
          syncEvent({
            listingId: 'listing-3',
            action: 'END',
            status: 'SUCCESS',
            metadata: stockMetadata(7, 0),
          }),
        ])

        assert.equal(
          story?.businessResult,
          'AUTO_PAUSED',
        )
        assert.equal(
          story?.resultLabel,
          'Automatikusan lekapcsolva',
        )
        assert.equal(story?.stockFrom, 7)
        assert.equal(story?.stockTo, 0)
      },
    )

    void it(
      'keeps MANUAL_INACTIVE as one skipped row',
      () => {
        const [story] = aggregateListingStories([
          syncEvent({
            listingId: 'listing-4',
            action: 'SKIP',
            status: 'MANUAL_INACTIVE',
            metadata: stockMetadata(0, 8),
          }),
        ])

        assert.equal(
          story?.businessResult,
          'MANUAL_SKIPPED',
        )
        assert.equal(story?.status, 'skipped')
      },
    )

    void it(
      'marks failed actions as one failed row',
      () => {
        const [story] = aggregateListingStories([
          syncEvent({
            id: 'listing-5-stock',
            listingId: 'listing-5',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            occurredAt:
              '2026-09-10T10:00:00.000Z',
            metadata: stockMetadata(3, 9),
          }),
          syncEvent({
            id: 'listing-5-activate',
            listingId: 'listing-5',
            action: 'ACTIVATE',
            status: 'FAILED',
            occurredAt:
              '2026-09-10T10:01:00.000Z',
            metadata: stockMetadata(null, null),
          }),
        ])

        assert.equal(
          story?.businessResult,
          'FAILED',
        )
        assert.equal(story?.status, 'failed')
        assert.equal(story?.eventCount, 2)
      },
    )

    void it(
      'never splits one listing into multiple rows',
      () => {
        const stories = aggregateListingStories([
          syncEvent({
            id: 'listing-6-a',
            listingId: 'listing-6',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            metadata: stockMetadata(1, 5),
          }),
          syncEvent({
            id: 'listing-6-b',
            listingId: 'listing-6',
            action: 'STOCK_UPDATE_AND_ACTIVATE',
            status: 'SUCCESS',
            metadata: stockMetadata(1, 5),
          }),
          syncEvent({
            id: 'listing-6-c',
            listingId: 'listing-6',
            action: 'REACTIVATION_CONFIRMED',
            status: 'SUCCESS',
            metadata: stockMetadata(null, null),
          }),
        ])

        assert.equal(stories.length, 1)
        assert.equal(
          stories[0]?.businessResult,
          'ACTIVATED',
        )
      },
    )

    void it(
      'keeps different listings separate',
      () => {
        const stories = aggregateListingStories([
          syncEvent({
            listingId: 'listing-7',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            metadata: stockMetadata(2, 6),
          }),
          syncEvent({
            listingId: 'listing-8',
            action: 'END',
            status: 'SUCCESS',
            metadata: stockMetadata(4, 0),
          }),
        ])

        assert.equal(stories.length, 2)
        assert.deepEqual(
          stories.map((story) => story.listingId),
          ['listing-7', 'listing-8'],
        )
      },
    )

    void it(
      'matches summary counters to aggregated results',
      () => {
        const stories = aggregateListingStories([
          syncEvent({
            listingId: 'listing-9',
            action: 'STOCK_UPDATE',
            status: 'SUCCESS',
            metadata: stockMetadata(2, 6),
          }),
          syncEvent({
            listingId: 'listing-10',
            action: 'END',
            status: 'SUCCESS',
            metadata: stockMetadata(4, 0),
          }),
          syncEvent({
            listingId: 'listing-11',
            action: 'SKIP',
            status: 'MANUAL_INACTIVE',
            metadata: stockMetadata(0, 8),
          }),
          syncEvent({
            listingId: 'listing-12',
            action: 'STOCK_UPDATE',
            status: 'FAILED',
            metadata: stockMetadata(1, 9),
          }),
          syncEvent({
            listingId: 'listing-13',
            action: 'NONE',
            status: 'NO_CHANGE',
            metadata: stockMetadata(null, null),
          }),
        ])
        const summary = summarizeStories(stories)

        assert.deepEqual(summary, {
          total: 5,
          affected: 4,
          stockChanged: 2,
          activated: 0,
          autoPaused: 1,
          skipped: 1,
          failed: 1,
          pending: 0,
          noAction: 1,
        })
      },
    )

    void it(
      'treats source success with Allegro failure as partial',
      () => {
        assert.deepEqual(
          summarizeRefreshRun({
            status: 'FAILED',
            importStatus: 'SUCCESS',
          }),
          {
            overall: 'partial',
            helper:
              'A készletforrás frissítése sikerült, de az Allegro szinkron során hiba történt.',
          },
        )
        assert.deepEqual(
          summarizeRefreshRun({
            status: 'COMPLETED',
            importStatus: 'SUCCESS',
          }),
          { overall: 'success', helper: null },
        )
        assert.deepEqual(
          summarizeRefreshRun({
            status: 'FAILED',
            importStatus: null,
          }),
          { overall: 'failed', helper: null },
        )
      },
    )
  },
)

void describe(
  'attachRelatedDayEvents',
  () => {
    const groups = [
      {
        groupId: 'group-new',
        occurredAt: '2026-09-10T12:00:00.000Z',
        listingIds: ['listing-1', 'listing-2'],
      },
      {
        groupId: 'group-old',
        occurredAt: '2026-09-10T09:00:00.000Z',
        listingIds: ['listing-2', 'listing-3'],
      },
    ]

    function dayEvent(
      id: string,
      listingId: string,
      eventType = 'STOCK',
      source = 'ALLEGRO_SYNC',
    ) {
      return {
        id,
        listingId,
        occurredAt: '2026-09-10T10:00:00.000Z',
        eventType,
        source,
      }
    }

    void it(
      'attaches overlapping listings to the newest owning group',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, [
            dayEvent('event-1', 'listing-1'),
            dayEvent('event-2', 'listing-2'),
          ])

        assert.deepEqual(
          attachments
            .get('group-new')
            ?.map((event) => event.id),
          ['event-1', 'event-2'],
        )
        assert.deepEqual(
          attachments.get('group-old'),
          undefined,
        )
        assert.deepEqual(leftover, [])
      },
    )

    void it(
      'keeps non-overlapping events as leftover',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, [
            dayEvent('event-1', 'listing-1'),
            dayEvent('event-9', 'listing-9'),
          ])

        assert.deepEqual(
          attachments
            .get('group-new')
            ?.map((event) => event.id),
          ['event-1'],
        )
        assert.deepEqual(
          leftover.map((event) => event.id),
          ['event-9'],
        )
      },
    )

    void it(
      'leaves everything leftover without groups',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents([], [
            dayEvent('event-1', 'listing-1'),
          ])

        assert.equal(attachments.size, 0)
        assert.deepEqual(
          leftover.map((event) => event.id),
          ['event-1'],
        )
      },
    )

    void it(
      'attaches STATUS same listing',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, [
            dayEvent(
              'event-1',
              'listing-1',
              'STATUS',
              'ALLEGRO_SYNC',
            ),
          ])

        assert.deepEqual(
          attachments
            .get('group-new')
            ?.map((event) => event.id),
          ['event-1'],
        )
        assert.deepEqual(leftover, [])
      },
    )

    void it(
      'does not attach PRICE same listing',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, [
            dayEvent(
              'event-1',
              'listing-1',
              'PRICE',
              'ALLEGRO_SYNC',
            ),
          ])

        assert.equal(attachments.size, 0)
        assert.deepEqual(
          leftover.map((event) => event.id),
          ['event-1'],
        )
      },
    )

    void it(
      'does not attach manual or campaign events on overlap',
      () => {
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, [
            dayEvent(
              'event-1',
              'listing-1',
              'STOCK',
              'MANUAL',
            ),
            dayEvent(
              'event-2',
              'listing-1',
              'CAMPAIGN',
              'ALLEGRO_CAMPAIGN',
            ),
            dayEvent(
              'event-3',
              'listing-2',
              'STATUS',
              'ALLEGRO_CAMPAIGN_SYNC',
            ),
          ])

        assert.equal(attachments.size, 0)
        assert.deepEqual(
          leftover.map((event) => event.id),
          ['event-1', 'event-2', 'event-3'],
        )
      },
    )

    void it(
      'never attaches one event twice',
      () => {
        const events = [
          dayEvent('event-1', 'listing-1'),
          dayEvent('event-2', 'listing-2'),
          dayEvent('event-3', 'listing-9'),
        ]
        const { attachments, leftover } =
          attachRelatedDayEvents(groups, events)
        const attached = [...attachments.values()].flat()

        assert.equal(
          attached.length + leftover.length,
          events.length,
        )
        assert.equal(
          new Set(
            [...attached, ...leftover].map(
              (event) => event.id,
            ),
          ).size,
          events.length,
        )
      },
    )
  },
)
