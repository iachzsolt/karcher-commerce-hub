/*
 * Missing Allegro offers: detail-404 verification gap and offer-debug
 * upstream error reporting.
 *
 * The real /sync and /offer-debug routes run here. The network is fully
 * isolated: environment variables point at invented `*.test` hosts and
 * `globalThis.fetch` answers only those hosts (fake Allegro API and a fake
 * Neon HTTP endpoint); anything else throws. No production endpoint can be
 * reached.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

// Must be set before the application modules (and dotenv) load.
process.env.ALLEGRO_ENV = 'PRODUCTION'
process.env.ALLEGRO_API_URL = 'https://api.allegro.test'
process.env.ALLEGRO_AUTH_URL = 'https://allegro.test/auth/oauth/authorize'
process.env.ALLEGRO_TOKEN_URL = 'https://allegro.test/auth/oauth/token'
process.env.ALLEGRO_USER_AGENT = 'commerce-hub-test'
process.env.ALLEGRO_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64')
process.env.DATABASE_URL = 'postgresql://test:test@ep-test.neon.test/testdb'

const { allegroAuth, restoreAllegroSession } = await import('../src/allegro-auth.ts')
const { encryptSecret } = await import('../src/token-crypto.ts')
const { evaluateSyncChunk, unverifiedListings } = await import('../src/allegro-remote-verification.ts')
const { lookupOfferDetail, offerDebugUpstreamError, sanitizeRetryAfter } = await import('../src/allegro-offer-detail.ts')
const { syncAllegroInventoryRows } = await import('../src/allegro-inventory-sync.ts')
const { createSliceBudget, INVENTORY_REFRESH_SLICE_DEFAULTS } = await import('../src/inventory-refresh-slice.ts')

type AllegroInventorySyncRow = Parameters<typeof syncAllegroInventoryRows>[1][number]

const ACCESS_TOKEN = 'test-access-token-never-in-responses'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'

/* ------------------------------------------------------------------ *
 * Network isolation: fake Allegro + fake Neon HTTP
 * ------------------------------------------------------------------ */

type Offer = { id: string; sku: string; listStatus: string; stock: number }
type DetailBehavior = { status: number; publication?: string; body?: string; retryAfter?: string } | 'TIMEOUT' | 'NETWORK'

const state = {
  offers: [] as Offer[],
  detail: new Map<string, DetailBehavior>(),
  queries: [] as Array<{ query: string; params: unknown[] }>,
  allegroRequests: [] as Array<{ url: string; authorization: string | null }>,
}

const listingIdFor = (offerId: string) => `00000000-0000-4000-8000-${offerId.padStart(12, '0').slice(-12)}`

function sqlResponse(query: string, params: unknown[]) {
  const rows = (values: unknown[][]) => ({
    fields: (values[0] ?? []).map((_, index) => ({ name: `c${index}`, dataTypeID: 25 })),
    rows: values,
    command: 'SELECT',
    rowCount: values.length,
  })

  if (/from "platform_account_credentials"/.test(query)) {
    return rows([[
      ACCOUNT_ID, 'Karcher_Hungaria', '12345', 'allegro-hu',
      encryptSecret(ACCESS_TOKEN), encryptSecret('refresh-token'),
      new Date(Date.now() + 3_600_000).toISOString(),
    ]])
  }
  if (/from "platforms"/.test(query)) return rows([['22222222-2222-4222-8222-222222222222']])
  if (/insert into "platform_accounts"/.test(query)) return rows([[ACCOUNT_ID]])
  if (/insert into "products"/.test(query)) return rows([['33333333-3333-4333-8333-333333333333']])
  if (/insert into "platform_listings"/.test(query)) {
    const offerId = params.find(value => typeof value === 'string' && state.offers.some(offer => offer.id === value))
    return rows([[listingIdFor(String(offerId))]])
  }
  return { fields: [], rows: [], command: 'SELECT', rowCount: 0 }
}

