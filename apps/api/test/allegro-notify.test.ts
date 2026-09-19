import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ALLEGRO_NOTIFY_SCOPES,
  buildCancellationEmail,
  buildMessageEmail,
  buildNotifyAuthorizeUrl,
  buildOrderEmail,
  canonicalJson,
  classifyOrderEvent,
  createMemoryNotifyKv,
  decryptNotifyToken,
  emptyOrderDetail,
  encryptNotifyToken,
  escapeNotifyHtml,
  exchangeNotifyCode,
  hmacSha256Hex,
  isNotifiableMessage,
  loadNotifyOAuth,
  NOTIFY_KV_KEYS,
  parseCheckoutForm,
  parseOrderEvents,
  parseThreadMessages,
  refreshNotifyTokens,
  resolveNotifyConfig,
  runAllegroNotifyTick,
  signRelayEnvelope,
  storeNotifyOAuth,
  verifyRelayEnvelope,
  type NotifyKv,
} from '../src/allegro-notify.ts'

const NOW_MS = new Date('2026-09-19T08:00:00.000Z').getTime()
const TOKEN_KEY = Buffer.from(
  crypto.getRandomValues(new Uint8Array(32)),
).toString('base64')

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
    ALLEGRO_NOTIFY_RELAY_URL:
      'https://relay.test/exec',
    ALLEGRO_NOTIFY_RELAY_SECRET: 'relay-secret',
    ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY:
      TOKEN_KEY,
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

type StubRoute = {
  match: (url: string) => boolean
  respond: (url: string) => Response
}

function stubFetch(routes: StubRoute[]) {
  const calls: string[] = []

  const fetchImpl = async (
    input: string,
  ): Promise<Response> => {
    calls.push(input)
    const route = routes.find((candidate) =>
      candidate.match(input),
    )

    if (!route) {
      throw new Error(`Unexpected fetch: ${input}`)
    }

    return route.respond(input)
  }

  return { fetchImpl, calls }
}

async function seedSession(
  kv: NotifyKv,
  accessToken = 'stub-access-token',
) {
  await storeNotifyOAuth(
    kv,
    {
      accessToken,
      refreshToken: 'stub-refresh-token',
      expiresAt: NOW_MS + 3600_000,
    },
    Buffer.from(TOKEN_KEY, 'base64'),
    NOW_MS,
  )
}

async function seedCursors(kv: NotifyKv) {
  await kv.set(NOTIFY_KV_KEYS.orderCursor, {
    lastId: 'ev-0',
    updatedAt: new Date(NOW_MS).toISOString(),
  })
  await kv.set(NOTIFY_KV_KEYS.messageCursor, {
    lastId: 'm-0',
    updatedAt: new Date(NOW_MS).toISOString(),
  })
}

const ORDER_EVENTS_FIXTURE = {
  events: [
    {
      id: 'ev-1',
      type: 'BOUGHT',
      occurredAt: '2026-09-19T07:01:00.000Z',
      order: { id: 'ord-1' },
    },
    {
      id: 'ev-2',
      type: 'READY_FOR_PROCESSING',
      occurredAt: '2026-09-19T07:02:00.000Z',
      order: { id: 'ord-2' },
    },
    {
      id: 'ev-3',
      type: 'BUYER_CANCELLED',
      occurredAt: '2026-09-19T07:03:00.000Z',
      order: { id: 'ord-3' },
    },
    {
      id: 'ev-4',
      type: 'AUTO_CANCELLED',
      occurredAt: '2026-09-19T07:04:00.000Z',
      order: { id: 'ord-4' },
    },
    {
      id: 'ev-5',
      type: 'FILLED_IN',
      occurredAt: '2026-09-19T07:05:00.000Z',
      order: { id: 'ord-5' },
    },
  ],
}

/* Field paths mirror real Allegro checkout-form
 * payloads (buyer, delivery.address/.method/.cost,
 * invoice.required/.address.company, lineItems[].offer
 * .external/.price, summary.totalToPay, payment
 * .type/.provider). All values are synthetic. */
function checkoutFormFixture(orderId: string) {
  return {
    id: orderId,
    boughtAt: '2026-09-19T07:02:00.000Z',
    buyer: {
      login: 'buyer42',
      firstName: 'Teszt',
      lastName: 'Vevő',
      email: 'buyer42@example.com',
      phoneNumber: '+3612345678',
    },
    lineItems: [
      {
        quantity: 2,
        offer: {
          id: 'off-5',
          name: 'Karcher WD 5',
          external: { id: '26451800' },
        },
        price: { amount: '64950', currency: 'HUF' },
      },
    ],
    summary: {
      totalToPay: { amount: '129900', currency: 'HUF' },
    },
    payment: { type: 'ONLINE', provider: 'PAYU' },
    delivery: {
      address: {
        firstName: 'Teszt',
        lastName: 'Vevő',
        street: 'Fő utca 1.',
        zipCode: '1051',
        city: 'Budapest',
        countryCode: 'HU',
        phoneNumber: '+3612345678',
      },
      method: { id: 'method-1', name: 'GLS futár' },
      cost: { amount: '1990', currency: 'HUF' },
    },
    invoice: {
      required: true,
      address: {
        street: 'Cég utca 2.',
        zipCode: '1134',
        city: 'Budapest',
        countryCode: 'HU',
        company: {
          name: 'Teszt Kft.',
          taxId: '12345678-2-41',
        },
      },
    },
    messageToSeller: 'Kérem óvatosan csomagolni.',
  }
}

const THREADS_FIXTURE = {
  threads: [{ id: 'th-1' }],
}

const MESSAGES_FIXTURE = {
  messages: [
    {
      id: 'm-1',
      createdAt: '2026-09-19T07:10:00.000Z',
      author: {
        isInterlocutor: false,
        login: 'our-shop',
      },
      text: 'Tisztelt Vásárlónk, feldolgozzuk rendelését.',
    },
    {
      id: 'm-2',
      createdAt: '2026-09-19T07:11:00.000Z',
      author: {
        isInterlocutor: true,
        login: 'buyer42',
      },
      text: 'Hello <b>shop</b>, hol a csomagom?',
      attachments: [{ fileName: 'szamla.pdf' }],
      orderId: 'ord-2',
      offerId: 'off-9',
    },
  ],
}

