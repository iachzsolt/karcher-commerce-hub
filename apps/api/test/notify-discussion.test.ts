import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bridgeCanonicalMessage,
  buildDiscussionEmail,
  buildMessageEmail,
  classifyOrderEvent,
  compareChronoPositions,
  createMemoryNotifyKv,
  cursorForPosition,
  getNotifyDiagnostics,
  handleNotifyAck,
  handleNotifyPull,
  hmacSha256Hex,
  isNotifiableIssueMessage,
  isPositionNewerThanCursor,
  newestPosition,
  NOTIFY_KV_KEYS,
  parseIssueChat,
  parseIssueList,
  storeNotifyOAuth,
  type BridgePending,
  type NotifyKv,
  type StoredCursor,
} from '../src/allegro-notify.ts'

/*
 * Discussion channel + chronological cursor tests.
 *
 * No production Allegro calls: every Allegro response is
 * a stubbed fetch. UUID-shaped ids are deliberately
 * ordered against timestamps to prove lexical order
 * never controls chronology.
 */

const NOW_MS = new Date(
  '2026-09-19T08:00:00.000Z',
).getTime()
const TOKEN_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString('base64')
const RELAY_SECRET = 'bridge-test-secret'

function baseEnvironment(
  overrides: Record<string, string | undefined> = {},
) {
  return {
    ALLEGRO_NOTIFY_ENABLED: 'true',
    ALLEGRO_API_URL: 'https://api.test',
    ALLEGRO_AUTH_URL: 'https://auth.test',
    ALLEGRO_TOKEN_URL: 'https://token.test',
    ALLEGRO_CLIENT_ID: 'test-client',
    ALLEGRO_CLIENT_SECRET: 'test-secret',
    ALLEGRO_NOTIFY_REDIRECT_URI:
      'https://hub.test/api/auth/allegro/notify-callback',
    ALLEGRO_USER_AGENT: 'test-agent/1.0',
    ALLEGRO_NOTIFY_RELAY_SECRET: RELAY_SECRET,
    ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    ALLEGRO_NOTIFY_ORDER_EMAIL:
      'orders@example.com',
    ALLEGRO_NOTIFY_MESSAGE_EMAIL:
      'customerservice@example.com',
    ALLEGRO_NOTIFY_CANCELLATION_EMAIL:
      'cancellations@example.com',
    ...overrides,
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

let nonceCounter = 0

async function signedAuth(body: unknown) {
  nonceCounter += 1
  const timestamp = new Date(NOW_MS).toISOString()
  const nonce = `discussion-test-nonce-${nonceCounter}`
  const signature = await hmacSha256Hex(
    RELAY_SECRET,
    bridgeCanonicalMessage(timestamp, nonce, body),
  )

  return { timestamp, nonce, signature, body }
}

async function seedSession(kv: NotifyKv) {
  await storeNotifyOAuth(
    kv,
    {
      accessToken: 'stub-access-token',
      refreshToken: 'stub-refresh-token',
      expiresAt: NOW_MS + 3600_000,
    },
    Buffer.from(TOKEN_KEY, 'base64'),
    NOW_MS,
  )
}

/* Pre-seed every channel cursor so a pull reaches the
 * channel under test instead of stopping at an earlier
 * channel's silent seeding branch. */
async function seedAllCursors(
  kv: NotifyKv,
  overrides: {
    order?: StoredCursor
    message?: StoredCursor
    discussion?: StoredCursor
    ret?: StoredCursor
  } = {},
) {
  const stamp = new Date(NOW_MS).toISOString()
  await kv.set(
    NOTIFY_KV_KEYS.orderCursor,
    overrides.order ?? {
      lastId: 'ev-seed-0',
      updatedAt: stamp,
    },
  )
  await kv.set(
    NOTIFY_KV_KEYS.messageCursor,
    overrides.message ??
      cursorForPosition(
        {
          createdAt: '2026-09-19T06:00:00.000Z',
          id: 'm-seed-0',
        },
        NOW_MS,
      ),
  )
  await kv.set(
    NOTIFY_KV_KEYS.discussionCursor,
    overrides.discussion ??
      cursorForPosition(
        {
          createdAt: '2026-09-19T06:00:00.000Z',
          id: 'chat-seed-0',
        },
        NOW_MS,
      ),
  )
  await kv.set(
    NOTIFY_KV_KEYS.returnCursor,
    overrides.ret ?? {
      lastId: 'ret-seed-0',
      updatedAt: stamp,
    },
  )
}

type StubMessage = {
  id: string
  createdAt: string
  interlocutor: boolean
  orderId?: string
  offerId?: string
}

type StubIssue = {
  id: string
  orderId?: string
  offerId?: string
  status?: string
  chat: Array<{
    id: string
    createdAt: string
    role: string
    login: string
    text?: string
  }>
}

function stubFetch(options: {
  orderEvents?: Array<{
    id: string
    type: string
    orderId: string
  }>
  threads?: Array<{
    id: string
    messages: StubMessage[]
  }>
  issues?: StubIssue[]
  returns?: unknown[]
  issuesStatus?: number
  seenAccept?: Map<string, string>
} = {}) {
  const {
    orderEvents = [],
    threads = [],
    issues = [],
    returns = [],
    issuesStatus = 200,
    seenAccept = new Map<string, string>(),
  } = options

  return async (
    input: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input)
    const headers = new Headers(init?.headers)
    const accept = headers.get('Accept') ?? ''

    if (url.pathname.endsWith('/order/event-stats')) {
      return jsonResponse({
        latestEvent: {
          id: 'ev-stats-latest',
          occurredAt: '2026-09-19T07:59:00.000Z',
        },
      })
    }

    if (url.pathname.endsWith('/order/customer-returns')) {
      seenAccept.set('returns', accept)
      return jsonResponse({ customerReturns: returns })
    }

    if (url.pathname.endsWith('/order/events')) {
      seenAccept.set('orders', accept)
      const from = url.searchParams.get('from')
      const limit = Number(
        url.searchParams.get('limit') ?? '100',
      )
      let start = 0

      if (from) {
        const index = orderEvents.findIndex(
          (event) => event.id === from,
        )
        start = index >= 0 ? index + 1 : 0
      }

      return jsonResponse({
        events: orderEvents
          .slice(start, start + limit)
          .map((event) => ({
            id: event.id,
            type: event.type,
            occurredAt: '2026-09-19T07:00:00.000Z',
            order: { id: event.orderId },
          })),
      })
    }

    if (url.pathname.endsWith('/sale/issues')) {
      seenAccept.set('issues', accept)

      if (issuesStatus !== 200) {
        return jsonResponse(
          { errors: [{ code: 'AccessDenied' }] },
          issuesStatus,
        )
      }

      const offset = Number(
        url.searchParams.get('offset') ?? '0',
      )
      const limit = Number(
        url.searchParams.get('limit') ?? '100',
      )

      return jsonResponse({
        issues: issues
          .slice(offset, offset + limit)
          .map((issue) => ({
            id: issue.id,
            type: 'DISPUTE',
            status: issue.status ?? 'OPEN',
            createdAt: '2026-09-19T06:00:00.000Z',
            order: issue.orderId
              ? { id: issue.orderId }
              : undefined,
            offer: issue.offerId
              ? { id: issue.offerId }
              : undefined,
          })),
      })
    }

    const chatMatch = url.pathname.match(
      /\/sale\/issues\/([^/]+)\/chat$/,
    )

    if (chatMatch) {
      seenAccept.set('chat', accept)
      const issue = issues.find(
        (entry) => entry.id === chatMatch[1],
      )
      const offset = Number(
        url.searchParams.get('offset') ?? '0',
      )
      const limit = Number(
        url.searchParams.get('limit') ?? '100',
      )

      return jsonResponse({
        chat: (issue?.chat ?? [])
          .slice(offset, offset + limit)
          .map((message) => ({
            id: message.id,
            text: message.text,
            createdAt: message.createdAt,
            author: {
              login: message.login,
              role: message.role,
            },
          })),
      })
    }

    if (url.pathname.includes('/messages')) {
      seenAccept.set('threads', accept)
      const threadMatch = url.pathname.match(
        /\/threads\/([^/]+)\/messages$/,
      )
      const thread = threads.find(
        (entry) => entry.id === threadMatch?.[1],
      )
      const offset = Number(
        url.searchParams.get('offset') ?? '0',
      )
      const limit = Number(
        url.searchParams.get('limit') ?? '20',
      )

      return jsonResponse({
        messages: (thread?.messages ?? [])
          .slice(offset, offset + limit)
          .map((message) => ({
            id: message.id,
            createdAt: message.createdAt,
            author: {
              isInterlocutor:
                message.interlocutor,
              login: message.interlocutor
                ? 'buyer42'
                : 'our-shop',
            },
            text: 'Szöveg',
            order: message.orderId
              ? { id: message.orderId }
              : undefined,
            offer: message.offerId
              ? { id: message.offerId }
              : undefined,
          })),
      })
    }

    if (url.pathname.endsWith('/messaging/threads')) {
      seenAccept.set('threads', accept)
      return jsonResponse({
        threads: threads.map((thread) => ({
          id: thread.id,
        })),
      })
    }

    if (url.pathname.includes('/checkout-forms/')) {
      return jsonResponse({
        buyer: { login: 'buyer42' },
      })
    }

    throw new Error(`Unexpected fetch: ${input}`)
  }
}

async function pullEmail(deps: {
  environment?: Record<string, string | undefined>
  kv: NotifyKv
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>
}) {
  const result = await handleNotifyPull(
    await signedAuth({}),
    {
      environment:
        deps.environment ?? baseEnvironment(),
      kv: deps.kv,
      fetchImpl: deps.fetchImpl,
      nowMs: NOW_MS,
    },
  )

  assert.equal(result.httpStatus, 200)

  if (result.httpStatus !== 200) {
    throw new Error('unreachable')
  }

  return result.result
}

async function ackDeliveryId(
  kv: NotifyKv,
  fetchImpl: (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>,
  deliveryId: string,
  environment?: Record<string, string | undefined>,
) {
  const result = await handleNotifyAck(
    await signedAuth({ deliveryId }),
    {
      environment: environment ?? baseEnvironment(),
      kv,
      fetchImpl,
      nowMs: NOW_MS,
    },
  )

  assert.equal(result.httpStatus, 200)

  if (result.httpStatus !== 200) {
    throw new Error('unreachable')
  }

  return result.result
}

void describe('chronological cursor ordering', () => {
  void it('lexical ID order never controls chronology', () => {
    const cursor: StoredCursor = cursorForPosition(
      {
        createdAt: '2026-09-19T07:30:00.000Z',
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
      },
      NOW_MS,
    )
    // Older instant, lexically greater id: not newer.
    assert.equal(
      isPositionNewerThanCursor(
        {
          createdAt: '2026-09-19T07:00:00.000Z',
          id: 'ffffffff-0000-4000-8000-000000000002',
        },
        cursor,
      ),
      false,
    )
    // Newer instant, lexically smaller id: newer.
    assert.equal(
      isPositionNewerThanCursor(
        {
          createdAt: '2026-09-19T07:45:00.000Z',
          id: '00000000-0000-4000-8000-000000000003',
        },
        cursor,
      ),
      true,
    )
    // Same id as the head: never newer, even now.
    assert.equal(
      isPositionNewerThanCursor(
        {
          createdAt: '2026-09-19T09:00:00.000Z',
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
        cursor,
      ),
      false,
    )
  })

  void it('equal timestamps deliver each sibling exactly once', () => {
    const cursor: StoredCursor = cursorForPosition(
      {
        createdAt: '2026-09-19T07:30:00.000Z',
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
      },
      NOW_MS,
    )
    // Same-instant sibling: newer (dedupe markers, not
    // this comparison, prevent resends).
    assert.equal(
      isPositionNewerThanCursor(
        {
          createdAt: '2026-09-19T07:30:00.000Z',
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
        },
        cursor,
      ),
      true,
    )
    assert.deepEqual(
      compareChronoPositions(
        {
          createdAt: '2026-09-19T07:30:00.000Z',
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
        {
          createdAt: '2026-09-19T07:30:00.000Z',
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
        },
      ) < 0,
      true,
    )
    assert.equal(
      newestPosition([
        {
          createdAt: '2026-09-19T07:30:00.000Z',
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
        },
        {
          createdAt: '2026-09-19T07:30:00.000Z',
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
        },
      ])?.id,
      'bbbbbbbb-0000-4000-8000-000000000002',
    )
  })

  void it('old v1 cursor upgrades without flooding history', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    // Pre-upgrade cursor: last write 07:00, old head id.
    await seedAllCursors(kv, {
      message: {
        lastId: 'ffffffff-0000-4000-8000-000000000009',
        updatedAt: '2026-09-19T07:00:00.000Z',
      } satisfies StoredCursor,
    })
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              // Older than the cursor write: skipped,
              // despite sorting lexically greater.
              id: 'ffffffff-0000-4000-8000-000000000010',
              createdAt: '2026-09-19T06:00:00.000Z',
              interlocutor: true,
            },
            {
              // Newer instant, lexically smaller id:
              // delivered.
              id: '00000000-0000-4000-8000-000000000011',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
              orderId: 'ord-1',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'EMAIL')
    assert.match(
      result.action === 'EMAIL'
        ? result.email.subject
        : '',
      /ord-1/,
    )
    const acked = await ackDeliveryId(
      kv,
      fetchImpl,
      result.action === 'EMAIL'
        ? result.deliveryId
        : '',
    )
    assert.equal(acked.action, 'ACKED')
    const cursor =
      await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.messageCursor,
      )
    assert.equal(cursor?.v, 2)
    assert.equal(
      cursor?.lastCreatedAt,
      '2026-09-19T07:30:00.000Z',
    )
    // Old message stays skipped after the upgrade.
    const again = await pullEmail({ kv, fetchImpl })
    assert.equal(again.action, 'NOOP')
  })

  void it('historical messages seed silently with v2 state', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-seed-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    } satisfies StoredCursor)
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: 'bbbbbbbb-0000-4000-8000-000000000001',
              createdAt: '2026-09-19T06:00:00.000Z',
              interlocutor: true,
            },
            {
              id: 'aaaaaaaa-0000-4000-8000-000000000002',
              createdAt: '2026-09-19T07:00:00.000Z',
              interlocutor: true,
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'SEEDED')

    if (result.action !== 'SEEDED') {
      throw new Error('unreachable')
    }

    assert.equal(result.channel, 'MESSAGE')
    const cursor =
      await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.messageCursor,
      )
    // Newest by instant, not by lexical id.
    assert.equal(
      cursor?.lastId,
      'aaaaaaaa-0000-4000-8000-000000000002',
    )
    assert.equal(cursor?.v, 2)
  })
})