const realFetch = globalThis.fetch

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)

    if (url.hostname.endsWith('.neon.test') && url.pathname === '/sql') {
      const body = JSON.parse(String(init?.body)) as { query: string; params: unknown[] }
      state.queries.push(body)
      return new Response(JSON.stringify(sqlResponse(body.query, body.params)), { status: 200 })
    }

    if (url.hostname === 'api.allegro.test') {
      const headers = new Headers(init?.headers)
      state.allegroRequests.push({ url: url.href, authorization: headers.get('Authorization') })

      if (url.pathname === '/sale/offers') {
        const ids = url.searchParams.getAll('offer.id')
        const offers = state.offers.filter(offer => ids.includes(offer.id)).map(offer => ({
          id: offer.id,
          name: `Offer ${offer.id}`,
          external: { id: offer.sku },
          publication: { status: offer.listStatus },
          stock: { available: offer.stock, sold: 0 },
          sellingMode: { price: { amount: '1000.00', currency: 'HUF' } },
        }))
        return new Response(JSON.stringify({ offers, totalCount: offers.length }), { status: 200 })
      }

      const detailMatch = /^\/sale\/product-offers\/(.+)$/.exec(url.pathname)
      if (detailMatch) {
        const behavior = state.detail.get(decodeURIComponent(detailMatch[1])) ?? { status: 200, publication: 'ACTIVE' }
        if (behavior === 'TIMEOUT') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        if (behavior === 'NETWORK') throw new TypeError('fetch failed')
        const responseHeaders = behavior.retryAfter ? { 'Retry-After': behavior.retryAfter } : undefined
        const body = behavior.body ?? (behavior.status === 200
          ? JSON.stringify({ id: detailMatch[1], publication: { status: behavior.publication } })
          : JSON.stringify({ errors: [{ code: 'NOT_FOUND', message: 'Offer does not exist.', userMessage: 'Nincs ilyen ajánlat' }] }))
        return new Response(body, { status: behavior.status, headers: responseHeaders })
      }
    }

    throw new Error(`Network isolation: unexpected request to ${url.href}`)
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

beforeEach(() => {
  state.offers = []
  state.detail = new Map()
  state.queries = []
  state.allegroRequests = []
})

function offer(id: string, overrides: Partial<Offer> = {}): Offer {
  return { id, sku: `SKU-${id}`, listStatus: 'ACTIVE', stock: 5, ...overrides }
}

async function sync(offerIds: string[], partial: boolean) {
  const response = await allegroAuth.request('/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ offerIds, partial }),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> & {
    verification: { verified: Array<{ offerId: string; listingId: string; publicationSource?: string }>; unverified: Array<{ offerId: string; reason: string }> }
  } }
}

const writesFor = (offerId: string) => state.queries.filter(entry =>
  /^insert into "(products|platform_listings|listing_remote_states|listing_price_history|listing_desired_states|allegro_change_events)"/.test(entry.query) &&
  JSON.stringify(entry.params).includes(offerId),
)
const remoteStateWrites = () => state.queries.filter(entry => /^insert into "listing_remote_states"/.test(entry.query))

/* ------------------------------------------------------------------ *
 * Pure classification
 * ------------------------------------------------------------------ */

void describe('lookupOfferDetail', () => {
  const respond = (status: number, body = '{}') => async () => new Response(body, { status })

  void it('distinguishes an explicit 404 from every other failure', async () => {
    assert.deepEqual(await lookupOfferDetail(respond(404)), { kind: 'NOT_FOUND', httpStatus: 404 })
    assert.deepEqual(await lookupOfferDetail(respond(401)), { kind: 'UNAVAILABLE', httpStatus: 401, failure: 'AUTH' })
    assert.deepEqual(await lookupOfferDetail(respond(403)), { kind: 'UNAVAILABLE', httpStatus: 403, failure: 'AUTH' })
    assert.deepEqual(await lookupOfferDetail(respond(429)), { kind: 'UNAVAILABLE', httpStatus: 429, failure: 'RATE_LIMITED' })
    assert.deepEqual(await lookupOfferDetail(respond(503)), { kind: 'UNAVAILABLE', httpStatus: 503, failure: 'UPSTREAM_ERROR' })
    assert.deepEqual(await lookupOfferDetail(respond(200, 'not json')), { kind: 'UNAVAILABLE', httpStatus: 200, failure: 'INVALID_RESPONSE' })
    assert.deepEqual(
      await lookupOfferDetail(async () => { throw new DOMException('timeout', 'TimeoutError') }),
      { kind: 'UNAVAILABLE', httpStatus: null, failure: 'TIMEOUT' },
    )
    assert.deepEqual(
      await lookupOfferDetail(async () => { throw new TypeError('fetch failed') }),
      { kind: 'UNAVAILABLE', httpStatus: null, failure: 'REQUEST_FAILED' },
    )
    assert.deepEqual(
      await lookupOfferDetail(respond(200, JSON.stringify({ publication: { status: 'ENDED' } }))),
      { kind: 'FOUND', publicationStatus: 'ENDED' },
    )
  })
})

/* ------------------------------------------------------------------ *
 * offer-debug (behavioral, real route)
 * ------------------------------------------------------------------ */