void describe('order event filtering', () => {
  void it('classifies V1 order event types', () => {
    assert.equal(
      classifyOrderEvent('READY_FOR_PROCESSING'),
      'NEW_ORDER',
    )
    assert.equal(
      classifyOrderEvent('BUYER_CANCELLED'),
      'CANCELLATION',
    )
    assert.equal(
      classifyOrderEvent('AUTO_CANCELLED'),
      'CANCELLATION',
    )
    assert.equal(classifyOrderEvent('BOUGHT'), null)
    assert.equal(
      classifyOrderEvent('FILLED_IN'),
      null,
    )
    assert.equal(
      classifyOrderEvent('CANCELLED'),
      null,
    )
    assert.equal(
      classifyOrderEvent('SOMETHING_NEW'),
      null,
    )
  })

  void it('parses order events defensively', () => {
    assert.deepEqual(parseOrderEvents(null), [])
    assert.deepEqual(
      parseOrderEvents({ events: [{ id: 'x' }] }),
      [],
    )
    assert.equal(
      parseOrderEvents(ORDER_EVENTS_FIXTURE).length,
      5,
    )
  })
})

void describe('message filtering', () => {
  void it('sends only interlocutor messages', () => {
    const messages = parseThreadMessages(
      'th-1',
      MESSAGES_FIXTURE,
    )
    assert.equal(messages.length, 2)
    assert.equal(
      isNotifiableMessage(messages[0]!),
      false,
    )
    assert.equal(
      isNotifiableMessage(messages[1]!),
      true,
    )
    assert.equal(
      messages[1]!.attachmentNames.join(','),
      'szamla.pdf',
    )
  })
})

void describe('email building', () => {
  void it('builds a new-order email with Hungarian fields', () => {
    const email = buildOrderEmail(
      'orders@example.com',
      {
        id: 'ev-2',
        type: 'READY_FOR_PROCESSING',
        occurredAt: '2026-09-19T07:02:00.000Z',
        orderId: 'ord-2',
      },
      parseCheckoutForm(
        'ord-2',
        checkoutFormFixture('ord-2'),
      ),
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] ÚJ RENDELÉS – ord-2',
    )
    assert.ok(email.textBody.includes('buyer42'))
    assert.ok(
      email.textBody.includes('Karcher WD 5 x2'),
    )
    assert.ok(
      email.textBody.includes(
        'Kérem óvatosan csomagolni.',
      ),
    )
    assert.ok(
      email.textBody.includes(
        'Erre az emailre ne válaszolj',
      ),
    )
    assert.ok(
      email.htmlBody.includes(
        'Erre az emailre ne válaszolj',
      ),
    )
  })

  void it('escapes customer content in HTML only', () => {
    const email = buildMessageEmail(
      'customerservice@example.com',
      {
        id: 'm-2',
        threadId: 'th-1',
        createdAt: '2026-09-19T07:11:00.000Z',
        authorIsInterlocutor: true,
        authorLogin: 'buyer<script>42</script>',
        text: 'Hello <b>shop</b>',
        attachmentNames: [],
        orderId: null,
        offerId: null,
      },
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] ÜZENET',
    )
    assert.ok(
      email.htmlBody.includes(
        'buyer&lt;script&gt;42&lt;/script&gt;',
      ),
    )
    assert.ok(
      email.htmlBody.includes(
        'Hello &lt;b&gt;shop&lt;/b&gt;',
      ),
    )
    assert.ok(
      email.textBody.includes('Hello <b>shop</b>'),
    )
    assert.ok(!email.htmlBody.includes('<script>'))
  })

  void it('uses the required scopes without messaging gaps', () => {
    assert.deepEqual([...ALLEGRO_NOTIFY_SCOPES], [
      'allegro:api:orders:read',
      'allegro:api:messaging',
      'allegro:api:profile:read',
    ])
  })
})

void describe('relay envelope', () => {
  const secret = 'relay-secret'
  const timestamp = '2026-09-19T08:00:00.000Z'
  const nonce = 'fixed-nonce-1'
  const payload = {
    to: 'orders@example.com',
    subject: '[ALLEGRO] ÚJ RENDELÉS – ord-2',
    textBody: 'hello',
    htmlBody: '<p>hello</p>',
  }

  void it('produces a stable canonical form', () => {
    assert.equal(
      canonicalJson({ b: 1, a: [3, 2] }),
      '{"a":[3,2],"b":1}',
    )
  })

  void it('signs and verifies a test vector', async () => {
    const envelope = await signRelayEnvelope(
      secret,
      timestamp,
      nonce,
      payload,
    )
    const verified = await verifyRelayEnvelope(
      secret,
      envelope,
      new Date(timestamp).getTime(),
    )
    assert.deepEqual(verified, {
      ok: true,
      reason: 'OK',
    })
  })

  void it('rejects tampered payloads and wrong secrets', async () => {
    const envelope = await signRelayEnvelope(
      secret,
      timestamp,
      nonce,
      payload,
    )
    assert.deepEqual(
      (
        await verifyRelayEnvelope(
          secret,
          {
            ...envelope,
            payload: {
              ...payload,
              subject: '[ALLEGRO] ÜZENET – x',
            },
          },
          new Date(timestamp).getTime(),
        )
      ).reason,
      'BAD_SIGNATURE',
    )
    assert.deepEqual(
      (
        await verifyRelayEnvelope(
          'other-secret',
          envelope,
          new Date(timestamp).getTime(),
        )
      ).reason,
      'BAD_SIGNATURE',
    )
  })

  void it('matches the fixed cross-runtime vector', async () => {
    // Independent node:crypto reference value. The same
    // vector lives in Code.gs testHmacCompatibility(), so
    // Deno/Node and Apps Script must agree byte-for-byte.
    // Contains Hungarian accents, quotes, newline, HTML.
    const payload = {
      to: 'rendeles@example.com',
      subject: '[Allegro][ÚJ RENDELÉS] ord-1',
      textBody:
        'Kärcher – értesítés\nÁr: 12 990 Ft "akció" <ok>',
      htmlBody: '<p>Kärcher – értesítés</p>',
    }
    const envelope = await signRelayEnvelope(
      'test-relay-secret-123',
      '2026-09-19T08:00:00.000Z',
      'kompatibilitasi-teszt-1',
      payload,
    )

    assert.equal(
      envelope.signature,
      '0dab45e4b8a39c2c2232b079838a42355d4039ac9096c1f4306a6a1935ff26f1',
    )
    assert.deepEqual(
      await verifyRelayEnvelope(
        'test-relay-secret-123',
        envelope,
        new Date('2026-09-19T08:00:00.000Z').getTime(),
      ),
      { ok: true, reason: 'OK' },
    )
  })

  void it('rejects expired timestamps', async () => {
    const envelope = await signRelayEnvelope(
      secret,
      timestamp,
      nonce,
      payload,
    )
    assert.deepEqual(
      (
        await verifyRelayEnvelope(
          secret,
          envelope,
          new Date(timestamp).getTime() + 10 * 60_000,
        )
      ).reason,
      'STALE_TIMESTAMP',
    )
  })
})