void describe('message channel chronology', () => {
  function messageCursor(
    createdAt: string,
    id: string,
  ): StoredCursor {
    return cursorForPosition(
      { createdAt, id },
      NOW_MS,
    )
  }

  void it('new buyer message with smaller id still emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      message: messageCursor(
        '2026-09-19T07:00:00.000Z',
        'zzzzzzzz-0000-4000-8000-000000000009',
      ),
    })
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
              orderId: 'ord-9',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'EMAIL')

    if (result.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(
      result.email.subject,
      '[ALLEGRO] ÜZENET – ord-9',
    )
  })

  void it('seller message never emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      message: messageCursor(
        '2026-09-19T07:00:00.000Z',
        'aaaaaaaa-0000-4000-8000-000000000001',
      ),
    })
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: 'bbbbbbbb-0000-4000-8000-000000000002',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: false,
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'NOOP')
  })

  void it('missing order and offer ids still send MESSAGE', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      message: messageCursor(
        '2026-09-19T07:00:00.000Z',
        'aaaaaaaa-0000-4000-8000-000000000001',
      ),
    })
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: 'bbbbbbbb-0000-4000-8000-000000000002',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'EMAIL')

    if (result.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(
      result.email.subject,
      '[ALLEGRO] ÜZENET',
    )
  })

  void it('equal-instant siblings each deliver once', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      message: messageCursor(
        '2026-09-19T07:00:00.000Z',
        'aaaaaaaa-0000-4000-8000-000000000001',
      ),
    })
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: 'bbbbbbbb-0000-4000-8000-000000000002',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
              orderId: 'ord-a',
            },
            {
              id: 'cccccccc-0000-4000-8000-000000000003',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
              orderId: 'ord-b',
            },
          ],
        },
      ],
    })
    const first = await pullEmail({ kv, fetchImpl })
    assert.equal(first.action, 'EMAIL')

    if (first.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    await ackDeliveryId(
      kv,
      fetchImpl,
      first.deliveryId,
    )
    const second = await pullEmail({ kv, fetchImpl })
    assert.equal(second.action, 'EMAIL')

    if (second.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.notEqual(
      second.deliveryId,
      first.deliveryId,
    )
    await ackDeliveryId(
      kv,
      fetchImpl,
      second.deliveryId,
    )
    const third = await pullEmail({ kv, fetchImpl })
    assert.equal(third.action, 'NOOP')
  })
})