void describe('offer-debug upstream error reporting', () => {
  void it('answers 401 without any Allegro call while no session is connected', async () => {
    const response = await allegroAuth.request('/offer-debug/999')
    assert.equal(response.status, 401)
    assert.equal(state.allegroRequests.length, 0)
  })

  void it('restores a session from the (fake) credential store', async () => {
    assert.equal(await restoreAllegroSession(), true)
  })

  void it('maps an upstream 404 to 404 with structured Allegro errors', async () => {
    state.detail.set('18673463241', { status: 404 })
    const response = await allegroAuth.request('/offer-debug/18673463241')
    const text = await response.text()
    const body = JSON.parse(text)

    assert.equal(response.status, 404)
    assert.equal(body.error, 'OFFER_NOT_FOUND')
    assert.equal(body.upstreamStatus, 404)
    assert.equal(body.allegroStatus, 404, 'kept for existing readers')
    assert.equal(body.allegroErrors[0].code, 'NOT_FOUND')
    assert.equal(text.includes(ACCESS_TOKEN), false, 'no token in the response')
  })

  void it('maps an upstream 429 to 429 and forwards a valid Retry-After only', async () => {
    state.detail.set('a', { status: 429, retryAfter: '30', body: '{}' })
    const limited = await allegroAuth.request('/offer-debug/a')
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('Retry-After'), '30')
    assert.equal((await limited.json()).error, 'RATE_LIMITED')

    state.detail.set('b', { status: 429, retryAfter: 'soon; please <script>', body: '{}' })
    const invalid = await allegroAuth.request('/offer-debug/b')
    assert.equal(invalid.status, 429)
    assert.equal(invalid.headers.get('Retry-After'), null)
  })

  void it('keeps 502 for other upstream failures with the original upstream status', async () => {
    state.detail.set('c', {
      status: 503,
      body: JSON.stringify({ errors: [{ code: 'SERVICE_UNAVAILABLE', message: 'Try later', internal: 'dropped' }] }),
    })
    const response = await allegroAuth.request('/offer-debug/c')
    const body = await response.json()
    assert.equal(response.status, 502)
    assert.equal(body.error, 'UPSTREAM_ERROR')
    assert.equal(body.upstreamStatus, 503)
    assert.equal(body.allegroErrors[0].code, 'SERVICE_UNAVAILABLE')
    assert.equal('internal' in body.allegroErrors[0], false)
  })

  void it('keeps the successful response shape unchanged', async () => {
    state.detail.set('d', { status: 200, publication: 'ACTIVE' })
    const response = await allegroAuth.request('/offer-debug/d')
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(body).sort(), ['data', 'offerId', 'status'])
    assert.equal(body.data.publication.status, 'ACTIVE')
  })

  void it('uses only the connected session token and never echoes it', async () => {
    state.detail.set('e', { status: 404 })
    const response = await allegroAuth.request('/offer-debug/e')
    assert.equal((await response.text()).includes(ACCESS_TOKEN), false)
    assert.equal(response.headers.get('Authorization'), null)
    assert.equal(state.allegroRequests.length, 1)
    assert.ok(state.allegroRequests.every(request => request.authorization === `Bearer ${ACCESS_TOKEN}`))
    assert.equal(sanitizeRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), 'Wed, 21 Oct 2026 07:28:00 GMT')
    assert.equal(sanitizeRetryAfter('1'.repeat(80)), null)
    assert.equal(offerDebugUpstreamError({ offerId: 'x', upstreamStatus: 500, retryAfter: '9', bodyText: '' }).retryAfter, null)
  })
})

/* ------------------------------------------------------------------ *
 * /sync partial flow: detail 404 (behavioral, real route)
 * ------------------------------------------------------------------ */

