/*
 * Allegro -> email notification bridge (V1, pull/ack).
 *
 * ONE Allegro event = ONE email. Transport direction is
 * Apps Script -> Commerce Hub: a scheduled Apps Script
 * client PULLs at most one pending notification per
 * request, sends it with GmailApp.sendEmail({ noReply:
 * true }), then ACKs. Only a valid ACK marks the event
 * delivered and advances the cursor.
 *
 * This module is intentionally isolated:
 *
 * - No Neon/database imports. The steady-state pull/ack
 *   path performs ZERO Neon queries; all technical state
 *   lives in Deno KV.
 * - No shared state with the primary Commerce Hub Allegro
 *   OAuth session: the notification session has its own
 *   scopes, its own refresh token, and its own encryption
 *   key (ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY).
 * - No customer/order/message payload is persisted anywhere
 *   or logged. Payloads exist in memory only while the
 *   current email is built, plus inside the single HTTPS
 *   EMAIL response to the HMAC-authenticated Apps Script
 *   client. KV holds technical state only (cursors,
 *   delivered IDs, one pending claim, replay nonces).
 */

export const ALLEGRO_NOTIFY_SCOPES = [
  'allegro:api:orders:read',
  'allegro:api:messaging',
  'allegro:api:profile:read',
] as const

const PUBLIC_V1_ACCEPT =
  'application/vnd.allegro.public.v1+json'

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000
const CRON_LEASE_TTL_MS = 8 * 60 * 1000
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
const DEDUPE_TTL_MS = 60 * 24 * 60 * 60 * 1000
const RELAY_SKEW_MS = 5 * 60 * 1000
const RELAY_MAX_BODY_CHARS = 200_000
/* Bridge (Apps Script -> Hub) replay window: one nonce
 * record per signed request, short TTL. Matches the
 * 5-minute timestamp skew above. */
const BRIDGE_NONCE_TTL_MS = 10 * 60 * 1000
/* Pending-claim TTL: comfortably longer than the
 * 10-minute Apps Script trigger cadence so a pulled
 * event survives until its ACK; short enough that a
 * lost ACK re-offers the event instead of wedging the
 * bridge behind one stale claim. */
const PENDING_TTL_MS = 30 * 60 * 1000
/* Pull-time scan bounds: order journal pages of 100. */
const ORDER_PAGE_LIMIT = 100
const ORDER_PULL_MAX_PAGES = 5
const ORDER_HIGH_WATER_MAX_PAGES = 200

const EMAIL_FOOTER_TEXT =
  'Automatikus Allegro értesítés. Erre az emailre ne válaszolj; ' +
  'az ügyfélnek az Allegro felületén válaszolj.'

const EMAIL_SENDER_NAME = 'Allegro értesítés'

type NotifyEnvironment = Record<
  string,
  string | undefined
>

export type NotifyConfig = {
  enabled: boolean
  apiUrl: string
  authUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  userAgent: string
  /* Legacy Deno -> Apps Script Web App URL. The pull/ack
   * bridge never reads it; it stays optional so existing
   * environments (where it may still be configured) keep
   * resolving. Do not reintroduce it into active logic. */
  relayUrl: string | null
  relaySecret: string
  tokenKeyBytes: Uint8Array
  orderEmail: string | null
  messageEmail: string | null
  cancellationEmail: string | null
}

function requiredEnv(
  environment: NotifyEnvironment,
  name: string,
): string {
  const value = environment[name]?.trim()

  if (!value) {
    throw new Error(
      `Allegro notify configuration is missing: ${name}.`,
    )
  }

  return value
}

function optionalEmail(
  environment: NotifyEnvironment,
  name: string,
): string | null {
  const value = environment[name]?.trim()

  return value ? value : null
}

function importTokenKey(
  encoded: string,
): Uint8Array {
  let bytes: Uint8Array

  try {
    const binary = atob(encoded.trim())
    bytes = new Uint8Array(binary.length)

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
  } catch {
    throw new Error(
      'ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY is not valid base64.',
    )
  }

  if (bytes.length !== 32) {
    throw new Error(
      'ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY must contain exactly 32 bytes.',
    )
  }

  return bytes
}

export function resolveNotifyConfig(
  environment: NotifyEnvironment = process.env,
): NotifyConfig {
  return {
    enabled:
      environment['ALLEGRO_NOTIFY_ENABLED']
        ?.trim()
        .toLowerCase() === 'true',
    apiUrl: requiredEnv(environment, 'ALLEGRO_API_URL'),
    authUrl: requiredEnv(
      environment,
      'ALLEGRO_AUTH_URL',
    ),
    tokenUrl: requiredEnv(
      environment,
      'ALLEGRO_TOKEN_URL',
    ),
    clientId: requiredEnv(
      environment,
      'ALLEGRO_CLIENT_ID',
    ),
    clientSecret: requiredEnv(
      environment,
      'ALLEGRO_CLIENT_SECRET',
    ),
    redirectUri: requiredEnv(
      environment,
      'ALLEGRO_NOTIFY_REDIRECT_URI',
    ),
    userAgent: requiredEnv(
      environment,
      'ALLEGRO_USER_AGENT',
    ),
    relayUrl:
      environment[
        'ALLEGRO_NOTIFY_RELAY_URL'
      ]?.trim() || null,
    relaySecret: requiredEnv(
      environment,
      'ALLEGRO_NOTIFY_RELAY_SECRET',
    ),
    tokenKeyBytes: importTokenKey(
      requiredEnv(
        environment,
        'ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY',
      ),
    ),
    orderEmail: optionalEmail(
      environment,
      'ALLEGRO_NOTIFY_ORDER_EMAIL',
    ),
    messageEmail: optionalEmail(
      environment,
      'ALLEGRO_NOTIFY_MESSAGE_EMAIL',
    ),
    cancellationEmail: optionalEmail(
      environment,
      'ALLEGRO_NOTIFY_CANCELLATION_EMAIL',
    ),
  }
}

/* ============================================================
 * Sanitized logging: technical identifiers only, never PII.
 * ============================================================ */

function logLine(
  level: 'log' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
) {
  const safe: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(
    fields,
  )) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      safe[key] = value
    } else {
      safe[key] = '[omitted]';
    }
  }

  console[level](
    `[allegro-notify] ${message}`,
    safe,
  )
}

export function notifyLog(
  message: string,
  fields: Record<string, unknown> = {},
) {
  logLine('log', message, fields)
}

export function notifyWarn(
  message: string,
  fields: Record<string, unknown> = {},
) {
  logLine('warn', message, fields)
}

export function notifyError(
  message: string,
  fields: Record<string, unknown> = {},
) {
  logLine('error', message, fields)
}

/* ============================================================
 * Deno KV state. Keys hold technical state only:
 * encrypted OAuth blob, cursors, delivered IDs, lease.
 * ============================================================ */

export type NotifyKvKey = readonly (
  | string
  | number
)[]

export type NotifyKv = {
  get<T>(key: NotifyKvKey): Promise<T | null>
  set(
    key: NotifyKvKey,
    value: unknown,
    options?: { ttlMs?: number },
  ): Promise<void>
  setIfAbsent(
    key: NotifyKvKey,
    value: unknown,
    options?: { ttlMs?: number },
  ): Promise<boolean>
  delete(key: NotifyKvKey): Promise<void>
}

export const NOTIFY_KV_KEYS = {
  oauth: ['allegro-notify', 'oauth'] as const,
  oauthState: (state: string) =>
    ['allegro-notify', 'oauth-state', state] as const,
  orderCursor: [
    'allegro-notify',
    'cursor',
    'orders',
  ] as const,
  messageCursor: [
    'allegro-notify',
    'cursor',
    'messages',
  ] as const,
  sentOrder: (eventId: string) =>
    [
      'allegro-notify',
      'sent',
      'order',
      eventId,
    ] as const,
  sentMessage: (messageId: string) =>
    [
      'allegro-notify',
      'sent',
      'message',
      messageId,
    ] as const,
  /* Single-slot pending claim: technical recreation data
   * for the one event currently checked out by the Apps
   * Script client. NEVER customer PII (see BridgePending).
   * While set, PULL re-offers this same event so a failed
   * Gmail send is retried before its cursor advances. */
  pending: ['allegro-notify', 'pending'] as const,
  /* Short replay-prevention record per bridge request
   * nonce. Technical value only. */
  bridgeNonce: (nonce: string) =>
    [
      'allegro-notify',
      'bridge-nonce',
      nonce,
    ] as const,
  lease: ['allegro-notify', 'lease'] as const,
} as const

export type StoredNotifyOAuth = {
  encrypted: string
  updatedAt: string
}

export type StoredCursor = {
  lastId: string
  updatedAt: string
}

export type StoredDelivery = {
  deliveredAt: string
  channel: 'order' | 'cancellation' | 'message'
}

export function createMemoryNotifyKv(): NotifyKv {
  const entries = new Map<
    string,
    { value: unknown; expiresAt: number | null }
  >()

  const serialize = (key: NotifyKvKey) =>
    JSON.stringify([...key])

  const read = <T,>(key: NotifyKvKey): T | null => {
    const entry = entries.get(serialize(key))

    if (!entry) {
      return null
    }

    if (
      entry.expiresAt !== null &&
      entry.expiresAt <= Date.now()
    ) {
      entries.delete(serialize(key))
      return null
    }

    return entry.value as T
  }

  return {
    get: async (key) => read(key),
    set: async (key, value, options) => {
      entries.set(serialize(key), {
        value,
        expiresAt:
          options?.ttlMs !== undefined
            ? Date.now() + options.ttlMs
            : null,
      })
    },
    setIfAbsent: async (key, value, options) => {
      if (read(key) !== null) {
        return false
      }

      entries.set(serialize(key), {
        value,
        expiresAt:
          options?.ttlMs !== undefined
            ? Date.now() + options.ttlMs
            : null,
      })

      return true
    },
    delete: async (key) => {
      entries.delete(serialize(key))
    },
  }
}

type DenoKvAtomicShim = {
  check(entry: {
    key: NotifyKvKey
    versionstamp: null
  }): DenoKvAtomicShim
  set(
    key: NotifyKvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): DenoKvAtomicShim
  delete(key: NotifyKvKey): DenoKvAtomicShim
  commit(): Promise<{ ok: boolean }>
}

type DenoKvShim = {
  get<T>(key: NotifyKvKey): Promise<{
    value: T | null
  }>
  set(
    key: NotifyKvKey,
    value: unknown,
    options?: { expireIn?: number },
  ): Promise<{ ok: boolean }>
  atomic(): DenoKvAtomicShim
  delete(key: NotifyKvKey): Promise<void>
}

let cachedDenoKv: Promise<DenoKvShim> | null =
  null

function getDenoKv(): Promise<DenoKvShim> {
  const deno = (
    globalThis as unknown as {
      Deno?: { openKv?: () => Promise<DenoKvShim> }
    }
  ).Deno

  if (!deno?.openKv) {
    throw new Error(
      'Deno KV is unavailable in this runtime.',
    )
  }

  cachedDenoKv ??= deno.openKv()

  return cachedDenoKv
}

let kvOverride: NotifyKv | null = null

export function setNotifyKvStore(
  store: NotifyKv | null,
) {
  kvOverride = store
}

export async function openDenoNotifyKv(): Promise<NotifyKv> {
  const kv = await getDenoKv()

  return {
    get: async <T,>(
      key: NotifyKvKey,
    ): Promise<T | null> =>
      (await kv.get<T>([...key])).value,
    set: async (key, value, options) => {
      const result = await kv.set(
        [...key],
        value,
        options?.ttlMs !== undefined
          ? { expireIn: options.ttlMs }
          : undefined,
      )

      if (!result.ok) {
        throw new Error(
          'Deno KV write failed.',
        )
      }
    },
    setIfAbsent: async (
      key,
      value,
      options,
    ) => {
      const result = await kv
        .atomic()
        .check({ key: [...key], versionstamp: null })
        .set(
          [...key],
          value,
          options?.ttlMs !== undefined
            ? { expireIn: options.ttlMs }
            : undefined,
        )
        .commit()

      return result.ok
    },
    delete: async (key) => {
      await kv.delete([...key])
    },
  }
}

export async function getNotifyKvStore(): Promise<NotifyKv> {
  if (kvOverride) {
    return kvOverride
  }

  return openDenoNotifyKv()
}

/* ============================================================
 * Token encryption (AES-256-GCM, WebCrypto, explicit key).
 * Isolated from the primary session key by construction:
 * the caller supplies ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY.
 * ============================================================ */

const TOKEN_FORMAT = 'anv1'

function base64Encode(bytes: Uint8Array): string {
  let binary = ''

  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary)
}

function base64Decode(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

function exactBytes(
  data: Uint8Array,
): Uint8Array<ArrayBuffer> {
  // Copy into an exact-length buffer: views over pooled
  // ArrayBuffers (e.g. Node Buffers) or ArrayBufferLike
  // typings would otherwise fail WebCrypto length checks.
  const raw = new Uint8Array(data.byteLength)
  raw.set(data)

  return raw
}

function utf8Bytes(value: string): Uint8Array<ArrayBuffer> {
  return exactBytes(new TextEncoder().encode(value))
}

async function importAesKey(
  keyBytes: Uint8Array,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    exactBytes(keyBytes),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptNotifyToken(
  plaintext: string,
  keyBytes: Uint8Array,
): Promise<string> {
  if (keyBytes.length !== 32) {
    throw new Error(
      'Notification token key must contain exactly 32 bytes.',
    )
  }

  const key = await importAesKey(keyBytes)
  const iv = crypto.getRandomValues(
    new Uint8Array(12),
  )
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      utf8Bytes(plaintext),
    ),
  )

  return [
    TOKEN_FORMAT,
    base64Encode(iv),
    base64Encode(ciphertext),
  ].join(':')
}

export async function decryptNotifyToken(
  payload: string,
  keyBytes: Uint8Array,
): Promise<string> {
  const [version, ivValue, ciphertextValue] =
    payload.split(':')

  if (
    version !== TOKEN_FORMAT ||
    !ivValue ||
    !ciphertextValue
  ) {
    throw new Error(
      'Invalid notification token format.',
    )
  }

  const key = await importAesKey(keyBytes)
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: exactBytes(base64Decode(ivValue)),
    },
    key,
    exactBytes(base64Decode(ciphertextValue)),
  )

  return new TextDecoder().decode(plaintext)
}

export type NotifyOAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export async function storeNotifyOAuth(
  kv: NotifyKv,
  tokens: NotifyOAuthTokens,
  keyBytes: Uint8Array,
  nowMs = Date.now(),
): Promise<void> {
  const encrypted = await encryptNotifyToken(
    JSON.stringify(tokens),
    keyBytes,
  )

  await kv.set(NOTIFY_KV_KEYS.oauth, {
    encrypted,
    updatedAt: new Date(nowMs).toISOString(),
  } satisfies StoredNotifyOAuth)
}

