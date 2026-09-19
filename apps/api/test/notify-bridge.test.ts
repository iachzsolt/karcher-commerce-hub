import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import {
  bridgeCanonicalMessage,
  createMemoryNotifyKv,
  fetchOrderHighWater,
  handleNotifyAck,
  handleNotifyPull,
  hmacSha256Hex,
  NOTIFY_KV_KEYS,
  reseedNotifyOrders,
  setNotifyKvStore,
  storeNotifyOAuth,
  verifyBridgeRequest,
  type BridgeDeps,
  type BridgePending,
  type NotifyKv,
  type StoredCursor,
} from '../src/allegro-notify.ts'
import { allegroAuth } from '../src/allegro-auth.ts'
import type { AccessVariables } from '../src/access-auth.ts'
import { onRequest } from '../../web/functions/api/[[path]].ts'

/*
 * Pull/ack bridge tests (Apps Script -> Commerce Hub).
 *
 * No production Allegro calls: every Allegro response is a
 * stubbed fetch. ALLEGRO_NOTIFY_ENABLED is controlled per
 * test through explicit environment objects; the process
 * environment is never enabled by these tests.
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
  const nonce = `bridge-test-nonce-${nonceCounter}`
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

type OrderStubEvent = {
  id: string
  type: string
  orderId: string
}

function orderEventPayload(event: OrderStubEvent) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: '2026-09-19T07:00:00.000Z',
    order: { id: event.orderId },
  }
}

function messagePayload(
  id: string,
  interlocutor: boolean,
) {
  return {
    id,
    createdAt: '2026-09-19T07:10:00.000Z',
    author: {
      isInterlocutor: interlocutor,
      login: interlocutor ? 'buyer42' : 'our-shop',
    },
    text: interlocutor
      ? 'Hol a csomagom?'
      : 'Feldolgozzuk.',
  }
}

/* Journal stub honoring `from` (exclusive continuation)
 * and limit/offset slicing so pagination terminates. */
function journalFetch(
  orderEvents: OrderStubEvent[],
  messages: Array<{
    id: string
    interlocutor: boolean
  }> = [],
  calls: string[] = [],
) {
  return async (input: string): Promise<Response> => {
    calls.push(input)
    const url = new URL(input)

    if (url.pathname.endsWith('/order/events')) {
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
          .map(orderEventPayload),
      })
    }

    if (url.pathname.includes('/messages')) {
      const offset = Number(
        url.searchParams.get('offset') ?? '0',
      )
      const limit = Number(
        url.searchParams.get('limit') ?? '20',
      )

      return jsonResponse({
        messages: messages
          .slice(offset, offset + limit)
          .map((message) =>
            messagePayload(
              message.id,
              message.interlocutor,
            ),
          ),
      })
    }

    if (url.pathname.endsWith('/messaging/threads')) {
      return jsonResponse({
        threads: [{ id: 'th-1' }],
      })
    }

    if (url.pathname.includes('/checkout-forms/')) {
      return jsonResponse({
        buyer: {
          login: 'buyer42',
          firstName: 'Teszt',
          lastName: 'Vevo',
          email: 'buyer42@example.com',
        },
      })
    }

    throw new Error(`Unexpected fetch: ${input}`)
  }
}

function manyHistoricalEvents(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `ev-hist-${String(index).padStart(4, '0')}`,
    type:
      index % 3 === 0
        ? 'READY_FOR_PROCESSING'
        : index % 3 === 1
          ? 'BUYER_CANCELLED'
          : 'AUTO_CANCELLED',
    orderId: `ord-hist-${index}`,
  }))
}

async function kvValues(kv: NotifyKv) {
  // Memory KV has no enumeration API; re-drive the keys
  // we care about instead.
  const pending = await kv.get<BridgePending>(
    NOTIFY_KV_KEYS.pending,
  )
  const orderCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.orderCursor,
  )
  const messageCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.messageCursor,
  )

  return { pending, orderCursor, messageCursor }
}