void describe('notification OAuth isolation', () => {
  void it('round-trips encrypted tokens', async () => {
    const keyBytes = Buffer.from(TOKEN_KEY, 'base64')
    const encrypted = await encryptNotifyToken(
      JSON.stringify({ accessToken: 'a', v: 1 }),
      keyBytes,
    )
    assert.ok(encrypted.startsWith('anv1:'))
    assert.equal(
      await decryptNotifyToken(
        encrypted,
        keyBytes,
      ),
      JSON.stringify({ accessToken: 'a', v: 1 }),
    )
  })

  void it('fails decryption with another key', async () => {
    const keyBytes = Buffer.from(TOKEN_KEY, 'base64')
    const other = crypto.getRandomValues(
      new Uint8Array(32),
    )
    const encrypted = await encryptNotifyToken(
      'secret-value',
      keyBytes,
    )
    await assert.rejects(
      decryptNotifyToken(encrypted, other),
    )
  })

  void it('rotates refresh tokens atomically in KV', async () => {
    const kv = createMemoryNotifyKv()
    const keyBytes = Buffer.from(TOKEN_KEY, 'base64')
    await storeNotifyOAuth(
      kv,
      {
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresAt: NOW_MS - 1_000,
      },
      keyBytes,
      NOW_MS,
    )
    const config = resolveNotifyConfig(
      baseEnvironment(),
    )
    const fetchImpl = async () =>
      jsonResponse({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      })
    const rotated = await refreshNotifyTokens(
      config,
      kv,
      (await loadNotifyOAuth(kv, keyBytes))!,
      NOW_MS,
      fetchImpl,
    )
    assert.ok(rotated)
    assert.equal(rotated.accessToken, 'new-access')
    assert.equal(rotated.refreshToken, 'new-refresh')
    assert.deepEqual(
      await loadNotifyOAuth(kv, keyBytes),
      rotated,
    )
  })

  void it('builds an authorize URL with notify scopes', async () => {
    const kv = createMemoryNotifyKv()
    const url = await buildNotifyAuthorizeUrl(
      resolveNotifyConfig(baseEnvironment()),
      kv,
      NOW_MS,
    )
    assert.ok(
      url.startsWith('https://auth.test/?'),
    )
    assert.equal(
      new URL(url).searchParams.get('scope'),
      'allegro:api:orders:read allegro:api:messaging allegro:api:profile:read',
    )
  })

  void it('exchanges a code only with a valid state', async () => {
    const kv = createMemoryNotifyKv()
    const config = resolveNotifyConfig(
      baseEnvironment(),
    )
    await buildNotifyAuthorizeUrl(
      config,
      kv,
      NOW_MS,
    )
    const fetchImpl = async () =>
      jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
      })
    assert.deepEqual(
      await exchangeNotifyCode(
        config,
        kv,
        'code',
        'bogus-state',
        NOW_MS,
        fetchImpl,
      ),
      { ok: false, status: 400 },
    )
  })
})