export async function loadNotifyOAuth(
  kv: NotifyKv,
  keyBytes: Uint8Array,
): Promise<NotifyOAuthTokens | null> {
  const stored =
    await kv.get<StoredNotifyOAuth>(
      NOTIFY_KV_KEYS.oauth,
    )

  if (!stored) {
    return null
  }

  try {
    const parsed = JSON.parse(
      await decryptNotifyToken(
        stored.encrypted,
        keyBytes,
      ),
    ) as Partial<NotifyOAuthTokens>

    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }

    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    }
  } catch {
    return null
  }
}

/* ============================================================
 * Notification OAuth bootstrap + refresh (isolated session).
 * ============================================================ */

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(
    new Uint8Array(byteCount),
  )

  return [...bytes]
    .map((byte) =>
      byte.toString(16).padStart(2, '0'),
    )
    .join('')
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

async function pkceChallenge(
  verifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    utf8Bytes(verifier),
  )

  return base64UrlEncode(new Uint8Array(digest))
}

export type NotifyAuthorizeState = {
  state: string
  codeVerifier: string
  createdAt: number
}

export async function buildNotifyAuthorizeUrl(
  config: NotifyConfig,
  kv: NotifyKv,
  nowMs = Date.now(),
): Promise<string> {
  const state = randomHex(32)
  const codeVerifier = base64UrlEncode(
    crypto.getRandomValues(new Uint8Array(64)),
  )

  await kv.set(
    NOTIFY_KV_KEYS.oauthState(state),
    {
      state,
      codeVerifier,
      createdAt: nowMs,
    } satisfies NotifyAuthorizeState,
    { ttlMs: OAUTH_STATE_TTL_MS },
  )

  const url = new URL(config.authUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set(
    'redirect_uri',
    config.redirectUri,
  )
  url.searchParams.set(
    'scope',
    [...ALLEGRO_NOTIFY_SCOPES].join(' '),
  )
  url.searchParams.set('state', state)
  url.searchParams.set(
    'code_challenge_method',
    'S256',
  )
  url.searchParams.set(
    'code_challenge',
    await pkceChallenge(codeVerifier),
  )

  return url.toString()
}

type FetchImpl = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

function defaultFetch(): FetchImpl {
  if (typeof fetch === 'undefined') {
    throw new Error(
      'Fetch implementation is required.',
    )
  }

  return fetch.bind(globalThis)
}

async function readJsonSafe(
  response: Response,
): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export async function exchangeNotifyCode(
  config: NotifyConfig,
  kv: NotifyKv,
  code: string,
  state: string,
  nowMs = Date.now(),
  fetchImpl: FetchImpl = defaultFetch(),
): Promise<{ ok: boolean; status: number }> {
  const stored =
    await kv.get<NotifyAuthorizeState>(
      NOTIFY_KV_KEYS.oauthState(state),
    )

  if (!stored || stored.state !== state) {
    return { ok: false, status: 400 }
  }

  await kv.delete(NOTIFY_KV_KEYS.oauthState(state))

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: stored.codeVerifier,
  })

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'Content-Type':
        'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    notifyWarn('notify OAuth exchange failed', {
      httpStatus: response.status,
    })
    return { ok: false, status: 502 }
  }

  const data = (await readJsonSafe(
    response,
  )) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  } | null

  if (
    typeof data?.access_token !== 'string' ||
    typeof data?.refresh_token !== 'string'
  ) {
    return { ok: false, status: 502 }
  }

  const expiresIn =
    typeof data.expires_in === 'number'
      ? data.expires_in
      : 3600

  await storeNotifyOAuth(
    kv,
    {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: nowMs + expiresIn * 1000,
    },
    config.tokenKeyBytes,
    nowMs,
  )

  return { ok: true, status: 200 }
}

export async function refreshNotifyTokens(
  config: NotifyConfig,
  kv: NotifyKv,
  current: NotifyOAuthTokens,
  nowMs = Date.now(),
  fetchImpl: FetchImpl = defaultFetch(),
): Promise<NotifyOAuthTokens | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  })

  const response = await fetchImpl(config.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
      'Content-Type':
        'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  if (!response.ok) {
    notifyWarn('notify token refresh failed', {
      httpStatus: response.status,
    })
    return null
  }

  const data = (await readJsonSafe(
    response,
  )) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  } | null

  if (
    typeof data?.access_token !== 'string' ||
    typeof data?.refresh_token !== 'string'
  ) {
    return null
  }

  const expiresIn =
    typeof data.expires_in === 'number'
      ? data.expires_in
      : 3600

  // Rotation is a single KV overwrite: atomic from the
  // reader's perspective. Overlapping ticks are excluded
  // by the cron lease. If the process dies after Allegro
  // rotated the refresh token but before this store lands,
  // the stored token may be rejected next tick and the
  // session needs a fresh bootstrap (fail-closed, logged).
  const rotated: NotifyOAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: nowMs + expiresIn * 1000,
  }

  await storeNotifyOAuth(
    kv,
    rotated,
    config.tokenKeyBytes,
    nowMs,
  )

  return rotated
}

async function authorizedNotifyFetch(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  path: string,
  fetchImpl: FetchImpl,
): Promise<Response> {
  return fetchImpl(`${config.apiUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: PUBLIC_V1_ACCEPT,
      'User-Agent': config.userAgent,
    },
  })
}

/* ============================================================
 * Allegro polling shapes (defensive parsing; unknown fields
 * are ignored, never logged).
 * ============================================================ */

export type NotifyOrderEvent = {
  id: string
  type: string
  occurredAt: string | null
  orderId: string | null
  /* Best-effort cancellation reason: order events observed
   * so far carry no reason field, so this stays null and
   * the email row is omitted unless Allegro provides one. */
  reason: string | null
}

export type NotifyMessage = {
  id: string
  threadId: string
  createdAt: string | null
  authorIsInterlocutor: boolean
  authorLogin: string | null
  text: string | null
  attachmentNames: string[]
  orderId: string | null
  offerId: string | null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== ''
    ? value
    : null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseOrderEvents(
  payload: unknown,
): NotifyOrderEvent[] {
  const root = recordOf(payload)
  const rawEvents = root?.['events']

  if (!Array.isArray(rawEvents)) {
    return []
  }

  const events: NotifyOrderEvent[] = []

  for (const raw of rawEvents) {
    const item = recordOf(raw)

    if (!item) {
      continue
    }

    const id = textOrNull(item['id'])
    const type = textOrNull(item['type'])

    if (!id || !type) {
      continue
    }

    const order = recordOf(item['order'])
    const checkoutForm =
      recordOf(order?.['checkoutForm']) ??
      recordOf(item['checkoutForm'])

    events.push({
      id,
      type,
      occurredAt: textOrNull(item['occurredAt']),
      orderId:
        textOrNull(order?.['id']) ??
        textOrNull(checkoutForm?.['id']),
      reason: textOrNull(item['reason']),
    })
  }

  return events
}

export function parseThreadMessages(
  threadId: string,
  payload: unknown,
): NotifyMessage[] {
  const root = recordOf(payload)
  const rawMessages = root?.['messages']

  if (!Array.isArray(rawMessages)) {
    return []
  }

  const messages: NotifyMessage[] = []

  for (const raw of rawMessages) {
    const item = recordOf(raw)

    if (!item) {
      continue
    }

    const id = textOrNull(item['id'])

    if (!id) {
      continue
    }

    const author = recordOf(item['author'])
    const attachments = Array.isArray(
      item['attachments'],
    )
      ? item['attachments']
      : []
    const attachmentNames: string[] = []

    for (const attachment of attachments) {
      const name = textOrNull(
        recordOf(attachment)?.['fileName'] ??
          recordOf(attachment)?.['name'],
      )

      if (name) {
        attachmentNames.push(name)
      }
    }

    messages.push({
      id,
      threadId,
      createdAt: textOrNull(item['createdAt']),
      authorIsInterlocutor:
        recordOf(item['author'])?.[
          'isInterlocutor'
        ] === true,
      authorLogin:
        textOrNull(author?.['login']) ??
        textOrNull(author?.['name']),
      text: textOrNull(item['text']),
      attachmentNames,
      orderId:
        textOrNull(item['orderId']) ??
        textOrNull(
          recordOf(item['order'])?.['id'],
        ),
      offerId:
        textOrNull(item['offerId']) ??
        textOrNull(
          recordOf(item['offer'])?.['id'],
        ),
    })
  }

  return messages
}

export function parseThreadList(
  payload: unknown,
): Array<{ id: string }> {
  const root = recordOf(payload)
  const rawThreads = root?.['threads']

  if (!Array.isArray(rawThreads)) {
    return []
  }

  const threads: Array<{ id: string }> = []

  for (const raw of rawThreads) {
    const id = textOrNull(recordOf(raw)?.['id'])

    if (id) {
      threads.push({ id })
    }
  }

  return threads
}

/* ============================================================
 * V1 event filters.
 * ============================================================ */

export type NotifiableOrderKind =
  | 'NEW_ORDER'
  | 'CANCELLATION'

export function classifyOrderEvent(
  type: string,
): NotifiableOrderKind | null {
  if (type === 'READY_FOR_PROCESSING') {
    return 'NEW_ORDER'
  }

  if (
    type === 'BUYER_CANCELLED' ||
    type === 'AUTO_CANCELLED'
  ) {
    return 'CANCELLATION'
  }

  return null
}

export function isNotifiableMessage(
  message: NotifyMessage,
): boolean {
  return message.authorIsInterlocutor === true
}

/* ============================================================
 * Email building (HTML-escaped, Hungarian, one event each).
 * ============================================================ */

export function escapeNotifyHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export type NotifyEmail = {
  to: string
  subject: string
  textBody: string
  htmlBody: string
}

export type NotifyEmailSection = {
  heading: string
  rows: Array<[string, string]>
}

/* A row is rendered only when its value is present.
 * Absent optional fields are omitted entirely — never
 * "undefined", "null", or empty placeholders. */
function rowsIf(
  label: string,
  value: string | null,
): Array<[string, string]> {
  return value ? [[label, value]] : []
}

/* ============================================================
 * Presentation-only display helpers. These reformat already
 * parsed values for humans; they never fetch, infer, or drop
 * data. Unknown codes/methods pass through untouched.
 * ============================================================ */

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function splitMoneyParts(
  value: string,
): { amount: string; currency: string | null } | null {
  const match =
    /^\s*(-?[\d\s.,]+)\s*([A-Za-z]{3})?\s*$/.exec(value)

  if (!match) {
    return null
  }

  return {
    amount: match[1]!.replace(/\s+/g, ''),
    currency: match[2] ?? null,
  }
}

function parseDecimalAmount(
  amount: string,
): { integer: string; fraction: string | null } | null {
  let normalized = amount

  if (
    normalized.includes(',') &&
    !normalized.includes('.')
  ) {
    normalized = normalized.replace(',', '.')
  }

  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    return null
  }

  const negative = normalized.startsWith('-')
  const unsigned = negative
    ? normalized.slice(1)
    : normalized
  const [integer = '', fraction] = unsigned.split('.')

  return {
    integer: (negative ? '-' : '') + integer,
    fraction: fraction ?? null,
  }
}

/* 56980.00 HUF -> 56 980 Ft. Non-HUF keeps its code with
 * grouped digits (1234.50 USD -> 1 234.50 USD).
 * Unparseable input is returned unchanged. */
export function formatMoneyDisplay(
  value: string | null,
): string | null {
  if (!value) {
    return null
  }

  const parts = splitMoneyParts(value)

  if (!parts) {
    return value
  }

  const parsed = parseDecimalAmount(parts.amount)

  if (!parsed) {
    return value
  }

  const grouped = groupThousands(parsed.integer)

  if (parts.currency === 'HUF') {
    if (
      parsed.fraction === null ||
      /^0+$/.test(parsed.fraction)
    ) {
      return `${grouped} Ft`
    }

    return `${grouped},${parsed.fraction} Ft`
  }

  const amount =
    parsed.fraction === null
      ? grouped
      : `${grouped}.${parsed.fraction}`

  return parts.currency
    ? `${amount} ${parts.currency}`
    : amount
}

/* Exactly one proven display mapping. Unknown delivery
 * methods are returned verbatim — never guessed. */
export function translateShipmentMethod(
  value: string | null,
): string | null {
  if (value === 'Dostawa przez sprzedającego') {
    return 'Eladó által szervezett kiszállítás'
  }

  return value
}

/* Human-primary cancellation label; the technical event
 * type stays alongside in parentheses where emitted. */
export function cancellationDisplayLabel(
  kind: string,
): string {
  if (kind === 'BUYER_CANCELLED') {
    return 'Vásárló által törölve'
  }

  if (kind === 'AUTO_CANCELLED') {
    return 'Automatikusan törölve'
  }

  return kind
}

/* Shared operational email style (single place, no
 * duplication): white background, max-width 800px, Arial,
 * dark text, #f3f4f6 section headers, #e5e7eb borders. No
 * branding, icons, gradients, or banners — a clean internal
 * notification. Table-based with inline styles for Gmail /
 * mobile / Outlook; a small media query stacks the two
 * card columns on narrow screens (clients without support
 * simply keep the two-column table). No JavaScript, no
 * remote CSS. Every externally sourced string is escaped
 * at render time. */
export type NotifyEmailCardRow = [
  NotifyEmailSection | null,
  NotifyEmailSection | null,
]

export type NotifyEmailProductTable = {
  caption: string
  headers: string[]
  rows: string[][]
  textLines: string[]
}

const EMAIL_FONT =
  "font-family:Arial,'Helvetica Neue',Helvetica,sans-serif"

function sectionBoxHtml(
  section: NotifyEmailSection,
): string {
  const rows = section.rows
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td style="${EMAIL_FONT};font-size:13px;color:#6b7280;padding:4px 8px 4px 0;vertical-align:top;white-space:nowrap;">${escapeNotifyHtml(label)}</td>` +
        `<td style="${EMAIL_FONT};font-size:13px;color:#111827;padding:4px 0;vertical-align:top;">${escapeNotifyHtml(value)}</td>` +
        `</tr>`,
    )
    .join('')

  return (
    `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse;background:#ffffff;">` +
    `<tr><td style="${EMAIL_FONT};font-size:12px;font-weight:bold;color:#374151;background:#f3f4f6;padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeNotifyHtml(section.heading)}</td></tr>` +
    `<tr><td style="padding:8px 12px;"><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table></td></tr>` +
    `</table>`
  )
}

