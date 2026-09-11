import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  FEED_RUN_ITEMS_RETAINED_RUNS,
  selectPrunableFeedRunIds,
} from '../src/arukereso.ts'

function detailedRun(
  id: string,
  ageMinutes: number,
  channelId = 'channel-a',
  itemCount = 10,
) {
  return {
    id,
    channelId,
    startedAtMs:
      1_700_000_000_000 - ageMinutes * 60_000,
    itemCount,
  }
}

void describe(
  'selectPrunableFeedRunIds',
  () => {
    void it(
      'keeps every run below the retention limit',
      () => {
        const runs = [1, 2, 3, 4].map(
          (age) =>
            detailedRun(`run-${age}`, age),
        )

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          [],
        )
        assert.equal(
          FEED_RUN_ITEMS_RETAINED_RUNS,
          5,
        )
      },
    )

    void it(
      'keeps exactly five detailed runs',
      () => {
        const runs = [1, 2, 3, 4, 5].map(
          (age) =>
            detailedRun(`run-${age}`, age),
        )

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          [],
        )
      },
    )

    void it(
      'prunes only the oldest run beyond the limit',
      () => {
        const runs = [1, 2, 3, 4, 5, 6].map(
          (age) =>
            detailedRun(`run-${age}`, age),
        )

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          ['run-6'],
        )
      },
    )

    void it(
      'ignores empty runs when counting slots',
      () => {
        const runs = [
          ...[1, 2, 3, 4, 5].map((age) =>
            detailedRun(`run-${age}`, age),
          ),
          detailedRun('empty-new', 0, 'channel-a', 0),
          detailedRun(
            'empty-old',
            99,
            'channel-a',
            0,
          ),
        ]

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          [],
        )
      },
    )

    void it(
      'isolates retention per channel',
      () => {
        const runs = [
          ...[1, 2, 3, 4, 5, 6].map((age) =>
            detailedRun(`a-${age}`, age, 'channel-a'),
          ),
          ...[1, 2].map((age) =>
            detailedRun(`b-${age}`, age, 'channel-b'),
          ),
        ]

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          ['a-6'],
        )
      },
    )

    void it(
      'never returns empty runs and leaves input untouched',
      () => {
        const runs = [
          ...[1, 2, 3, 4, 5, 6, 7].map(
            (age) =>
              detailedRun(`run-${age}`, age),
          ),
          detailedRun('empty', 8, 'channel-a', 0),
        ]
        const snapshot = structuredClone(runs)

        assert.deepEqual(
          selectPrunableFeedRunIds(runs),
          ['run-6', 'run-7'],
        )
        assert.deepEqual(runs, snapshot)
      },
    )

    void it(
      'is idempotent across repeated runs',
      () => {
        const runs = [1, 2, 3, 4, 5, 6].map(
          (age) =>
            detailedRun(`run-${age}`, age),
        )
        const first =
          selectPrunableFeedRunIds(runs)
        const remaining = runs.filter(
          (run) => !first.includes(run.id),
        )

        assert.deepEqual(
          selectPrunableFeedRunIds(remaining),
          [],
        )
      },
    )
  },
)