void describe('/sync detail 404 in the partial flow', () => {
  void it('keeps a listing unverified and writes nothing for it, while other offers verify', async () => {
    state.offers = [offer('ok-1'), offer('gone-1')]
    state.detail.set('gone-1', { status: 404 })

    const { status, body } = await sync(['ok-1', 'gone-1'], true)

    assert.equal(status, 200)
    assert.deepEqual(body.verification.unverified, [{ offerId: 'gone-1', reason: 'OFFER_NOT_FOUND' }])
    assert.deepEqual(body.verification.verified, [
      { offerId: 'ok-1', listingId: listingIdFor('ok-1'), publicationSource: 'DETAIL' },
    ])
    assert.deepEqual(writesFor('gone-1'), [], 'no product, listing, remote-state or history write for the 404 offer')
    assert.equal(remoteStateWrites().length, 1, 'only the verified offer advances last_synced_at')
    assert.ok(writesFor('ok-1').length > 0)
  })

  void it('never falls back to the bulk-list status after an explicit 404 (list says ACTIVE)', async () => {
    state.offers = [offer('gone-2', { listStatus: 'ACTIVE' })]
    state.detail.set('gone-2', { status: 404 })

    const { body } = await sync(['gone-2'], true)

    assert.deepEqual(body.verification.verified, [])
    assert.equal(remoteStateWrites().length, 0)
  })

  void it('uses the detail status when the detail GET succeeds (existing behavior)', async () => {
    state.offers = [offer('ended-1', { listStatus: 'ACTIVE' })]
    state.detail.set('ended-1', { status: 200, publication: 'ENDED' })

    const { body } = await sync(['ended-1'], true)

    assert.equal(body.verification.verified[0].publicationSource, 'DETAIL')
    const write = remoteStateWrites()[0]
    assert.ok(write.params.includes('ENDED'), 'publication status from the detail is persisted')
  })

  for (const behavior of [
    { label: '401', value: { status: 401 } },
    { label: '403', value: { status: 403 } },
    { label: '429', value: { status: 429 } },
    { label: '5xx', value: { status: 500 } },
    { label: 'timeout', value: 'TIMEOUT' as const },
    { label: 'network error', value: 'NETWORK' as const },
  ]) {
    void it(`documents the unchanged list fallback for a detail ${behavior.label}`, async () => {
      state.offers = [offer('flaky-1')]
      state.detail.set('flaky-1', behavior.value)

      const { body } = await sync(['flaky-1'], true)

      // Stock and list status come from this same, successful bulk read; only
      // the publication refinement failed, so the offer stays verified.
      assert.deepEqual(body.verification.verified, [
        { offerId: 'flaky-1', listingId: listingIdFor('flaky-1'), publicationSource: 'LIST' },
      ])
    })
  }

  void it('keeps the previous behavior for non-partial callers (404 falls back to the list)', async () => {
    state.offers = [offer('gone-3')]
    state.detail.set('gone-3', { status: 404 })

    const { body } = await sync(['gone-3'], false)

    assert.equal(body.verification.verified[0].publicationSource, 'LIST')
    assert.equal(remoteStateWrites().length, 1)
  })
})

/* ------------------------------------------------------------------ *
 * Downstream: the real /sync report drives the inventory decisions
 * ------------------------------------------------------------------ */