function emailShell(
  title: string,
  eventLabel: string,
  eventSubLabel: string | null,
  cardRows: NotifyEmailCardRow[],
  fullSections: NotifyEmailSection[],
  freeText: Array<{ label: string; value: string }>,
  productTable: NotifyEmailProductTable | null,
): { textBody: string; htmlBody: string } {
  const cardSections = cardRows.flatMap(
    ([left, right]) => [left, right],
  )
  const visible = [...cardSections, ...fullSections].filter(
    (section): section is NotifyEmailSection =>
      section !== null && section.rows.length > 0,
  )
  const textLines = [title, '']

  for (const section of visible) {
    textLines.push(section.heading)

    for (const [label, value] of section.rows) {
      textLines.push(`${label}: ${value}`)
    }

    textLines.push('')
  }

  textLines.push(
    ...freeText.flatMap(({ label, value }) => [
      `${label}:`,
      value,
      '',
    ]),
  )

  if (productTable) {
    textLines.push(productTable.caption, '')

    for (const line of productTable.textLines) {
      textLines.push(line)
    }

    textLines.push('')
  }

  textLines.push(EMAIL_FOOTER_TEXT)

  const cardRowsHtml = cardRows
    .map(([left, right]) => {
      const leftHtml =
        left && left.rows.length > 0
          ? sectionBoxHtml(left)
          : ''
      const rightHtml =
        right && right.rows.length > 0
          ? sectionBoxHtml(right)
          : ''

      if (!leftHtml && !rightHtml) {
        return ''
      }

      if (leftHtml && !rightHtml) {
        return (
          `<tr><td colspan="2" class="notify-stack" style="padding:0 0 12px 0;vertical-align:top;">${leftHtml}</td></tr>`
        )
      }

      if (!leftHtml && rightHtml) {
        return (
          `<tr><td colspan="2" class="notify-stack" style="padding:0 0 12px 0;vertical-align:top;">${rightHtml}</td></tr>`
        )
      }

      return (
        `<tr>` +
        `<td class="notify-stack" width="50%" style="padding:0 6px 12px 0;vertical-align:top;">${leftHtml}</td>` +
        `<td class="notify-stack" width="50%" style="padding:0 0 12px 6px;vertical-align:top;">${rightHtml}</td>` +
        `</tr>`
      )
    })
    .join('')
  const fullHtml = fullSections
    .filter((section) => section.rows.length > 0)
    .map(
      (section) =>
        `<tr><td colspan="2" style="padding:0 0 12px 0;vertical-align:top;">${sectionBoxHtml(section)}</td></tr>`,
    )
    .join('')
  const freeHtml = freeText
    .map(
      ({ label, value }) =>
        `<tr><td colspan="2" style="padding:0 0 12px 0;vertical-align:top;">` +
        `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse;background:#ffffff;">` +
        `<tr><td style="${EMAIL_FONT};font-size:12px;font-weight:bold;color:#374151;background:#f3f4f6;padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeNotifyHtml(label)}</td></tr>` +
        `<tr><td style="${EMAIL_FONT};font-size:13px;color:#111827;padding:8px 12px;">${escapeNotifyHtml(value).replace(/\n/g, '<br>')}</td></tr>` +
        `</table></td></tr>`,
    )
    .join('')
  const productHtml = productTable
    ? `<tr><td colspan="2" style="padding:0 0 12px 0;vertical-align:top;">` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-collapse:collapse;background:#ffffff;">` +
      `<tr><td colspan="${productTable.headers.length}" style="${EMAIL_FONT};font-size:12px;font-weight:bold;color:#374151;background:#f3f4f6;padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeNotifyHtml(productTable.caption)}</td></tr>` +
      `<tr>${productTable.headers
        .map(
          (header) =>
            `<th align="left" style="${EMAIL_FONT};font-size:12px;font-weight:bold;color:#374151;padding:6px 8px;border-bottom:1px solid #e5e7eb;background:#f9fafb;">${escapeNotifyHtml(header)}</th>`,
        )
        .join('')}</tr>` +
      productTable.rows
        .map(
          (row) =>
            `<tr>${row
              .map(
                (cell) =>
                  `<td style="${EMAIL_FONT};font-size:13px;color:#111827;padding:6px 8px;border-bottom:1px solid #e5e7eb;vertical-align:top;">${escapeNotifyHtml(cell)}</td>`,
              )
              .join('')}</tr>`,
        )
        .join('') +
      `</table></td></tr>`
    : ''

  return {
    textBody: textLines.join('\n'),
    htmlBody:
      `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">` +
      `<style>@media only screen and (max-width:600px){.notify-stack{display:block !important;width:100% !important;padding-left:0 !important;padding-right:0 !important;}}</style>` +
      `</head><body style="margin:0;padding:0;background:#ffffff;">` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:16px 8px;">` +
      `<table width="100%" cellpadding="0" cellspacing="0" style="max-width:800px;border-collapse:collapse;">` +
      `<tr>` +
      `<td align="left" style="${EMAIL_FONT};padding:0 0 12px 0;vertical-align:middle;"><span style="color:#ff5a00;font-weight:bold;font-size:28px;">allegro</span></td>` +
      `<td align="right" style="${EMAIL_FONT};padding:0 0 12px 0;vertical-align:middle;">` +
      `<div style="font-size:15px;font-weight:bold;color:#111827;">${escapeNotifyHtml(eventLabel)}</div>` +
      (eventSubLabel
        ? `<div style="font-size:12px;color:#6b7280;">${escapeNotifyHtml(eventSubLabel)}</div>`
        : '') +
      `</td></tr>` +
      `<tr><td colspan="2" style="${EMAIL_FONT};font-size:13px;font-weight:bold;color:#111827;padding:0 0 12px 0;">${escapeNotifyHtml(title)}</td></tr>` +
      cardRowsHtml +
      fullHtml +
      freeHtml +
      productHtml +
      `<tr><td colspan="2" style="${EMAIL_FONT};font-size:11px;color:#6b7280;padding:8px 0 0 0;border-top:1px solid #e5e7eb;">${escapeNotifyHtml(EMAIL_FOOTER_TEXT)}</td></tr>` +
      `</table></td></tr></table></body></html>`,
  }
}

function customerSection(
  detail: OrderDetail,
): NotifyEmailSection {
  return {
    heading: 'VÁSÁRLÓ',
    rows: [
      ...rowsIf('Név', detail.customer.fullName),
      ...rowsIf(
        'Cég',
        detail.customer.companyName,
      ),
      ...rowsIf(
        'Allegro login',
        detail.customer.login ?? detail.buyerLogin,
      ),
      ...rowsIf('Email', detail.customer.email),
      ...rowsIf('Telefon', detail.customer.phone),
    ],
  }
}

function formatPickupPoint(
  point: OrderPickupPoint,
): string | null {
  const title = [point.name, point.description]
    .filter((part) => part !== null && part !== '')
    .join(' – ')
  const address = [
    point.street,
    [point.zipCode, point.city]
      .filter((part) => part !== null && part !== '')
      .join(' '),
    point.countryCode,
  ]
    .filter((part) => part !== null && part !== '')
    .join(', ')

  if (!title && !address) {
    return null
  }

  return address ? `${title} (${address})` : title
}

function shippingSection(
  detail: OrderDetail,
): NotifyEmailSection {
  return {
    heading: 'SZÁLLÍTÁSI ADATOK',
    rows: [
      ...rowsIf(
        'Címzett',
        detail.shipping.recipientName,
      ),
      ...rowsIf(
        'Cég',
        detail.shipping.companyName,
      ),
      ...rowsIf('Utca', detail.shipping.street),
      ...rowsIf(
        'Irányítószám',
        detail.shipping.zipCode,
      ),
      ...rowsIf('Város', detail.shipping.city),
      ...rowsIf(
        'Ország',
        detail.shipping.countryCode,
      ),
      ...rowsIf('Telefon', detail.shipping.phone),
      ...rowsIf(
        'Szállítási mód',
        translateShipmentMethod(detail.shipmentMethod),
      ),
      ...rowsIf(
        'Szállítási költség',
        formatMoneyDisplay(detail.deliveryCost),
      ),
      ...rowsIf(
        'Átvételi pont',
        detail.pickupPoint
          ? formatPickupPoint(detail.pickupPoint)
          : null,
      ),
    ],
  }
}

function billingSection(
  detail: OrderDetail | null,
): NotifyEmailSection {
  if (!detail) {
    return { heading: 'SZÁMLÁZÁSI ADATOK', rows: [] }
  }

  const billing = detail.billing
  const hasData =
    billing.invoiceRequested !== null ||
    billing.name !== null ||
    billing.street !== null ||
    billing.zipCode !== null ||
    billing.city !== null ||
    billing.countryCode !== null ||
    billing.taxId !== null

  if (!hasData) {
    return {
      heading: 'SZÁMLÁZÁSI ADATOK',
      rows: [
        [
          'Számlázási adat',
          'nincs külön megadva',
        ],
      ],
    }
  }

  return {
    heading: 'SZÁMLÁZÁSI ADATOK',
    rows: [
      ...(billing.invoiceRequested === null
        ? []
        : [
            [
              'Számla igényelve',
              billing.invoiceRequested
                ? 'Igen'
                : 'Nem',
            ] as [string, string],
          ]),
      ...rowsIf('Név / cégnév', billing.name),
      ...rowsIf('Utca', billing.street),
      ...rowsIf(
        'Irányítószám',
        billing.zipCode,
      ),
      ...rowsIf('Város', billing.city),
      ...rowsIf('Ország', billing.countryCode),
      ...rowsIf('Adószám', billing.taxId),
    ],
  }
}

/* Compact product table: only columns with at least one
 * value are rendered. SKU and the Allegro offer ID are
 * separate columns — a bare SKU is never labeled as an
 * offer reference. */
function productTableData(
  lines: OrderProductLine[],
): NotifyEmailProductTable | null {
  if (lines.length === 0) {
    return null
  }

  const showUnit = lines.some(
    (line) => line.unitPrice !== null,
  )
  const showTotal = lines.some(
    (line) => line.lineTotal !== null,
  )
  const showSku = lines.some(
    (line) => line.sku !== null,
  )
  const showOffer = lines.some(
    (line) => line.offerId !== null,
  )
  const headers = ['Termék', 'Mennyiség']

  if (showUnit) {
    headers.push('Egységár')
  }

  if (showTotal) {
    headers.push('Összeg')
  }

  if (showSku) {
    headers.push('SKU')
  }

  if (showOffer) {
    headers.push('Allegro ajánlat ID')
  }

  const rows = lines.map((line) => {
    const cells = [
      line.name,
      String(line.quantity),
    ]

    if (showUnit) {
      cells.push(
        formatMoneyDisplay(line.unitPrice) ?? '–',
      )
    }

    if (showTotal) {
      cells.push(
        formatMoneyDisplay(line.lineTotal) ?? '–',
      )
    }

    if (showSku) {
      cells.push(line.sku ?? '–')
    }

    if (showOffer) {
      cells.push(line.offerId ?? '–')
    }

    return cells
  })
  const textLines = lines.map((line) => {
    const parts = [`${line.name} x${line.quantity}`]
    const unit = formatMoneyDisplay(line.unitPrice)

    if (unit) {
      parts.push(unit)
    }

    if (line.sku) {
      parts.push(`SKU: ${line.sku}`)
    }

    if (line.offerId) {
      parts.push(`Ajánlat: ${line.offerId}`)
    }

    const total = formatMoneyDisplay(line.lineTotal)

    if (total) {
      parts.push(`Összesen: ${total}`)
    }

    return `- ${parts.join(' · ')}`
  })

  return {
    caption: 'TERMÉKEK',
    headers,
    rows,
    textLines,
  }
}

function paymentText(
  detail: OrderDetail,
): string | null {
  if (
    detail.paymentStatus &&
    detail.paymentProvider
  ) {
    return `${detail.paymentStatus} (${detail.paymentProvider})`
  }

  return (
    detail.paymentStatus ?? detail.paymentProvider
  )
}

function orderSection(
  detail: OrderDetail,
): NotifyEmailSection {
  return {
    heading: 'RENDELÉS',
    rows: [
      ['Rendelési azonosító', detail.id],
      ...rowsIf('Időpont', detail.occurredAt),
      ...rowsIf('Fizetés', paymentText(detail)),
      ...rowsIf(
        'Végösszeg',
        formatMoneyDisplay(detail.total),
      ),
      ...rowsIf('Pénznem', detail.currency),
    ],
  }
}

/* ============================================================
 * Checkout-form detail model. Field paths below come from
 * real Allegro checkout-form payloads (buyer, delivery
 * .address/.method/.pickupPoint/.cost, invoice.required,
 * lineItems[].offer/.price, summary.totalToPay, payment
 * .type/.provider). Every field is optional and parsed
 * defensively: absent or misshaped values become null and
 * are omitted from the email instead of rendered.
 * Customer data parsed here lives only in memory and in
 * the outbound relay email payload — never in KV, Neon,
 * logs, or diagnostics (see the privacy tests).
 * ============================================================ */

/* Raw numeric amount + currency from an Allegro money
 * value ({ amount, currency } object or "123.45 HUF"
 * string). Used only to fall back to price × quantity when
 * a line carries no canonical totalPrice — never to
 * override one. */
function moneyParts(
  value: unknown,
): { amount: number; currency: string | null } | null {
  if (typeof value === 'number') {
    return Number.isFinite(value)
      ? { amount: value, currency: null }
      : null
  }

  if (typeof value === 'string') {
    const split = splitMoneyParts(value)

    if (!split) {
      return null
    }

    const parsed = parseDecimalAmount(split.amount)

    if (!parsed) {
      return null
    }

    const amount = Number(
      parsed.fraction === null
        ? parsed.integer
        : `${parsed.integer}.${parsed.fraction}`,
    )

    return Number.isFinite(amount)
      ? { amount, currency: split.currency }
      : null
  }

  const record = recordOf(value)
  const rawAmount = record?.['amount']

  if (
    typeof rawAmount !== 'string' &&
    typeof rawAmount !== 'number'
  ) {
    return null
  }

  const parsed = moneyParts(rawAmount)

  if (!parsed) {
    return null
  }

  return {
    amount: parsed.amount,
    currency: textOrNull(record?.['currency']),
  }
}

function moneyText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value === '' ? null : value
  }

  const record = recordOf(value)
  const amount = textOrNull(record?.['amount'])

  if (!amount) {
    return null
  }

  const currency = textOrNull(record?.['currency'])

  return currency ? `${amount} ${currency}` : amount
}

function moneyCurrency(value: unknown): string | null {
  if (typeof value === 'string') {
    return null
  }

  return textOrNull(recordOf(value)?.['currency'])
}