void describe('notification tick', () => {
  async function runTickWithRelay(
    relayStatus: number,
    environment: Record<
      string,
      string | undefined
    > = baseEnvironment(),
  ) {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    const relayPosts: Array<{
      to: string
      subject: string
    }> = []
    const inner = stubFetch([
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/events',
          ),
        respond: () =>
          jsonResponse(ORDER_EVENTS_FIXTURE),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/checkout-forms/',
          ),
        respond: (url) =>
          jsonResponse(
            checkoutFormFixture(
              url.split('/').pop() ?? 'ord-x',
            ),
          ),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/messaging/threads',
          ) && !url.includes('/messages'),
        respond: () => jsonResponse(THREADS_FIXTURE),
      },
      {
        match: (url) => url.includes('/messages'),
        respond: () =>
          jsonResponse(MESSAGES_FIXTURE),
      },
      {
        match: (url) =>
          url === 'https://relay.test/exec',
        respond: () => jsonResponse({ ok: true }),
      },
    ])
    const relayCalls: string[] = []
    const fetchImpl = async (
      input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (input === 'https://relay.test/exec') {
        relayCalls.push(input)
        const envelope = JSON.parse(
          String(init?.body ?? '{}'),
        ) as {
          payload: { to: string; subject: string }
        }
        relayPosts.push({
          to: envelope.payload.to,
          subject: envelope.payload.subject,
        })

        if (relayStatus !== 200) {
          return new Response('error', {
            status: relayStatus,
          })
        }

        return jsonResponse({ ok: true })
      }

      return inner.fetchImpl(input)
    }
    const summary = await runAllegroNotifyTick({
      environment,
      kv,
      fetchImpl,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })

    return { summary, kv, relayCalls, relayPosts }
  }

  void it('is disabled without any work when the flag is false', async () => {
    const kv = createMemoryNotifyKv()
    let calls = 0
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment({
        ALLEGRO_NOTIFY_ENABLED: 'false',
      }),
      kv,
      fetchImpl: async () => {
        calls += 1
        throw new Error('must not be called')
      },
      nowMs: NOW_MS,
    })

    assert.equal(summary.status, 'DISABLED')
    assert.equal(calls, 0)
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.lease),
      null,
    )
  })

  void it('needs bootstrap without a stored session', async () => {
    const kv = createMemoryNotifyKv()
    let calls = 0
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: async () => {
        calls += 1
        throw new Error('must not be called')
      },
      nowMs: NOW_MS,
    })

    assert.equal(summary.status, 'NEEDS_BOOTSTRAP')
    assert.equal(calls, 0)
  })

  void it('sends exactly one email per notifiable event', async () => {
    const { summary, relayPosts } =
      await runTickWithRelay(200)

    assert.equal(summary.status, 'OK')
    assert.equal(summary.orderEventsSeen, 5)
    assert.equal(summary.orderEmailsSent, 3)
    assert.equal(summary.orderEmailsFailed, 0)
    assert.equal(summary.messageEmailsSent, 1)
    assert.deepEqual(
      relayPosts.map((post) => post.subject),
      [
        '[ALLEGRO] ÚJ RENDELÉS – ord-2',
        '[ALLEGRO] TÖRLÉS – ord-3',
        '[ALLEGRO] TÖRLÉS – ord-4',
        '[ALLEGRO] ÜZENET – ord-2',
      ],
    )
    assert.deepEqual(
      relayPosts.map((post) => post.to),
      [
        'orders@example.com',
        'cancellations@example.com',
        'cancellations@example.com',
        'customerservice@example.com',
      ],
    )
  })

  void it('creates dedupe keys only on relay success', async () => {
    const failed = await runTickWithRelay(500)
    assert.equal(
      failed.summary.orderEmailsFailed,
      3,
    )
    assert.equal(
      failed.summary.orderEmailsSent,
      0,
    )
    assert.equal(
      await failed.kv.get(
        NOTIFY_KV_KEYS.sentOrder('ev-2'),
      ),
      null,
    )
    // ev-1 (BOUGHT, ignored) still advances the cursor;
    // the failed ev-2 blocks further advancement.
    assert.deepEqual(
      await failed.kv.get(NOTIFY_KV_KEYS.orderCursor),
      {
        lastId: 'ev-1',
        updatedAt: new Date(NOW_MS).toISOString(),
      },
    )

    const ok = await runTickWithRelay(200)
    assert.notEqual(
      await ok.kv.get(NOTIFY_KV_KEYS.sentOrder('ev-2')),
      null,
    )
  })

  void it('does not advance the cursor past a failed event', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    let attempt = 0
    const failingWrapped = async (
      input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (input === 'https://relay.test/exec') {
        attempt += 1

        if (attempt === 1) {
          return new Response('error', {
            status: 500,
          })
        }

        return jsonResponse({ ok: true })
      }

      const inner = stubFetch([
        {
          match: (url) =>
            url.startsWith(
              'https://api.test/order/events',
            ),
          respond: () =>
            jsonResponse({
              events: [
                {
                  id: 'ev-2',
                  type: 'READY_FOR_PROCESSING',
                  occurredAt:
                    '2026-09-19T07:02:00.000Z',
                  order: { id: 'ord-2' },
                },
                {
                  id: 'ev-3',
                  type: 'BUYER_CANCELLED',
                  occurredAt:
                    '2026-09-19T07:03:00.000Z',
                  order: { id: 'ord-3' },
                },
              ],
            }),
        },
        {
          match: () => true,
          respond: (url) =>
            url.includes('/messages') ||
            url.includes('/threads')
              ? jsonResponse({ messages: [] })
              : jsonResponse(
                  checkoutFormFixture('ord-x'),
                ),
        },
      ])

      return inner.fetchImpl(input)
    }

    const first = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: failingWrapped,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })
    assert.equal(first.orderEmailsFailed, 1)
    assert.equal(first.orderEmailsSent, 1)
    assert.equal(
      (
        (await kv.get(NOTIFY_KV_KEYS.orderCursor)) as {
          lastId: string
        } | null
      )?.lastId,
      'ev-0',
    )

    const second = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: failingWrapped,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })
    assert.equal(second.orderEmailsFailed, 0)
    assert.equal(second.orderEmailsSent, 1)
    assert.equal(
      (
        (await kv.get(NOTIFY_KV_KEYS.orderCursor)) as {
          lastId: string
        } | null
      )?.lastId,
      'ev-3',
    )
  })

  void it('duplicate second tick sends nothing new', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)

    const makeFetch = () => {
      let relayCalls = 0
      const inner = stubFetch([
        {
          match: (url) =>
            url.startsWith(
              'https://api.test/order/events',
            ),
          respond: () =>
            jsonResponse(ORDER_EVENTS_FIXTURE),
        },
        {
          match: (url) =>
            url.startsWith(
              'https://api.test/order/checkout-forms/',
            ),
          respond: (url) =>
            jsonResponse(
              checkoutFormFixture(
                url.split('/').pop() ?? 'ord-x',
              ),
            ),
        },
        {
          match: (url) =>
            url.startsWith(
              'https://api.test/messaging/threads',
            ) && !url.includes('/messages'),
          respond: () => jsonResponse(THREADS_FIXTURE),
        },
        {
          match: (url) =>
            url.includes('/messages'),
          respond: () =>
            jsonResponse(MESSAGES_FIXTURE),
        },
        {
          match: (url) =>
            url === 'https://relay.test/exec',
          respond: () => {
            relayCalls += 1
            return jsonResponse({ ok: true })
          },
        },
      ])

      return {
        fetchImpl: inner.fetchImpl,
        relayCalls: () => relayCalls,
      }
    }

    const first = makeFetch()
    const firstSummary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: first.fetchImpl,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })
    assert.equal(firstSummary.orderEmailsSent, 3)
    assert.equal(first.relayCalls(), 4)

    const second = makeFetch()
    const secondSummary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: second.fetchImpl,
      nowMs: NOW_MS + 600_000,
      nonce: 'fixed-test-nonce-2',
    })
    assert.equal(secondSummary.orderEmailsSent, 0)
    assert.equal(secondSummary.messageEmailsSent, 0)
    assert.equal(second.relayCalls(), 0)
  })

  void it('prevents overlapping ticks via the KV lease', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    await kv.set(NOTIFY_KV_KEYS.lease, {
      owner: 'other-tick',
    })
    let calls = 0
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: async () => {
        calls += 1
        throw new Error('must not be called')
      },
      nowMs: NOW_MS,
    })

    assert.equal(summary.status, 'LEASE_HELD')
    assert.equal(calls, 0)
  })

  void it('fails closed when a recipient is missing', async () => {
    const { summary, relayPosts } =
      await runTickWithRelay(
        200,
        baseEnvironment({
          ALLEGRO_NOTIFY_MESSAGE_EMAIL: '',
        }),
      )

    assert.equal(summary.orderEmailsSent, 3)
    assert.equal(summary.messageEmailsSent, 0)
    assert.equal(
      relayPosts.some((post) =>
        post.subject.startsWith('[ALLEGRO] ÜZENET'),
      ),
      false,
    )
  })

  void it('never stores customer data in KV', async () => {
    const stored: unknown[] = []
    const kv = createMemoryNotifyKv()
    const recording: NotifyKv = {
      get: (key) => kv.get(key),
      set: async (key, value, options) => {
        stored.push(value)
        await kv.set(key, value, options)
      },
      setIfAbsent: (key, value, options) =>
        kv.setIfAbsent(key, value, options),
      delete: (key) => kv.delete(key),
    }
    await seedSession(recording)
    await seedCursors(recording)
    const inner = stubFetch([
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/events',
          ),
        respond: () =>
          jsonResponse(ORDER_EVENTS_FIXTURE),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/checkout-forms/',
          ),
        respond: (url) =>
          jsonResponse(
            checkoutFormFixture(
              url.split('/').pop() ?? 'ord-x',
            ),
          ),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/messaging/threads',
          ) && !url.includes('/messages'),
        respond: () => jsonResponse(THREADS_FIXTURE),
      },
      {
        match: (url) => url.includes('/messages'),
        respond: () => jsonResponse(MESSAGES_FIXTURE),
      },
      {
        match: (url) =>
          url === 'https://relay.test/exec',
        respond: () => jsonResponse({ ok: true }),
      },
    ])
    await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv: recording,
      fetchImpl: inner.fetchImpl,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })

    const snapshot = JSON.stringify(stored)

    for (const forbidden of [
      'buyer42',
      'buyer42@example.com',
      '+3612345678',
      'Teszt Vevő',
      'Teszt Kft.',
      '12345678-2-41',
      'Fő utca 1.',
      'Cég utca 2.',
      '26451800',
      'Kérem óvatosan',
      'Hello',
      'szamla.pdf',
      'orders@example.com',
      'customerservice@example.com',
      'stub-access-token',
      'stub-refresh-token',
      'Karcher WD 5',
    ]) {
      assert.ok(
        !snapshot.includes(forbidden),
        `KV must not contain: ${forbidden}`,
      )
    }
  })

  void it('never logs customer data', async () => {
    const lines: string[] = []
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    }
    console.log = (...args: unknown[]) => {
      lines.push(
        args.map((part) => String(part)).join(' '),
      )
    }
    console.warn = console.log
    console.error = console.log

    try {
      await runTickWithRelay(200)
    } finally {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    }

    const snapshot = lines.join('\n')

    for (const forbidden of [
      'buyer42',
      'buyer42@example.com',
      '+3612345678',
      'Teszt Vevő',
      'Teszt Kft.',
      '12345678-2-41',
      'Fő utca 1.',
      'Cég utca 2.',
      '26451800',
      'Kérem óvatosan',
      'Hello',
      'orders@example.com',
      'stub-access-token',
      'relay-secret',
    ]) {
      assert.ok(
        !snapshot.includes(forbidden),
        `logs must not contain: ${forbidden}`,
      )
    }

    assert.ok(snapshot.includes('notify tick completed'))
  })

  void it('seeds cursors silently on first run', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    const inner = stubFetch([
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/events',
          ),
        respond: () =>
          jsonResponse(ORDER_EVENTS_FIXTURE),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/messaging/threads',
          ) && !url.includes('/messages'),
        respond: () => jsonResponse(THREADS_FIXTURE),
      },
      {
        match: (url) => url.includes('/messages'),
        respond: () => jsonResponse(MESSAGES_FIXTURE),
      },
      {
        match: () => true,
        respond: () => {
          throw new Error('relay must not be called')
        },
      },
    ])
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: inner.fetchImpl,
      nowMs: NOW_MS,
      nonce: 'fixed-test-nonce',
    })

    assert.equal(summary.orderEmailsSent, 0)
    assert.equal(summary.messageEmailsSent, 0)
    assert.equal(
      (
        (await kv.get(NOTIFY_KV_KEYS.orderCursor)) as {
          lastId: string
        } | null
      )?.lastId,
      'ev-5',
    )
  })

  void it('keeps the steady-state path free of database code', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(
      new URL('../src/allegro-notify.ts', import.meta.url),
      'utf8',
    )

    for (const forbidden of [
      '@karcher-commerce-hub/database',
      'createDatabase',
      'restoreAllegroSession',
      'initializeCommerceHubRuntime',
      'requireDatabase',
      "from './allegro-auth.js'",
    ]) {
      assert.ok(
        !source.includes(forbidden),
        `steady-state module must not reference: ${forbidden}`,
      )
    }
  })

  void it('serves notifications via pull/ack with no notify cron', async () => {
    const { readFileSync } = await import('node:fs')
    const denoSource = readFileSync(
      new URL('../src/deno.ts', import.meta.url),
      'utf8',
    )

    // Pull/ack architecture: a scheduled Apps Script client
    // drives delivery, so Deno registers NO notification
    // cron (the old Deno -> Web App relay got HTTP 401).
    // The KV store override below still wires Deno KV for
    // the pull/ack/queue routes served by Deno.serve.
    assert.ok(
      !denoSource.includes('commerce-hub-allegro-notify'),
    )
    assert.ok(
      !denoSource.includes('runAllegroNotifyCron'),
    )
    assert.ok(
      !denoSource.includes('runAllegroNotifyTick'),
    )
    assert.ok(
      denoSource.includes(
        'setNotifyKvStore(await openDenoNotifyKv())',
      ),
    )
  })

  void it('parses checkout forms defensively', () => {
    const detail = parseCheckoutForm(
      'ord-9',
      checkoutFormFixture('ord-9'),
    )
    assert.equal(detail.buyerLogin, 'buyer42')
    assert.equal(detail.productLines.length, 1)
    const empty = parseCheckoutForm('ord-9', null)
    assert.equal(empty.productLines.length, 0)
    assert.equal(empty.buyerLogin, null)
  })
})