void describe('bridge HMAC authentication', () => {
  void it('uses the same canonical construction as the relay vector', async () => {
    const payload = {
      to: 'rendeles@example.com',
      subject: '[Allegro][ÚJ RENDELÉS] ord-1',
      textBody:
        'Kärcher – értesítés\nÁr: 12 990 Ft "akció" <ok>',
      htmlBody: '<p>Kärcher – értesítés</p>',
    }

    assert.equal(
      bridgeCanonicalMessage(
        '2026-09-19T08:00:00.000Z',
        'kompatibilitasi-teszt-1',
        payload,
      ),
      '2026-09-19T08:00:00.000Z\n' +
        'kompatibilitasi-teszt-1\n' +
        '{"htmlBody":"<p>Kärcher – értesítés</p>",' +
        '"subject":"[Allegro][ÚJ RENDELÉS] ord-1",' +
        '"textBody":"Kärcher – értesítés\\nÁr: 12 990 Ft \\"akció\\" <ok>",' +
        '"to":"rendeles@example.com"}',
    )
    assert.equal(
      await hmacSha256Hex(
        'test-relay-secret-123',
        bridgeCanonicalMessage(
          '2026-09-19T08:00:00.000Z',
          'kompatibilitasi-teszt-1',
          payload,
        ),
      ),
      '0dab45e4b8a39c2c2232b079838a42355d4039ac9096c1f4306a6a1935ff26f1',
    )
  })

  void it('rejects pull without auth headers before any Allegro work', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const calls: string[] = []

    const outcome = await handleNotifyPull(
      {
        timestamp: undefined,
        nonce: undefined,
        signature: undefined,
        body: {},
      },
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch([], [], calls),
        nowMs: NOW_MS,
      },
    )

    assert.equal(outcome.httpStatus, 401)
    assert.deepEqual(calls, [])
  })

  void it('rejects ack without auth headers', async () => {
    const kv = createMemoryNotifyKv()

    const outcome = await handleNotifyAck(
      {
        timestamp: undefined,
        nonce: undefined,
        signature: undefined,
        body: { deliveryId: 'order:ev-1' },
      },
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch([]),
        nowMs: NOW_MS,
      },
    )

    assert.equal(outcome.httpStatus, 401)
  })

  void it('rejects a bad signature before any Allegro work', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const calls: string[] = []
    const auth = await signedAuth({})

    const outcome = await handleNotifyPull(
      { ...auth, signature: '0'.repeat(64) },
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch([], [], calls),
        nowMs: NOW_MS,
      },
    )

    assert.equal(outcome.httpStatus, 401)
    assert.deepEqual(calls, [])
  })

  void it('rejects a stale timestamp', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const calls: string[] = []
    const auth = await signedAuth({})

    const outcome = await handleNotifyPull(auth, {
      environment: baseEnvironment(),
      kv,
      fetchImpl: journalFetch([], [], calls),
      nowMs: NOW_MS + 6 * 60_000,
    })

    assert.equal(outcome.httpStatus, 401)

    if (outcome.httpStatus === 401) {
      assert.equal(outcome.reason, 'STALE_TIMESTAMP')
    }

    assert.deepEqual(calls, [])
  })

  void it('rejects a replayed nonce', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const deps: BridgeDeps = {
      environment: baseEnvironment(),
      kv,
      fetchImpl: journalFetch([]),
      nowMs: NOW_MS,
    }
    const auth = await signedAuth({})

    const first = await handleNotifyPull(auth, deps)
    assert.equal(first.httpStatus, 200)

    const second = await handleNotifyPull(auth, deps)
    assert.equal(second.httpStatus, 401)

    if (second.httpStatus === 401) {
      assert.equal(second.reason, 'REPLAYED_NONCE')
    }
  })

  void it('answers DISABLED without Allegro work while the flag is off', async () => {
    const kv = createMemoryNotifyKv()
    const calls: string[] = []

    const pull = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment({
          ALLEGRO_NOTIFY_ENABLED: 'false',
        }),
        kv,
        fetchImpl: journalFetch([], [], calls),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(pull, {
      httpStatus: 200,
      result: { action: 'DISABLED' },
    })
    assert.deepEqual(calls, [])

    const ack = await handleNotifyAck(
      await signedAuth({ deliveryId: 'order:ev-1' }),
      {
        environment: baseEnvironment({
          ALLEGRO_NOTIFY_ENABLED: 'false',
        }),
        kv,
        fetchImpl: journalFetch([], [], calls),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(ack, {
      httpStatus: 200,
      result: { action: 'DISABLED' },
    })
    assert.deepEqual(
      await kv.get(NOTIFY_KV_KEYS.pending),
      null,
    )
  })

  void it('answers PONG on ping without touching cursors', async () => {
    const kv = createMemoryNotifyKv()

    const pong = await handleNotifyPull(
      await signedAuth({ mode: 'ping' }),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch([]),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(pong, {
      httpStatus: 200,
      result: { action: 'PONG' },
    })
    assert.deepEqual(await kvValues(kv), {
      pending: null,
      orderCursor: null,
      messageCursor: null,
    })
  })
})

void describe('order historical-flood bootstrap', () => {
  void it('seeds a 100-event journal with zero emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const events = manyHistoricalEvents(100)

    const outcome = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(events),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(outcome, {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'ORDER' },
    })

    const cursor = await kv.get<StoredCursor>(
      NOTIFY_KV_KEYS.orderCursor,
    )
    assert.equal(cursor?.lastId, 'ev-hist-0099')
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.sentOrder('ev-hist-0000')),
      null,
    )
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.pending),
      null,
    )
  })

  void it('finds the true high-water mark past 100 events', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)

    const result = await fetchOrderHighWater(
      {
        ...baseEnvironment(),
        relayUrl: null,
        relaySecret: RELAY_SECRET,
        tokenKeyBytes: Buffer.from(
          TOKEN_KEY,
          'base64',
        ),
        orderEmail: 'orders@example.com',
        messageEmail: 'customerservice@example.com',
        cancellationEmail: 'cancellations@example.com',
        enabled: true,
        apiUrl: 'https://api.test',
        authUrl: 'https://auth.test',
        tokenUrl: 'https://token.test',
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://hub.test/x',
        userAgent: 'test-agent/1.0',
      } as never,
      {
        accessToken: 'stub-access-token',
        refreshToken: 'stub-refresh-token',
        expiresAt: NOW_MS + 3600_000,
      },
      journalFetch(manyHistoricalEvents(250)),
      null,
    )

    assert.equal(result.ok, true)

    if (result.ok) {
      assert.equal(
        result.highWater.highWaterId,
        'ev-hist-0249',
      )
      assert.equal(result.highWater.eventsScanned, 250)
      assert.equal(result.highWater.pages, 3)
    }
  })

  void it('never emails historical READY/CANCELLED across repeated pulls', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const fetchImpl = journalFetch(
      manyHistoricalEvents(23),
    )
    const deps = {
      environment: baseEnvironment(),
      kv,
      fetchImpl,
      nowMs: NOW_MS,
    }

    const first = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.deepEqual(first, {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'ORDER' },
    })

    // Journal is exhausted: no pending, further pulls
    // must stay NOOP (messages fixtures are empty).
    const second = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )

    if (
      second.httpStatus === 200 &&
      second.result.action === 'EMAIL'
    ) {
      assert.fail(
        'historical event must never become EMAIL',
      )
    }
  })

  void it('emails the first new event after the seed, exactly once', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const events = manyHistoricalEvents(5)
    const deps = {
      environment: baseEnvironment(),
      kv,
      fetchImpl: journalFetch(events),
      nowMs: NOW_MS,
    }

    const seeded = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.deepEqual(seeded, {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'ORDER' },
    })

    events.push({
      id: 'ev-new-1',
      type: 'READY_FOR_PROCESSING',
      orderId: 'ord-new-1',
    })
    events.push({
      id: 'ev-new-2',
      type: 'READY_FOR_PROCESSING',
      orderId: 'ord-new-2',
    })

    // At most ONE email per pull.
    const first = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.equal(first.httpStatus, 200)

    if (
      first.httpStatus !== 200 ||
      first.result.action !== 'EMAIL'
    ) {
      assert.fail('expected one EMAIL')
    }

    assert.equal(
      first.result.deliveryId,
      'order:ev-new-1',
    )
    assert.equal(
      first.result.email.subject,
      '[ALLEGRO] ÚJ RENDELÉS – ord-new-1',
    )

    // No ACK yet: the same pending event is re-offered,
    // never the newer one.
    const retry = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.deepEqual(retry, first)

    // ACK marks delivered + advances the cursor.
    const ack = await handleNotifyAck(
      await signedAuth({ deliveryId: 'order:ev-new-1' }),
      deps,
    )
    assert.deepEqual(ack, {
      httpStatus: 200,
      result: { action: 'ACKED', duplicate: false },
    })
    assert.notEqual(
      await kv.get(NOTIFY_KV_KEYS.sentOrder('ev-new-1')),
      null,
    )
    assert.equal(
      (
        await kv.get<StoredCursor>(
          NOTIFY_KV_KEYS.orderCursor,
        )
      )?.lastId,
      'ev-new-1',
    )
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.pending),
      null,
    )

    // Next pull offers the second new event only.
    const second = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.equal(second.httpStatus, 200)

    if (
      second.httpStatus !== 200 ||
      second.result.action !== 'EMAIL'
    ) {
      assert.fail('expected the second EMAIL')
    }

    assert.equal(
      second.result.deliveryId,
      'order:ev-new-2',
    )

    // ACK is idempotent.
    const ackAgain = await handleNotifyAck(
      await signedAuth({ deliveryId: 'order:ev-new-1' }),
      deps,
    )
    assert.deepEqual(ackAgain, {
      httpStatus: 200,
      result: { action: 'ACKED', duplicate: true },
    })
  })

  void it('keeps the email payload out of KV', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const events: OrderStubEvent[] = [
      {
        id: 'ev-1',
        type: 'READY_FOR_PROCESSING',
        orderId: 'ord-1',
      },
    ]

    const pulled = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(events),
        nowMs: NOW_MS,
      },
    )
    assert.equal(pulled.httpStatus, 200)

    const pending = await kv.get<BridgePending>(
      NOTIFY_KV_KEYS.pending,
    )
    assert.ok(pending)
    assert.deepEqual(
      Object.keys(pending).sort(),
      [
        'channel',
        'createdAt',
        'cursorBefore',
        'deliveryId',
        'eventId',
        'eventType',
        'messageId',
        'offerId',
        'orderId',
        'threadId',
      ].sort(),
    )
    assert.ok(
      !JSON.stringify(pending).includes('buyer42'),
    )
  })

  void it('advances safely over ignored events without email', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const events: OrderStubEvent[] = [
      { id: 'ev-1', type: 'BOUGHT', orderId: 'ord-1' },
      {
        id: 'ev-2',
        type: 'READY_FOR_PROCESSING',
        orderId: 'ord-2',
      },
    ]
    const deps = {
      environment: baseEnvironment(),
      kv,
      fetchImpl: journalFetch(events),
      nowMs: NOW_MS,
    }

    const pulled = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )
    assert.equal(pulled.httpStatus, 200)

    if (
      pulled.httpStatus !== 200 ||
      pulled.result.action !== 'EMAIL'
    ) {
      assert.fail('expected ev-2 EMAIL')
    }

    assert.equal(
      pulled.result.deliveryId,
      'order:ev-2',
    )
  })

  void it('skips already-delivered events', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    await kv.set(NOTIFY_KV_KEYS.sentOrder('ev-1'), {
      deliveredAt: new Date(NOW_MS).toISOString(),
      channel: 'order',
    })
    const events: OrderStubEvent[] = [
      {
        id: 'ev-1',
        type: 'READY_FOR_PROCESSING',
        orderId: 'ord-1',
      },
      {
        id: 'ev-2',
        type: 'READY_FOR_PROCESSING',
        orderId: 'ord-2',
      },
    ]

    const pulled = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(events),
        nowMs: NOW_MS,
      },
    )

    if (
      pulled.httpStatus !== 200 ||
      pulled.result.action !== 'EMAIL'
    ) {
      assert.fail('expected ev-2 EMAIL')
    }

    assert.equal(pulled.result.deliveryId, 'order:ev-2')
  })
})