void describe('inventory decisions after a detail 404', () => {
  const chain = (result: unknown): unknown => new Proxy(function () {}, {
    get: (_target, property) => property === 'then'
      ? (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result).then(resolve, reject)
      : () => chain(result),
  })

  function fakeDatabase(stockJournal: unknown[] = []) {
    const inserted: Array<Record<string, unknown>> = []
    let updates = 0
    return {
      inserted,
      updates: () => updates,
      database: {
        select: (fields: Record<string, unknown>) =>
          chain('metadataJson' in fields && !('oldValue' in fields) ? stockJournal : []),
        insert: () => ({ values: (values: unknown) => {
          inserted.push(...(Array.isArray(values) ? values : [values]) as Array<Record<string, unknown>>)
          return chain(undefined)
        } }),
        update: () => { updates += 1; return chain([]) },
      } as unknown as Parameters<typeof syncAllegroInventoryRows>[0],
    }
  }

  function recorder() {
    const calls: string[] = []
    return {
      calls,
      adapter: {
        pushStock: async (listingId: string) => { calls.push(`pushStock:${listingId}`); return { ok: true, status: 200, details: { status: 'ok' } } },
        pushStatus: async (listingId: string) => { calls.push(`pushStatus:${listingId}`); return { ok: true, status: 200, details: { status: 'ok' } } },
        reconcileOwnership: async (listingId: string) => { calls.push(`reconcileOwnership:${listingId}`); return { cleared: false } },
        refresh: async () => ({ ok: true, details: null }),
      },
    }
  }

  function row(offerId: string, overrides: Partial<AllegroInventorySyncRow> = {}): AllegroInventorySyncRow {
    return {
      sku: `SKU-${offerId}`, listingId: listingIdFor(offerId), offerId,
      targetStock: 9, remoteStock: 5, desiredStock: 9,
      stockLocked: false, stockAutoPaused: false, autoStockSync: true,
      publicationStatus: 'ACTIVE', desiredPublicationStatus: 'ACTIVE',
      duplicateOfferCount: 1, sourceMissing: false,
      ...overrides,
    }
  }

  /** Run the real /sync (partial) and map its report onto rows exactly like /inventory-sync. */
  async function verify(rows: AllegroInventorySyncRow[]) {
    const offerIds = rows.map(entry => entry.offerId!)
    const { status, body } = await sync(offerIds, true)
    return unverifiedListings(rows, evaluateSyncChunk(offerIds, { ok: status < 300, status, body }))
  }

  const sliced = () => ({ slice: createSliceBudget(INVENTORY_REFRESH_SLICE_DEFAULTS, 0), sliceWait: async () => {}, now: () => 0 })

  void it('blocks stock mutations for the 404 listing and keeps verified ones running', async () => {
    state.offers = [offer('gone-4'), offer('ok-4')]
    state.detail.set('gone-4', { status: 404 })
    const rows = [row('gone-4'), row('ok-4')]
    const unverified = await verify(rows)
    assert.deepEqual([...unverified], [[listingIdFor('gone-4'), 'OFFER_NOT_FOUND']])

    const db = fakeDatabase()
    const spy = recorder()
    const result = await syncAllegroInventoryRows(db.database, rows, spy.adapter, { ...sliced(), remoteUnverified: unverified })

    assert.deepEqual(spy.calls, [`pushStock:${listingIdFor('ok-4')}`])
    const gone = result.results.find(entry => entry.listingId === listingIdFor('gone-4'))
    assert.equal(gone?.status, 'REMOTE_UNVERIFIED')
    assert.equal(gone?.reason, 'OFFER_NOT_FOUND')
  })

  void it('blocks publication mutations (reactivation of an auto-paused offer) after a 404', async () => {
    state.offers = [offer('gone-5', { listStatus: 'ENDED' })]
    state.detail.set('gone-5', { status: 404 })
    const rows = [row('gone-5', { publicationStatus: 'ENDED', stockAutoPaused: true, desiredPublicationStatus: 'INACTIVE', remoteStock: 158, targetStock: 169 })]
    const unverified = await verify(rows)

    const db = fakeDatabase()
    const spy = recorder()
    await syncAllegroInventoryRows(db.database, rows, spy.adapter, { ...sliced(), remoteUnverified: unverified })

    assert.deepEqual(spy.calls, [], 'no stock push, no ACTIVATE, no ownership reconciliation')
    assert.equal(db.updates(), 0, 'desired publication and auto-pause markers untouched')
  })

  void it('does not reconcile a pending journal from the invalidated observation', async () => {
    state.offers = [offer('gone-6')]
    state.detail.set('gone-6', { status: 404 })
    const rows = [row('gone-6', { remoteStock: 7, targetStock: 7 })]
    const unverified = await verify(rows)

    const db = fakeDatabase([{
      listingId: listingIdFor('gone-6'),
      newValue: 'PENDING',
      metadataJson: JSON.stringify({ commandId: 'c37c8fcf-5def-48a4-9252-7a70a0ed5fcb', offerId: 'gone-6', toStock: 7 }),
    }])
    const spy = recorder()
    await syncAllegroInventoryRows(db.database, rows, spy.adapter, { ...sliced(), remoteUnverified: unverified })

    assert.deepEqual(spy.calls, [])
    assert.equal(db.inserted.filter(event => event.eventType === 'STOCK_OPERATION').length, 0,
      'the cached stock (7) matching toStock must not close the command')
  })

  for (const publicationStatus of ['ACTIVE', 'ACTIVATING'] as const) {
    void it(`preserves the B1 zero-stock failure for a cached ${publicationStatus} listing with detail 404`, async () => {
      state.offers = [offer('gone-7')]
      state.detail.set('gone-7', { status: 404 })
      const rows = [row('gone-7', { publicationStatus, targetStock: 0, remoteStock: 4 })]
      const unverified = await verify(rows)

      const spy = recorder()
      const result = await syncAllegroInventoryRows(fakeDatabase().database, rows, spy.adapter, { ...sliced(), remoteUnverified: unverified })

      assert.deepEqual(spy.calls, [])
      assert.equal(result.summary.failed, 1)
      assert.equal(result.results[0].reason, 'REMOTE_UNVERIFIED_ZERO_STOCK')
      assert.equal(result.results[0].verificationReason, 'OFFER_NOT_FOUND')
    })
  }

  void it('preserves exact listing identity: a verified offer persisted for another listing does not authorize', async () => {
    state.offers = [offer('ok-8')]
    const rows = [row('ok-8', { listingId: '99999999-9999-4999-8999-999999999999' })]
    const unverified = await verify(rows)
    assert.deepEqual([...unverified], [['99999999-9999-4999-8999-999999999999', 'VERIFICATION_IDENTITY_MISMATCH']])
  })
})