void describe('notification email enrichment', () => {
  const orderEvent = {
    id: 'ev-9',
    type: 'READY_FOR_PROCESSING',
    occurredAt: '2026-09-19T07:02:00.000Z',
    orderId: 'ord-9',
    reason: null,
  }

  void it('builds a new-order email with customer, shipping and billing sections', () => {
    const detail = parseCheckoutForm(
      'ord-9',
      checkoutFormFixture('ord-9'),
    )
    const email = buildOrderEmail(
      'orders@example.com',
      orderEvent,
      detail,
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] ÚJ RENDELÉS – ord-9',
    )

    for (const part of [
      'VÁSÁRLÓ',
      'Teszt Vevő',
      'buyer42',
      'buyer42@example.com',
      '+3612345678',
      'SZÁLLÍTÁSI ADATOK',
      'Fő utca 1.',
      '1051',
      'Budapest',
      'GLS futár',
      '1990 HUF',
      'SZÁMLÁZÁSI ADATOK',
      'Számla igényelve',
      'Igen',
      'Teszt Kft.',
      'Cég utca 2.',
      '12345678-2-41',
      'RENDELÉS',
      'ONLINE (PAYU)',
      '129900 HUF',
      'Karcher WD 5 x2',
      '64950 HUF',
      'SKU/ajánlat: 26451800',
      'Kérem óvatosan csomagolni.',
    ]) {
      assert.ok(
        email.textBody.includes(part),
        `order email must contain: ${part}`,
      )
    }
  })

  void it('renders an order without billing data cleanly', () => {
    const detail = parseCheckoutForm('ord-9', {
      id: 'ord-9',
      boughtAt: '2026-09-19T07:02:00.000Z',
      buyer: { login: 'buyer42' },
      lineItems: [],
    })
    const email = buildOrderEmail(
      'orders@example.com',
      orderEvent,
      detail,
    )

    assert.ok(
      email.textBody.includes(
        'Számlázási adat: nincs külön megadva',
      ),
    )
    assert.ok(!email.textBody.includes('Adószám'))
    assert.ok(
      !email.textBody.includes('undefined'),
    )
    assert.ok(
      !email.htmlBody.includes('undefined'),
    )

    const declined = buildOrderEmail(
      'orders@example.com',
      orderEvent,
      parseCheckoutForm('ord-9', {
        id: 'ord-9',
        invoice: { required: false },
      }),
    )

    assert.ok(
      declined.textBody.includes('Számla igényelve: Nem'),
    )
    assert.ok(
      !declined.textBody.includes(
        'Számlázási adat: nincs külön megadva',
      ),
    )
  })

  void it('builds a cancellation email with customer, shipping and billing details', () => {
    const detail = parseCheckoutForm(
      'ord-9',
      checkoutFormFixture('ord-9'),
    )
    const email = buildCancellationEmail(
      'cancellations@example.com',
      'BUYER_CANCELLED',
      {
        ...orderEvent,
        type: 'BUYER_CANCELLED',
      },
      detail,
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] TÖRLÉS – ord-9',
    )

    for (const part of [
      'VÁSÁRLÓ',
      'Teszt Vevő',
      'buyer42@example.com',
      '+3612345678',
      'SZÁLLÍTÁSI ADATOK',
      'Fő utca 1.',
      'Budapest',
      'SZÁMLÁZÁSI ADATOK',
      'Teszt Kft.',
      '12345678-2-41',
      'TÖRLÉS',
      'BUYER_CANCELLED',
      'Karcher WD 5 x2',
      '129900 HUF',
    ]) {
      assert.ok(
        email.textBody.includes(part),
        `cancellation email must contain: ${part}`,
      )
    }

    assert.ok(
      !email.textBody.includes('Indok'),
    )
  })

  void it('builds a cancellation email without detail from event data only', () => {
    const email = buildCancellationEmail(
      'cancellations@example.com',
      'AUTO_CANCELLED',
      {
        ...orderEvent,
        type: 'AUTO_CANCELLED',
      },
      null,
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] TÖRLÉS – ord-9',
    )
    assert.ok(
      email.textBody.includes('AUTO_CANCELLED'),
    )
    assert.ok(
      !email.textBody.includes('VÁSÁRLÓ'),
    )
    assert.ok(
      !email.textBody.includes('undefined'),
    )
  })

  void it('adds a compact customer block to order-related buyer messages', () => {
    const detail = parseCheckoutForm(
      'ord-2',
      checkoutFormFixture('ord-2'),
    )
    const email = buildMessageEmail(
      'customerservice@example.com',
      {
        id: 'm-9',
        threadId: 'th-1',
        createdAt: '2026-09-19T07:11:00.000Z',
        authorIsInterlocutor: true,
        authorLogin: 'buyer42',
        text: 'Hol a csomagom?',
        attachmentNames: [],
        orderId: 'ord-2',
        offerId: null,
      },
      detail,
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] ÜZENET – ord-2',
    )
    assert.ok(email.textBody.includes('ÜGYFÉL'))
    assert.ok(
      email.textBody.includes('Teszt Vevő'),
    )
    assert.ok(
      email.textBody.includes(
        'buyer42@example.com',
      ),
    )
    assert.ok(
      email.textBody.includes('+3612345678'),
    )
    assert.ok(
      email.textBody.includes('Fő utca 1.'),
    )
    assert.ok(
      !email.textBody.includes('SZÁMLÁZÁSI ADATOK'),
    )
    assert.ok(
      !email.textBody.includes('Adószám'),
    )
  })

  void it('adds no customer block to messages without a related order', () => {
    const email = buildMessageEmail(
      'customerservice@example.com',
      {
        id: 'm-9',
        threadId: 'th-1',
        createdAt: '2026-09-19T07:11:00.000Z',
        authorIsInterlocutor: true,
        authorLogin: 'buyer42',
        text: 'Általános kérdés.',
        attachmentNames: [],
        orderId: null,
        offerId: 'off-9',
      },
    )

    assert.equal(
      email.subject,
      '[ALLEGRO] ÜZENET – off-9',
    )
    assert.ok(!email.textBody.includes('ÜGYFÉL'))
    assert.ok(
      !email.textBody.includes('Teszt Vevő'),
    )
  })

  void it('omits missing optional fields without placeholders', () => {
    const email = buildOrderEmail(
      'orders@example.com',
      orderEvent,
      emptyOrderDetail('ord-9', null),
    )

    assert.ok(
      !email.textBody.includes('undefined'),
    )
    assert.ok(
      !email.textBody.includes(': null'),
    )
    assert.ok(
      !email.htmlBody.includes('undefined'),
    )
    assert.ok(
      email.textBody.includes(
        'Számlázási adat: nincs külön megadva',
      ),
    )
  })

  void it('escapes customer-derived fields in HTML only', () => {
    const detail = parseCheckoutForm('ord-9', {
      id: 'ord-9',
      buyer: {
        login: 'buyer42',
        firstName: '<b>Teszt</b>',
        lastName: 'Vevő',
        email: 'buyer42@example.com',
        phoneNumber: '+3612345678',
      },
      delivery: {
        address: {
          street: '"Fő" utca & társa',
          city: 'Budapest',
        },
      },
      invoice: {
        required: true,
        address: {
          company: {
            name: 'Teszt <Kft.>',
            taxId: '123<x>',
          },
        },
      },
      lineItems: [],
    })
    const email = buildOrderEmail(
      'orders@example.com',
      orderEvent,
      detail,
    )

    for (const escaped of [
      '&lt;b&gt;Teszt&lt;/b&gt;',
      '&quot;Fő&quot; utca &amp; társa',
      'Teszt &lt;Kft.&gt;',
      '123&lt;x&gt;',
    ]) {
      assert.ok(
        email.htmlBody.includes(escaped),
        `HTML must escape: ${escaped}`,
      )
    }

    assert.ok(
      email.textBody.includes('<b>Teszt</b> Vevő'),
    )
    assert.ok(
      !email.htmlBody.includes('<b>Teszt</b>'),
    )
  })

  void it('fetches checkout-form details once per order per tick', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    let detailCalls = 0
    const inner = stubFetch([
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/events',
          ),
        respond: () =>
          jsonResponse({
            events: [
              {
                id: 'ev-1',
                type: 'READY_FOR_PROCESSING',
                occurredAt:
                  '2026-09-19T07:02:00.000Z',
                order: { id: 'ord-9' },
              },
              {
                id: 'ev-2',
                type: 'BUYER_CANCELLED',
                occurredAt:
                  '2026-09-19T07:03:00.000Z',
                order: { id: 'ord-9' },
              },
            ],
          }),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/checkout-forms/',
          ),
        respond: (url) => {
          detailCalls += 1
          return jsonResponse(
            checkoutFormFixture(
              url.split('/').pop() ?? 'ord-x',
            ),
          )
        },
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/messaging/threads',
          ),
        respond: () =>
          jsonResponse({ threads: [] }),
      },
      {
        match: (url) =>
          url === 'https://relay.test/exec',
        respond: () => jsonResponse({ ok: true }),
      },
    ])
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: inner.fetchImpl,
      nowMs: NOW_MS,
    })

    assert.equal(detailCalls, 1)
    assert.equal(summary.orderEmailsSent, 2)
    assert.equal(summary.orderEmailsFailed, 0)
  })
})