void describe('discussion channel', () => {
  function discussionCursor(
    createdAt: string,
    id: string,
  ): StoredCursor {
    return cursorForPosition(
      { createdAt, id },
      NOW_MS,
    )
  }

  void it('issue bootstrap seeds silently', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv)
    await kv.delete(NOTIFY_KV_KEYS.discussionCursor)
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-1',
          orderId: 'ord-7',
          chat: [
            {
              id: 'chat-old-1',
              createdAt: '2026-09-19T06:00:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Régi panasz',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'SEEDED')

    if (result.action !== 'SEEDED') {
      throw new Error('unreachable')
    }

    assert.equal(result.channel, 'DISCUSSION')
    const cursor =
      await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.discussionCursor,
      )
    assert.equal(cursor?.lastId, 'chat-old-1')
    assert.equal(cursor?.v, 2)
  })

  void it('new buyer issue sends a DISCUSSION email', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-9',
          orderId: 'ord-9',
          offerId: 'offer-9',
          status: 'OPEN',
          chat: [
            {
              id: 'chat-new-9',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'buyer',
              login: 'buyer42',
              text: 'Nem érkezett meg.',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'EMAIL')

    if (result.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(
      result.email.subject,
      '[ALLEGRO] VITA – ord-9',
    )
    assert.match(result.email.textBody, /Új vita/)
    assert.match(result.email.textBody, /issue-9/)
  })

  void it('buyer chat message sends a DISCUSSION email', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T07:00:00.000Z',
        'chat-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-2',
          chat: [
            {
              id: 'chat-1',
              createdAt: '2026-09-19T06:00:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Első.',
            },
            {
              id: 'chat-2',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Második.',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'EMAIL')

    if (result.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(
      result.email.subject,
      '[ALLEGRO] VITA – issue-2',
    )
    assert.match(result.email.textBody, /Új vevői üzenet/)
  })

  void it('seller chat message never emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-3',
          chat: [
            {
              id: 'chat-seller-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'SELLER',
              login: 'our-shop',
              text: 'Válasz.',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'NOOP')
  })

  void it('admin and system chat never email', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-4',
          chat: [
            {
              id: 'chat-admin-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'ADMIN',
              login: 'allegro',
              text: 'Rendszerüzenet.',
            },
            {
              id: 'chat-sys-1',
              createdAt: '2026-09-19T07:31:00.000Z',
              role: 'SYSTEM',
              login: 'system',
              text: 'Státusz változott.',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'NOOP')
  })

  void it('status-only change without buyer text never emails', async () => {
    assert.equal(
      isNotifiableIssueMessage({
        id: 'chat-status-1',
        issueId: 'issue-5',
        createdAt: '2026-09-19T07:30:00.000Z',
        authorRole: 'BUYER',
        authorLogin: 'buyer42',
        text: null,
        attachmentNames: [],
      }),
      false,
    )
    assert.equal(
      isNotifiableIssueMessage({
        id: 'chat-attachment-1',
        issueId: 'issue-5',
        createdAt: '2026-09-19T07:30:00.000Z',
        authorRole: 'BUYER',
        authorLogin: 'buyer42',
        text: null,
        attachmentNames: ['szamla.jpg'],
      }),
      true,
    )
    const parsed = parseIssueChat('issue-5', {
      chat: [
        {
          id: 'chat-nontext-1',
          createdAt: '2026-09-19T07:30:00.000Z',
          author: { login: 'buyer42', role: 'BUYER' },
        },
      ],
    })
    assert.equal(parsed.length, 1)
    assert.equal(
      isNotifiableIssueMessage(parsed[0]!),
      false,
    )
  })

  void it('repeated issue messages are deduped', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-6',
          chat: [
            {
              id: 'chat-dup-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Kérem a refundot.',
            },
          ],
        },
      ],
    })
    const first = await pullEmail({ kv, fetchImpl })
    assert.equal(first.action, 'EMAIL')

    if (first.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    // Same pull again without ACK: identical payload.
    const retry = await pullEmail({ kv, fetchImpl })
    assert.equal(retry.action, 'EMAIL')

    if (retry.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(
      retry.deliveryId,
      first.deliveryId,
    )
    await ackDeliveryId(
      kv,
      fetchImpl,
      first.deliveryId,
    )
    const after = await pullEmail({ kv, fetchImpl })
    assert.equal(after.action, 'NOOP')
    const cursor =
      await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.discussionCursor,
      )
    assert.equal(cursor?.lastId, 'chat-dup-1')
    assert.equal(cursor?.v, 2)
    assert.equal(
      cursor?.lastCreatedAt,
      '2026-09-19T07:30:00.000Z',
    )
  })

  void it('three buyer messages become three separate emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-7',
          chat: [
            {
              id: 'chat-m1',
              createdAt: '2026-09-19T07:10:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Egy.',
            },
            {
              id: 'chat-m2',
              createdAt: '2026-09-19T07:20:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Kettő.',
            },
            {
              id: 'chat-m3',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Három.',
            },
          ],
        },
      ],
    })
    const seen: string[] = []

    for (let round = 0; round < 3; round += 1) {
      const pulled = await pullEmail({ kv, fetchImpl })
      assert.equal(pulled.action, 'EMAIL')

      if (pulled.action !== 'EMAIL') {
        throw new Error('unreachable')
      }

      seen.push(pulled.deliveryId)
      await ackDeliveryId(
        kv,
        fetchImpl,
        pulled.deliveryId,
      )
    }

    assert.equal(new Set(seen).size, 3)
    const done = await pullEmail({ kv, fetchImpl })
    assert.equal(done.action, 'NOOP')
  })

  void it('pending claim prevents duplicate delivery', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-8',
          chat: [
            {
              id: 'chat-p1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Függő.',
            },
          ],
        },
      ],
    })
    const first = await pullEmail({ kv, fetchImpl })
    assert.equal(first.action, 'EMAIL')

    if (first.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    // No ACK: the same claim is re-offered, never a
    // second delivery.
    const second = await pullEmail({ kv, fetchImpl })
    assert.equal(second.action, 'EMAIL')

    if (second.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.equal(second.deliveryId, first.deliveryId)
    const pending =
      await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)
    assert.equal(pending?.channel, 'discussion')
    assert.equal(pending?.eventId, 'chat-p1')
  })

  void it('ACK advances the discussion cursor', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-9',
          chat: [
            {
              id: 'chat-ack-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Nyugtázandó.',
            },
          ],
        },
      ],
    })
    const pulled = await pullEmail({ kv, fetchImpl })
    assert.equal(pulled.action, 'EMAIL')

    if (pulled.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    const acked = await ackDeliveryId(
      kv,
      fetchImpl,
      pulled.deliveryId,
    )
    assert.equal(acked.action, 'ACKED')

    if (acked.action !== 'ACKED') {
      throw new Error('unreachable')
    }

    assert.equal(acked.duplicate, false)
  })

  void it('no buyer PII is written to KV', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      discussion: discussionCursor(
        '2026-09-19T06:00:00.000Z',
        'chat-old-1',
      ),
    })
    const secretText = 'TitkosPanaszSzöveg123'
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-10',
          chat: [
            {
              id: 'chat-pii-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: secretText,
            },
          ],
        },
      ],
    })
    const pulled = await pullEmail({ kv, fetchImpl })
    assert.equal(pulled.action, 'EMAIL')

    if (pulled.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    // Email payload itself carries the text for
    // forwarding; technical KV state must not.
    assert.match(
      pulled.email.textBody,
      new RegExp(secretText),
    )
    const pending =
      await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)
    const cursor =
      await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.discussionCursor,
      )
    const serialized = JSON.stringify({
      pending,
      cursor,
    })
    assert.ok(!serialized.includes(secretText))
    assert.ok(!serialized.includes('buyer42'))
    await ackDeliveryId(
      kv,
      fetchImpl,
      pulled.deliveryId,
    )
    const marker = await kv.get(
      NOTIFY_KV_KEYS.sentDiscussion('chat-pii-1'),
    )
    const serializedAfter = JSON.stringify({
      marker,
      cursor: await kv.get<StoredCursor>(
        NOTIFY_KV_KEYS.discussionCursor,
      ),
    })
    assert.ok(!serializedAfter.includes(secretText))
    assert.ok(!serializedAfter.includes('buyer42'))
  })

  void it('issue channel answers DISABLED while the flag is off', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const fetchImpl = stubFetch({
      issues: [
        {
          id: 'issue-11',
          chat: [
            {
              id: 'chat-off-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Kikapcsolt.',
            },
          ],
        },
      ],
    })
    const result = await pullEmail({
      environment: baseEnvironment({
        ALLEGRO_NOTIFY_ENABLED: 'false',
      }),
      kv,
      fetchImpl,
    })
    assert.equal(result.action, 'DISABLED')
  })

  void it('missing issue scope degrades to NOOP without crashing', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv)
    await kv.delete(NOTIFY_KV_KEYS.discussionCursor)
    const fetchImpl = stubFetch({ issuesStatus: 403 })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'NOOP')
    const diagnostics = await getNotifyDiagnostics({
      environment: baseEnvironment(),
      kv,
      fetchImpl,
      nowMs: NOW_MS,
    })
    assert.equal(diagnostics.ok, true)

    if (!diagnostics.ok) {
      throw new Error('unreachable')
    }

    assert.equal(
      diagnostics.diagnostics.issueScopeRequested,
      true,
    )
    assert.equal(
      diagnostics.diagnostics.channels.discussion
        .cursorPresent,
      false,
    )
  })
})