function joinName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  const parts = [firstName, lastName].filter(
    (part): part is string =>
      part !== null && part !== '',
  )

  return parts.length > 0 ? parts.join(' ') : null
}

export type OrderCustomer = {
  fullName: string | null
  companyName: string | null
  login: string | null
  email: string | null
  phone: string | null
}

export type OrderShipping = {
  recipientName: string | null
  companyName: string | null
  street: string | null
  zipCode: string | null
  city: string | null
  countryCode: string | null
  phone: string | null
}

export type OrderBilling = {
  invoiceRequested: boolean | null
  name: string | null
  street: string | null
  zipCode: string | null
  city: string | null
  countryCode: string | null
  taxId: string | null
}

export type OrderPickupPoint = {
  name: string | null
  description: string | null
  street: string | null
  zipCode: string | null
  city: string | null
  countryCode: string | null
}

export type OrderProductLine = {
  name: string
  quantity: number
  offerId: string | null
  sku: string | null
  unitPrice: string | null
  lineTotal: string | null
  currency: string | null
}

export type OrderDetail = {
  id: string
  buyerLogin: string | null
  customer: OrderCustomer
  shipping: OrderShipping
  billing: OrderBilling
  pickupPoint: OrderPickupPoint | null
  occurredAt: string | null
  productLines: OrderProductLine[]
  total: string | null
  currency: string | null
  paymentStatus: string | null
  paymentProvider: string | null
  shipmentMethod: string | null
  deliveryCost: string | null
  messageToSeller: string | null
}

export function parseCheckoutForm(
  orderId: string,
  payload: unknown,
): OrderDetail {
  const root = recordOf(payload) ?? {}
  const buyer = recordOf(root['buyer'])
  const lineItems = Array.isArray(root['lineItems'])
    ? root['lineItems']
    : []
  const productLines: OrderDetail['productLines'] = []

  for (const raw of lineItems) {
    const item = recordOf(raw)
    const offer = recordOf(item?.['offer'])
    const name =
      textOrNull(offer?.['name']) ??
      textOrNull(item?.['name']) ??
      'Ismeretlen termék'
    const quantity =
      typeof item?.['quantity'] === 'number'
        ? item['quantity']
        : 1
    const unitSource =
      item?.['price'] ?? item?.['originalPrice']
    // Canonical totalPrice wins; only when absent is the
    // total derived from the line's own price × quantity.
    let lineTotal = moneyText(item?.['totalPrice'])

    if (!lineTotal) {
      const unit = moneyParts(unitSource)

      if (
        unit &&
        Number.isFinite(quantity) &&
        quantity > 0
      ) {
        const total =
          Math.round(unit.amount * quantity * 100) / 100

        lineTotal = moneyText({
          amount: String(total),
          currency: unit.currency,
        })
      }
    }

    productLines.push({
      name,
      quantity,
      offerId: textOrNull(offer?.['id']),
      sku: textOrNull(
        recordOf(offer?.['external'])?.['id'],
      ),
      unitPrice: moneyText(unitSource),
      lineTotal,
      currency: moneyCurrency(unitSource),
    })
  }

  const summary = recordOf(root['summary'])
  const payment = recordOf(root['payment'])
  const delivery = recordOf(root['delivery'])
  const deliveryAddress = recordOf(
    delivery?.['address'],
  )
  const deliveryMethod = recordOf(
    delivery?.['method'],
  )
  const pickupPoint = recordOf(
    delivery?.['pickupPoint'],
  )
  const pickupAddress = recordOf(
    pickupPoint?.['address'],
  )
  const invoice = recordOf(root['invoice'])
  const invoiceAddress = recordOf(
    invoice?.['address'],
  )
  const invoiceCompany = recordOf(
    invoiceAddress?.['company'],
  )
  const invoicePerson = recordOf(
    invoiceAddress?.['naturalPerson'],
  )
  const invoiceRequired =
    typeof invoice?.['required'] === 'boolean'
      ? invoice['required']
      : null
  const totalSource =
    summary?.['totalToPay'] ?? summary?.['total']

  return {
    id: orderId,
    buyerLogin: textOrNull(buyer?.['login']),
    customer: {
      fullName: joinName(
        textOrNull(buyer?.['firstName']),
        textOrNull(buyer?.['lastName']),
      ),
      companyName: textOrNull(
        buyer?.['companyName'],
      ),
      login: textOrNull(buyer?.['login']),
      email: textOrNull(buyer?.['email']),
      phone: textOrNull(buyer?.['phoneNumber']),
    },
    shipping: {
      recipientName: joinName(
        textOrNull(deliveryAddress?.['firstName']),
        textOrNull(deliveryAddress?.['lastName']),
      ),
      companyName: textOrNull(
        deliveryAddress?.['companyName'],
      ),
      street: textOrNull(
        deliveryAddress?.['street'],
      ),
      zipCode: textOrNull(
        deliveryAddress?.['zipCode'],
      ),
      city: textOrNull(deliveryAddress?.['city']),
      countryCode: textOrNull(
        deliveryAddress?.['countryCode'],
      ),
      phone: textOrNull(
        deliveryAddress?.['phoneNumber'],
      ),
    },
    billing: {
      invoiceRequested: invoiceRequired,
      name:
        textOrNull(invoiceCompany?.['name']) ??
        joinName(
          textOrNull(
            invoicePerson?.['firstName'],
          ),
          textOrNull(invoicePerson?.['lastName']),
        ),
      street: textOrNull(
        invoiceAddress?.['street'],
      ),
      zipCode: textOrNull(
        invoiceAddress?.['zipCode'],
      ),
      city: textOrNull(invoiceAddress?.['city']),
      countryCode: textOrNull(
        invoiceAddress?.['countryCode'],
      ),
      taxId: textOrNull(invoiceCompany?.['taxId']),
    },
    pickupPoint: pickupPoint
      ? {
          name: textOrNull(pickupPoint['name']),
          description: textOrNull(
            pickupPoint['description'],
          ),
          street: textOrNull(
            pickupAddress?.['street'],
          ),
          zipCode: textOrNull(
            pickupAddress?.['zipCode'],
          ),
          city: textOrNull(
            pickupAddress?.['city'],
          ),
          countryCode: textOrNull(
            pickupAddress?.['countryCode'],
          ),
        }
      : null,
    occurredAt:
      textOrNull(root['boughtAt']) ??
      textOrNull(root['createdAt']),
    productLines,
    total: moneyText(totalSource),
    currency:
      moneyCurrency(totalSource) ??
      productLines.find(
        (line) => line.currency !== null,
      )?.currency ??
      null,
    paymentStatus:
      textOrNull(payment?.['status']) ??
      textOrNull(payment?.['type']),
    paymentProvider: textOrNull(
      payment?.['provider'],
    ),
    shipmentMethod:
      textOrNull(
        recordOf(delivery?.['shipment'])?.['name'],
      ) ??
      textOrNull(deliveryMethod?.['name']) ??
      textOrNull(delivery?.['method']),
    deliveryCost: moneyText(
      recordOf(delivery?.['cost']) ?? delivery?.['cost'],
    ),
    messageToSeller: textOrNull(
      root['messageToSeller'],
    ),
  }
}

/* Detail used when the checkout-form fetch fails: every
 * customer field stays null so nothing is invented and
 * the email still carries the event-level identifiers. */
export function emptyOrderDetail(
  orderId: string,
  occurredAt: string | null,
): OrderDetail {
  return {
    id: orderId,
    buyerLogin: null,
    customer: {
      fullName: null,
      companyName: null,
      login: null,
      email: null,
      phone: null,
    },
    shipping: {
      recipientName: null,
      companyName: null,
      street: null,
      zipCode: null,
      city: null,
      countryCode: null,
      phone: null,
    },
    billing: {
      invoiceRequested: null,
      name: null,
      street: null,
      zipCode: null,
      city: null,
      countryCode: null,
      taxId: null,
    },
    pickupPoint: null,
    occurredAt,
    productLines: [],
    total: null,
    currency: null,
    paymentStatus: null,
    paymentProvider: null,
    shipmentMethod: null,
    deliveryCost: null,
    messageToSeller: null,
  }
}

export function buildOrderEmail(
  to: string,
  event: NotifyOrderEvent,
  detail: OrderDetail,
): NotifyEmail {
  const title = `[ALLEGRO] ÚJ RENDELÉS – ${detail.id}`
  const products = productTableData(detail.productLines)
  const { textBody, htmlBody } = emailShell(
    title,
    'Új rendelés',
    null,
    [
      [customerSection(detail), shippingSection(detail)],
      [billingSection(detail), orderSection(detail)],
    ],
    [],
    [
      ...(detail.messageToSeller
        ? [
            {
              label: 'VÁSÁRLÓI MEGJEGYZÉS',
              value: detail.messageToSeller,
            },
          ]
        : []),
      ...(!products
        ? [{ label: 'TERMÉKEK', value: '–' }]
        : []),
    ],
    products,
  )

  return { to, subject: title, textBody, htmlBody }
}

export function buildCancellationEmail(
  to: string,
  kind: string,
  event: NotifyOrderEvent,
  detail: OrderDetail | null,
): NotifyEmail {
  const orderId = detail?.id ?? event.orderId ?? event.id
  const title = `[ALLEGRO] TÖRLÉS – ${orderId}`
  const displayKind = cancellationDisplayLabel(kind)
  const products =
    detail !== null
      ? productTableData(detail.productLines)
      : null
  const { textBody, htmlBody } = emailShell(
    title,
    'Rendeléstörlés',
    null,
    detail
      ? [
          [
            customerSection(detail),
            shippingSection(detail),
          ],
          [
            billingSection(detail),
            {
              heading: 'TÖRLÉSI INFORMÁCIÓK',
              rows: [
                [
                  'Típus',
                  displayKind === kind
                    ? kind
                    : `${displayKind} (${kind})`,
                ],
                ['Rendelési azonosító', orderId],
                ...rowsIf(
                  'Időpont',
                  event.occurredAt ??
                    detail?.occurredAt ??
                    null,
                ),
                ...rowsIf(
                  'Indok',
                  event.reason ?? null,
                ),
                ...rowsIf(
                  'Végösszeg',
                  formatMoneyDisplay(detail?.total ?? null),
                ),
                ...rowsIf(
                  'Pénznem',
                  detail?.currency ?? null,
                ),
              ],
            },
          ],
        ]
      : [
          [
            null,
            {
              heading: 'TÖRLÉSI INFORMÁCIÓK',
              rows: [
                [
                  'Típus',
                  displayKind === kind
                    ? kind
                    : `${displayKind} (${kind})`,
                ],
                ['Rendelési azonosító', orderId],
                ...rowsIf(
                  'Időpont',
                  event.occurredAt ?? null,
                ),
                ...rowsIf(
                  'Indok',
                  event.reason ?? null,
                ),
              ],
            },
          ],
        ],
    [],
    [],
    products,
  )

  return { to, subject: title, textBody, htmlBody }
}

/* Compact customer block for order-related buyer
 * messages. Deliberately no billing/invoice section: no
 * billing classification exists in the message payload,
 * so one is never inferred. */
function messageCustomerSection(
  detail: OrderDetail,
): NotifyEmailSection {
  const customer = detail.customer
  const shipping = detail.shipping
  const addressLine = [
    shipping.recipientName,
    shipping.street,
    [shipping.zipCode, shipping.city]
      .filter((part) => part !== null && part !== '')
      .join(' '),
    shipping.countryCode,
  ]
    .filter((part) => part !== null && part !== '')
    .join(', ')

  return {
    heading: 'ÜGYFÉL',
    rows: [
      ...rowsIf(
        'Név',
        customer.fullName ?? customer.login,
      ),
      ...rowsIf('Email', customer.email),
      ...rowsIf('Telefon', customer.phone),
      ...rowsIf(
        'Szállítási cím',
        addressLine === '' ? null : addressLine,
      ),
    ],
  }
}

/* Buyer message relationship: order-related, offer /
 * product-related, or general. Irrelevant relationship
 * sections are omitted entirely — never "nincs"
 * placeholders. Product name/SKU render only when present
 * in the available data (the message payload carries the
 * offer ID; names come from order enrichment when the
 * message is order-related). */
function messageRelationSection(
  message: NotifyMessage,
  detail: OrderDetail | null,
): NotifyEmailSection | null {
  if (message.orderId) {
    return {
      heading: 'KAPCSOLÓDÓ RENDELÉS',
      rows: [
        ...rowsIf('Rendelés', message.orderId),
        ...rowsIf('Ajánlat', message.offerId),
      ],
    }
  }

  if (message.offerId) {
    const enriched = detail?.productLines.find(
      (line) => line.offerId === message.offerId,
    )

    return {
      heading: 'KAPCSOLÓDÓ TERMÉK / AJÁNLAT',
      rows: [
        ...rowsIf('Ajánlat', message.offerId),
        ...rowsIf(
          'Termék',
          enriched?.name ?? null,
        ),
        ...rowsIf('SKU', enriched?.sku ?? null),
      ],
    }
  }

  return null
}

export function buildMessageEmail(
  to: string,
  message: NotifyMessage,
  detail: OrderDetail | null = null,
): NotifyEmail {
  const title = message.orderId
    ? `[ALLEGRO] ÜZENET – ${message.orderId}`
    : message.offerId
      ? `[ALLEGRO] ÜZENET – ${message.offerId}`
      : '[ALLEGRO] ÜZENET'
  const subLabel = message.orderId
    ? 'Rendeléshez kapcsolódó megkeresés'
    : message.offerId
      ? 'Termékhez kapcsolódó kérdés'
      : 'Általános megkeresés'
  const customer = detail
    ? messageCustomerSection(detail)
    : null
  const relation = messageRelationSection(
    message,
    detail,
  )
  const meta: NotifyEmailSection = {
    heading: 'ÜZENET ADATAI',
    rows: [
      ...rowsIf('Vevő', message.authorLogin),
      ...rowsIf('Időpont', message.createdAt),
    ],
  }
  const attachments: NotifyEmailSection = {
    heading: 'CSATOLMÁNYOK',
    rows: message.attachmentNames.map(
      (name, index) =>
        [`${index + 1}. fájl`, name] as [
          string,
          string,
        ],
    ),
  }
  const { textBody, htmlBody } = emailShell(
    title,
    'Vásárlói üzenet',
    subLabel,
    customer || relation
      ? [[customer, relation]]
      : [],
    [meta, attachments],
    [
      {
        label: 'ÜZENET TARTALMA',
        value: message.text ?? '–',
      },
    ],
    null,
  )

  return { to, subject: title, textBody, htmlBody }
}

