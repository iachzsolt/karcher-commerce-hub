import {
  describe,
  it,
} from 'node:test'
import assert from 'node:assert/strict'
import {
  FEED_ACCESS_RECENT_DAYS_LIMIT,
  FEED_ACCESS_USER_AGENT_MAX_LENGTH,
  isLikelyArukeresoRequest,
  recordFeedAccessServe,
  resolveFeedAccessDay,
  toFeedAccessStatusView,
  truncateFeedAccessUserAgent,
} from '../src/arukereso.ts'

void describe(
  'feed access tracking helpers',
  () => {
    void it(
      'uses one UTC day key per calendar day',
      () => {
        assert.equal(
          resolveFeedAccessDay(
            new Date('2026-09-11T00:00:00.000Z'),
          ),
          '2026-09-11',
        )
        assert.equal(
          resolveFeedAccessDay(
            new Date('2026-09-11T23:59:59.999Z'),
          ),
          '2026-09-11',
        )
        assert.notEqual(
          resolveFeedAccessDay(
            new Date('2026-09-11T23:59:59.999Z'),
          ),
          resolveFeedAccessDay(
            new Date('2026-09-12T00:00:00.000Z'),
          ),
        )
      },
    )

    void it(
      'truncates user agents and drops empties',
      () => {
        assert.equal(
          truncateFeedAccessUserAgent(null),
          null,
        )
        assert.equal(
          truncateFeedAccessUserAgent('   '),
          null,
        )
        assert.equal(
          truncateFeedAccessUserAgent(
            'Mozilla/5.0 (compatible)',
          ),
          'Mozilla/5.0 (compatible)',
        )

        const long = `x`.repeat(
          FEED_ACCESS_USER_AGENT_MAX_LENGTH +
            40,
        )
        const truncated =
          truncateFeedAccessUserAgent(long)

        assert.equal(
          truncated?.length,
          FEED_ACCESS_USER_AGENT_MAX_LENGTH,
        )
      },
    )

    void it(
      'flags only explicit Árukereső user agents',
      () => {
        assert.equal(
          isLikelyArukeresoRequest(
            'Arukereso-feed-fetcher/1.0',
          ),
          true,
        )
        assert.equal(
          isLikelyArukeresoRequest(
            'ÁRUKERESŐ crawler',
          ),
          true,
        )
        assert.equal(
          isLikelyArukeresoRequest(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          ),
          false,
        )
        assert.equal(
          isLikelyArukeresoRequest(null),
          false,
        )
        assert.equal(
          isLikelyArukeresoRequest(''),
          false,
        )
      },
    )

    void it(
      'shapes today plus bounded recent history',
      () => {
        const rows = Array.from(
          { length: 20 },
          (_, index) => {
            const day = `2026-08-${String(
              index + 1,
            ).padStart(2, '0')}`

            return {
              day,
              requestCount: index + 1,
              lastRequestedAt: new Date(
                `${day}T10:00:00.000Z`,
              ),
              lastServedRunId:
                index % 2 === 0
                  ? 'run-id'
                  : null,
              lastUserAgent:
                'Arukereso-feed-fetcher/1.0',
            }
          },
        )
        const view = toFeedAccessStatusView(
          rows,
          '2026-08-20',
        )

        assert.equal(
          view.today?.day,
          '2026-08-20',
        )
        assert.equal(
          view.today?.requestCount,
          20,
        )
        assert.equal(
          view.today?.likelyArukereso,
          true,
        )
        assert.equal(
          view.recentDays.length,
          FEED_ACCESS_RECENT_DAYS_LIMIT,
        )
        assert.equal(
          view.recentDays[0]?.day,
          '2026-08-20',
        )
      },
    )

    void it(
      'returns empty view without rows',
      () => {
        assert.deepEqual(
          toFeedAccessStatusView(
            [],
            '2026-08-20',
          ),
          { today: null, recentDays: [] },
        )
      },
    )

    void it(
      'increments with a single upsert statement',
      async () => {
        const calls: string[] = []
        const stub: unknown = new Proxy(
          {},
          {
            get(_target, property) {
              if (property === 'then') {
                return undefined
              }

              calls.push(String(property))

              return (..._args: unknown[]) =>
                stub
            },
          },
        )

        await recordFeedAccessServe({
          database: stub as never,
          channelId: 'channel-id',
          runId: 'run-id',
          userAgent: 'Mozilla/5.0',
          now: new Date(
            '2026-09-11T10:00:00.000Z',
          ),
        })

        // Exactly one statement: no read of request_count,
        // no application-side increment, no second write.
        assert.deepEqual(calls, [
          'insert',
          'values',
          'onConflictDoUpdate',
        ])
      },
    )

    void it(
      'never rejects even when the database fails',
      async () => {
        const brokenDatabase = new Proxy(
          {},
          {
            get() {
              throw new Error(
                'database unavailable',
              )
            },
          },
        )

        await assert.doesNotReject(
          recordFeedAccessServe({
            database:
              brokenDatabase as never,
            channelId: 'channel-id',
            runId: 'run-id',
            userAgent: 'Mozilla/5.0',
          }),
        )
      },
    )
  },
)