void describe('media types and journal ordering', () => {
  void it('threads stay public.v1 while issues use beta.v1', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      message: cursorForPosition(
        {
          createdAt: '2026-09-19T07:00:00.000Z',
          id: 'm-cursor-1',
        },
        NOW_MS,
      ),
      discussion: cursorForPosition(
        {
          createdAt: '2026-09-19T06:00:00.000Z',
          id: 'chat-old-1',
        },
        NOW_MS,
      ),
    })
    const seenAccept = new Map<string, string>()
    const fetchImpl = stubFetch({
      threads: [
        {
          id: 'th-1',
          messages: [
            {
              id: 'm-new-1',
              createdAt: '2026-09-19T07:30:00.000Z',
              interlocutor: true,
              orderId: 'ord-1',
            },
          ],
        },
      ],
      issues: [
        {
          id: 'issue-1',
          chat: [
            {
              id: 'chat-new-1',
              createdAt: '2026-09-19T07:31:00.000Z',
              role: 'BUYER',
              login: 'buyer42',
              text: 'Vita.',
            },
          ],
        },
      ],
      seenAccept,
    })
    const first = await pullEmail({ kv, fetchImpl })
    // Message channel wins by priority on the first
    // pull; the discussion EMAIL follows after its ACK.
    assert.equal(first.action, 'EMAIL')

    if (first.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    await ackDeliveryId(kv, fetchImpl, first.deliveryId)
    const second = await pullEmail({ kv, fetchImpl })
    assert.equal(second.action, 'EMAIL')

    if (second.action !== 'EMAIL') {
      throw new Error('unreachable')
    }

    assert.match(
      second.deliveryId,
      /^discussion:/,
    )
    assert.equal(
      seenAccept.get('threads'),
      'application/vnd.allegro.public.v1+json',
    )
    assert.equal(
      seenAccept.get('issues'),
      'application/vnd.allegro.beta.v1+json',
    )
    assert.equal(
      seenAccept.get('chat'),
      'application/vnd.allegro.beta.v1+json',
    )
  })

  void it('order journal order wins over UUID lexical order', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'cursor-ev',
      updatedAt: new Date(NOW_MS).toISOString(),
    } satisfies StoredCursor)
    // Journal order is aa -> mm -> zz (lexically
    // scrambled); delivery must follow the journal.
    const fetchImpl = stubFetch({
      orderEvents: [
        { id: 'zz-last', type: 'READY_FOR_PROCESSING', orderId: 'ord-zz' },
        { id: 'aa-first', type: 'READY_FOR_PROCESSING', orderId: 'ord-aa' },
        { id: 'mm-middle', type: 'READY_FOR_PROCESSING', orderId: 'ord-mm' },
      ],
    })
    const seen: string[] = []

    for (let round = 0; round < 3; round += 1) {
      const pulled = await pullEmail({ kv, fetchImpl })
      assert.equal(pulled.action, 'EMAIL')

      if (pulled.action !== 'EMAIL') {
        throw new Error('unreachable')
      }

      seen.push(pulled.deliveryId)
      await ackDeliveryId(
        kv,
        fetchImpl,
        pulled.deliveryId,
      )
    }

    assert.deepEqual(seen, [
      'order:zz-last',
      'order:aa-first',
      'order:mm-middle',
    ])
    assert.equal(
      classifyOrderEvent('FULFILLMENT_STATUS_CHANGED'),
      null,
    )
    assert.equal(classifyOrderEvent('BOUGHT'), null)
  })

  void it('unknown order events stay intentionally ignored', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedAllCursors(kv, {
      order: {
        lastId: 'cursor-ev',
        updatedAt: new Date(NOW_MS).toISOString(),
      } satisfies StoredCursor,
    })
    const fetchImpl = stubFetch({
      orderEvents: [
        {
          id: 'ev-unknown-1',
          type: 'FULFILLMENT_STATUS_CHANGED',
          orderId: 'ord-x',
        },
      ],
    })
    const result = await pullEmail({ kv, fetchImpl })
    assert.equal(result.action, 'NOOP')
  })
})