void describe('safe order recovery', () => {
  void it('repairs a faulty empty cursor without touching messages', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    // Faulty production state: cursor row exists but the
    // id is empty (falsy) — must be treated as missing.
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: '',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: 'm-15',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    await kv.set(NOTIFY_KV_KEYS.pending, {
      deliveryId: 'order:ev-stale',
      channel: 'order',
      eventId: 'ev-stale',
      eventType: 'READY_FOR_PROCESSING',
      orderId: 'ord-stale',
      threadId: null,
      offerId: null,
      messageId: null,
      cursorBefore: '',
      createdAt: new Date(NOW_MS).toISOString(),
    } satisfies BridgePending)

    const result = await reseedNotifyOrders({
      environment: baseEnvironment({
        ALLEGRO_NOTIFY_ENABLED: 'false',
      }),
      kv,
      fetchImpl: journalFetch(manyHistoricalEvents(150)),
      nowMs: NOW_MS,
    })

    assert.equal(result.ok, true)

    if (result.ok) {
      assert.equal(result.reseed.previousCursor, '')
      assert.equal(
        result.reseed.highWaterId,
        'ev-hist-0149',
      )
      assert.equal(result.reseed.eventsScanned, 150)
      assert.equal(
        result.reseed.clearedOrderPending,
        true,
      )
    }

    assert.equal(
      (
        await kv.get<StoredCursor>(
          NOTIFY_KV_KEYS.orderCursor,
        )
      )?.lastId,
      'ev-hist-0149',
    )
    // Message state untouched.
    assert.equal(
      (
        await kv.get<StoredCursor>(
          NOTIFY_KV_KEYS.messageCursor,
        )
      )?.lastId,
      'm-15',
    )
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.pending),
      null,
    )
    assert.equal(
      await kv.get(
        NOTIFY_KV_KEYS.sentOrder('ev-hist-0149'),
      ),
      null,
    )
  })

  void it('rejects anonymous reseed and requires confirmation', async () => {
    const anonymous = await allegroAuth.request(
      '/notify-reseed-orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      },
    )
    assert.equal(anonymous.status, 403)

    const app = new Hono<{
      Variables: AccessVariables
    }>()
    app.use('*', async (context, next) => {
      context.set('commerceHubUser', {
        email: 'admin@example.com',
        role: 'ADMIN',
        subject: null,
      })
      await next()
    })
    app.route('/auth/allegro', allegroAuth)

    const unconfirmed = await app.request(
      '/auth/allegro/notify-reseed-orders',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: false }),
      },
    )
    assert.equal(unconfirmed.status, 400)
  })

  void it('rejects anonymous pull/ack at the route layer', async () => {
    const keys = [
      'ALLEGRO_API_URL',
      'ALLEGRO_AUTH_URL',
      'ALLEGRO_TOKEN_URL',
      'ALLEGRO_CLIENT_ID',
      'ALLEGRO_CLIENT_SECRET',
      'ALLEGRO_NOTIFY_REDIRECT_URI',
      'ALLEGRO_USER_AGENT',
      'ALLEGRO_NOTIFY_RELAY_SECRET',
      'ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY',
      'ALLEGRO_NOTIFY_ORDER_EMAIL',
      'ALLEGRO_NOTIFY_MESSAGE_EMAIL',
      'ALLEGRO_NOTIFY_CANCELLATION_EMAIL',
    ]
    const snapshot = new Map(
      keys.map((key) => [key, process.env[key]]),
    )
    const env = baseEnvironment()
    for (const key of keys) {
      process.env[key] = env[key]
    }
    setNotifyKvStore(createMemoryNotifyKv())

    try {
      for (const route of [
        'notify-pull',
        'notify-ack',
      ]) {
        const response = await allegroAuth.request(
          `/${route}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({}),
          },
        )
        assert.equal(response.status, 401)
      }
    } finally {
      setNotifyKvStore(null)
      for (const [key, value] of snapshot) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})

void describe('message cursor preservation', () => {
  void it('continues from the seeded message cursor', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    // Production-seeded message cursor: must not reset.
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: 'm-15',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const deps = {
      environment: baseEnvironment(),
      kv,
      fetchImpl: journalFetch(
        [],
        [{ id: 'm-16', interlocutor: true }],
      ),
      nowMs: NOW_MS,
    }

    const pulled = await handleNotifyPull(
      await signedAuth({}),
      deps,
    )

    if (
      pulled.httpStatus !== 200 ||
      pulled.result.action !== 'EMAIL'
    ) {
      assert.fail('expected message EMAIL')
    }

    assert.equal(
      pulled.result.deliveryId,
      'message:m-16',
    )
    assert.equal(
      pulled.result.email.subject,
      '[ALLEGRO] ÜZENET',
    )

    const ack = await handleNotifyAck(
      await signedAuth({ deliveryId: 'message:m-16' }),
      deps,
    )
    assert.deepEqual(ack, {
      httpStatus: 200,
      result: { action: 'ACKED', duplicate: false },
    })
    assert.equal(
      (
        await kv.get<StoredCursor>(
          NOTIFY_KV_KEYS.messageCursor,
        )
      )?.lastId,
      'm-16',
    )
  })

  void it('seeds a fresh message environment with zero historical emails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })

    const seeded = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(
          [],
          [
            { id: 'm-01', interlocutor: true },
            { id: 'm-02', interlocutor: true },
          ],
        ),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(seeded, {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'MESSAGE' },
    })
    assert.equal(
      (
        await kv.get<StoredCursor>(
          NOTIFY_KV_KEYS.messageCursor,
        )
      )?.lastId,
      'm-02',
    )
  })

  void it('ignores seller messages', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: 'm-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })

    const pulled = await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(
          [],
          [{ id: 'm-1', interlocutor: false }],
        ),
        nowMs: NOW_MS,
      },
    )

    assert.deepEqual(pulled, {
      httpStatus: 200,
      result: { action: 'NOOP' },
    })
  })

  void it('keeps message pagination at public.v1 limits', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: 'm-0',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const calls: string[] = []

    await handleNotifyPull(
      await signedAuth({}),
      {
        environment: baseEnvironment(),
        kv,
        fetchImpl: journalFetch(
          [],
          [{ id: 'm-1', interlocutor: true }],
          calls,
        ),
        nowMs: NOW_MS,
      },
    )

    const messaging = calls.filter((url) =>
      url.includes('/messaging/'),
    )
    assert.ok(messaging.length > 0)

    for (const url of messaging) {
      const limit = Number(
        new URL(url).searchParams.get('limit'),
      )
      assert.ok(limit >= 1 && limit <= 20)
    }
  })
})

const bridgeRepoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
)

function readBridgeSource(relativePath: string) {
  return readFileSync(
    join(bridgeRepoRoot, relativePath),
    'utf8',
  )
}

void describe('bridge ping cross-runtime vector', () => {
  /*
   * NEW bridge-request vector (header format), distinct from
   * the legacy relay-envelope vector (signature inside the
   * JSON body). Fixed inputs agreed with Code.gs
   * testBridgeConnection: body {"mode":"ping"}.
   *
   * gasSignBridgeRequest() below is an independent
   * Apps Script-semantics port: same canonicalJson code
   * shape as Code.gs, node:crypto standing in for
   * Utilities.computeHmacSha256Signature(message, secret,
   * UTF_8). It must agree byte-for-byte with the Deno
   * implementation, and the pinned hex guards regressions.
   */
  const PING_TIMESTAMP = '2026-09-19T14:00:00.000Z'
  const PING_NONCE = '00112233445566778899aabbccddeeff'
  const PING_SECRET = 'test-relay-secret-123'
  const PING_BODY = { mode: 'ping' }
  const PING_SIGNATURE =
    'a6400053e2485926fbd6da1012741c9c25ebf48fe8c15d946267521b18f1bbae'

  function gasCanonicalJson(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null'
    }

    if (
      Object.prototype.toString.call(value) ===
      '[object Array]'
    ) {
      return (
        '[' +
        (value as unknown[])
          .map(gasCanonicalJson)
          .join(',') +
        ']'
      )
    }

    if (typeof value === 'object') {
      const keys = Object.keys(
        value as Record<string, unknown>,
      ).sort()

      return (
        '{' +
        keys
          .map(
            (key) =>
              JSON.stringify(key) +
              ':' +
              gasCanonicalJson(
                (value as Record<string, unknown>)[key],
              ),
          )
          .join(',') +
        '}'
      )
    }

    return JSON.stringify(value)
  }

  function gasSignBridgeRequest(
    secret: string,
    timestamp: string,
    nonce: string,
    body: unknown,
  ) {
    const message =
      timestamp + '\n' + nonce + '\n' + gasCanonicalJson(body)

    return {
      message,
      signature: createHmac(
        'sha256',
        Buffer.from(secret, 'utf8'),
      )
        .update(Buffer.from(message, 'utf8'))
        .digest('hex'),
    }
  }

  void it('matches the Apps Script pipeline byte-for-byte', async () => {
    const independent = gasSignBridgeRequest(
      PING_SECRET,
      PING_TIMESTAMP,
      PING_NONCE,
      PING_BODY,
    )

    assert.equal(
      independent.message,
      bridgeCanonicalMessage(
        PING_TIMESTAMP,
        PING_NONCE,
        PING_BODY,
      ),
    )
    assert.equal(independent.signature, PING_SIGNATURE)
    assert.equal(
      await hmacSha256Hex(
        PING_SECRET,
        bridgeCanonicalMessage(
          PING_TIMESTAMP,
          PING_NONCE,
          PING_BODY,
        ),
      ),
      PING_SIGNATURE,
    )
  })

  void it('accepts the exact ping vector in the real verifier', async () => {
    assert.deepEqual(
      await verifyBridgeRequest(
        PING_SECRET,
        PING_TIMESTAMP,
        PING_NONCE,
        PING_SIGNATURE,
        PING_BODY,
        Date.parse(PING_TIMESTAMP),
      ),
      { ok: true, reason: 'OK' },
    )
  })

  void it('accepts the exact ping vector in the real pull handler', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)

    const outcome = await handleNotifyPull(
      {
        timestamp: PING_TIMESTAMP,
        nonce: 'ping-vector-pull-1',
        signature: (
          await gasSignBridgeRequest(
            PING_SECRET,
            PING_TIMESTAMP,
            'ping-vector-pull-1',
            PING_BODY,
          )
        ).signature,
        body: PING_BODY,
      },
      {
        environment: baseEnvironment({
          ALLEGRO_NOTIFY_RELAY_SECRET: PING_SECRET,
        }),
        kv,
        fetchImpl: journalFetch([]),
        nowMs: Date.parse(PING_TIMESTAMP),
      },
    )

    assert.deepEqual(outcome, {
      httpStatus: 200,
      result: { action: 'PONG' },
    })
  })

  void it('rejects one-byte body/timestamp/nonce/secret changes', async () => {
    const nowMs = Date.parse(PING_TIMESTAMP)
    const cases: Array<{
      name: string
      secret: string
      timestamp: string
      nonce: string
      body: unknown
    }> = [
      {
        name: 'body',
        secret: PING_SECRET,
        timestamp: PING_TIMESTAMP,
        nonce: PING_NONCE,
        body: { mode: 'pong' },
      },
      {
        name: 'timestamp',
        secret: PING_SECRET,
        timestamp: '2026-09-19T14:00:00.001Z',
        nonce: PING_NONCE,
        body: PING_BODY,
      },
      {
        name: 'nonce',
        secret: PING_SECRET,
        timestamp: PING_TIMESTAMP,
        nonce: '00112233445566778899aabbccddeefe',
        body: PING_BODY,
      },
      {
        name: 'secret',
        secret: 'test-relay-secret-124',
        timestamp: PING_TIMESTAMP,
        nonce: PING_NONCE,
        body: PING_BODY,
      },
    ]

    for (const mutated of cases) {
      assert.deepEqual(
        await verifyBridgeRequest(
          mutated.secret,
          mutated.timestamp,
          mutated.nonce,
          PING_SIGNATURE,
          mutated.body,
          nowMs,
        ),
        { ok: false, reason: 'BAD_SIGNATURE' },
        `mutated ${mutated.name} must fail`,
      )
    }
  })

  void it('requires lowercase hex exactly as Apps Script sends it', async () => {
    assert.deepEqual(
      await verifyBridgeRequest(
        PING_SECRET,
        PING_TIMESTAMP,
        PING_NONCE,
        PING_SIGNATURE.toUpperCase(),
        PING_BODY,
        Date.parse(PING_TIMESTAMP),
      ),
      { ok: false, reason: 'BAD_SIGNATURE' },
    )
  })
})

void describe('bridge proxy origin handling', () => {
  const realFetch = globalThis.fetch
  const upstream: Array<{
    url: string
    method: string
    headers: Headers
    body: string | null
  }> = []

  function stubUpstream() {
    upstream.length = 0
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const headers = new Headers(
        init?.headers as HeadersInit | undefined,
      )
      // The proxy forwards context.request.body (a stream);
      // consume it the way an HTTP server would.
      let body: string | null = null

      if (typeof init?.body === 'string') {
        body = init.body
      } else if (init?.body) {
        body = await new Response(
          init.body as BodyInit,
        ).text()
      }

      upstream.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers,
        body,
      })
      return new Response(
        JSON.stringify({ ok: true, action: 'DISABLED' }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as typeof fetch
  }

  function bridgeContext(
    segments: string[],
    init: {
      origin?: string | null
      headers?: Record<string, string>
      body?: unknown
    } = {},
  ) {
    const headers = new Headers(init.headers)

    // Simulate Apps Script UrlFetchApp: no Origin header
    // unless the test passes one explicitly.
    if (init.origin !== undefined && init.origin !== null) {
      headers.set('Origin', init.origin)
    }

    return {
      params: { path: segments },
      request: new Request(
        `https://hub.test/api/${segments.join('/')}`,
        {
          method: 'POST',
          headers,
          body:
            init.body === undefined
              ? '{}'
              : JSON.stringify(init.body),
        },
      ),
      env: {
        COMMERCE_HUB_API_ORIGIN: 'https://api.test/',
      },
    }
  }

  async function signedProxyBody() {
    const body = {}
    const auth = await signedAuth(body)

    return {
      body,
      headers: {
        'X-Allegro-Notify-Timestamp': auth.timestamp,
        'X-Allegro-Notify-Nonce': auth.nonce,
        'X-Allegro-Notify-Signature': auth.signature,
      },
    }
  }

  void it('forwards a signed pull without Origin to the bridge', async () => {
    stubUpstream()
    const signed = await signedProxyBody()

    try {
      const response = await onRequest(
        bridgeContext(
          ['auth', 'allegro', 'notify-pull'],
          { headers: signed.headers, body: signed.body },
        ) as never,
      )

      assert.equal(response.status, 200)
      assert.equal(upstream.length, 1)
      assert.equal(
        upstream[0]?.url,
        'https://api.test/auth/allegro/notify-pull',
      )
      assert.equal(upstream[0]?.method, 'POST')
      // Bridge HMAC headers forwarded unchanged.
      assert.equal(
        upstream[0]?.headers.get(
          'X-Allegro-Notify-Timestamp',
        ),
        signed.headers['X-Allegro-Notify-Timestamp'],
      )
      assert.equal(
        upstream[0]?.headers.get(
          'X-Allegro-Notify-Nonce',
        ),
        signed.headers['X-Allegro-Notify-Nonce'],
      )
      assert.equal(
        upstream[0]?.headers.get(
          'X-Allegro-Notify-Signature',
        ),
        signed.headers['X-Allegro-Notify-Signature'],
      )
      assert.equal(upstream[0]?.body, '{}')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  void it('forwards a signed ack without Origin to the bridge', async () => {
    stubUpstream()
    const signed = await signedProxyBody()

    try {
      const response = await onRequest(
        bridgeContext(['auth', 'allegro', 'notify-ack'], {
          headers: signed.headers,
          body: signed.body,
        }) as never,
      )

      assert.equal(response.status, 200)
      assert.equal(upstream.length, 1)
      assert.equal(
        upstream[0]?.url,
        'https://api.test/auth/allegro/notify-ack',
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })

  void it('still rejects a foreign Origin on bridge paths', async () => {
    stubUpstream()
    const signed = await signedProxyBody()

    try {
      const response = await onRequest(
        bridgeContext(
          ['auth', 'allegro', 'notify-pull'],
          {
            headers: signed.headers,
            body: signed.body,
            origin: 'https://evil.test',
          },
        ) as never,
      )

      assert.equal(response.status, 403)
      assert.deepEqual(await response.json(), {
        status: 'error',
        message: 'Cross-origin changes are not allowed',
      })
      assert.deepEqual(upstream, [])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  void it('still blocks originless mutations outside the bridge', async () => {
    stubUpstream()

    try {
      for (const segments of [
        ['auth', 'allegro', 'notify-reseed-orders'],
        ['auth', 'allegro', 'status'],
      ]) {
        const response = await onRequest(
          bridgeContext(segments, {
            body: { confirm: true },
          }) as never,
        )

        // Reseed/connect are not transport-public: the
        // Bearer gate fires first (401). With a Bearer
        // token but no Origin, the origin gate must fire
        // (403) — never forwarded.
        assert.equal(response.status, 401)
        assert.deepEqual(upstream, [])

        const authed = await onRequest(
          bridgeContext(segments, {
            headers: {
              Authorization: 'Bearer hub-token',
            },
            body: { confirm: true },
          }) as never,
        )
        assert.equal(authed.status, 403)
        assert.deepEqual(await authed.json(), {
          status: 'error',
          message:
            'Cross-origin changes are not allowed',
        })
        assert.deepEqual(upstream, [])
      }
    } finally {
      globalThis.fetch = realFetch
    }
  })

  void it('keeps the server exemption exact with no CORS wildcard', () => {
    const source = readBridgeSource(
      'apps/web/functions/api/[[path]].ts',
    )
    const start = source.indexOf(
      'const BRIDGE_SERVER_PATHS = new Set([',
    )
    assert.ok(start >= 0)
    const block = source.slice(
      start,
      source.indexOf('])', start),
    )
    assert.ok(
      block.includes("'auth/allegro/notify-pull'"),
    )
    assert.ok(
      block.includes("'auth/allegro/notify-ack'"),
    )
    assert.ok(!block.includes('reseed'))
    assert.ok(!block.includes('connect'))
    assert.ok(!block.includes('*'))
    assert.ok(
      !source.includes('Access-Control-Allow-Origin'),
    )
  })
})

void describe('bridge architecture guards', () => {
  const repoRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
  )

  function readSource(relativePath: string) {
    return readFileSync(
      join(repoRoot, relativePath),
      'utf8',
    )
  }

  void it('registers no notification Deno cron', () => {
    const source = readSource('apps/api/src/deno.ts')
    const crons = source.match(/Deno\.cron\(/g) ?? []

    // Static call sites: 1 Arukereso-source loop + 1 daily
    // maintenance + 1 daily-scheduler helper (invoked per
    // pattern at startup). Runtime total is 6 (2 daily
    // scheduler + 3 Arukereso source + 1 maintenance).
    assert.equal(crons.length, 3)
    assert.ok(
      !source.includes('commerce-hub-allegro-notify'),
    )
    assert.ok(!source.includes('runAllegroNotifyTick'))
    assert.ok(!source.includes('runAllegroNotifyCron'))
  })

  void it('keeps the pull/ack path free of Neon/session imports', () => {
    const source = readSource(
      'apps/api/src/allegro-notify.ts',
    )

    for (const forbidden of [
      'drizzle-orm',
      '@karcher-commerce-hub/database',
      'initializeCommerceHubRuntime',
      'restoreAllegroSession',
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `forbidden import: ${forbidden}`,
      )
    }
  })

  void it('exposes exactly pull+ack publicly, never connect/reseed', () => {
    // Scope the assertions to the allowlist literals: the
    // surrounding comments legitimately name the routes
    // that must STAY protected.
    const apiSource = readSource(
      'apps/api/src/access-auth.ts',
    )
    const apiBlock = apiSource.slice(
      apiSource.indexOf('const PUBLIC_PATHS = new Set(['),
      apiSource.indexOf('])', apiSource.indexOf(
        'const PUBLIC_PATHS = new Set([',
      )),
    )
    assert.ok(
      apiBlock.includes("'/auth/allegro/notify-pull'"),
    )
    assert.ok(
      apiBlock.includes("'/auth/allegro/notify-ack'"),
    )
    assert.ok(!apiBlock.includes('notify-reseed'))
    assert.ok(!apiBlock.includes('notify-connect'))

    const proxySource = readSource(
      'apps/web/functions/api/[[path]].ts',
    )
    const proxyBlock = proxySource.slice(
      proxySource.indexOf(
        'const PUBLIC_PROXY_PATHS = new Set([',
      ),
      proxySource.indexOf('])', proxySource.indexOf(
        'const PUBLIC_PROXY_PATHS = new Set([',
      )),
    )
    assert.ok(
      proxyBlock.includes("'auth/allegro/notify-pull'"),
    )
    assert.ok(
      proxyBlock.includes("'auth/allegro/notify-ack'"),
    )
    assert.ok(!proxyBlock.includes('notify-reseed'))
    assert.ok(!proxyBlock.includes('notify-connect'))
    assert.ok(!proxyBlock.includes('*'))
  })
})
