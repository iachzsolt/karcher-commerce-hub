/*
 * Allegro -> email notification bridge (V1).
 *
 * ONE Allegro event = ONE email, sent through a Google Apps
 * Script relay. This module is intentionally isolated:
 *
 * - No Neon/database imports. The steady-state tick performs
 *   ZERO Neon queries; all technical state lives in Deno KV.
 * - No shared state with the primary Commerce Hub Allegro
 *   OAuth session: the notification session has its own
 *   scopes, its own refresh token, and its own encryption
 *   key (ALLEGRO_NOTIFY_TOKEN_ENCRYPTION_KEY).
 * - No customer/order/message payload is persisted anywhere
 *   or logged. Payloads exist in memory only while the
 *   current email is built and sent.
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
  relayUrl: string
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
    relayUrl: requiredEnv(
      environment,
      'ALLEGRO_NOTIFY_RELAY_URL',
    ),
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

function emailShell(
  title: string,
  sections: NotifyEmailSection[],
  freeText: Array<{ label: string; value: string }>,
): { textBody: string; htmlBody: string } {
  const visible = sections.filter(
    (section) => section.rows.length > 0,
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
    EMAIL_FOOTER_TEXT,
  )

  const htmlSections = visible
    .map(
      (section) =>
        `<h3>${escapeNotifyHtml(section.heading)}</h3>` +
        `<table border="0" cellpadding="4">${section.rows
          .map(
            ([label, value]) =>
              `<tr><th align="left">${escapeNotifyHtml(label)}</th>` +
              `<td>${escapeNotifyHtml(value)}</td></tr>`,
          )
          .join('')}</table>`,
    )
    .join('')
  const htmlFree = freeText
    .map(
      ({ label, value }) =>
        `<h3>${escapeNotifyHtml(label)}</h3>` +
        `<p>${escapeNotifyHtml(value).replace(/\n/g, '<br>')}</p>`,
    )
    .join('')

  return {
    textBody: textLines.join('\n'),
    htmlBody:
      `<html><body><h2>${escapeNotifyHtml(title)}</h2>` +
      htmlSections +
      htmlFree +
      `<hr><p><small>${escapeNotifyHtml(EMAIL_FOOTER_TEXT)}</small></p>` +
      `</body></html>`,
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
        detail.shipmentMethod,
      ),
      ...rowsIf(
        'Szállítási költség',
        detail.deliveryCost,
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

function formatProductLine(
  line: OrderProductLine,
): string {
  const parts = [`${line.name} x${line.quantity}`]

  if (line.unitPrice) {
    parts.push(line.unitPrice)
  }

  const reference = line.sku ?? line.offerId

  if (reference) {
    parts.push(`SKU/ajánlat: ${reference}`)
  }

  if (line.lineTotal) {
    parts.push(`Összesen: ${line.lineTotal}`)
  }

  return `- ${parts.join(' · ')}`
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
      ...rowsIf('Végösszeg', detail.total),
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
    productLines.push({
      name,
      quantity,
      offerId: textOrNull(offer?.['id']),
      sku: textOrNull(
        recordOf(offer?.['external'])?.['id'],
      ),
      unitPrice: moneyText(
        item?.['price'] ?? item?.['originalPrice'],
      ),
      lineTotal: moneyText(item?.['totalPrice']),
      currency: moneyCurrency(
        item?.['price'] ?? item?.['originalPrice'],
      ),
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
  const productText =
    detail.productLines.length > 0
      ? detail.productLines
          .map(formatProductLine)
          .join('\n')
      : '–'
  const { textBody, htmlBody } = emailShell(
    title,
    [
      customerSection(detail),
      shippingSection(detail),
      billingSection(detail),
      orderSection(detail),
    ],
    [
      { label: 'Termékek', value: productText },
      ...(detail.messageToSeller
        ? [
            {
              label: 'Vevő üzenete az eladónak',
              value: detail.messageToSeller,
            },
          ]
        : []),
    ],
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
  const productText =
    detail && detail.productLines.length > 0
      ? detail.productLines
          .map(formatProductLine)
          .join('\n')
      : null
  const { textBody, htmlBody } = emailShell(
    title,
    [
      ...(detail
        ? [
            customerSection(detail),
            shippingSection(detail),
            billingSection(detail),
          ]
        : []),
      {
        heading: 'TÖRLÉS',
        rows: [
          ['Típus', kind],
          ['Rendelési azonosító', orderId],
          ...rowsIf(
            'Időpont',
            event.occurredAt ?? detail?.occurredAt ?? null,
          ),
          ...rowsIf(
            'Indok',
            event.reason ?? null,
          ),
          ...rowsIf(
            'Végösszeg',
            detail?.total ?? null,
          ),
          ...rowsIf(
            'Pénznem',
            detail?.currency ?? null,
          ),
        ],
      },
    ],
    productText
      ? [{ label: 'Termékek', value: productText }]
      : [],
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
  const { textBody, htmlBody } = emailShell(
    title,
    [
      {
        heading: 'ÜZENET',
        rows: [
          ...rowsIf('Vevő', message.authorLogin),
          ...rowsIf('Időpont', message.createdAt),
          ...rowsIf('Rendelés', message.orderId),
          ...rowsIf('Ajánlat', message.offerId),
          [
            'Csatolmány',
            message.attachmentNames.length > 0
              ? message.attachmentNames.join(', ')
              : 'nincs',
          ],
        ],
      },
      ...(detail ? [messageCustomerSection(detail)] : []),
    ],
    [
      {
        label: 'Vevő üzenete',
        value: message.text ?? '–',
      },
    ],
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
  const eventsUrl =
    `${config.apiUrl}/order/events?limit=100` +
    (cursor ? `&from=${encodeURIComponent(cursor.lastId)}` : '')
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

  if (!cursor && events.length > 0) {
    // First run: seed the cursor at the newest event so
    // enabling the bridge does not flood the mailbox with
    // historic events. Nothing is sent on this tick.
    const newest = events[events.length - 1]!

    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: newest.id,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
    notifyLog('notify order cursor seeded', {
      eventId: newest.id,
      eventsSeen: events.length,
    })

    return
  }

  // Cursor advances over the leading delivered-or-ignored
  // run only. A failed/held event stops advancement but
  // later independent events are still attempted (their
  // own dedupe keys prevent repeats), so nothing is lost.
  let stopped = false
  let contiguousDeliveredThrough: string | null =
    cursor?.lastId ?? null

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
    contiguousDeliveredThrough !== cursor?.lastId
  ) {
    await kv.set(NOTIFY_KV_KEYS.orderCursor, {
      lastId: contiguousDeliveredThrough,
      updatedAt: new Date(nowMs).toISOString(),
    } satisfies StoredCursor)
  }
}

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
  const threadsFetched = await fetchJson(
    `${config.apiUrl}/messaging/threads?limit=50`,
    tokens,
    config,
    fetchImpl,
  )

  if (!threadsFetched.ok) {
    notifyWarn('notify thread poll failed', {
      httpStatus: threadsFetched.status,
    })
    return
  }

  const threads = parseThreadList(threadsFetched.data)
  const candidates: NotifyMessage[] = []

  for (const thread of threads) {
    const messagesFetched = await fetchJson(
      `${config.apiUrl}/messaging/threads/${encodeURIComponent(thread.id)}/messages?limit=50`,
      tokens,
      config,
      fetchImpl,
    )

    if (!messagesFetched.ok) {
      notifyWarn('notify message poll failed', {
        httpStatus: messagesFetched.status,
        threadId: thread.id,
      })
      continue
    }

    for (const message of parseThreadMessages(
      thread.id,
      messagesFetched.data,
    )) {
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