/* ============================================================
 * Apps Script relay envelope (signed JSON, no custom headers).
 * canonical = timestamp + "\n" + nonce + "\n" + canonicalJson.
 * ============================================================ */

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()

    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
      )
      .join(',')}}`
  }

  return JSON.stringify(value) ?? 'null'
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    utf8Bytes(message),
  )

  return hexEncode(new Uint8Array(signature))
}

export type RelayPayload = {
  to: string
  subject: string
  textBody: string
  htmlBody: string
}

export type RelayEnvelope = {
  timestamp: string
  nonce: string
  payload: RelayPayload
  signature: string
}

export function relayCanonicalMessage(
  timestamp: string,
  nonce: string,
  payload: RelayPayload,
): string {
  return `${timestamp}\n${nonce}\n${canonicalJson(payload)}`
}

export async function signRelayEnvelope(
  secret: string,
  timestamp: string,
  nonce: string,
  payload: RelayPayload,
): Promise<RelayEnvelope> {
  return {
    timestamp,
    nonce,
    payload,
    signature: await hmacSha256Hex(
      secret,
      relayCanonicalMessage(timestamp, nonce, payload),
    ),
  }
}

/*
 * Mirrors the Apps Script verification logic so the same
 * vectors are testable on both sides.
 */
export async function verifyRelayEnvelope(
  secret: string,
  envelope: RelayEnvelope,
  nowMs: number,
  maxSkewMs = RELAY_SKEW_MS,
): Promise<{ ok: boolean; reason: string }> {
  if (
    typeof envelope.timestamp !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.signature !== 'string' ||
    recordOf(envelope.payload) === null
  ) {
    return { ok: false, reason: 'INVALID_SHAPE' }
  }

  const { to, subject, textBody, htmlBody } =
    envelope.payload

  if (
    typeof to !== 'string' ||
    typeof subject !== 'string' ||
    typeof textBody !== 'string' ||
    typeof htmlBody !== 'string' ||
    to === '' ||
    subject === ''
  ) {
    return { ok: false, reason: 'INVALID_PAYLOAD' }
  }

  const envelopeSize =
    envelope.payload.to.length +
    envelope.payload.subject.length +
    envelope.payload.textBody.length +
    envelope.payload.htmlBody.length

  if (envelopeSize > RELAY_MAX_BODY_CHARS) {
    return { ok: false, reason: 'PAYLOAD_TOO_LARGE' }
  }

  const timestampMs = Date.parse(envelope.timestamp)

  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' }
  }

  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'STALE_TIMESTAMP' }
  }

  const expected = await hmacSha256Hex(
    secret,
    relayCanonicalMessage(
      envelope.timestamp,
      envelope.nonce,
      envelope.payload,
    ),
  )

  if (expected.length !== envelope.signature.length) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  let difference = 0

  for (
    let index = 0;
    index < expected.length;
    index += 1
  ) {
    difference |=
      expected.charCodeAt(index) ^
      envelope.signature.charCodeAt(index)
  }

  return difference === 0
    ? { ok: true, reason: 'OK' }
    : { ok: false, reason: 'BAD_SIGNATURE' }
}

export async function postRelayEmail(
  relayUrl: string,
  envelope: RelayEnvelope,
  fetchImpl: FetchImpl = defaultFetch(),
): Promise<{ ok: boolean; status: number }> {
  const response = await fetchImpl(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  })

  if (!response.ok) {
    return { ok: false, status: response.status }
  }

  const data = (await readJsonSafe(response)) as {
    ok?: unknown
  } | null

  return data?.ok === true
    ? { ok: true, status: response.status }
    : { ok: false, status: response.status }
}

/* Diagnostic history scan bound: the order-events journal
 * pages forward only, so predecessors of the cursor are
 * found by scanning from the journal start with a flat
 * 5-record sliding window. 50 pages (5000 events) keeps a
 * manual ADMIN call bounded; when the cursor is not reached
 * inside the bound the field is honestly empty instead of
 * fabricated. */
const DIAGNOSTIC_HISTORY_MAX_PAGES = 50
const DIAGNOSTIC_HISTORY_WINDOW = 5

/* ============================================================
 * Pull/ack bridge authentication (Apps Script -> Hub).
 *
 * The endpoints are transport-public (Apps Script cannot
 * present Commerce Hub credentials) but application-private:
 * every request must carry
 *
 *   X-Allegro-Notify-Timestamp
 *   X-Allegro-Notify-Nonce
 *   X-Allegro-Notify-Signature
 *
 * with signature = HMAC-SHA256(secret,
 *   timestamp + "\n" + nonce + "\n" + canonicalJson(body)).
 *
 * Same canonical/HMAC/UTF-8 construction as the legacy
 * relay envelope, so the existing cross-runtime HMAC
 * compatibility vector stays valid. Verification runs
 * BEFORE any Allegro/OAuth/KV-mutating work, and the
 * secret/signature/body are never logged.
 * ============================================================ */

export function bridgeCanonicalMessage(
  timestamp: string,
  nonce: string,
  body: unknown,
): string {
  return `${timestamp}\n${nonce}\n${canonicalJson(body ?? null)}`
}

export async function verifyBridgeRequest(
  secret: string,
  timestamp: unknown,
  nonce: unknown,
  signature: unknown,
  body: unknown,
  nowMs: number,
  maxSkewMs = RELAY_SKEW_MS,
): Promise<{ ok: boolean; reason: string }> {
  if (
    typeof timestamp !== 'string' ||
    typeof nonce !== 'string' ||
    typeof signature !== 'string' ||
    timestamp === '' ||
    nonce === '' ||
    signature === ''
  ) {
    return { ok: false, reason: 'INVALID_AUTH' }
  }

  const timestampMs = Date.parse(timestamp)

  if (!Number.isFinite(timestampMs)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' }
  }

  if (Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'STALE_TIMESTAMP' }
  }

  const expected = await hmacSha256Hex(
    secret,
    bridgeCanonicalMessage(timestamp, nonce, body),
  )

  if (expected.length !== signature.length) {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }

  let difference = 0

  for (
    let index = 0;
    index < expected.length;
    index += 1
  ) {
    difference |=
      expected.charCodeAt(index) ^
      signature.charCodeAt(index)
  }

  return difference === 0
    ? { ok: true, reason: 'OK' }
    : { ok: false, reason: 'BAD_SIGNATURE' }
}

/* ============================================================
 * Order-event journal high-water mark.
 *
 * Allegro /order/events is a journal: responses list
 * events in journal order (oldest first) and `from=<last
 * event id>` continues the journal AFTER that event. The
 * implementation therefore pages forward from the given
 * start until a short (or empty) page ends the journal and
 * takes the LAST event of the LAST non-empty page as the
 * high-water mark. Opaque IDs are never sorted or
 * compared — position in the journal is the only ordering
 * signal used.
 *
 * This shared helper fixes the historical-flood bootstrap:
 * one 100-row page is NOT assumed sufficient.
 * ============================================================ */

export type OrderHighWater = {
  highWaterId: string | null
  eventsScanned: number
  pages: number
}

export async function fetchOrderHighWater(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  startFrom: string | null = null,
): Promise<
  | { ok: true; highWater: OrderHighWater }
  | { ok: false; status: number }
> {
  let from = startFrom
  let highWaterId: string | null = null
  let eventsScanned = 0
  let pages = 0

  while (pages < ORDER_HIGH_WATER_MAX_PAGES) {
    const url =
      `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
      (from
        ? `&from=${encodeURIComponent(from)}`
        : '')
    const fetched = await fetchJson(
      url,
      tokens,
      config,
      fetchImpl,
    )

    if (!fetched.ok) {
      return { ok: false, status: fetched.status }
    }

    pages += 1
    const events = parseOrderEvents(fetched.data)
    eventsScanned += events.length

    if (events.length === 0) {
      break
    }

    highWaterId = events[events.length - 1]!.id
    from = highWaterId

    if (events.length < ORDER_PAGE_LIMIT) {
      break
    }
  }

  return {
    ok: true,
    highWater: { highWaterId, eventsScanned, pages },
  }
}

function isValidCursor(
  cursor: StoredCursor | null,
): cursor is StoredCursor {
  return (
    cursor !== null &&
    typeof cursor.lastId === 'string' &&
    cursor.lastId !== ''
  )
}

/* ============================================================
 * Pull/ack bridge state machine.
 *
 * KV persists ONLY technical recreation data (see
 * BridgePending): channel, event/message/thread/order
 * identifiers, event type, opaque delivery ID, the cursor
 * value observed at pull time, and technical timestamps.
 * Rendered subjects/bodies, customer data, and message
 * text are built in memory per pull and never stored.
 * ============================================================ */

export type BridgePending = {
  deliveryId: string
  channel: 'order' | 'message'
  eventId: string
  eventType: string
  orderId: string | null
  threadId: string | null
  offerId: string | null
  messageId: string | null
  cursorBefore: string | null
  createdAt: string
}

export type BridgeEmail = {
  to: string
  subject: string
  textBody: string
  htmlBody: string
}

export type NotifyPullResult =
  | { action: 'DISABLED' }
  | { action: 'NEEDS_BOOTSTRAP' }
  | { action: 'NOOP' }
  | { action: 'PONG' }
  | { action: 'SEEDED'; channel: 'ORDER' | 'MESSAGE' }
  | {
      action: 'EMAIL'
      deliveryId: string
      email: BridgeEmail
    }

export type NotifyAckResult =
  | { action: 'DISABLED' }
  | { action: 'ACKED'; duplicate: boolean }
  | { action: 'UNKNOWN' }

function orderDeliveryId(eventId: string): string {
  return `order:${eventId}`
}

function messageDeliveryId(
  messageId: string,
): string {
  return `message:${messageId}`
}

function parseDeliveryId(
  deliveryId: unknown,
): {
  channel: 'order' | 'message'
  eventId: string
} | null {
  if (typeof deliveryId !== 'string') {
    return null
  }

  if (deliveryId.startsWith('order:') && deliveryId.length > 6) {
    return {
      channel: 'order',
      eventId: deliveryId.slice(6),
    }
  }

  if (
    deliveryId.startsWith('message:') &&
    deliveryId.length > 8
  ) {
    return {
      channel: 'message',
      eventId: deliveryId.slice(8),
    }
  }

  return null
}

export type BridgeRequestAuth = {
  timestamp: unknown
  nonce: unknown
  signature: unknown
  body: unknown
}

export type BridgeDeps = {
  environment?: NotifyEnvironment
  kv?: NotifyKv
  fetchImpl?: FetchImpl
  nowMs?: number
}

async function authenticateBridgeRequest(
  config: NotifyConfig,
  kv: NotifyKv,
  auth: BridgeRequestAuth,
  nowMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const verified = await verifyBridgeRequest(
    config.relaySecret,
    auth.timestamp,
    auth.nonce,
    auth.signature,
    auth.body,
    nowMs,
  )

  if (!verified.ok) {
    return verified
  }

  // Nonce replay prevention: first-seen wins inside the
  // 10-minute window. A repeated nonce is rejected even
  // with an otherwise valid signature.
  const claimed = await kv.setIfAbsent(
    NOTIFY_KV_KEYS.bridgeNonce(auth.nonce as string),
    {
      seenAt: new Date(nowMs).toISOString(),
    },
    { ttlMs: BRIDGE_NONCE_TTL_MS },
  )

  if (!claimed) {
    return { ok: false, reason: 'REPLAYED_NONCE' }
  }

  return { ok: true }
}

async function buildOrderEmailForEvent(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  event: NotifyOrderEvent,
): Promise<{ email: BridgeEmail } | { held: true }> {
  const kind = classifyOrderEvent(event.type)

  if (kind === null) {
    return { held: true }
  }

  const recipient =
    kind === 'NEW_ORDER'
      ? config.orderEmail
      : (config.cancellationEmail ?? config.orderEmail)

  if (!recipient) {
    return { held: true }
  }

  let detail: OrderDetail | null = null

  if (event.orderId) {
    const detailFetched = await fetchJson(
      `${config.apiUrl}/order/checkout-forms/${encodeURIComponent(event.orderId)}`,
      tokens,
      config,
      fetchImpl,
    )

    if (detailFetched.ok) {
      detail = parseCheckoutForm(
        event.orderId,
        detailFetched.data,
      )
    } else {
      notifyWarn('notify order detail failed', {
        eventType: event.type,
        eventId: event.id,
        httpStatus: detailFetched.status,
      })
    }
  }

  const email =
    kind === 'NEW_ORDER'
      ? buildOrderEmail(
          recipient,
          event,
          detail ??
            emptyOrderDetail(
              event.orderId ?? event.id,
              event.occurredAt,
            ),
        )
      : buildCancellationEmail(
          recipient,
          event.type,
          event,
          detail,
        )

  return {
    email: {
      to: email.to,
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
    },
  }
}

async function buildMessageEmailForMessage(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  message: NotifyMessage,
): Promise<{ email: BridgeEmail } | { held: true }> {
  if (!config.messageEmail) {
    return { held: true }
  }

  let detail: OrderDetail | null = null

  if (message.orderId) {
    const detailFetched = await fetchJson(
      `${config.apiUrl}/order/checkout-forms/${encodeURIComponent(message.orderId)}`,
      tokens,
      config,
      fetchImpl,
    )

    if (detailFetched.ok) {
      detail = parseCheckoutForm(
        message.orderId,
        detailFetched.data,
      )
    } else {
      notifyWarn('notify order detail failed', {
        eventType: 'MESSAGE',
        eventId: message.id,
        httpStatus: detailFetched.status,
      })
    }
  }

  const email = buildMessageEmail(
    config.messageEmail,
    message,
    detail,
  )

  return {
    email: {
      to: email.to,
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
    },
  }
}

/* Recreate the EMAIL payload for an existing pending
 * claim. Re-fetches Allegro state in memory so the
 * retried email reflects current data; never reads PII
 * from KV because none is stored there. Returns null
 * when the underlying event can no longer be resolved
 * (caller then drops the stale claim and continues). */