void describe('notification messaging pagination', () => {
  /* public.v1 allows limit 1..20 on both messaging
   * endpoints; larger limits are rejected with 422. IDs
   * are zero-padded because the cursor comparison is a
   * plain string comparison. */
  type PageMessage = {
    id: string
    orderId?: string
  }

  function buyerMessagePayload(message: PageMessage) {
    return {
      id: message.id,
      createdAt: '2026-09-19T07:11:00.000Z',
      author: {
        isInterlocutor: true,
        login: 'buyer42',
      },
      text: `Üzenet ${message.id}`,
      ...(message.orderId
        ? { orderId: message.orderId }
        : {}),
    }
  }

  async function runMessagingTick(options: {
    threadIds: string[]
    messagesByThread?: Record<string, PageMessage[]>
    threadStatus?: number
    seedCursors?: boolean
    seedMessageCursor?: string
  }) {
    const messagesByThread =
      options.messagesByThread ?? {}
    const threadStatus = options.threadStatus ?? 200
    const kv = createMemoryNotifyKv()
    await seedSession(kv)

    if (options.seedCursors !== false) {
      await seedCursors(kv)
    }

    if (options.seedMessageCursor) {
      await kv.set(NOTIFY_KV_KEYS.messageCursor, {
        lastId: options.seedMessageCursor,
        updatedAt: new Date(NOW_MS).toISOString(),
      })
    }

    const requests: Array<{
      url: string
      accept: string | null
    }> = []
    let relayCalls = 0
    const fetchImpl = async (
      input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({
        url: input,
        accept: new Headers(
          init?.headers,
        ).get('Accept'),
      })

      if (
        input.startsWith(
          'https://api.test/messaging/threads',
        ) &&
        !input.includes('/messages')
      ) {
        if (threadStatus !== 200) {
          return new Response('error', {
            status: threadStatus,
          })
        }

        const offset = Number(
          new URL(input).searchParams.get('offset') ??
            '0',
        )

        return jsonResponse({
          threads: options.threadIds
            .slice(offset, offset + 20)
            .map((id) => ({ id })),
        })
      }

      if (input.includes('/messages')) {
        const threadId = decodeURIComponent(
          input.match(
            /threads\/([^/]+)\/messages/,
          )?.[1] ?? '',
        )
        const offset = Number(
          new URL(input).searchParams.get('offset') ??
            '0',
        )
        const page = (
          messagesByThread[threadId] ?? []
        ).slice(offset, offset + 20)

        return jsonResponse({
          messages: page.map((message) =>
            buyerMessagePayload(message),
          ),
        })
      }

      if (input === 'https://relay.test/exec') {
        relayCalls += 1
        return jsonResponse({ ok: true })
      }

      if (
        input.startsWith(
          'https://api.test/order/events',
        )
      ) {
        return jsonResponse({ events: [] })
      }

      if (
        input.startsWith(
          'https://api.test/order/checkout-forms/',
        )
      ) {
        return jsonResponse(
          checkoutFormFixture(
            input.split('/').pop() ?? 'ord-x',
          ),
        )
      }

      throw new Error(`Unexpected fetch: ${input}`)
    }
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl,
      nowMs: NOW_MS,
    })

    return { summary, requests, relayCalls, kv }
  }

  function messagingUrls(
    requests: Array<{ url: string }>,
    segment: string,
  ) {
    return requests
      .map((request) => request.url)
      .filter((url) => url.includes(segment))
  }

  void it('uses the public.v1 Accept header on both messaging endpoints', async () => {
    const { requests } = await runMessagingTick({
      threadIds: ['th-1'],
      messagesByThread: {
        'th-1': [{ id: 'm-01' }],
      },
    })
    const threadUrls = messagingUrls(
      requests,
      '/messaging/threads?',
    )
    const messageUrls = messagingUrls(
      requests,
      '/messages?',
    )

    assert.ok(threadUrls.length > 0)
    assert.ok(messageUrls.length > 0)

    for (const url of [...threadUrls, ...messageUrls]) {
      assert.equal(
        requests.find(
          (request) => request.url === url,
        )?.accept,
        'application/vnd.allegro.public.v1+json',
      )
    }
  })

  void it('keeps thread and message limits at or below 20 with supported params only', async () => {
    const { requests } = await runMessagingTick({
      threadIds: ['th-1'],
      messagesByThread: {
        'th-1': [{ id: 'm-01' }],
      },
    })

    for (const url of messagingUrls(
      requests,
      '/messaging/threads?',
    )) {
      const params = new URL(url).searchParams
      assert.ok(Number(params.get('limit')) <= 20)
      assert.deepEqual(
        [...params.keys()].sort(),
        ['limit', 'offset'],
      )
    }

    for (const url of messagingUrls(
      requests,
      '/messages?',
    )) {
      const params = new URL(url).searchParams
      assert.ok(Number(params.get('limit')) <= 20)
    }
  })

  void it('paginates across more than 20 threads', async () => {
    const threadIds = Array.from(
      { length: 25 },
      (_, index) =>
        `th-${String(index).padStart(2, '0')}`,
    )
    const { requests, summary } =
      await runMessagingTick({ threadIds })
    const threadUrls = messagingUrls(
      requests,
      '/messaging/threads?',
    )
    const offsets = threadUrls.map(
      (url) =>
        new URL(url).searchParams.get('offset'),
    )

    assert.deepEqual(offsets, ['0', '20'])
    assert.ok(
      requests.some((request) =>
        request.url.includes(
          '/threads/th-24/messages',
        ),
      ),
      'page-2 threads must be scanned',
    )
    assert.equal(summary.messagesSeen, 0)
    assert.equal(summary.messageEmailsSent, 0)
  })

  void it('paginates messages within one thread', async () => {
    const messages = Array.from(
      { length: 25 },
      (_, index) => ({
        id: `m-${String(index + 1).padStart(2, '0')}`,
      }),
    )
    const { requests, summary } =
      await runMessagingTick({
        threadIds: ['th-1'],
        messagesByThread: { 'th-1': messages },
      })
    const messageUrls = messagingUrls(
      requests,
      '/messages?',
    )
    const offsets = messageUrls.map(
      (url) =>
        new URL(url).searchParams.get('offset'),
    )

    assert.deepEqual(offsets, ['0', '20'])
    assert.equal(summary.messagesSeen, 25)
    assert.equal(summary.messageEmailsSent, 25)
  })

  void it('seeds the first successful message run without sending history', async () => {
    const { summary, kv } = await runMessagingTick({
      threadIds: ['th-1'],
      messagesByThread: {
        'th-1': [{ id: 'm-01' }, { id: 'm-02' }],
      },
      seedCursors: false,
    })

    assert.equal(summary.messageEmailsSent, 0)
    assert.equal(summary.messageEmailsFailed, 0)
    assert.deepEqual(
      await kv.get(NOTIFY_KV_KEYS.messageCursor),
      {
        lastId: 'm-02',
        updatedAt: new Date(NOW_MS).toISOString(),
      },
    )
    assert.equal(
      await kv.get(NOTIFY_KV_KEYS.orderCursor),
      null,
    )
  })

  void it('keeps the order cursor untouched when the thread poll fails', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: 'ev-9',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const fetchImpl = async (
      input: string,
    ): Promise<Response> => {
      if (
        input.startsWith(
          'https://api.test/messaging/threads',
        )
      ) {
        return new Response('error', { status: 422 })
      }

      if (
        input.startsWith(
          'https://api.test/order/events',
        )
      ) {
        return jsonResponse({ events: [] })
      }

      throw new Error(`Unexpected fetch: ${input}`)
    }
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl,
      nowMs: NOW_MS,
    })

    assert.equal(summary.status, 'OK')
    assert.equal(summary.messagesSeen, 0)
    assert.equal(summary.messageEmailsSent, 0)
    assert.equal(summary.messageEmailsFailed, 0)
    assert.deepEqual(
      await kv.get(NOTIFY_KV_KEYS.orderCursor),
      {
        lastId: 'ev-9',
        updatedAt: new Date(NOW_MS).toISOString(),
      },
    )
    assert.deepEqual(
      await kv.get(NOTIFY_KV_KEYS.messageCursor),
      {
        lastId: 'm-0',
        updatedAt: new Date(NOW_MS).toISOString(),
      },
    )
  })

  void it('sends a post-seed buyer message exactly once', async () => {
    const options = {
      threadIds: ['th-1'],
      messagesByThread: {
        'th-1': [{ id: 'm-01' }, { id: 'm-02' }],
      },
      seedMessageCursor: 'm-01',
    }
    const first = await runMessagingTick(options)

    assert.equal(first.summary.messageEmailsSent, 1)
    assert.equal(first.relayCalls, 1)

    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: 'm-02',
      updatedAt: new Date(NOW_MS).toISOString(),
    })
    const requests: string[] = []
    const second = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: (async (input: string) => {
        requests.push(input)

        if (
          input.startsWith(
            'https://api.test/messaging/threads',
          ) &&
          !input.includes('/messages')
        ) {
          return jsonResponse({
            threads: [{ id: 'th-1' }],
          })
        }

        if (input.includes('/messages')) {
          return jsonResponse({
            messages: [
              buyerMessagePayload({ id: 'm-01' }),
              buyerMessagePayload({ id: 'm-02' }),
            ],
          })
        }

        if (
          input.startsWith(
            'https://api.test/order/events',
          )
        ) {
          return jsonResponse({ events: [] })
        }

        throw new Error(
          `relay must not be called: ${input}`,
        )
      }) as (
        input: string,
        init?: RequestInit,
      ) => Promise<Response>,
      nowMs: NOW_MS,
    })

    assert.equal(second.messageEmailsSent, 0)
    assert.equal(second.messageEmailsFailed, 0)
    assert.ok(
      !requests.some((url) =>
        url.includes('relay.test'),
      ),
    )
  })

  void it('does not fetch order details for messages without a related order', async () => {
    const kv = createMemoryNotifyKv()
    await seedSession(kv)
    await seedCursors(kv)
    let detailCalls = 0
    const inner = stubFetch([
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/events',
          ),
        respond: () => jsonResponse({ events: [] }),
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/order/checkout-forms/',
          ),
        respond: () => {
          detailCalls += 1
          return jsonResponse({})
        },
      },
      {
        match: (url) =>
          url.startsWith(
            'https://api.test/messaging/threads',
          ) && !url.includes('/messages'),
        respond: () =>
          jsonResponse({ threads: [{ id: 'th-9' }] }),
      },
      {
        match: (url) => url.includes('/messages'),
        respond: () =>
          jsonResponse({
            messages: [
              {
                id: 'm-9',
                createdAt:
                  '2026-09-19T07:11:00.000Z',
                author: {
                  isInterlocutor: true,
                  login: 'buyer42',
                },
                text: 'Általános kérdés.',
              },
            ],
          }),
      },
      {
        match: (url) =>
          url === 'https://relay.test/exec',
        respond: () => jsonResponse({ ok: true }),
      },
    ])
    const summary = await runAllegroNotifyTick({
      environment: baseEnvironment(),
      kv,
      fetchImpl: inner.fetchImpl,
      nowMs: NOW_MS,
    })

    assert.equal(detailCalls, 0)
    assert.equal(summary.messageEmailsSent, 1)
    assert.equal(summary.messageEmailsFailed, 0)
  })
})