void describe('discussion email template', () => {
  void it('keeps the Karcher VITA style without PII leaks', () => {
    const email = buildDiscussionEmail(
      'info.hu@karcher.com',
      {
        id: 'issue-t1',
        kind: 'DISPUTE',
        status: 'OPEN',
        createdAt: '2026-09-19T06:00:00.000Z',
        orderId: 'ord-t1',
        offerId: 'offer-t1',
        subject: null,
      },
      {
        id: 'chat-t1',
        issueId: 'issue-t1',
        createdAt: '2026-09-19T07:30:00.000Z',
        authorRole: 'BUYER',
        authorLogin: 'buyer42',
        text: 'Hol a csomagom?',
        attachmentNames: [],
      },
      true,
    )
    assert.equal(
      email.subject,
      '[ALLEGRO] VITA – ord-t1',
    )
    assert.equal(email.to, 'info.hu@karcher.com')
    assert.match(email.textBody, /Új vita/)
    assert.match(email.textBody, /issue-t1/)
    assert.match(email.htmlBody, /Hol a csomagom\?/)
  })

  void it('falls back to the issue id without an order', () => {
    const email = buildDiscussionEmail(
      'info.hu@karcher.com',
      {
        id: 'issue-t2',
        kind: 'CLAIM',
        status: 'OPEN',
        createdAt: null,
        orderId: null,
        offerId: null,
        subject: null,
      },
      {
        id: 'chat-t2',
        issueId: 'issue-t2',
        createdAt: null,
        authorRole: 'BUYER',
        authorLogin: null,
        text: null,
        attachmentNames: [],
      },
      false,
    )
    assert.equal(
      email.subject,
      '[ALLEGRO] VITA – issue-t2',
    )
    assert.match(email.textBody, /Új vevői üzenet/)
  })

  void it('existing MESSAGE template is unchanged', () => {
    const email = buildMessageEmail(
      'customerservice@example.com',
      {
        id: 'm-1',
        threadId: 'th-1',
        createdAt: '2026-09-19T07:30:00.000Z',
        authorIsInterlocutor: true,
        authorLogin: 'buyer42',
        text: 'Kérdés',
        attachmentNames: [],
        orderId: 'ord-1',
        offerId: null,
      },
      null,
    )
    assert.equal(
      email.subject,
      '[ALLEGRO] ÜZENET – ord-1',
    )
  })

  void it('issue list and chat parse defensively', () => {
    assert.deepEqual(parseIssueList({}), [])
    assert.deepEqual(parseIssueList({ issues: 'nope' }), [])
    assert.deepEqual(
      parseIssueChat('issue-x', {}),
      [],
    )
    const issues = parseIssueList({
      issues: [
        { id: 'issue-a', type: 'dispute', status: 'OPEN' },
        { noId: true },
      ],
    })
    assert.equal(issues.length, 1)
    assert.equal(issues[0]?.kind, 'dispute')
    const chat = parseIssueChat('issue-a', {
      chat: [
        {
          id: 'c1',
          createdAt: '2026-09-19T07:30:00.000Z',
          author: { login: 'b', role: 'seller' },
          text: 'Válasz',
        },
      ],
    })
    assert.equal(chat[0]?.authorRole, 'SELLER')
    assert.equal(isNotifiableIssueMessage(chat[0]!), false)
  })
})