async function rebuildPendingEmail(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  pending: BridgePending,
): Promise<{ email: BridgeEmail } | null> {
  if (pending.channel === 'order') {
    const page = await fetchJson(
      `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
        (pending.cursorBefore
          ? `&from=${encodeURIComponent(pending.cursorBefore)}`
          : ''),
      tokens,
      config,
      fetchImpl,
    )

    if (!page.ok) {
      return null
    }

    // Scan a bounded window for the claimed event. The
    // claim is normally on the first page; a few extra
    // pages tolerate concurrent journal growth.
    let pages = 0
    let from = pending.cursorBefore
    let found: NotifyOrderEvent | null = null

    while (pages < ORDER_PULL_MAX_PAGES) {
      const url =
        `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
        (from
          ? `&from=${encodeURIComponent(from)}`
          : '')
      const fetched =
        pages === 0
          ? page
          : await fetchJson(
              url,
              tokens,
              config,
              fetchImpl,
            )

      if (!fetched.ok) {
        return null
      }

      pages += 1
      const events = parseOrderEvents(fetched.data)

      if (events.length === 0) {
        break
      }

      const match = events.find(
        (event) => event.id === pending.eventId,
      )

      if (match) {
        found = match
        break
      }

      from = events[events.length - 1]!.id

      if (events.length < ORDER_PAGE_LIMIT) {
        break
      }
    }

    if (!found) {
      return null
    }

    const built = await buildOrderEmailForEvent(
      config,
      tokens,
      fetchImpl,
      found,
    )

    return 'email' in built ? built : null
  }

  const fetched = await fetchAllThreadMessages(
    config,
    tokens,
    fetchImpl,
    pending.threadId ?? '',
  )

  if (!fetched.ok || !pending.threadId) {
    return null
  }

  const match = fetched.messages.find(
    (message) => message.id === pending.messageId,
  )

  if (!match || !isNotifiableMessage(match)) {
    return null
  }

  const built = await buildMessageEmailForMessage(
    config,
    tokens,
    fetchImpl,
    match,
  )

  return 'email' in built ? built : null
}

/* Next undelivered order event at/after the cursor.
 * Ignored event types advance the returned cursor but
 * never produce email. Returns null when the bounded
 * scan finds no pending event. */
async function findNextOrderEvent(
  config: NotifyConfig,
  kv: NotifyKv,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  cursor: StoredCursor,
): Promise<
  | {
      event: NotifyOrderEvent
      advanceCursorTo: string
    }
  | { none: true }
> {
  let from: string | null = cursor.lastId
  let advanceCursorTo = cursor.lastId

  for (
    let page = 0;
    page < ORDER_PULL_MAX_PAGES;
    page += 1
  ) {
    const fetched = await fetchJson(
      `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
        (from
          ? `&from=${encodeURIComponent(from)}`
          : ''),
      tokens,
      config,
      fetchImpl,
    )

    if (!fetched.ok) {
      notifyWarn('notify order poll failed', {
        httpStatus: fetched.status,
      })
      return { none: true }
    }

    const events = parseOrderEvents(fetched.data)

    if (events.length === 0) {
      break
    }

    for (const event of events) {
      if (classifyOrderEvent(event.type) === null) {
        advanceCursorTo = event.id
        continue
      }

      if (
        (await kv.get(
          NOTIFY_KV_KEYS.sentOrder(event.id),
        )) !== null
      ) {
        advanceCursorTo = event.id
        continue
      }

      return { event, advanceCursorTo }
    }

    from = events[events.length - 1]!.id

    if (events.length < ORDER_PAGE_LIMIT) {
      break
    }
  }

  if (advanceCursorTo !== cursor.lastId) {
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: advanceCursorTo,
      updatedAt: new Date().toISOString(),
    } satisfies StoredCursor)
  }

  return { none: true }
}

export async function handleNotifyPull(
  auth: BridgeRequestAuth,
  deps: BridgeDeps = {},
): Promise<
  | { httpStatus: 401; reason: string }
  | { httpStatus: 503; reason: string }
  | { httpStatus: 200; result: NotifyPullResult }
> {
  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? defaultFetch()

  let config: NotifyConfig

  try {
    config = resolveNotifyConfig(environment)
  } catch {
    return { httpStatus: 503, reason: 'NOT_CONFIGURED' }
  }

  const kv = deps.kv ?? (await getNotifyKvStore())
  const authenticated = await authenticateBridgeRequest(
    config,
    kv,
    auth,
    nowMs,
  )

  if (!authenticated.ok) {
    return { httpStatus: 401, reason: authenticated.reason }
  }

  const body = (
    recordOf(auth.body) ?? {}
  ) as Record<string, unknown>

  // Safe connectivity check: validates HMAC, performs no
  // Allegro poll, mutates no cursor, sends no email. When
  // the flag is off it still reports DISABLED (auth already
  // proved the bridge + secret work).
  if (body['mode'] === 'ping') {
    return {
      httpStatus: 200,
      result: config.enabled
        ? { action: 'PONG' }
        : { action: 'DISABLED' },
    }
  }

  if (!config.enabled) {
    return {
      httpStatus: 200,
      result: { action: 'DISABLED' },
    }
  }

  const session = await ensureAccessToken(
    config,
    kv,
    nowMs,
    fetchImpl,
  )

  if ('missing' in session) {
    notifyWarn('notify pull needs OAuth bootstrap', {})
    return {
      httpStatus: 200,
      result: { action: 'NEEDS_BOOTSTRAP' },
    }
  }

  const { tokens } = session

  // A pending claim wins over everything newer: the
  // failed email is retried before its cursor advances.
  const pending =
    await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)

  if (pending && typeof pending.deliveryId === 'string') {
    const rebuilt = await rebuildPendingEmail(
      config,
      tokens,
      fetchImpl,
      pending,
    )

    if (rebuilt) {
      return {
        httpStatus: 200,
        result: {
          action: 'EMAIL',
          deliveryId: pending.deliveryId,
          email: rebuilt.email,
        },
      }
    }

    // Stale claim (event no longer resolvable): drop it
    // and continue selecting fresh work below. Dropping
    // is loss-free here because the event was never
    // marked delivered AND can no longer be found — the
    // next scan re-derives state from the cursors.
    notifyWarn('notify pending claim dropped', {
      eventType: pending.eventType,
      eventId: pending.eventId,
    })
    await kv.delete(NOTIFY_KV_KEYS.pending)
  }

  // Orders first (matches the legacy tick priority).
  const orderCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.orderCursor,
  )

  if (!isValidCursor(orderCursor)) {
    // Historical-flood fix: walk the whole journal to
    // the true high-water mark, store ONLY the cursor,
    // send ZERO emails, create ZERO delivered markers.
    // Only events appearing AFTER this seed may notify.
    const seeded = await fetchOrderHighWater(
      config,
      tokens,
      fetchImpl,
      null,
    )

    if (!seeded.ok) {
      notifyWarn('notify order seed poll failed', {
        httpStatus: seeded.status,
      })
      return {
        httpStatus: 200,
        result: { action: 'NOOP' },
      }
    }

    if (seeded.highWater.highWaterId) {
      await kv.set(NOTIFY_KV_KEYS.orderCursor, {
        lastId: seeded.highWater.highWaterId,
        updatedAt: new Date(nowMs).toISOString(),
      } satisfies StoredCursor)
      notifyLog('notify order cursor seeded', {
        eventId: seeded.highWater.highWaterId,
        eventsSeen: seeded.highWater.eventsScanned,
      })
    }

    return {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'ORDER' },
    }
  }

  const nextOrder = await findNextOrderEvent(
    config,
    kv,
    tokens,
    fetchImpl,
    orderCursor,
  )

  if (!('none' in nextOrder)) {
    const built = await buildOrderEmailForEvent(
      config,
      tokens,
      fetchImpl,
      nextOrder.event,
    )

    if ('email' in built) {
      const deliveryId = orderDeliveryId(
        nextOrder.event.id,
      )
      await kv.set(
        NOTIFY_KV_KEYS.pending,
        {
          deliveryId,
          channel: 'order',
          eventId: nextOrder.event.id,
          eventType: nextOrder.event.type,
          orderId: nextOrder.event.orderId,
          threadId: null,
          offerId: null,
          messageId: null,
          cursorBefore: orderCursor.lastId,
          createdAt: new Date(nowMs).toISOString(),
        } satisfies BridgePending,
        { ttlMs: PENDING_TTL_MS },
      )

      return {
        httpStatus: 200,
        result: {
          action: 'EMAIL',
          deliveryId,
          email: built.email,
        },
      }
    }
  }

  // Buyer messages (cursor preserved across the
  // migration; a fresh environment seeds silently).
  const messageCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.messageCursor,
  )
  const threadsFetched = await fetchAllThreadIds(
    config,
    tokens,
    fetchImpl,
  )

  if (!threadsFetched.ok) {
    notifyWarn('notify thread poll failed', {
      httpStatus: threadsFetched.status,
    })
    return {
      httpStatus: 200,
      result: { action: 'NOOP' },
    }
  }

  const candidates: NotifyMessage[] = []

  for (const threadId of threadsFetched.threadIds) {
    const messagesFetched =
      await fetchAllThreadMessages(
        config,
        tokens,
        fetchImpl,
        threadId,
      )

    if (!messagesFetched.ok) {
      notifyWarn('notify message poll failed', {
        httpStatus: messagesFetched.status,
        threadId,
      })
      continue
    }

    for (const message of messagesFetched.messages) {
      if (
        isNotifiableMessage(message) &&
        (!messageCursor ||
          message.id > messageCursor.lastId)
      ) {
        candidates.push(message)
      }
    }
  }

  candidates.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  )

  if (!isValidCursor(messageCursor)) {
    if (candidates.length > 0) {
      const newest = candidates[candidates.length - 1]!

      await kv.set(NOTIFY_KV_KEYS.messageCursor, {
        lastId: newest.id,
        updatedAt: new Date(nowMs).toISOString(),
      } satisfies StoredCursor)
      notifyLog('notify message cursor seeded', {
        eventId: newest.id,
        eventsSeen: candidates.length,
      })
    }

    return {
      httpStatus: 200,
      result: { action: 'SEEDED', channel: 'MESSAGE' },
    }
  }

  for (const message of candidates) {
    if (
      (await kv.get(
        NOTIFY_KV_KEYS.sentMessage(message.id),
      )) !== null
    ) {
      continue
    }

    const built = await buildMessageEmailForMessage(
      config,
      tokens,
      fetchImpl,
      message,
    )

    if (!('email' in built)) {
      continue
    }

    const deliveryId = messageDeliveryId(message.id)
    await kv.set(
      NOTIFY_KV_KEYS.pending,
      {
        deliveryId,
        channel: 'message',
        eventId: message.id,
        eventType: 'MESSAGE',
        orderId: message.orderId,
        threadId: message.threadId,
        offerId: message.offerId,
        messageId: message.id,
        cursorBefore: messageCursor.lastId,
        createdAt: new Date(nowMs).toISOString(),
      } satisfies BridgePending,
      { ttlMs: PENDING_TTL_MS },
    )

    return {
      httpStatus: 200,
      result: {
        action: 'EMAIL',
        deliveryId,
        email: built.email,
      },
    }
  }

  return {
    httpStatus: 200,
    result: { action: 'NOOP' },
  }
}

export async function handleNotifyAck(
  auth: BridgeRequestAuth,
  deps: BridgeDeps = {},
): Promise<
  | { httpStatus: 401; reason: string }
  | { httpStatus: 503; reason: string }
  | { httpStatus: 200; result: NotifyAckResult }
> {
  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()

  let config: NotifyConfig

  try {
    config = resolveNotifyConfig(environment)
  } catch {
    return { httpStatus: 503, reason: 'NOT_CONFIGURED' }
  }

  const kv = deps.kv ?? (await getNotifyKvStore())
  const authenticated = await authenticateBridgeRequest(
    config,
    kv,
    auth,
    nowMs,
  )

  if (!authenticated.ok) {
    return { httpStatus: 401, reason: authenticated.reason }
  }

  // Fail closed while disabled: never mutate delivery
  // state, even for a well-formed ACK.
  if (!config.enabled) {
    return {
      httpStatus: 200,
      result: { action: 'DISABLED' },
    }
  }

  const parsed = parseDeliveryId(
    recordOf(auth.body)?.['deliveryId'],
  )

  if (!parsed) {
    return {
      httpStatus: 200,
      result: { action: 'UNKNOWN' },
    }
  }

  const deliveryId =
    parsed.channel === 'order'
      ? orderDeliveryId(parsed.eventId)
      : messageDeliveryId(parsed.eventId)
  const pending =
    await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)

  if (
    pending &&
    pending.deliveryId === deliveryId &&
    pending.eventId === parsed.eventId
  ) {
    const markerKey =
      pending.channel === 'order'
        ? NOTIFY_KV_KEYS.sentOrder(pending.eventId)
        : NOTIFY_KV_KEYS.sentMessage(pending.eventId)

    await kv.set(
      markerKey,
      {
        deliveredAt: new Date(nowMs).toISOString(),
        channel:
          pending.channel === 'order'
            ? pending.eventType === 'READY_FOR_PROCESSING'
              ? 'order'
              : 'cancellation'
            : 'message',
      } satisfies StoredDelivery,
      { ttlMs: DEDUPE_TTL_MS },
    )

    // Advance the cursor ONLY when it still equals the
    // value observed at pull time. If an operator
    // reseeded forward in between, the cursor stays
    // forward (never moved backward into history).
    const cursorKey =
      pending.channel === 'order'
        ? NOTIFY_KV_KEYS.orderCursor
        : NOTIFY_KV_KEYS.messageCursor
    const current =
      await kv.get<StoredCursor>(cursorKey)

    if (
      (current === null && pending.cursorBefore === null) ||
      (current !== null &&
        current.lastId === pending.cursorBefore)
    ) {
      await kv.set(cursorKey, {
        lastId: pending.eventId,
        updatedAt: new Date(nowMs).toISOString(),
      } satisfies StoredCursor)
    }

    await kv.delete(NOTIFY_KV_KEYS.pending)

    return {
      httpStatus: 200,
      result: { action: 'ACKED', duplicate: false },
    }
  }

  // Idempotent retry: the claim is gone but the event was
  // already marked delivered (e.g. the first ACK commit
  // landed, then the response was lost).
  const markerKey =
    parsed.channel === 'order'
      ? NOTIFY_KV_KEYS.sentOrder(parsed.eventId)
      : NOTIFY_KV_KEYS.sentMessage(parsed.eventId)

  if ((await kv.get(markerKey)) !== null) {
    return {
      httpStatus: 200,
      result: { action: 'ACKED', duplicate: true },
    }
  }

  return {
    httpStatus: 200,
    result: { action: 'UNKNOWN' },
  }
}

/* ============================================================
 * ADMIN-only safe order recovery (works while disabled).
 * Walks the journal to the current high-water mark, writes
 * ONLY the order cursor, drops a stale ORDER pending claim
 * if one exists, sends ZERO emails, creates ZERO delivered
 * markers, and never touches the message cursor/dedupe.
 * ============================================================ */

export type NotifyReseedResult = {
  previousCursor: string | null
  highWaterId: string | null
  eventsScanned: number
  pages: number
  clearedOrderPending: boolean
}

export async function reseedNotifyOrders(
  deps: BridgeDeps = {},
): Promise<
  | { ok: true; reseed: NotifyReseedResult }
  | { ok: false; reason: string; status?: number }
> {
  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? defaultFetch()

  let config: NotifyConfig

  try {
    config = resolveNotifyConfig(environment)
  } catch {
    return { ok: false, reason: 'NOT_CONFIGURED' }
  }

  const kv = deps.kv ?? (await getNotifyKvStore())
  const session = await ensureAccessToken(
    config,
    kv,
    nowMs,
    fetchImpl,
  )

  if ('missing' in session) {
    return { ok: false, reason: 'NEEDS_BOOTSTRAP' }
  }

  const previous = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.orderCursor,
  )
  const highWater = await fetchOrderHighWater(
    config,
    session.tokens,
    fetchImpl,
    null,
  )

  if (!highWater.ok) {
    return {
      ok: false,
      reason: 'ORDER_POLL_FAILED',
      status: highWater.status,
    }
  }

  let clearedOrderPending = false
  const pending =
    await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)

  if (pending && pending.channel === 'order') {
    await kv.delete(NOTIFY_KV_KEYS.pending)
    clearedOrderPending = true
  }

  if (highWater.highWater.highWaterId) {
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: highWater.highWater.highWaterId,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
  }

  notifyLog('notify orders reseeded', {
    eventsScanned: highWater.highWater.eventsScanned,
    clearedOrderPending,
  })

  return {
    ok: true,
    reseed: {
      previousCursor: previous?.lastId ?? null,
      highWaterId:
        highWater.highWater.highWaterId,
      eventsScanned:
        highWater.highWater.eventsScanned,
      pages: highWater.highWater.pages,
      clearedOrderPending,
    },
  }
}

/* ============================================================
 * ADMIN-only read-only email preview. Renders the exact
 * email the bridge WOULD send for an already-processed
 * order event, using the same buildOrderEmailForEvent code
 * as real delivery (no duplicated template logic). The
 * email is returned to the authenticated ADMIN browser
 * only: nothing is persisted, logged, marked, claimed,
 * sent, or advanced. Checkout-form detail lives in memory
 * for the duration of this call.
 * ============================================================ */

export type NotifyPreview = {
  event: {
    id: string
    type: string
    checkoutFormId: string | null
    occurredAt: string | null
  }
  email: BridgeEmail
}

export async function previewNotifyEmail(
  eventId: string,
  deps: BridgeDeps = {},
): Promise<
  | { ok: true; preview: NotifyPreview }
  | { ok: false; reason: string; status?: number }
> {
  if (typeof eventId !== 'string' || eventId === '') {
    return { ok: false, reason: 'INVALID_EVENT_ID' }
  }

  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? defaultFetch()

  let config: NotifyConfig

  try {
    config = resolveNotifyConfig(environment)
  } catch {
    return { ok: false, reason: 'NOT_CONFIGURED' }
  }

  const kv = deps.kv ?? (await getNotifyKvStore())
  const session = await ensureAccessToken(
    config,
    kv,
    nowMs,
    fetchImpl,
  )

  if ('missing' in session) {
    return { ok: false, reason: 'NEEDS_BOOTSTRAP' }
  }

  // Locate the event by id equality while paging forward
  // (same bounded journal walk as the diagnostic history;
  // opaque ids are never ordered). Read-only: no cursor,
  // pending, or dedupe key is touched.
  let found: NotifyOrderEvent | null = null

  {
    let from: string | null = null

    for (
      let page = 0;
      page < DIAGNOSTIC_HISTORY_MAX_PAGES;
      page += 1
    ) {
      const fetched = await fetchJson(
        `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
          (from
            ? `&from=${encodeURIComponent(from)}`
            : ''),
        session.tokens,
        config,
        fetchImpl,
      )

      if (!fetched.ok) {
        return {
          ok: false,
          reason: 'DIAGNOSTIC_POLL_FAILED',
          status: fetched.status,
        }
      }

      const events = parseOrderEvents(fetched.data)

      if (events.length === 0) {
        break
      }

      const match = events.find(
        (event) => event.id === eventId,
      )

      if (match) {
        found = match
        break
      }

      from = events[events.length - 1]!.id

      if (events.length < ORDER_PAGE_LIMIT) {
        break
      }
    }
  }

  if (!found) {
    return { ok: false, reason: 'EVENT_NOT_FOUND' }
  }

  const kind = classifyOrderEvent(found.type)

  if (kind === null) {
    return { ok: false, reason: 'EVENT_NOT_NOTIFIABLE' }
  }

  const recipient =
    kind === 'NEW_ORDER'
      ? config.orderEmail
      : (config.cancellationEmail ?? config.orderEmail)

  if (!recipient) {
    return { ok: false, reason: 'RECIPIENT_MISSING' }
  }

  // EXACT same renderer as real delivery (order detail is
  // fetched in memory only and never stored or logged).
  const built = await buildOrderEmailForEvent(
    config,
    session.tokens,
    fetchImpl,
    found,
  )

  if (!('email' in built)) {
    return { ok: false, reason: 'RECIPIENT_MISSING' }
  }

  return {
    ok: true,
    preview: {
      event: {
        id: found.id,
        type: found.type,
        checkoutFormId: found.orderId,
        occurredAt: found.occurredAt,
      },
      email: built.email,
    },
  }
}

/* ============================================================
 * ADMIN-only read-only diagnostic. Strictly observational:
 * KV is only READ (cursors, pending claim), Allegro sees
 * only GETs (event-stats + one bounded events page), and
 * nothing is emailed, advanced, marked, claimed, or written
 * to Neon (this module has no database imports by
 * construction). Only technical identifiers leave this
 * function — event/order/message/thread IDs, types, and
 * timestamps. No buyer, customer, order-content, or message
 * fields are selected, stored, or logged. Works whether the
 * bridge flag is on or off.
 * ============================================================ */

export type NotifyDiagnosticsEvent = {
  id: string
  type: string
  checkoutFormId: string | null
  occurredAt: string | null
}

export type NotifyDiagnostics = {
  enabled: boolean
  orderCursor: string | null
  orderPending: {
    deliveryId: string
    eventId: string
    eventType: string
    orderId: string | null
  } | null
  messageCursorPresent: boolean
  allegroLatestEvent: {
    id: string
    occurredAt: string | null
  } | null
  eventsAfterCursor: NotifyDiagnosticsEvent[]
  lastProcessedOrderEvents: NotifyDiagnosticsEvent[]
}

/* /order/event-stats shape is parsed defensively: only a
 * technical latest-event id + timestamp are extracted, and
 * anything unrecognized yields null instead of invented
 * data. */
function parseLatestEvent(
  payload: unknown,
): { id: string; occurredAt: string | null } | null {
  const root = recordOf(payload)

  if (!root) {
    return null
  }

  const holders = [
    root['latestEvent'],
    root['lastEvent'],
    root,
  ]

  for (const holder of holders) {
    const record = recordOf(holder)

    if (!record) {
      continue
    }

    const id =
      textOrNull(record['id']) ??
      textOrNull(record['eventId'])

    if (!id) {
      continue
    }

    return {
      id,
      occurredAt:
        textOrNull(record['occurredAt']) ??
        textOrNull(record['createdAt']),
    }
  }

  return null
}

export async function getNotifyDiagnostics(
  deps: BridgeDeps = {},
): Promise<
  | { ok: true; diagnostics: NotifyDiagnostics }
  | { ok: false; reason: string; status?: number }
> {
  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? defaultFetch()

  let config: NotifyConfig

  try {
    config = resolveNotifyConfig(environment)
  } catch {
    return { ok: false, reason: 'NOT_CONFIGURED' }
  }

  // Read-only by construction: every KV access below is
  // get(), every Allegro call is GET, and no email,
  // cursor, dedupe, pending, or Neon mutation exists on
  // this path.
  const kv = deps.kv ?? (await getNotifyKvStore())
  const session = await ensureAccessToken(
    config,
    kv,
    nowMs,
    fetchImpl,
  )

  if ('missing' in session) {
    return { ok: false, reason: 'NEEDS_BOOTSTRAP' }
  }

  const { tokens } = session
  const orderCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.orderCursor,
  )
  const messageCursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.messageCursor,
  )
  const pending =
    await kv.get<BridgePending>(NOTIFY_KV_KEYS.pending)

  const statsFetched = await fetchJson(
    `${config.apiUrl}/order/event-stats`,
    tokens,
    config,
    fetchImpl,
  )

  if (!statsFetched.ok) {
    return {
      ok: false,
      reason: 'DIAGNOSTIC_POLL_FAILED',
      status: statsFetched.status,
    }
  }

  let eventsAfterCursor: NotifyDiagnosticsEvent[] = []

  if (isValidCursor(orderCursor)) {
    const pageFetched = await fetchJson(
      `${config.apiUrl}/order/events?from=${encodeURIComponent(orderCursor.lastId)}&limit=20`,
      tokens,
      config,
      fetchImpl,
    )

    if (!pageFetched.ok) {
      return {
        ok: false,
        reason: 'DIAGNOSTIC_POLL_FAILED',
        status: pageFetched.status,
      }
    }

    eventsAfterCursor = parseOrderEvents(
      pageFetched.data,
    ).map((event) => ({
      id: event.id,
      type: event.type,
      checkoutFormId: event.orderId,
      occurredAt: event.occurredAt,
    }))
  }

  // Predecessors of the cursor: the journal pages forward
  // only (`from` continues AFTER an id), so walk from the
  // journal start with a flat sliding window and stop at
  // the cursor id itself. Matching is by id equality only
  // — opaque ids are never ordered or compared. The window
  // holds whitelisted technical fields; checkout-form
  // detail is never fetched here, so customer data never
  // even enters memory on this path.
  let lastProcessedOrderEvents: NotifyDiagnosticsEvent[] =
    []

  if (isValidCursor(orderCursor)) {
    const window: NotifyDiagnosticsEvent[] = []
    let from: string | null = null
    let reached = false

    for (
      let page = 0;
      page < DIAGNOSTIC_HISTORY_MAX_PAGES;
      page += 1
    ) {
      const historyFetched = await fetchJson(
        `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
          (from
            ? `&from=${encodeURIComponent(from)}`
            : ''),
        tokens,
        config,
        fetchImpl,
      )

      if (!historyFetched.ok) {
        return {
          ok: false,
          reason: 'DIAGNOSTIC_POLL_FAILED',
          status: historyFetched.status,
        }
      }

      const history = parseOrderEvents(
        historyFetched.data,
      )

      if (history.length === 0) {
        break
      }

      for (const event of history) {
        window.push({
          id: event.id,
          type: event.type,
          checkoutFormId: event.orderId,
          occurredAt: event.occurredAt,
        })

        if (
          window.length > DIAGNOSTIC_HISTORY_WINDOW
        ) {
          window.shift()
        }

        if (event.id === orderCursor.lastId) {
          reached = true
          break
        }
      }

      if (reached) {
        break
      }

      from = history[history.length - 1]!.id

      if (history.length < ORDER_PAGE_LIMIT) {
        break
      }
    }

    lastProcessedOrderEvents = reached ? window : []
  }

  return {
    ok: true,
    diagnostics: {
      enabled: config.enabled,
      orderCursor: orderCursor?.lastId ?? null,
      orderPending:
        pending && pending.channel === 'order'
          ? {
              deliveryId: pending.deliveryId,
              eventId: pending.eventId,
              eventType: pending.eventType,
              orderId: pending.orderId,
            }
          : null,
      messageCursorPresent: isValidCursor(messageCursor),
      allegroLatestEvent: parseLatestEvent(
        statsFetched.data,
      ),
      eventsAfterCursor,
      lastProcessedOrderEvents,
    },
  }
}

/* ============================================================
 * Notification tick: ONE cron invocation handles order
 * events and buyer messages with effectively-once delivery.
 *
 * - No Neon access anywhere on this path by construction.
 * - Lease in KV prevents overlapping executions.
 * - Checkout-form details are fetched at most once per
 *   order per tick via an in-memory Map (shared by the
 *   order and message processors). The cache is never
 *   persisted: it holds customer PII, which may exist
 *   only in memory and in the outbound relay payload.
 * - Per event: dedupe check -> one email -> one relay POST
 *   -> mark delivered only on relay success.
 * - Cursor advances over the leading delivered run only, so
 *   a failed event is retried without losing later events.
 * ============================================================ */

export type NotifyTickSummary = {
  status:
    | 'DISABLED'
    | 'LEASE_HELD'
    | 'NEEDS_BOOTSTRAP'
    | 'OK'
  orderEventsSeen: number
  orderEmailsSent: number
  orderEmailsFailed: number
  messagesSeen: number
  messageEmailsSent: number
  messageEmailsFailed: number
}

export type NotifyTickDeps = {
  environment?: NotifyEnvironment
  kv?: NotifyKv
  fetchImpl?: FetchImpl
  nowMs?: number
  nonce?: string
}

async function ensureAccessToken(
  config: NotifyConfig,
  kv: NotifyKv,
  nowMs: number,
  fetchImpl: FetchImpl,
): Promise<{ tokens: NotifyOAuthTokens } | { missing: true }> {
  const stored = await loadNotifyOAuth(
    kv,
    config.tokenKeyBytes,
  )

  if (!stored) {
    return { missing: true }
  }

  if (stored.expiresAt - nowMs > TOKEN_REFRESH_BUFFER_MS) {
    return { tokens: stored }
  }

  const rotated = await refreshNotifyTokens(
    config,
    kv,
    stored,
    nowMs,
    fetchImpl,
  )

  if (!rotated) {
    return { missing: true }
  }

  return { tokens: rotated }
}

async function fetchJson(
  url: string,
  tokens: NotifyOAuthTokens,
  config: NotifyConfig,
  fetchImpl: FetchImpl,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: PUBLIC_V1_ACCEPT,
      'User-Agent': config.userAgent,
    },
  })

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data: null,
    }
  }

  return {
    ok: true,
    status: response.status,
    data: await readJsonSafe(response),
  }
}

export async function runAllegroNotifyTick(
  deps: NotifyTickDeps = {},
): Promise<NotifyTickSummary> {
  const environment = deps.environment ?? process.env
  const nowMs = deps.nowMs ?? Date.now()
  const fetchImpl = deps.fetchImpl ?? defaultFetch()
  const summary: NotifyTickSummary = {
    status: 'OK',
    orderEventsSeen: 0,
    orderEmailsSent: 0,
    orderEmailsFailed: 0,
    messagesSeen: 0,
    messageEmailsSent: 0,
    messageEmailsFailed: 0,
  }

  if (
    environment['ALLEGRO_NOTIFY_ENABLED']
      ?.trim()
      .toLowerCase() !== 'true'
  ) {
    return { ...summary, status: 'DISABLED' }
  }

  const config = resolveNotifyConfig(environment)
  const kv = deps.kv ?? (await getNotifyKvStore())
  const leaseOwner = deps.nonce ?? randomHex(16)
  const leaseAcquired = await kv.setIfAbsent(
    NOTIFY_KV_KEYS.lease,
    { owner: leaseOwner, acquiredAt: new Date(nowMs).toISOString() },
    { ttlMs: CRON_LEASE_TTL_MS },
  )

  if (!leaseAcquired) {
    notifyWarn('notify tick skipped, lease held', {})
    return { ...summary, status: 'LEASE_HELD' }
  }

  try {
    const session = await ensureAccessToken(
      config,
      kv,
      nowMs,
      fetchImpl,
    )

    if ('missing' in session) {
      notifyWarn('notify tick needs OAuth bootstrap', {})
      return { ...summary, status: 'NEEDS_BOOTSTRAP' }
    }

    const { tokens } = session
    const orderDetailCache = new Map<
      string,
      OrderDetail | null
    >()

    await processOrderEvents(
      config,
      kv,
      tokens,
      fetchImpl,
      nowMs,
      deps.nonce,
      summary,
      orderDetailCache,
    )
    await processBuyerMessages(
      config,
      kv,
      tokens,
      fetchImpl,
      nowMs,
      deps.nonce,
      summary,
      orderDetailCache,
    )
  } finally {
    await kv.delete(NOTIFY_KV_KEYS.lease).catch(() => undefined)
  }

  notifyLog('notify tick completed', {
    orderEventsSeen: summary.orderEventsSeen,
    orderEmailsSent: summary.orderEmailsSent,
    orderEmailsFailed: summary.orderEmailsFailed,
    messagesSeen: summary.messagesSeen,
    messageEmailsSent: summary.messageEmailsSent,
    messageEmailsFailed: summary.messageEmailsFailed,
  })

  return summary
}

async function deliverOneEmail(
  kv: NotifyKv,
  config: NotifyConfig,
  dedupeKey: NotifyKvKey,
  email: NotifyEmail,
  channel: StoredDelivery['channel'],
  eventRef: { type: string; id: string },
  nowMs: number,
  nonce: string | undefined,
  fetchImpl: FetchImpl,
): Promise<'SENT' | 'DUPLICATE' | 'FAILED'> {
  if ((await kv.get(dedupeKey)) !== null) {
    return 'DUPLICATE'
  }

  // Legacy Deno -> Web App push path (only the tick
  // uses it; production uses pull/ack). Without a
  // configured relay URL the event is held, never lost.
  if (!config.relayUrl) {
    notifyWarn('notify relay URL missing, event held', {
      eventType: eventRef.type,
      eventId: eventRef.id,
    })
    return 'FAILED'
  }

  const envelope = await signRelayEnvelope(
    config.relaySecret,
    new Date(nowMs).toISOString(),
    nonce ?? randomHex(16),
    {
      to: email.to,
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
    },
  )
  const relayed = await postRelayEmail(
    config.relayUrl,
    envelope,
    fetchImpl,
  )

  if (!relayed.ok) {
    notifyWarn('notify relay delivery failed', {
      eventType: eventRef.type,
      eventId: eventRef.id,
      httpStatus: relayed.status,
    })
    return 'FAILED'
  }

  await kv.set(
    dedupeKey,
    {
      deliveredAt: new Date(nowMs).toISOString(),
      channel,
    } satisfies StoredDelivery,
    { ttlMs: DEDUPE_TTL_MS },
  )

  return 'SENT'
}

/* Checkout-form fetch shared by the order and message
 * processors. At most one fetch per order per tick; the
 * Map is created fresh in runAllegroNotifyTick and never
 * persisted. Only technical identifiers reach the logs. */
async function getCachedOrderDetail(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  cache: Map<string, OrderDetail | null>,
  orderId: string,
  eventRef: { type: string; id: string },
): Promise<OrderDetail | null> {
  if (cache.has(orderId)) {
    return cache.get(orderId) ?? null
  }

  const detailFetched = await fetchJson(
    `${config.apiUrl}/order/checkout-forms/${encodeURIComponent(orderId)}`,
    tokens,
    config,
    fetchImpl,
  )

  if (!detailFetched.ok) {
    notifyWarn('notify order detail failed', {
      eventType: eventRef.type,
      eventId: eventRef.id,
      httpStatus: detailFetched.status,
    })
    cache.set(orderId, null)

    return null
  }

  const detail = parseCheckoutForm(
    orderId,
    detailFetched.data,
  )
  cache.set(orderId, detail)

  return detail
}

async function processOrderEvents(
  config: NotifyConfig,
  kv: NotifyKv,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  nowMs: number,
  nonce: string | undefined,
  summary: NotifyTickSummary,
  orderDetailCache: Map<string, OrderDetail | null>,
): Promise<void> {
  const cursor =
    await kv.get<StoredCursor>(NOTIFY_KV_KEYS.orderCursor)

  if (!isValidCursor(cursor)) {
    // First run: walk the WHOLE journal to the true
    // high-water mark (one 100-row page is never assumed
    // sufficient) and store ONLY the cursor. Nothing is
    // sent on this tick: only events appearing AFTER this
    // seed may generate emails.
    const highWater = await fetchOrderHighWater(
      config,
      tokens,
      fetchImpl,
      null,
    )

    if (highWater.ok) {
      summary.orderEventsSeen +=
        highWater.highWater.eventsScanned

      if (highWater.highWater.highWaterId) {
        await kv.set(NOTIFY_KV_KEYS.orderCursor, {
          lastId: highWater.highWater.highWaterId,
          updatedAt: new Date(nowMs).toISOString(),
        } satisfies StoredCursor)
        notifyLog('notify order cursor seeded', {
          eventId: highWater.highWater.highWaterId,
          eventsSeen:
            highWater.highWater.eventsScanned,
        })
      }
    } else {
      notifyWarn('notify order seed poll failed', {
        httpStatus: highWater.status,
      })
    }

    return
  }

  const eventsUrl =
    `${config.apiUrl}/order/events?limit=${ORDER_PAGE_LIMIT}` +
    `&from=${encodeURIComponent(cursor.lastId)}`
  const fetched = await fetchJson(
    eventsUrl,
    tokens,
    config,
    fetchImpl,
  )

  if (!fetched.ok) {
    notifyWarn('notify order poll failed', {
      httpStatus: fetched.status,
    })
    return
  }

  const events = parseOrderEvents(fetched.data)
  summary.orderEventsSeen += events.length

  // Cursor advances over the leading delivered-or-ignored
  // run only. A failed/held event stops advancement but
  // later independent events are still attempted (their
  // own dedupe keys prevent repeats), so nothing is lost.
  // (cursor is a valid StoredCursor here: the missing-
  // cursor branch above always returns early.)
  let stopped = false
  let contiguousDeliveredThrough: string | null =
    cursor.lastId

  for (const event of events) {
    const kind = classifyOrderEvent(event.type)

    if (kind === null) {
      if (!stopped) {
        contiguousDeliveredThrough = event.id
      }

      continue
    }

    const recipient =
      kind === 'NEW_ORDER'
        ? config.orderEmail
        : (config.cancellationEmail ?? config.orderEmail)

    if (!recipient) {
      notifyWarn('notify recipient missing, event held', {
        eventType: event.type,
        eventId: event.id,
      })
      stopped = true
      continue
    }

    let detail: OrderDetail | null = null

    if (event.orderId) {
      detail = await getCachedOrderDetail(
        config,
        tokens,
        fetchImpl,
        orderDetailCache,
        event.orderId,
        { type: event.type, id: event.id },
      )
    }

    const email =
      kind === 'NEW_ORDER'
        ? buildOrderEmail(
            recipient,
            event,
            detail ??
              emptyOrderDetail(
                event.orderId ?? event.id,
                event.occurredAt,
              ),
          )
        : buildCancellationEmail(
            recipient,
            event.type,
            event,
            detail,
          )

    const outcome = await deliverOneEmail(
      kv,
      config,
      NOTIFY_KV_KEYS.sentOrder(event.id),
      email,
      kind === 'NEW_ORDER' ? 'order' : 'cancellation',
      { type: event.type, id: event.id },
      nowMs,
      nonce,
      fetchImpl,
    )

    if (outcome === 'FAILED') {
      summary.orderEmailsFailed += 1
      stopped = true
      continue
    }

    if (outcome === 'SENT') {
      summary.orderEmailsSent += 1
    }

    if (!stopped) {
      contiguousDeliveredThrough = event.id
    }
  }

  if (
    contiguousDeliveredThrough !== null &&
    contiguousDeliveredThrough !== cursor.lastId
  ) {
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: contiguousDeliveredThrough,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
  }
}

/* public.v1 page size: /messaging/threads and
 * /messaging/threads/{id}/messages both accept limit
 * 1..20. A larger limit is rejected with HTTP 422, so
 * both endpoints are paged with limit=20 + offset and
 * no other list filters (after/before are not sent to
 * the thread list). */
const MESSAGING_PAGE_LIMIT = 20

async function fetchAllThreadIds(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
): Promise<{
  ok: boolean
  status: number
  threadIds: string[]
}> {
  const threadIds: string[] = []
  let offset = 0

  while (true) {
    const fetched = await fetchJson(
      `${config.apiUrl}/messaging/threads` +
        `?limit=${MESSAGING_PAGE_LIMIT}&offset=${offset}`,
      tokens,
      config,
      fetchImpl,
    )

    if (!fetched.ok) {
      return {
        ok: false,
        status: fetched.status,
        threadIds: [],
      }
    }

    const page = parseThreadList(fetched.data)

    for (const thread of page) {
      threadIds.push(thread.id)
    }

    if (page.length < MESSAGING_PAGE_LIMIT) {
      return {
        ok: true,
        status: fetched.status,
        threadIds,
      }
    }

    offset += MESSAGING_PAGE_LIMIT
  }
}

async function fetchAllThreadMessages(
  config: NotifyConfig,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  threadId: string,
): Promise<{
  ok: boolean
  status: number
  messages: NotifyMessage[]
}> {
  const messages: NotifyMessage[] = []
  let offset = 0

  while (true) {
    const fetched = await fetchJson(
      `${config.apiUrl}/messaging/threads/${encodeURIComponent(threadId)}/messages` +
        `?limit=${MESSAGING_PAGE_LIMIT}&offset=${offset}`,
      tokens,
      config,
      fetchImpl,
    )

    if (!fetched.ok) {
      return {
        ok: false,
        status: fetched.status,
        messages: [],
      }
    }

    const page = parseThreadMessages(
      threadId,
      fetched.data,
    )
    messages.push(...page)

    if (page.length < MESSAGING_PAGE_LIMIT) {
      return {
        ok: true,
        status: fetched.status,
        messages,
      }
    }

    offset += MESSAGING_PAGE_LIMIT
  }
}

/* Message polling has no Allegro-side global cursor, so
 * each tick scans every thread (paginated) and keeps
 * interlocutor messages with id > stored message cursor.
 * Misses are impossible: any message newer than the
 * cursor is fetched on the next tick. Resends are
 * impossible: delivered IDs carry per-message dedupe keys
 * (60-day TTL) and the cursor advances only over the
 * leading delivered run. Message failures never touch
 * the order cursor. */
async function processBuyerMessages(
  config: NotifyConfig,
  kv: NotifyKv,
  tokens: NotifyOAuthTokens,
  fetchImpl: FetchImpl,
  nowMs: number,
  nonce: string | undefined,
  summary: NotifyTickSummary,
  orderDetailCache: Map<string, OrderDetail | null>,
): Promise<void> {
  const cursor = await kv.get<StoredCursor>(
    NOTIFY_KV_KEYS.messageCursor,
  )
  const threadsFetched = await fetchAllThreadIds(
    config,
    tokens,
    fetchImpl,
  )

  if (!threadsFetched.ok) {
    notifyWarn('notify thread poll failed', {
      httpStatus: threadsFetched.status,
    })
    return
  }

  const candidates: NotifyMessage[] = []

  for (const threadId of threadsFetched.threadIds) {
    const messagesFetched =
      await fetchAllThreadMessages(
        config,
        tokens,
        fetchImpl,
        threadId,
      )

    if (!messagesFetched.ok) {
      notifyWarn('notify message poll failed', {
        httpStatus: messagesFetched.status,
        threadId,
      })
      continue
    }

    for (const message of messagesFetched.messages) {
      if (
        isNotifiableMessage(message) &&
        (!cursor || message.id > cursor.lastId)
      ) {
        candidates.push(message)
      }
    }
  }

  candidates.sort((left, right) =>
    left.id < right.id ? -1 : 1,
  )
  summary.messagesSeen += candidates.length

  if (!cursor && candidates.length > 0) {
    // First run: seed at the newest message so enabling
    // the bridge does not resend historic threads.
    const newest = candidates[candidates.length - 1]!

    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: newest.id,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
    notifyLog('notify message cursor seeded', {
      eventId: newest.id,
      eventsSeen: candidates.length,
    })

    return
  }

  let stopped = false
  let contiguousDeliveredThrough: string | null =
    cursor?.lastId ?? null

  for (const message of candidates) {
    if (!config.messageEmail) {
      notifyWarn('notify recipient missing, event held', {
        eventType: 'MESSAGE',
        eventId: message.id,
      })
      stopped = true
      continue
    }

    // Order-related messages reuse the per-tick
    // checkout-form cache. A failed enrichment fetch only
    // drops the customer block — the message itself is
    // still delivered. Messages without a related order
    // never trigger enrichment.
    let detail: OrderDetail | null = null

    if (message.orderId) {
      detail = await getCachedOrderDetail(
        config,
        tokens,
        fetchImpl,
        orderDetailCache,
        message.orderId,
        { type: 'MESSAGE', id: message.id },
      )
    }

    const email = buildMessageEmail(
      config.messageEmail,
      message,
      detail,
    )
    const outcome = await deliverOneEmail(
      kv,
      config,
      NOTIFY_KV_KEYS.sentMessage(message.id),
      email,
      'message',
      { type: 'MESSAGE', id: message.id },
      nowMs,
      nonce,
      fetchImpl,
    )

    if (outcome === 'FAILED') {
      summary.messageEmailsFailed += 1
      stopped = true
      continue
    }

    if (outcome === 'SENT') {
      summary.messageEmailsSent += 1
    }

    if (!stopped) {
      contiguousDeliveredThrough = message.id
    }
  }

  if (
    contiguousDeliveredThrough !== null &&
    contiguousDeliveredThrough !== cursor?.lastId
  ) {
    await kv.set(NOTIFY_KV_KEYS.messageCursor, {
      lastId: contiguousDeliveredThrough,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
  }
}
