import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, desc, eq, lt } from 'drizzle-orm'
import { decryptSecret, encryptSecret } from './token-crypto.js'
import { applyAllegroDesiredStock, resolveAllegroInventoryRows, syncAllegroInventoryRows } from './allegro-inventory-sync.js'
import {
  createDatabase,
  allegroChangeEvents,
  listingCampaigns,

  listingAcceptedStates,
  listingDesiredStates,
  listingPriceHistory,
  listingPriceSchedules,
  listingRemoteStates,
  platformAccountCredentials,
  platformInventorySyncSettings,
  platformAccounts,
  platformListings,
  platforms,
  products,
} from '@karcher-commerce-hub/database'

type PendingAuthorization = {
  codeVerifier: string
  createdAt: number
}

type TokenResponse = {
  access_token: string
  token_type: string
  refresh_token: string
  expires_in: number
  scope?: string
}

type AllegroAccount = {
  id: string
  login: string
  email?: string
  baseMarketplace?: {
    id: string
  }
  company?: {
    name?: string
    taxId?: string
  }
}

type AllegroSession = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  platformAccountId: string
  environment: AllegroEnvironment
  account: AllegroAccount
}

const pendingAuthorizations = new Map<
  string,
  PendingAuthorization
>()

let currentSession: AllegroSession | null = null

const SESSION_TTL_MS = 10 * 60 * 1000
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000

let refreshInFlight: Promise<boolean> | null = null

function toBase64Url(value: Buffer) {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function createCodeVerifier() {
  return toBase64Url(randomBytes(64))
}

function createCodeChallenge(codeVerifier: string) {
  return toBase64Url(
    createHash('sha256')
      .update(codeVerifier)
      .digest(),
  )
}

function removeExpiredAuthorizations() {
  const now = Date.now()

  for (const [state, authorization] of pendingAuthorizations) {
    if (now - authorization.createdAt > SESSION_TTL_MS) {
      pendingAuthorizations.delete(state)
    }
  }
}

type AllegroEnvironment =
  | 'SANDBOX'
  | 'PRODUCTION'

function getAllegroEnvironment(): AllegroEnvironment {
  const environment =
    (process.env.ALLEGRO_ENV ?? 'SANDBOX')
      .toUpperCase()

  if (
    environment !== 'SANDBOX' &&
    environment !== 'PRODUCTION'
  ) {
    throw new Error(
      `Invalid ALLEGRO_ENV: ${environment}. Expected SANDBOX or PRODUCTION.`,
    )
  }

  return environment
}

function assertAllegroEnvironmentConfiguration() {
  const environment =
    getAllegroEnvironment()

  const apiUrl =
    process.env.ALLEGRO_API_URL

  const authUrl =
    process.env.ALLEGRO_AUTH_URL

  const tokenUrl =
    process.env.ALLEGRO_TOKEN_URL

  const urls = [
    ['ALLEGRO_API_URL', apiUrl],
    ['ALLEGRO_AUTH_URL', authUrl],
    ['ALLEGRO_TOKEN_URL', tokenUrl],
  ] as const

  for (const [name, value] of urls) {
    if (!value) {
      throw new Error(
        `${name} is required for Allegro ${environment}`,
      )
    }
  }

  const sandboxValues =
    urls.filter(
      ([, value]) =>
        value !== undefined &&
        value
          .toLowerCase()
          .includes('sandbox'),
    )

  if (
    environment === 'PRODUCTION' &&
    sandboxValues.length > 0
  ) {
    throw new Error(
      `Allegro environment mismatch: PRODUCTION uses sandbox URL in ${sandboxValues
        .map(([name]) => name)
        .join(', ')}`,
    )
  }

  if (
    environment === 'SANDBOX' &&
    sandboxValues.length !== urls.length
  ) {
    throw new Error(
      'Allegro environment mismatch: SANDBOX must use sandbox Allegro URLs',
    )
  }

  return environment
}

function assertAllegroWriteSafety() {
  const environment =
    assertAllegroEnvironmentConfiguration()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  if (
    currentSession.environment !==
    environment
  ) {
    throw new Error(
      `Allegro session environment mismatch: session=${currentSession.environment}, config=${environment}`,
    )
  }

  return environment
}

function getAllegroUserAgent() {
  const userAgent =
    process.env.ALLEGRO_USER_AGENT?.trim()

  if (!userAgent) {
    throw new Error(
      'ALLEGRO_USER_AGENT is required',
    )
  }

  return userAgent
}

async function allegroFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) {
  const headers =
    new Headers(init?.headers)

  headers.set(
    'User-Agent',
    getAllegroUserAgent(),
  )

  return globalThis.fetch(
    input,
    {
      ...init,
      headers,
    },
  )
}

export const allegroAuth = new Hono()
export async function refreshAllegroSessionIfNeeded() {
  if (!currentSession) {
    return false
  }

  if (
    currentSession.expiresAt - Date.now() >
    TOKEN_REFRESH_BUFFER_MS
  ) {
    return true
  }

  if (refreshInFlight) {
    return refreshInFlight
  }

  refreshInFlight = (async () => {
    const tokenUrl = process.env.ALLEGRO_TOKEN_URL
    const clientId = process.env.ALLEGRO_CLIENT_ID
    const clientSecret =
      process.env.ALLEGRO_CLIENT_SECRET
    const databaseUrl = process.env.DATABASE_URL

    if (
      !tokenUrl ||
      !clientId ||
      !clientSecret ||
      !databaseUrl
    ) {
      console.error(
        'Allegro token refresh configuration is incomplete',
      )

      return false
    }

    const session = currentSession

    if (!session) {
      return false
    }

    const authorization = Buffer.from(
      `${clientId}:${clientSecret}`,
      'utf8',
    ).toString('base64')

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    })

    try {
      const response = await allegroFetch(tokenUrl, {
        method: 'POST',
        headers: {
          Authorization:
            `Basic ${authorization}`,
          'Content-Type':
            'application/x-www-form-urlencoded',
        },
        body,
      })

      if (!response.ok) {
        const errorBody = await response.text()

        console.error(
          'Allegro token refresh failed:',
          response.status,
          errorBody,
        )

        if (
          response.status >= 400 &&
          response.status < 500
        ) {
          currentSession = null
        }

        return false
      }

      const tokenData =
        (await response.json()) as TokenResponse

      if (
        !tokenData.access_token ||
        !tokenData.refresh_token ||
        !tokenData.expires_in
      ) {
        console.error(
          'Allegro token refresh returned incomplete data',
        )

        return false
      }

      const expiresAt =
        Date.now() + tokenData.expires_in * 1000

      const refreshedSession: AllegroSession = {
        ...session,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt,
      }

      currentSession = refreshedSession

      const db = createDatabase(databaseUrl)
      const now = new Date()

      await db
        .update(platformAccountCredentials)
        .set({
          accessTokenEncrypted:
            encryptSecret(tokenData.access_token),

          refreshTokenEncrypted:
            encryptSecret(tokenData.refresh_token),

          accessTokenExpiresAt:
            new Date(expiresAt),

          tokenType:
            tokenData.token_type ?? null,

          scope:
            tokenData.scope ?? null,

          updatedAt: now,
        })
        .where(
          eq(
            platformAccountCredentials.accountId,
            session.platformAccountId,
          ),
        )

      console.log(
        `Allegro access token refreshed for ${session.account.login}`,
      )

      return true
    } catch (error) {
      console.error(
        'Allegro token refresh failed:',
        error,
      )

      return false
    }
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}
export async function restoreAllegroSession() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    console.warn(
      'Allegro session restore skipped: database is not configured',
    )

    return false
  }

  try {
    const db = createDatabase(databaseUrl)

    const [storedSession] = await db
      .select({
        accountId:
          platformAccounts.id,

        accountName:
          platformAccounts.name,

        externalAccountId:
          platformAccounts.externalAccountId,

        marketplace:
          platformAccounts.marketplace,

        accessTokenEncrypted:
          platformAccountCredentials.accessTokenEncrypted,

        refreshTokenEncrypted:
          platformAccountCredentials.refreshTokenEncrypted,

        accessTokenExpiresAt:
          platformAccountCredentials.accessTokenExpiresAt,
      })
      .from(platformAccountCredentials)
      .innerJoin(
        platformAccounts,
        eq(
          platformAccounts.id,
          platformAccountCredentials.accountId,
        ),
      )
      .innerJoin(
        platforms,
        eq(
          platforms.id,
          platformAccounts.platformId,
        ),
      )
      .where(
        and(
          eq(platforms.code, 'ALLEGRO'),
          eq(platformAccounts.active, true),
          eq(
            platformAccounts.environment,
            getAllegroEnvironment(),
          ),
        ),
      )
      .limit(1)

    if (!storedSession) {
      console.log(
        'No stored Allegro session found',
      )

      return false
    }

    if (!storedSession.externalAccountId) {
      console.warn(
        'Stored Allegro account has no external account ID',
      )

      return false
    }

    const expiresAt =
      storedSession.accessTokenExpiresAt.getTime()



    currentSession = {
      accessToken: decryptSecret(
        storedSession.accessTokenEncrypted,
      ),

      refreshToken: decryptSecret(
        storedSession.refreshTokenEncrypted,
      ),

      expiresAt,

      platformAccountId: storedSession.accountId,

      environment:
        getAllegroEnvironment(),

      account: {
        id: storedSession.externalAccountId,
        login: storedSession.accountName,

        baseMarketplace:
          storedSession.marketplace
            ? {
                id: storedSession.marketplace,
              }
            : undefined,
      },
    }

    const sessionReady =
      await refreshAllegroSessionIfNeeded()

    if (!sessionReady) {
      console.warn(
        'Stored Allegro session could not be restored',
      )

      return false
    }

    console.log(
      `Allegro session restored for ${storedSession.accountName}`,
    )

    return true
  } catch (error) {
    console.error(
      'Allegro session restore failed:',
      error,
    )

    currentSession = null

    return false
  }
}


allegroAuth.get('/inventory-sync-settings', async (context) => {
  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database configuration is missing',
      },
      500,
    )
  }

  if (!currentSession) {
    await restoreAllegroSession()
  }

  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      409,
    )
  }

  const db =
    createDatabase(databaseUrl)

  const [settings] =
    await db
      .select({
        enabled:
          platformInventorySyncSettings.enabled,
        triggerMode:
          platformInventorySyncSettings.triggerMode,
        updatedAt:
          platformInventorySyncSettings.updatedAt,
      })
      .from(
        platformInventorySyncSettings,
      )
      .where(
        eq(
          platformInventorySyncSettings.accountId,
          currentSession.platformAccountId,
        ),
      )
      .limit(1)

  return context.json({
    enabled:
      settings?.enabled ?? false,
    triggerMode:
      settings?.triggerMode ??
      'INVENTORY_REFRESH',
    updatedAt:
      settings?.updatedAt ?? null,
  })
})


allegroAuth.put('/inventory-sync-settings', async (context) => {
  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database configuration is missing',
      },
      500,
    )
  }

  if (!currentSession) {
    await restoreAllegroSession()
  }

  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      409,
    )
  }

  let body: {
    enabled?: unknown
  }

  try {
    body =
      await context.req.json()
  } catch {
    return context.json(
      {
        status: 'error',
        message: 'Invalid request body',
      },
      400,
    )
  }

  if (typeof body.enabled !== 'boolean') {
    return context.json(
      {
        status: 'error',
        message: 'enabled must be a boolean',
      },
      400,
    )
  }

  const db =
    createDatabase(databaseUrl)

  const now =
    new Date()

  const [settings] =
    await db
      .insert(
        platformInventorySyncSettings,
      )
      .values({
        accountId:
          currentSession.platformAccountId,
        enabled:
          body.enabled,
        triggerMode:
          'INVENTORY_REFRESH',
        updatedAt:
          now,
      })
      .onConflictDoUpdate({
        target:
          platformInventorySyncSettings.accountId,
        set: {
          enabled:
            body.enabled,
          triggerMode:
            'INVENTORY_REFRESH',
          updatedAt:
            now,
        },
      })
      .returning({
        enabled:
          platformInventorySyncSettings.enabled,
        triggerMode:
          platformInventorySyncSettings.triggerMode,
        updatedAt:
          platformInventorySyncSettings.updatedAt,
      })

  return context.json(settings)
})


allegroAuth.get(
  '/inventory-stock-preview',
  async (context) => {
    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message: 'Database configuration is missing',
        },
        500,
      )
    }

    if (!currentSession) {
      await restoreAllegroSession()
    }

    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message: 'Allegro account is not connected',
        },
        409,
      )
    }

    const body =
      (await context.req.json().catch(() => null)) as
        | {
            listingIds?: string[]
          }
        | null

    const connectionId =
      context.req.query('connectionId')

    if (!connectionId) {
      return context.json(
        {
          status: 'error',
          message: 'connectionId is required',
        },
        400,
      )
    }

    const db =
      createDatabase(databaseUrl)

    const result =
      await resolveAllegroInventoryRows(
        db,
        {
          connectionId,
          accountId:
            currentSession.platformAccountId,
        },
      )

    if (!result.ok) {
      return context.json(
        {
          status: 'error',
          reason: result.reason,
        },
        404,
      )
    }

    return context.json({
      status: 'ok',
      connection: result.connection,
      summary: result.summary,
      rows: result.rows,
    })
  },
)


allegroAuth.post(
  '/inventory-apply-desired',
  async (context) => {
    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message: 'Database configuration is missing',
        },
        500,
      )
    }

    if (!currentSession) {
      await restoreAllegroSession()
    }

    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message: 'Allegro account is not connected',
        },
        409,
      )
    }

    const body =
      (await context.req.json().catch(() => null)) as
        | {
            listingIds?: string[]
          }
        | null

    const connectionId =
      context.req.query('connectionId')

    if (!connectionId) {
      return context.json(
        {
          status: 'error',
          message: 'connectionId is required',
        },
        400,
      )
    }

    const db =
      createDatabase(databaseUrl)

    const resolved =
      await resolveAllegroInventoryRows(
        db,
        {
          connectionId,
          accountId:
            currentSession.platformAccountId,
        },
      )

    if (!resolved.ok) {
      return context.json(
        {
          status: 'error',
          reason: resolved.reason,
        },
        404,
      )
    }

    if (!resolved.connection.isActive) {
      return context.json(
        {
          status: 'error',
          message:
            'Only the active inventory source can be applied',
        },
        409,
      )
    }

    const requestedIds =
      new Set(
        (body?.listingIds ?? []).map(String),
      )

    if (requestedIds.size === 0) {
      return context.json(
        {
          status: 'error',
          message:
            'listingIds are required for inventory desired stock apply',
        },
        400,
      )
    }

    const rowsToApply =
      resolved.rows.filter((row) =>
        requestedIds.has(row.listingId),
      )

    if (
      rowsToApply.length !==
      requestedIds.size
    ) {
      const resolvedIds =
        new Set(
          rowsToApply.map(
            (row) =>
              row.listingId,
          ),
        )

      const missingListingIds =
        [...requestedIds].filter(
          (listingId) =>
            !resolvedIds.has(listingId),
        )

      return context.json(
        {
          status: 'error',
          message:
            'One or more requested listings are outside the resolved inventory scope',
          missingListingIds,
        },
        409,
      )
    }

    if (rowsToApply.length > 100) {
      return context.json(
        {
          status: 'error',
          message:
            'Maximum 100 listings per desired stock apply',
        },
        409,
      )
    }

    const applied =
      await applyAllegroDesiredStock(
        db,
        rowsToApply,
      )

    return context.json({
      status: 'ok',
      mode: 'DESIRED_STOCK_ONLY',
      allegroPushPerformed: false,
      connection: resolved.connection,
      inventorySummary:
        resolved.summary,
      summary:
        applied.summary,
      results:
        applied.results,
    })
  },
)


allegroAuth.post('/inventory-sync', async (context) => {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database configuration is missing',
      },
      500,
    )
  }

  if (!currentSession) {
    await restoreAllegroSession()
  }

  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      409,
    )
  }

  const body =
    (await context.req.json().catch(() => null)) as
      | {
          confirm?: boolean
          connectionId?: string
          listingIds?: string[]
        }
      | null

  if (body?.confirm !== true) {
    return context.json(
      {
        status: 'error',
        message: 'Explicit confirm=true is required',
      },
      400,
    )
  }

  if (!body.connectionId) {
    return context.json(
      {
        status: 'error',
        message: 'connectionId is required',
      },
      400,
    )
  }

  const db = createDatabase(databaseUrl)

  const resolved =
    await resolveAllegroInventoryRows(
      db,
      {
        connectionId: body.connectionId,
        accountId:
          currentSession.platformAccountId,
      },
    )

  if (!resolved.ok) {
    return context.json(
      {
        status: 'error',
        reason: resolved.reason,
      },
      404,
    )
  }

  if (!resolved.connection.isActive) {
    return context.json(
      {
        status: 'error',
        message:
          'Only the active inventory source can be synced',
      },
      409,
    )
  }

  const requestedIds =
    new Set(
      (body.listingIds ?? []).map(String),
    )

  const rowsToApply =
    requestedIds.size > 0
      ? resolved.rows.filter((row) =>
          requestedIds.has(row.listingId),
        )
      : resolved.rows

  if (
    requestedIds.size > 0 &&
    rowsToApply.length !== requestedIds.size
  ) {
    const resolvedIds =
      new Set(
        rowsToApply.map(
          (row) => row.listingId,
        ),
      )

    const missingListingIds =
      [...requestedIds].filter(
        (listingId) =>
          !resolvedIds.has(listingId),
      )

    return context.json(
      {
        status: 'error',
        message:
          'One or more requested listings are outside the resolved inventory scope',
        missingListingIds,
      },
      409,
    )
  }

  if (rowsToApply.length > 100) {
    return context.json(
      {
        status: 'error',
        message:
          'Maximum 100 listings per stock sync run',
      },
      409,
    )
  }

  const applied =
    await applyAllegroDesiredStock(
      db,
      rowsToApply,
    )

  const refreshed =
    await resolveAllegroInventoryRows(
      db,
      {
        connectionId: body.connectionId,
        accountId:
          currentSession.platformAccountId,
      },
    )

  if (!refreshed.ok) {
    return context.json(
      {
        status: 'error',
        reason: refreshed.reason,
      },
      404,
    )
  }

  const rows =
    requestedIds.size > 0
      ? refreshed.rows.filter((row) =>
          requestedIds.has(row.listingId),
        )
      : refreshed.rows

  if (rows.length > 100) {
    return context.json(
      {
        status: 'error',
        message:
          'Maximum 100 listings per stock sync run',
      },
      409,
    )
  }

  const postAllegro =
    async (path: string) => {
      const response =
        await allegroAuth.request(
          path,
          { method: 'POST' },
        )

      const details =
        (await response
          .json()
          .catch(() => null)) as
          | {
              status?: string
              message?: string
            }
          | null

      return {
        ok: response.ok,
        status: response.status,
        details,
      }
    }

  const syncResult =
    await syncAllegroInventoryRows(
      db,
      rows,
      {
        pushStock:
          (listingId) =>
            postAllegro(
              '/push-stock/' +
                encodeURIComponent(listingId),
            ),

        pushStatus:
          (listingId) =>
            postAllegro(
              '/push-status/' +
                encodeURIComponent(listingId),
            ),

        refresh:
          async (listingIds?: string[]) => {
            const requestedListingIds =
              listingIds && listingIds.length > 0
                ? new Set(listingIds)
                : null

            const refreshRows =
              requestedListingIds
                ? rows.filter((row) =>
                    requestedListingIds.has(
                      row.listingId,
                    ),
                  )
                : rows

            const offerIds =
              refreshRows
                .map((row) => row.offerId)
                .filter(
                  (offerId): offerId is string =>
                    typeof offerId === 'string' &&
                    offerId.trim().length > 0,
                )

            const batches: string[][] = []

            for (
              let index = 0;
              index < offerIds.length;
              index += 10
            ) {
              batches.push(
                offerIds.slice(index, index + 10),
              )
            }

            const batchResults: Array<{
              offerIds: string[]
              ok: boolean
              status: number
              details: unknown
            }> = []

            for (const batch of batches) {
              const response =
                await allegroAuth.request(
                  '/sync',
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type':
                        'application/json',
                    },
                    body: JSON.stringify({
                      offerIds: batch,
                    }),
                  },
                )

              const details =
                await response
                  .json()
                  .catch(() => null)

              batchResults.push({
                offerIds: batch,
                ok: response.ok,
                status: response.status,
                details,
              })

              if (!response.ok) {
                return {
                  ok: false,
                  details: {
                    batches: batchResults,
                  },
                }
              }
            }

            return {
              ok: true,
              details: {
                refreshedOffers:
                  offerIds.length,
                batchCount:
                  batches.length,
                batches:
                  batchResults,
              },
            }
          },
      },
    )

  return context.json({
    status: 'ok',
    mode:
      'MANUAL_CONFIRMED_STOCK_SYNC_SERVICE',
    apply: applied.summary,
    ...syncResult,
  })
})


allegroAuth.get('/connect', (context) => {
  removeExpiredAuthorizations()

  const clientId = process.env.ALLEGRO_CLIENT_ID
  const redirectUri = process.env.ALLEGRO_REDIRECT_URI
  const authUrl = process.env.ALLEGRO_AUTH_URL

  if (!clientId || !redirectUri || !authUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro OAuth environment variables are missing',
      },
      500,
    )
  }

  const state = toBase64Url(randomBytes(32))
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  pendingAuthorizations.set(state, {
    codeVerifier,
    createdAt: Date.now(),
  })

  const scopes = [
    'allegro:api:sale:offers:read',
    'allegro:api:sale:offers:write',
    'allegro:api:orders:read',
    'allegro:api:billing:read',
    'allegro:api:campaigns',
    'allegro:api:profile:read',
  ]

  const authorizationUrl = new URL(authUrl)

  authorizationUrl.searchParams.set(
    'response_type',
    'code',
  )

  authorizationUrl.searchParams.set(
    'client_id',
    clientId,
  )

  authorizationUrl.searchParams.set(
    'redirect_uri',
    redirectUri,
  )

  authorizationUrl.searchParams.set(
    'scope',
    scopes.join(' '),
  )

  authorizationUrl.searchParams.set(
    'state',
    state,
  )

  authorizationUrl.searchParams.set(
    'code_challenge',
    codeChallenge,
  )

  authorizationUrl.searchParams.set(
    'code_challenge_method',
    'S256',
  )

  return context.redirect(authorizationUrl.toString())
})

allegroAuth.get('/callback', async (context) => {
  const code = context.req.query('code')
  const state = context.req.query('state')

  const oauthError = context.req.query('error')
  const oauthErrorDescription =
    context.req.query('error_description')

  if (oauthError) {
    return context.json(
      {
        status: 'error',
        error: oauthError,
        description: oauthErrorDescription ?? null,
      },
      400,
    )
  }

  if (!code || !state) {
    return context.json(
      {
        status: 'error',
        message: 'Authorization code or state is missing',
      },
      400,
    )
  }

  const pendingAuthorization =
    pendingAuthorizations.get(state)

  pendingAuthorizations.delete(state)

  if (!pendingAuthorization) {
    return context.json(
      {
        status: 'error',
        message: 'Invalid or expired OAuth state',
      },
      400,
    )
  }

  if (
    Date.now() - pendingAuthorization.createdAt >
    SESSION_TTL_MS
  ) {
    return context.json(
      {
        status: 'error',
        message: 'OAuth authorization expired',
      },
      400,
    )
  }

  const clientId = process.env.ALLEGRO_CLIENT_ID
  const redirectUri = process.env.ALLEGRO_REDIRECT_URI
  const tokenUrl = process.env.ALLEGRO_TOKEN_URL
  const apiUrl = process.env.ALLEGRO_API_URL

  if (
    !clientId ||
    !redirectUri ||
    !tokenUrl ||
    !apiUrl
  ) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro environment is incomplete',
      },
      500,
    )
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier:
      pendingAuthorization.codeVerifier,
    client_id: clientId,
  })

  const tokenResponse = await allegroFetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text()

    console.error(
      'Allegro token exchange failed:',
      tokenResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not exchange authorization code',
        httpStatus: tokenResponse.status,
      },
      500,
    )
  }

  const tokenData =
    (await tokenResponse.json()) as TokenResponse

  const profileResponse = await allegroFetch(
    `${apiUrl}/me`,
    {
      headers: {
        Authorization:
          `Bearer ${tokenData.access_token}`,
        Accept:
          'application/vnd.allegro.public.v1+json',
      },
    },
  )

  if (!profileResponse.ok) {
    const errorBody = await profileResponse.text()

    console.error(
      'Allegro profile request failed:',
      profileResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message: 'Token received but profile request failed',
        httpStatus: profileResponse.status,
      },
      500,
    )
  }

  const account =
    (await profileResponse.json()) as AllegroAccount

  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database configuration is missing',
      },
      500,
    )
  }

  const db = createDatabase(databaseUrl)
  const now = new Date()

  const accessTokenExpiresAt = new Date(
    Date.now() + tokenData.expires_in * 1000,
  )

  const [allegroPlatform] = await db
    .select({
      id: platforms.id,
    })
    .from(platforms)
    .where(eq(platforms.code, 'ALLEGRO'))
    .limit(1)

  if (!allegroPlatform) {
    return context.json(
      {
        status: 'error',
        message: 'ALLEGRO platform is missing from database',
      },
      500,
    )
  }

  const environment =
    assertAllegroEnvironmentConfiguration()

  const accountCode =
    `${account.login.toUpperCase()}_${environment}`

  const [platformAccount] = await db
    .insert(platformAccounts)
    .values({
      platformId: allegroPlatform.id,
      code: accountCode,
      name: account.login,
      externalAccountId: account.id,
      marketplace:
        account.baseMarketplace?.id ?? null,
      environment,
      active: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        platformAccounts.platformId,
        platformAccounts.code,
      ],
      set: {
        name: account.login,
        externalAccountId: account.id,
        marketplace:
          account.baseMarketplace?.id ?? null,
        environment,
        active: true,
        updatedAt: now,
      },
    })
    .returning({
      id: platformAccounts.id,
    })

  await db
    .insert(platformAccountCredentials)
    .values({
      accountId: platformAccount.id,

      accessTokenEncrypted:
        encryptSecret(tokenData.access_token),

      refreshTokenEncrypted:
        encryptSecret(tokenData.refresh_token),

      accessTokenExpiresAt,

      tokenType:
        tokenData.token_type ?? null,

      scope:
        tokenData.scope ?? null,

      updatedAt: now,
    })
    .onConflictDoUpdate({
      target:
        platformAccountCredentials.accountId,
      set: {
        accessTokenEncrypted:
          encryptSecret(tokenData.access_token),

        refreshTokenEncrypted:
          encryptSecret(tokenData.refresh_token),

        accessTokenExpiresAt,

        tokenType:
          tokenData.token_type ?? null,

        scope:
          tokenData.scope ?? null,

        updatedAt: now,
      },
    })
  currentSession = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt:
      Date.now() + tokenData.expires_in * 1000,
    platformAccountId: platformAccount.id,
    environment,
    account,
  }

  return context.json({
    status: 'ok',
    message: `Allegro ${environment} connected successfully`,
    environment,
    account: {
      id: account.id,
      login: account.login,
      baseMarketplace:
        account.baseMarketplace?.id ?? null,
      companyName:
        account.company?.name ?? null,
    },
    accessTokenExpiresAt: new Date(
      currentSession.expiresAt,
    ).toISOString(),
  })
})

export type SubmitAllegroCampaignOfferInput = {
  campaignId: string
  offerId: string
  campaignType:
    | 'STANDARD'
    | 'DISCOUNT'
    | 'SOURCING'
    | 'OTHER'
  bargainPriceMinor?: number | null
  currency?: string
  campaignStock?: number | null
}

export type AllegroCampaignSubmissionResult =
  | {
      ok: true
      status: number
      data: unknown
    }
  | {
      ok: false
      status: number
      data: unknown
    }

export async function submitOfferToAllegroCampaign(
  input: SubmitAllegroCampaignOfferInput,
): Promise<AllegroCampaignSubmissionResult> {
  assertAllegroEnvironmentConfiguration()

  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }


  assertAllegroWriteSafety()
const body: {
    campaign: {
      id: string
    }
    offer: {
      id: string
    }
    prices?: {
      bargain: {
        amount: string
        currency: string
      }
    }
    campaignStock?: {
      quantity: number
    }
  } = {
    campaign: {
      id: input.campaignId,
    },
    offer: {
      id: input.offerId,
    },
  }

  if (
    input.campaignType === 'DISCOUNT' ||
    input.campaignType === 'SOURCING'
  ) {
    if (
      input.bargainPriceMinor === null ||
      input.bargainPriceMinor === undefined ||
      input.bargainPriceMinor <= 0
    ) {
      throw new Error(
        'Campaign bargain price is required',
      )
    }

    body.prices = {
      bargain: {
        amount:
          (
            input.bargainPriceMinor / 100
          ).toFixed(2),
        currency:
          input.currency ?? 'HUF',
      },
    }
  }

  if (
    input.campaignStock !== null &&
    input.campaignStock !== undefined
  ) {
    if (
      !Number.isInteger(input.campaignStock) ||
      input.campaignStock <= 0
    ) {
      throw new Error(
        'Declared campaign stock must be a positive integer',
      )
    }

    body.campaignStock = {
      quantity: input.campaignStock,
    }
  }

  const response = await allegroFetch(
    `${apiUrl}/sale/badges`,
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Content-Type':
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
      body: JSON.stringify(body),
    },
  )

  const responseText =
    await response.text()

  let responseData: unknown =
    responseText

  if (responseText) {
    try {
      responseData =
        JSON.parse(responseText)
    } catch {
      responseData =
        responseText
    }
  }

  if (!response.ok) {
    console.error(
      'Allegro campaign submission failed:',
      response.status,
      responseData,
    )

    return {
      ok: false,
      status: response.status,
      data: responseData,
    }
  }

  return {
    ok: true,
    status: response.status,
    data: responseData,
  }
}
export type FinishAllegroCampaignOfferInput = {
  campaignId: string
  offerId: string
}

export type AllegroCampaignFinishResult =
  | {
      ok: true
      status: number
      data: unknown
    }
  | {
      ok: false
      status: number
      data: unknown
    }

export async function finishOfferAllegroCampaign(
  input: FinishAllegroCampaignOfferInput,
): Promise<AllegroCampaignFinishResult> {
  assertAllegroEnvironmentConfiguration()

  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }


  assertAllegroWriteSafety()
const response = await allegroFetch(
    `${apiUrl}/sale/badges/offers/${encodeURIComponent(
      input.offerId,
    )}/campaigns/${encodeURIComponent(
      input.campaignId,
    )}`,
    {
      method: 'PATCH',

      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Content-Type':
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },

      body: JSON.stringify({
        process: {
          status: 'FINISHED',
        },
      }),
    },
  )

  const responseText =
    await response.text()

  let responseData: unknown =
    responseText

  if (responseText) {
    try {
      responseData =
        JSON.parse(responseText)
    } catch {
      responseData =
        responseText
    }
  }

  if (!response.ok) {
    console.error(
      'Allegro campaign finish failed:',
      response.status,
      responseData,
    )

    return {
      ok: false,
      status: response.status,
      data: responseData,
    }
  }

  return {
    ok: true,
    status: response.status,
    data: responseData,
  }
}
export type AllegroBadgeOperation = {
  id: string
  type: string
  createdAt: string
  updatedAt: string
  campaign: {
    id: string
  }
  offer: {
    id: string
  }
  process: {
    status: string
    rejectionReasons: unknown[]
  }
}

export async function getAllegroBadgeOperation(
  operationId: string,
): Promise<AllegroBadgeOperation> {
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const response = await allegroFetch(
    `${apiUrl}/sale/badge-operations/${encodeURIComponent(
      operationId,
    )}`,
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
    },
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `Allegro badge operation loading failed (${response.status}): ${responseText}`,
    )
  }

  return JSON.parse(
    responseText,
  ) as AllegroBadgeOperation
}
export type AllegroBadgeApplication = {
  id: string
  createdAt: string
  updatedAt: string
  campaign: {
    id: string
  }
  offer: {
    id: string
  }
  process: {
    status:
      | 'REQUESTED'
      | 'PROCESSED'
      | 'DECLINED'
      | string

    rejectionReasons: unknown[]
  }
}

export async function getAllegroBadgeApplication(
  applicationId: string,
): Promise<AllegroBadgeApplication> {
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const response = await allegroFetch(
    `${apiUrl}/sale/badge-applications/${encodeURIComponent(
      applicationId,
    )}`,
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
    },
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `Allegro badge application loading failed (${response.status}): ${responseText}`,
    )
  }

  return JSON.parse(
    responseText,
  ) as AllegroBadgeApplication
}
export type AllegroBadgeApplicationsPayload = {
  badgeApplications: AllegroBadgeApplication[]
  count: number
  totalCount: number
}

export async function getAllegroBadgeApplicationsForOffer(
  offerId: string,
): Promise<AllegroBadgeApplication[]> {
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const applications: AllegroBadgeApplication[] = []

  const limit = 1000
  let offset = 0

  while (true) {
    const url = new URL(
      `${apiUrl}/sale/badge-applications`,
    )

    url.searchParams.set(
      'offer.id',
      offerId,
    )

    url.searchParams.set(
      'limit',
      String(limit),
    )

    url.searchParams.set(
      'offset',
      String(offset),
    )

    const response = await allegroFetch(
      url.toString(),
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',

          'Accept-Language':
            'hu-HU',
        },
      },
    )

    const responseText =
      await response.text()

    if (!response.ok) {
      throw new Error(
        `Allegro badge applications loading failed (${response.status}): ${responseText}`,
      )
    }

    const payload = JSON.parse(
      responseText,
    ) as AllegroBadgeApplicationsPayload

    applications.push(
      ...payload.badgeApplications,
    )

    offset +=
      payload.badgeApplications.length

    if (
      payload.badgeApplications.length === 0 ||
      offset >= payload.totalCount
    ) {
      break
    }
  }

  return applications
}

export type AllegroBadgeCampaign = {
  id: string
  name: string
  marketplace: {
    id: string
  }
  type: string
  eligibility: {
    eligible: boolean
    refusalReasons: Array<{
      code: string
      messages: Array<{
        text: string
        link: string | null
      }>
    }>
  }
  application: {
    type: string
    from: string | null
    to: string | null
  }
  publication: {
    type: string
    from: string | null
    to: string | null
  }
  visibility: {
    type: string
    from: string | null
    to: string | null
  }
  regulationsLink: string | null
  stockReservationIsRequired: boolean
}

export type AllegroBadgeCampaignsPayload = {
  badgeCampaigns: AllegroBadgeCampaign[]
}

export async function getAllegroBadgeCampaigns(
  marketplaceId = 'allegro-hu',
): Promise<AllegroBadgeCampaignsPayload> {
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const response = await allegroFetch(
    `${apiUrl}/sale/badge-campaigns?marketplace.id=${encodeURIComponent(
      marketplaceId,
    )}`,
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
    },
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `Allegro campaign loading failed (${response.status}): ${responseText}`,
    )
  }

  const data =
    JSON.parse(
      responseText,
    ) as AllegroBadgeCampaignsPayload

  return {
    badgeCampaigns:
      data.badgeCampaigns ?? [],
  }
}
export type AllegroBadge = {
  offer: {
    id: string
  }
  campaign: {
    id: string
    name: string
  }
  publication:
    | {
        type: string
        from?: string | null
        to?: string | null
      }
    | null
  prices:
    | {
        bargain?:
          | {
              amount: string
              currency: string
            }
          | null
        market?:
          | {
              amount: string
              currency: string
            }
          | null
        subsidy?: unknown
      }
    | null
  process: {
    status: string
    rejectionReasons: unknown[]
  }
  campaignStock?:
    | {
        quantity: number
      }
    | null
}

export type AllegroBadgesPayload = {
  badges: AllegroBadge[]
  count?: number
  totalCount?: number
}

export async function getAllegroBadges(
  options: {
    offerId?: string
    marketplaceId?: string
  } = {},
): Promise<AllegroBadgesPayload> {
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error('ALLEGRO_API_URL is missing')
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const url = new URL(
    `${apiUrl}/sale/badges`,
  )

  url.searchParams.set(
    'marketplace.id',
    options.marketplaceId ?? 'allegro-hu',
  )

  if (options.offerId) {
    url.searchParams.set(
      'offer.id',
      options.offerId,
    )
  }

  url.searchParams.set('limit', '1000')

  const response = await allegroFetch(
    url.toString(),
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
    },
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `Allegro badges loading failed (${response.status}): ${responseText}`,
    )
  }

  const data =
    JSON.parse(
      responseText,
    ) as AllegroBadgesPayload

  return {
    ...data,
    badges: data.badges ?? [],
  }
}
export type AllegroAlleDiscountCampaign = {
  id: string
  name: string

  type?:
    | 'DISCOUNT'
    | 'SOURCING'
    | string

  marketplace?: {
    id: string
  }

  visibility?: {
    type: string
    from: string | null
    to: string | null
  }

  application?: {
    type: string
    from: string | null
    to: string | null
  }

  publication?: {
    type: string
    from: string | null
    to: string | null
  }
}

export type AllegroAlleDiscountCampaignsPayload = {
  alleDiscountCampaigns:
    AllegroAlleDiscountCampaign[]
}

type AllegroAlleDiscountMoney = {
  amount: string
  currency: string
}

export type AllegroAlleDiscountEligibleOffer = {
  id: string

  product?: {
    id: string
  }

  basePrice?: AllegroAlleDiscountMoney

  alleDiscount?: {
    campaignConditions?: {
      meetsConditions: boolean
      violations: unknown[]
    }

    requiredMerchantPrice?:
      | AllegroAlleDiscountMoney
      | null

    minimumGuaranteedDiscount?: {
      percentage: string
    } | null
  }
}

export type AllegroAlleDiscountEligibleOffersPayload = {
  eligibleOffers:
    AllegroAlleDiscountEligibleOffer[]

  count: number
  totalCount: number
}

export async function getAllegroAlleDiscountCampaigns(
  campaignId?: string,
): Promise<AllegroAlleDiscountCampaignsPayload> {
  const apiUrl =
    process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error(
      'ALLEGRO_API_URL is missing',
    )
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const searchParams =
    new URLSearchParams()

  if (campaignId) {
    searchParams.set(
      'campaignId',
      campaignId,
    )
  }

  const query =
    searchParams.toString()

  const response = await allegroFetch(
    `${apiUrl}/sale/alle-discount/campaigns${
      query ? `?${query}` : ''
    }`,
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Accept-Language':
          'hu-HU',
      },
    },
  )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `Allegro AlleDiscount campaign loading failed (${response.status}): ${responseText}`,
    )
  }

  return JSON.parse(
    responseText,
  ) as AllegroAlleDiscountCampaignsPayload
}

export async function getAllegroAlleDiscountEligibleOffers(
  input: {
    campaignId: string
    meetsConditions?: boolean
    offerId?: string
  },
): Promise<AllegroAlleDiscountEligibleOffersPayload> {
  const apiUrl =
    process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    throw new Error(
      'ALLEGRO_API_URL is missing',
    )
  }

  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    throw new Error(
      'Allegro session is not available',
    )
  }

  const eligibleOffers:
    AllegroAlleDiscountEligibleOffer[] = []

  const limit = 200
  let offset = 0
  let totalCount = 0

  for (;;) {
    const searchParams =
      new URLSearchParams()

    searchParams.set(
      'limit',
      String(limit),
    )

    searchParams.set(
      'offset',
      String(offset),
    )

    if (
      input.meetsConditions !== undefined
    ) {
      searchParams.set(
        'meetsConditions',
        String(
          input.meetsConditions,
        ),
      )
    }

    if (input.offerId) {
      searchParams.set(
        'offerId',
        input.offerId,
      )
    }

    const response = await allegroFetch(
      `${apiUrl}/sale/alle-discount/${encodeURIComponent(
        input.campaignId,
      )}/eligible-offers?${searchParams.toString()}`,
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',

          'Accept-Language':
            'hu-HU',
        },
      },
    )

    const responseText =
      await response.text()

    if (!response.ok) {
      throw new Error(
        `Allegro AlleDiscount eligible offers loading failed (${response.status}): ${responseText}`,
      )
    }

    const page =
      JSON.parse(
        responseText,
      ) as AllegroAlleDiscountEligibleOffersPayload

    const pageOffers =
      page.eligibleOffers ?? []

    eligibleOffers.push(
      ...pageOffers,
    )

    totalCount =
      Number(
        page.totalCount ??
          eligibleOffers.length,
      )

    if (
      input.offerId ||
      pageOffers.length === 0 ||
      eligibleOffers.length >= totalCount
    ) {
      break
    }

    offset += pageOffers.length
  }

  return {
    eligibleOffers,
    count:
      eligibleOffers.length,
    totalCount,
  }
}

allegroAuth.get(
  '/alle-discount/campaigns',
  async (context) => {
    try {
      const campaignId =
        context.req.query(
          'campaignId',
        )

      const data =
        await getAllegroAlleDiscountCampaigns(
          campaignId,
        )

      return context.json({
        status: 'ok',
        data,
      })
    } catch (error) {
      console.error(
        'AlleDiscount campaign loading failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Could not load AlleDiscount campaigns',
        },
        500,
      )
    }
  },
)

allegroAuth.get(
  '/alle-discount/:campaignId/eligible-offers',
  async (context) => {
    try {
      const campaignId =
        context.req.param(
          'campaignId',
        )

      const meetsConditionsQuery =
        context.req.query(
          'meetsConditions',
        )

      const offerId =
        context.req.query(
          'offerId',
        )

      const meetsConditions =
        meetsConditionsQuery === undefined
          ? true
          : meetsConditionsQuery ===
            'true'

      const data =
        await getAllegroAlleDiscountEligibleOffers(
          {
            campaignId,
            meetsConditions,
            offerId,
          },
        )

      return context.json({
        status: 'ok',
        campaignId,
        meetsConditions,
        data,
      })
    } catch (error) {
      console.error(
        'AlleDiscount eligible offers loading failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Could not load eligible AlleDiscount offers',
        },
        500,
      )
    }
  },
)
allegroAuth.get('/badges', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  const offerId =
    context.req.query('offerId')?.trim()

  if (!offerId) {
    return context.json(
      {
        status: 'error',
        message: 'offerId is required',
      },
      400,
    )
  }

  try {
    const data =
      await getAllegroBadges({
        offerId,
        marketplaceId: 'allegro-hu',
      })

    return context.json({
      status: 'ok',
      marketplace: 'allegro-hu',
      offerId,
      data,
    })
  } catch (error) {
    console.error(
      'Allegro badges loading failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not load Allegro badges',
      },
      500,
    )
  }
})
allegroAuth.get('/campaigns', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  try {
    const data =
      await getAllegroBadgeCampaigns(
        'allegro-hu',
      )

    return context.json({
      status: 'ok',
      marketplace: 'allegro-hu',
      data,
    })
  } catch (error) {
    console.error(
      'Allegro campaign loading failed:',
      error,
    )

    return context.json(
      {
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Could not load Allegro campaigns',
      },
      500,
    )
  }
})
allegroAuth.get('/offers', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'ALLEGRO_API_URL is missing',
      },
      500,
    )
  }

  const requestedLimit =
  Number(context.req.query('limit') ?? '20')

const requestedOffset =
  Number(context.req.query('offset') ?? '0')

const limit =
  Number.isInteger(requestedLimit) &&
  requestedLimit >= 1 &&
  requestedLimit <= 100
    ? requestedLimit
    : 20

const offset =
  Number.isInteger(requestedOffset) &&
  requestedOffset >= 0
    ? requestedOffset
    : 0

const offersUrl =
  new URL(
    '/sale/offers',
    apiUrl,
  )

offersUrl.searchParams.set(
  'limit',
  String(limit),
)

offersUrl.searchParams.set(
  'offset',
  String(offset),
)
const response = await allegroFetch(
    offersUrl.toString(),
    {
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,
        Accept:
          'application/vnd.allegro.public.v1+json',
      },
    },
  )

  const body = await response.text()

  if (!response.ok) {
    console.error(
      'Allegro offers request failed:',
      response.status,
      body,
    )

    return context.json(
      {
        status: 'error',
        httpStatus: response.status,
        response: body,
      },
      500,
    )
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
    },
  })
})

allegroAuth.get('/import-issues', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  const apiUrl = process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'ALLEGRO_API_URL is missing',
      },
      500,
    )
  }

  type ImportIssueOffer = {
    id: string
    name?: string
    external?: {
      id?: string | null
    }
    additionalMarketplaces?: Record<
      string,
      unknown
    >
  }

  type ImportIssueOffersResponse = {
    offers?: ImportIssueOffer[]
    totalCount?: number
    count?: number
  }

  const allOffers: ImportIssueOffer[] = []

  const limit = 100
  let offset = 0
  let totalCount: number | null = null

  do {
    const offersUrl =
      new URL(
        '/sale/offers',
        apiUrl,
      )

    offersUrl.searchParams.set(
      'limit',
      String(limit),
    )

    offersUrl.searchParams.set(
      'offset',
      String(offset),
    )

    const response =
      await allegroFetch(
        offersUrl.toString(),
        {
          headers: {
            Authorization:
              `Bearer ${currentSession.accessToken}`,
            Accept:
              'application/vnd.allegro.public.v1+json',
          },
        },
      )

    const body =
      await response.text()

    if (!response.ok) {
      return context.json(
        {
          status: 'error',
          message:
            'Failed to check Allegro offers',
          httpStatus:
            response.status,
          offset,
        },
        502,
      )
    }

    const page =
      JSON.parse(
        body,
      ) as ImportIssueOffersResponse

    const pageOffers =
      page.offers ?? []

    allOffers.push(
      ...pageOffers,
    )

    if (totalCount === null) {
      totalCount =
        page.totalCount ??
        page.count ??
        pageOffers.length
    }

    if (
      pageOffers.length === 0 &&
      offset < totalCount
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro offer pagination stopped unexpectedly',
          offset,
          totalCount,
        },
        502,
      )
    }

    offset += limit
  } while (
    totalCount !== null &&
    offset < totalCount
  )

  const issues: Array<{
    offerId: string
    name: string
    issue:
      | 'MISSING_HU_MARKETPLACE'
      | 'MISSING_SKU'
  }> = []

  const isHuBaseMarketplace =
    currentSession.account
      .baseMarketplace?.id ===
    'allegro-hu'

  for (const offer of allOffers) {
    const huAdditionalState =
      offer.additionalMarketplaces?.[
        'allegro-hu'
      ]

    const hasHuMarketplace =
      isHuBaseMarketplace ||
      Boolean(huAdditionalState)

    if (!hasHuMarketplace) {
      issues.push({
        offerId: offer.id,
        name:
          offer.name ??
          'Névtelen Allegro-ajánlat',
        issue:
          'MISSING_HU_MARKETPLACE',
      })

      continue
    }

    const sku =
      offer.external?.id?.trim()

    if (!sku) {
      issues.push({
        offerId: offer.id,
        name:
          offer.name ??
          'Névtelen Allegro-ajánlat',
        issue:
          'MISSING_SKU',
      })
    }
  }

  return context.json({
    status: 'ok',
    scannedOffers:
      allOffers.length,
    count:
      issues.length,
    data:
      issues,
  })
})
allegroAuth.post('/disconnect', async (context) => {
  if (!currentSession) {
    return context.json({
      status: 'ok',
      connected: false,
    })
  }

  const databaseUrl =
    process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message:
          'Database configuration is missing',
      },
      500,
    )
  }

  const db =
    createDatabase(databaseUrl)

  const accountId =
    currentSession.platformAccountId

  await db
    .update(platformInventorySyncSettings)
    .set({
      enabled: false,
      updatedAt: new Date(),
    })
    .where(
      eq(
        platformInventorySyncSettings.accountId,
        accountId,
      ),
    )

  await db
    .update(platformAccounts)
    .set({
      active: false,
      updatedAt: new Date(),
    })
    .where(
      eq(
        platformAccounts.id,
        accountId,
      ),
    )

  currentSession = null

  return context.json({
    status: 'ok',
    connected: false,
  })
})

allegroAuth.get('/status', (context) => {
  if (!currentSession) {
    return context.json({
      status: 'ok',
      connected: false,
      environment:
        process.env.ALLEGRO_ENV ?? null,
    })
  }

  return context.json({
    status: 'ok',
    connected: true,
    environment:
      process.env.ALLEGRO_ENV ?? null,
    account: {
      id: currentSession.account.id,
      login: currentSession.account.login,
      baseMarketplace:
        currentSession.account.baseMarketplace?.id ??
        null,
    },
    accessTokenExpiresAt: new Date(
      currentSession.expiresAt,
    ).toISOString(),
  })
})

type AllegroDashboardOffer = {
  id: string
  publication?: {
    status?: string
  }
}

type AllegroDashboardOrder = {
  id: string
  status?: string
  fulfillment?: {
    status?: string
  }
  lineItems?: Array<{
    quantity?: number
    boughtAt?: string
    offer?: {
      id?: string
      name?: string
    }
    discounts?: Array<{
      type?: string
    }>
    price?: {
      amount?: string
      currency?: string
    }
    reconciliation?: {
      quantity?: number
      type?: 'BILLING' | 'WALLET'
      value?: {
        amount?: string
        currency?: string
      }
    }
  }>
}

type AllegroDashboardBillingEntry = {
  occurredAt?: string
  asset?: 'DEBIT' | 'CREDIT'
  type?: {
    id?: string
  }
  value?: {
    amount?: string
    currency?: string
  }
}

function getBudapestMonthValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
    },
  ).formatToParts(date)

  const year =
    parts.find((part) => part.type === 'year')
      ?.value
  const month =
    parts.find((part) => part.type === 'month')
      ?.value

  return `${year}-${month}`
}

function getBudapestDateValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(date)

  const getPart = (type: string) =>
    parts.find((part) => part.type === type)
      ?.value

  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`
}

function getTimeZoneOffsetMilliseconds(
  date: Date,
  timeZone: string,
) {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    },
  ).formatToParts(date)

  const value = (type: string) =>
    Number(
      parts.find((part) => part.type === type)
        ?.value,
    )

  return (
    Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    ) - date.getTime()
  )
}

function budapestMonthBoundary(
  year: number,
  monthIndex: number,
  day = 1,
) {
  const approximate = new Date(
    Date.UTC(year, monthIndex, day),
  )
  const firstOffset =
    getTimeZoneOffsetMilliseconds(
      approximate,
      'Europe/Budapest',
    )
  const firstCandidate = new Date(
    approximate.getTime() - firstOffset,
  )
  const finalOffset =
    getTimeZoneOffsetMilliseconds(
      firstCandidate,
      'Europe/Budapest',
    )

  return new Date(
    approximate.getTime() - finalOffset,
  )
}

function parseDateValue(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(
    value,
  )

  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(
    Date.UTC(year, month - 1, day),
  )

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return { year, month, day, date }
}

function formatDateValue(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getDashboardBucketKey(
  value: string,
  groupBy: 'day' | 'month',
) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(date)
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)
      ?.value
  const month = `${getPart('year')}-${getPart('month')}`

  return groupBy === 'month'
    ? month
    : `${month}-${getPart('day')}`
}

function createDashboardSeries(
  from: Date,
  to: Date,
  groupBy: 'day' | 'month',
) {
  const result: Array<{
    key: string
    label: string
    ordersCount: number
    unitsSold: number
    revenueMinor: number
    allegroCostMinor: number
    allegroCreditMinor: number
  }> = []
  const formatter = new Intl.DateTimeFormat(
    'hu-HU',
    groupBy === 'month'
      ? {
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }
      : {
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        },
  )
  const cursor = new Date(from)

  while (cursor <= to) {
    const key =
      groupBy === 'month'
        ? cursor.toISOString().slice(0, 7)
        : cursor.toISOString().slice(0, 10)

    result.push({
      key,
      label: formatter.format(cursor),
      ordersCount: 0,
      unitsSold: 0,
      revenueMinor: 0,
      allegroCostMinor: 0,
      allegroCreditMinor: 0,
    })

    if (groupBy === 'month') {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1)
    } else {
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }

  return result
}

function moneyToMinor(value?: string) {
  const amount = Number(value)

  return Number.isFinite(amount)
    ? Math.round(amount * 100)
    : 0
}

type DashboardCampaignMembership = {
  externalCampaignId: string
  campaignName: string | null
  campaignStatus: string | null
  externalListingId: string
  listingName: string | null
  validFrom: Date | null
  validTo: Date | null
  campaignPriceMinor: number | null
  referencePriceMinor: number | null
}

function buildAllCampaignSalesAnalysis(
  orders: AllegroDashboardOrder[],
) {
  const campaignOfferIds = new Set<string>()

  for (const order of orders) {
    for (const lineItem of order.lineItems ?? []) {
      if (
        lineItem.offer?.id &&
        lineItem.discounts?.some(
          (discount) => discount.type === 'CAMPAIGN',
        )
      ) {
        campaignOfferIds.add(lineItem.offer.id)
      }
    }
  }

  if (campaignOfferIds.size === 0) return null

  const productsByOfferId = new Map<
    string,
    {
      offerId: string
      name: string
      campaignOrderIds: Set<string>
      outsideOrderIds: Set<string>
      campaignUnits: number
      outsideUnits: number
      campaignRevenueMinor: number
      outsideRevenueMinor: number
    }
  >()

  for (const order of orders) {
    for (const lineItem of order.lineItems ?? []) {
      const offerId = lineItem.offer?.id

      if (!offerId || !campaignOfferIds.has(offerId)) continue

      const quantity =
        Number.isFinite(lineItem.quantity) &&
        (lineItem.quantity ?? 0) > 0
          ? lineItem.quantity ?? 0
          : 0
      const reconciliationQuantity =
        Number.isFinite(lineItem.reconciliation?.quantity) &&
        (lineItem.reconciliation?.quantity ?? 0) > 0
          ? lineItem.reconciliation?.quantity ?? 0
          : 0
      const revenueMinor =
        moneyToMinor(lineItem.price?.amount) * quantity +
        moneyToMinor(
          lineItem.reconciliation?.value?.amount,
        ) * reconciliationQuantity
      const isCampaignSale =
        lineItem.discounts?.some(
          (discount) => discount.type === 'CAMPAIGN',
        ) ?? false
      const product = productsByOfferId.get(offerId) ?? {
        offerId,
        name: lineItem.offer?.name ?? offerId,
        campaignOrderIds: new Set<string>(),
        outsideOrderIds: new Set<string>(),
        campaignUnits: 0,
        outsideUnits: 0,
        campaignRevenueMinor: 0,
        outsideRevenueMinor: 0,
      }

      if (isCampaignSale) {
        product.campaignOrderIds.add(order.id)
        product.campaignUnits += quantity
        product.campaignRevenueMinor += revenueMinor
      } else {
        product.outsideOrderIds.add(order.id)
        product.outsideUnits += quantity
        product.outsideRevenueMinor += revenueMinor
      }

      productsByOfferId.set(offerId, product)
    }
  }

  const products = [...productsByOfferId.values()]
    .map((product) => ({
      offerId: product.offerId,
      name: product.name,
      campaignOrders: product.campaignOrderIds.size,
      outsideOrders: product.outsideOrderIds.size,
      campaignUnits: product.campaignUnits,
      outsideUnits: product.outsideUnits,
      campaignRevenueMinor: product.campaignRevenueMinor,
      outsideRevenueMinor: product.outsideRevenueMinor,
      campaignStatus: 'CAMPAIGN',
      campaignPriceMinor: null,
      referencePriceMinor: null,
    }))
    .sort(
      (left, right) =>
        right.campaignOrders - left.campaignOrders ||
        right.campaignRevenueMinor - left.campaignRevenueMinor ||
        left.name.localeCompare(right.name, 'hu-HU'),
    )
  const campaignOrderIds = new Set(
    [...productsByOfferId.values()]
      .flatMap((product) => [...product.campaignOrderIds]),
  )
  const outsideOrderIds = new Set(
    [...productsByOfferId.values()]
      .flatMap((product) => [...product.outsideOrderIds]),
  )

  return {
    campaignId: 'ALL_ALLEGRO_CAMPAIGNS',
    campaignName: 'Összes Allegro-kampány',
    offerCount: campaignOfferIds.size,
    totals: {
      campaignOrders: campaignOrderIds.size,
      outsideOrders: outsideOrderIds.size,
      campaignUnits: products.reduce(
        (total, product) => total + product.campaignUnits,
        0,
      ),
      outsideUnits: products.reduce(
        (total, product) => total + product.outsideUnits,
        0,
      ),
      campaignRevenueMinor: products.reduce(
        (total, product) => total + product.campaignRevenueMinor,
        0,
      ),
      outsideRevenueMinor: products.reduce(
        (total, product) => total + product.outsideRevenueMinor,
        0,
      ),
    },
    products,
  }
}

function buildDashboardCampaignPerformance(
  orders: AllegroDashboardOrder[],
  memberships: DashboardCampaignMembership[],
  periodStart: Date,
  periodEnd: Date,
  namedCampaignTrackingStart: Date,
) {
  const namedCampaignPeriodStart = new Date(
    Math.max(
      periodStart.getTime(),
      namedCampaignTrackingStart.getTime(),
    ),
  )
  const eligibleMemberships = memberships.filter(
    (membership) =>
      !membership.externalCampaignId.startsWith('LOCAL-') &&
      (membership.campaignStatus === 'ACTIVE' ||
        membership.campaignStatus === 'FINISHED') &&
      periodEnd >= namedCampaignTrackingStart &&
      (!membership.validFrom || membership.validFrom <= periodEnd) &&
      (!membership.validTo ||
        membership.validTo >= namedCampaignPeriodStart),
  )
  const campaignsById = new Map<
    string,
    {
      id: string
      name: string
      validFrom: Date | null
      validTo: Date | null
      memberships: DashboardCampaignMembership[]
    }
  >()

  for (const membership of eligibleMemberships) {
    const existing = campaignsById.get(
      membership.externalCampaignId,
    )

    if (existing) {
      existing.memberships.push(membership)

      if (
        membership.validFrom &&
        (!existing.validFrom ||
          membership.validFrom < existing.validFrom)
      ) {
        existing.validFrom = membership.validFrom
      }

      if (
        membership.validTo &&
        (!existing.validTo || membership.validTo > existing.validTo)
      ) {
        existing.validTo = membership.validTo
      }
    } else {
      campaignsById.set(membership.externalCampaignId, {
        id: membership.externalCampaignId,
        name:
          membership.campaignName ??
          membership.externalCampaignId,
        validFrom: membership.validFrom,
        validTo: membership.validTo,
        memberships: [membership],
      })
    }
  }

  const campaigns = [...campaignsById.values()].sort(
    (left, right) =>
      (right.validTo?.getTime() ?? 0) -
      (left.validTo?.getTime() ?? 0),
  )
  const analyses = campaigns.map((campaign) => {
    const membershipsByOfferId = new Map(
      campaign.memberships.map((membership) => [
        membership.externalListingId,
        membership,
      ]),
    )
    const productsByOfferId = new Map<
      string,
      {
        offerId: string
        name: string
        campaignOrderIds: Set<string>
        outsideOrderIds: Set<string>
        campaignUnits: number
        outsideUnits: number
        campaignRevenueMinor: number
        outsideRevenueMinor: number
        campaignStatus: string
        campaignPriceMinor: number | null
        referencePriceMinor: number | null
      }
    >()
    const campaignOrderIds = new Set<string>()
    const outsideOrderIds = new Set<string>()

    for (const membership of campaign.memberships) {
      productsByOfferId.set(membership.externalListingId, {
        offerId: membership.externalListingId,
        name:
          membership.listingName ??
          membership.externalListingId,
        campaignOrderIds: new Set<string>(),
        outsideOrderIds: new Set<string>(),
        campaignUnits: 0,
        outsideUnits: 0,
        campaignRevenueMinor: 0,
        outsideRevenueMinor: 0,
        campaignStatus:
          membership.campaignStatus ?? 'UNKNOWN',
        campaignPriceMinor: membership.campaignPriceMinor,
        referencePriceMinor: membership.referencePriceMinor,
      })
    }

    for (const order of orders) {
      for (const lineItem of order.lineItems ?? []) {
        const offerId = lineItem.offer?.id
        const boughtAt = lineItem.boughtAt

        if (!offerId || !boughtAt) continue

        const membership = membershipsByOfferId.get(offerId)

        if (!membership) continue

        const boughtDate = new Date(boughtAt)

        if (Number.isNaN(boughtDate.getTime())) continue
        if (boughtDate < namedCampaignTrackingStart) continue

        const hasCampaignDiscount =
          lineItem.discounts?.some(
            (discount) => discount.type === 'CAMPAIGN',
          ) ?? false
        const isInsideCampaignWindow =
          (!membership.validFrom ||
            boughtDate >= membership.validFrom) &&
          (!membership.validTo || boughtDate <= membership.validTo)
        const isCampaignSale =
          hasCampaignDiscount &&
          isInsideCampaignWindow &&
          (membership.campaignStatus === 'ACTIVE' ||
            membership.campaignStatus === 'FINISHED')
        const quantity =
          Number.isFinite(lineItem.quantity) &&
          (lineItem.quantity ?? 0) > 0
            ? lineItem.quantity ?? 0
            : 0
        const reconciliationQuantity =
          Number.isFinite(lineItem.reconciliation?.quantity) &&
          (lineItem.reconciliation?.quantity ?? 0) > 0
            ? lineItem.reconciliation?.quantity ?? 0
            : 0
        const revenueMinor =
          moneyToMinor(lineItem.price?.amount) * quantity +
          moneyToMinor(
            lineItem.reconciliation?.value?.amount,
          ) * reconciliationQuantity
        const product = productsByOfferId.get(offerId) ?? {
          offerId,
          name:
            lineItem.offer?.name ??
            membership.listingName ??
            offerId,
          campaignOrderIds: new Set<string>(),
          outsideOrderIds: new Set<string>(),
          campaignUnits: 0,
          outsideUnits: 0,
          campaignRevenueMinor: 0,
          outsideRevenueMinor: 0,
          campaignStatus:
            membership.campaignStatus ?? 'UNKNOWN',
          campaignPriceMinor: membership.campaignPriceMinor,
          referencePriceMinor: membership.referencePriceMinor,
        }

        if (isCampaignSale) {
          product.campaignOrderIds.add(order.id)
          product.campaignUnits += quantity
          product.campaignRevenueMinor += revenueMinor
          campaignOrderIds.add(order.id)
        } else {
          product.outsideOrderIds.add(order.id)
          product.outsideUnits += quantity
          product.outsideRevenueMinor += revenueMinor
          outsideOrderIds.add(order.id)
        }

        productsByOfferId.set(offerId, product)
      }
    }

    const products = [...productsByOfferId.values()]
      .map((product) => ({
        offerId: product.offerId,
        name: product.name,
        campaignOrders: product.campaignOrderIds.size,
        outsideOrders: product.outsideOrderIds.size,
        campaignUnits: product.campaignUnits,
        outsideUnits: product.outsideUnits,
        campaignRevenueMinor: product.campaignRevenueMinor,
        outsideRevenueMinor: product.outsideRevenueMinor,
        campaignStatus: product.campaignStatus,
        campaignPriceMinor: product.campaignPriceMinor,
        referencePriceMinor: product.referencePriceMinor,
      }))
      .sort(
        (left, right) =>
          right.campaignOrders + right.outsideOrders -
            (left.campaignOrders + left.outsideOrders) ||
          right.campaignRevenueMinor + right.outsideRevenueMinor -
            (left.campaignRevenueMinor + left.outsideRevenueMinor) ||
          ({ ACTIVE: 0, FINISHED: 1, DECLINED: 2 }[
            left.campaignStatus
          ] ?? 3) -
            ({ ACTIVE: 0, FINISHED: 1, DECLINED: 2 }[
              right.campaignStatus
            ] ?? 3) ||
          left.name.localeCompare(right.name, 'hu-HU'),
      )

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      totals: {
        campaignOrders: campaignOrderIds.size,
        outsideOrders: outsideOrderIds.size,
        campaignUnits: products.reduce(
          (total, product) => total + product.campaignUnits,
          0,
        ),
        outsideUnits: products.reduce(
          (total, product) => total + product.outsideUnits,
          0,
        ),
        campaignRevenueMinor: products.reduce(
          (total, product) =>
            total + product.campaignRevenueMinor,
          0,
        ),
        outsideRevenueMinor: products.reduce(
          (total, product) =>
            total + product.outsideRevenueMinor,
          0,
        ),
      },
      products,
    }
  })

  const allCampaignSales =
    buildAllCampaignSalesAnalysis(orders)

  return {
    campaigns: [
      ...(allCampaignSales
        ? [
            {
              id: allCampaignSales.campaignId,
              name: allCampaignSales.campaignName,
              validFrom: periodStart.toISOString(),
              validTo: periodEnd.toISOString(),
              offerCount: allCampaignSales.offerCount,
            },
          ]
        : []),
      ...campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      validFrom: campaign.validFrom?.toISOString() ?? null,
      validTo: campaign.validTo?.toISOString() ?? null,
      offerCount: new Set(
        campaign.memberships.map(
          (membership) => membership.externalListingId,
        ),
      ).size,
      })),
    ],
    analyses: [
      ...(allCampaignSales ? [allCampaignSales] : []),
      ...analyses,
    ],
    attribution:
      'CAMPAIGN_DISCOUNT_AND_OFFER_MEMBERSHIP_WITHIN_ACTIVE_WINDOW',
  }
}

allegroAuth.get(
  '/dashboard-summary',
  async (context) => {
    await refreshAllegroSessionIfNeeded()

    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro account is not connected',
        },
        401,
      )
    }

    const apiUrl = process.env.ALLEGRO_API_URL
    const databaseUrl = process.env.DATABASE_URL

    if (!apiUrl || !databaseUrl) {
      return context.json(
        {
          status: 'error',
          message:
            'ALLEGRO_API_URL or DATABASE_URL is missing',
        },
        500,
      )
    }

    assertAllegroEnvironmentConfiguration()
    const db = createDatabase(databaseUrl)

    const currentDate = getBudapestDateValue()
    const currentMonth = getBudapestMonthValue()
    const requestedFrom =
      context.req.query('from') ??
      `${currentMonth}-01`
    const requestedTo =
      context.req.query('to') ??
      currentDate
    const parsedFrom = parseDateValue(requestedFrom)
    const parsedTo = parseDateValue(requestedTo)
    const requestedGroupBy =
      context.req.query('groupBy') ?? 'day'

    if (
      !parsedFrom ||
      !parsedTo ||
      (requestedGroupBy !== 'day' &&
        requestedGroupBy !== 'month')
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'from/to must use YYYY-MM-DD and groupBy must be day or month',
        },
        400,
      )
    }

    const rangeDays = Math.floor(
      (parsedTo.date.getTime() -
        parsedFrom.date.getTime()) /
        (24 * 60 * 60 * 1000),
    )

    if (rangeDays < 0 || rangeDays > 366) {
      return context.json(
        {
          status: 'error',
          message:
            'The dashboard date range must be between 1 and 367 days',
        },
        400,
      )
    }

    const groupBy = requestedGroupBy
    const periodStart =
      budapestMonthBoundary(
        parsedFrom.year,
        parsedFrom.month - 1,
        parsedFrom.day,
      )
    const nextDay = new Date(parsedTo.date)
    nextDay.setUTCDate(nextDay.getUTCDate() + 1)
    const nextPeriodStart =
      budapestMonthBoundary(
        nextDay.getUTCFullYear(),
        nextDay.getUTCMonth(),
        nextDay.getUTCDate(),
      )
    const periodEnd = new Date(
      nextPeriodStart.getTime() - 1,
    )
    const series = createDashboardSeries(
      parsedFrom.date,
      parsedTo.date,
      groupBy,
    )
    const seriesByKey = new Map(
      series.map((item) => [item.key, item]),
    )

    const headers = {
      Authorization:
        `Bearer ${currentSession.accessToken}`,
      Accept:
        'application/vnd.allegro.public.v1+json',
      'Accept-Language': 'hu-HU',
    }

    const fetchPage = async <T>(url: URL) => {
      const response = await allegroFetch(
        url.toString(),
        { headers },
      )
      const body = await response.text()

      if (!response.ok) {
        const error = new Error(
          `Allegro request failed: HTTP ${response.status}`,
        ) as Error & { httpStatus?: number }
        error.httpStatus = response.status
        throw error
      }

      return JSON.parse(body) as T
    }

    try {
      const offers: AllegroDashboardOffer[] = []
      const limit = 100
      let offset = 0
      let totalCount: number | null = null

      do {
        const url = new URL('/sale/offers', apiUrl)
        url.searchParams.set('limit', String(limit))
        url.searchParams.set('offset', String(offset))

        const page = await fetchPage<{
          offers?: AllegroDashboardOffer[]
          totalCount?: number
          count?: number
        }>(url)
        const pageOffers = page.offers ?? []

        offers.push(...pageOffers)
        totalCount ??=
          page.totalCount ??
          page.count ??
          pageOffers.length
        offset += limit
      } while (
        totalCount !== null &&
        offset < totalCount
      )

      const offerStatuses = {
        total: offers.length,
        active: 0,
        activating: 0,
        inactive: 0,
        ended: 0,
        unknown: 0,
      }

      for (const offer of offers) {
        switch (offer.publication?.status) {
          case 'ACTIVE':
            offerStatuses.active++
            break
          case 'ACTIVATING':
            offerStatuses.activating++
            break
          case 'INACTIVE':
            offerStatuses.inactive++
            break
          case 'ENDED':
            offerStatuses.ended++
            break
          default:
            offerStatuses.unknown++
        }
      }

      let ordersAuthorized = true
      let billingAuthorized = true
      let ordersError: string | null = null
      let billingError: string | null = null
      let ordersCount = 0
      let unitsSold = 0
      let grossSalesMinor = 0
      let salesCurrency = 'HUF'
      let commissionCostMinor = 0
      let totalAllegroCostMinor = 0
      let allegroCreditsMinor = 0
      let billingEntryCount = 0
      const orderStatuses = {
        total: 0,
        bought: 0,
        filledIn: 0,
        readyForProcessing: 0,
        cancelled: 0,
        unknown: 0,
      }
      const fulfillmentStatuses: Record<
        string,
        number
      > = {}
      let campaignPerformance = {
        campaigns: [] as Array<{
          id: string
          name: string
          validFrom: string | null
          validTo: string | null
          offerCount: number
        }>,
        analyses: [] as Array<{
          campaignId: string
          campaignName: string
          totals: {
            campaignOrders: number
            outsideOrders: number
            campaignUnits: number
            outsideUnits: number
            campaignRevenueMinor: number
            outsideRevenueMinor: number
          }
          products: Array<{
            offerId: string
            name: string
            campaignOrders: number
            outsideOrders: number
            campaignUnits: number
            outsideUnits: number
            campaignRevenueMinor: number
            outsideRevenueMinor: number
            campaignStatus: string
            campaignPriceMinor: number | null
            referencePriceMinor: number | null
          }>
        }>,
        attribution:
          'CAMPAIGN_DISCOUNT_AND_OFFER_MEMBERSHIP_WITHIN_ACTIVE_WINDOW',
      }

      try {
        const orders: AllegroDashboardOrder[] = []
        let orderOffset = 0
        let orderTotal: number | null = null

        do {
          const url = new URL(
            '/order/checkout-forms',
            apiUrl,
          )
          url.searchParams.set('limit', '100')
          url.searchParams.set(
            'offset',
            String(orderOffset),
          )
          url.searchParams.set(
            'marketplace.id',
            'allegro-hu',
          )
          url.searchParams.set(
            'lineItems.boughtAt.gte',
            periodStart.toISOString(),
          )
          url.searchParams.set(
            'lineItems.boughtAt.lte',
            periodEnd.toISOString(),
          )

          const page = await fetchPage<{
            checkoutForms?: AllegroDashboardOrder[]
            totalCount?: number
            count?: number
          }>(url)
          const pageOrders =
            page.checkoutForms ?? []

          orders.push(...pageOrders)
          orderTotal ??=
            page.totalCount ??
            page.count ??
            pageOrders.length
          orderOffset += 100
        } while (
          orderTotal !== null &&
          orderOffset < orderTotal &&
          orderOffset < 10_000
        )

        const completedOrders = orders.filter(
          (order) =>
            order.status ===
              'READY_FOR_PROCESSING' &&
            order.fulfillment?.status !==
              'CANCELLED',
        )

        ordersCount = completedOrders.length

        const localCampaignMemberships = await db
          .select({
            externalCampaignId:
              listingCampaigns.externalCampaignId,
            campaignName: listingCampaigns.campaignName,
            campaignStatus:
              listingCampaigns.campaignStatus,
            externalListingId:
              platformListings.externalListingId,
            listingName: platformListings.listingName,
            validFrom: listingCampaigns.validFrom,
            validTo: listingCampaigns.validTo,
            campaignPriceMinor:
              listingCampaigns.remotePriceMinor,
            referencePriceMinor:
              listingCampaigns.referencePriceMinor,
          })
          .from(listingCampaigns)
          .innerJoin(
            platformListings,
            eq(
              listingCampaigns.listingId,
              platformListings.id,
            ),
          )

        const namedCampaignTrackingStart =
          budapestMonthBoundary(2026, 8, 1)

        campaignPerformance =
          buildDashboardCampaignPerformance(
            completedOrders,
            localCampaignMemberships,
            periodStart,
            periodEnd,
            namedCampaignTrackingStart,
          )

        orderStatuses.total = orders.length

        for (const order of orders) {
          switch (order.status) {
            case 'BOUGHT':
              orderStatuses.bought++
              break
            case 'FILLED_IN':
              orderStatuses.filledIn++
              break
            case 'READY_FOR_PROCESSING':
              orderStatuses.readyForProcessing++
              break
            case 'CANCELLED':
              orderStatuses.cancelled++
              break
            default:
              orderStatuses.unknown++
          }

          const fulfillmentStatus =
            order.fulfillment?.status ?? 'UNKNOWN'
          fulfillmentStatuses[fulfillmentStatus] =
            (fulfillmentStatuses[fulfillmentStatus] ?? 0) + 1
        }

        for (const order of completedOrders) {
          const orderBucketKey =
            order.lineItems?.[0]?.boughtAt
              ? getDashboardBucketKey(
                  order.lineItems[0].boughtAt,
                  groupBy,
                )
              : null

          if (orderBucketKey) {
            const bucket = seriesByKey.get(orderBucketKey)

            if (bucket) {
              bucket.ordersCount++
            }
          }

          for (const lineItem of order.lineItems ?? []) {
            const quantity =
              Number.isFinite(lineItem.quantity) &&
              (lineItem.quantity ?? 0) > 0
                ? lineItem.quantity ?? 0
                : 0

            unitsSold += quantity
            grossSalesMinor +=
              moneyToMinor(
                lineItem.price?.amount,
              ) * quantity

            if (lineItem.boughtAt) {
              const bucketKey =
                getDashboardBucketKey(
                  lineItem.boughtAt,
                  groupBy,
                )
              const bucket = bucketKey
                ? seriesByKey.get(bucketKey)
                : null

              if (bucket) {
                bucket.unitsSold += quantity
                bucket.revenueMinor +=
                  moneyToMinor(
                    lineItem.price?.amount,
                  ) * quantity
              }
            }
            salesCurrency =
              lineItem.price?.currency ??
              salesCurrency
          }
        }
      } catch (error) {
        const httpStatus =
          (error as Error & {
            httpStatus?: number
          }).httpStatus

        ordersAuthorized = httpStatus !== 403
        ordersError =
          httpStatus === 403
            ? 'REAUTHORIZATION_REQUIRED'
            : error instanceof Error
              ? error.message
              : 'Could not load Allegro orders'
      }

      try {
        const entries: AllegroDashboardBillingEntry[] = []
        let billingOffset = 0
        let billingTotal: number | null = null

        do {
          const url = new URL(
            '/billing/billing-entries',
            apiUrl,
          )
          url.searchParams.set('limit', '100')
          url.searchParams.set(
            'offset',
            String(billingOffset),
          )
          url.searchParams.set(
            'marketplaceId',
            'allegro-hu',
          )
          url.searchParams.set(
            'occurredAt.gte',
            periodStart.toISOString(),
          )
          url.searchParams.set(
            'occurredAt.lte',
            periodEnd.toISOString(),
          )

          const page = await fetchPage<{
            billingEntries?: AllegroDashboardBillingEntry[]
            totalCount?: number
            count?: number
          }>(url)
          const pageEntries =
            page.billingEntries ?? []

          entries.push(...pageEntries)
          billingTotal ??=
            page.totalCount ??
            page.count ??
            pageEntries.length
          billingOffset += 100
        } while (
          billingTotal !== null &&
          billingOffset < billingTotal &&
          billingOffset < 10_000
        )

        billingEntryCount = entries.length
        let billingCostsMinor = 0
        let billingCreditsMinor = 0
        let commissionCostsMinor = 0

        for (const entry of entries) {
          const valueMinor = moneyToMinor(
            entry.value?.amount,
          )

          if (valueMinor < 0) {
            billingCostsMinor += -valueMinor

            if (entry.type?.id === 'SUC') {
              commissionCostsMinor += -valueMinor
            }
          } else if (valueMinor > 0) {
            billingCreditsMinor += valueMinor
          }

          if (entry.occurredAt) {
            const bucketKey =
              getDashboardBucketKey(
                entry.occurredAt,
                groupBy,
              )
            const bucket = bucketKey
              ? seriesByKey.get(bucketKey)
              : null

            if (bucket) {
              if (valueMinor < 0) {
                bucket.allegroCostMinor +=
                  -valueMinor
              } else if (valueMinor > 0) {
                bucket.allegroCreditMinor +=
                  valueMinor
              }
            }
          }
        }

        commissionCostMinor = commissionCostsMinor
        totalAllegroCostMinor = billingCostsMinor
        allegroCreditsMinor = billingCreditsMinor
      } catch (error) {
        const httpStatus =
          (error as Error & {
            httpStatus?: number
          }).httpStatus

        billingAuthorized = httpStatus !== 403
        billingError =
          httpStatus === 403
            ? 'REAUTHORIZATION_REQUIRED'
            : error instanceof Error
              ? error.message
              : 'Could not load Allegro billing entries'
      }

      return context.json({
        status: 'ok',
        generatedAt: new Date().toISOString(),
        account: {
          name: currentSession.account.login,
          marketplace:
            currentSession.account.baseMarketplace
              ?.id ?? null,
        },
        period: {
          fromDate: requestedFrom,
          toDate: requestedTo,
          groupBy,
          timeZone: 'Europe/Budapest',
          from: periodStart.toISOString(),
          to: periodEnd.toISOString(),
        },
        permissions: {
          offers: true,
          orders: ordersAuthorized,
          billing: billingAuthorized,
        },
        errors: {
          orders: ordersError,
          billing: billingError,
        },
        offers: offerStatuses,
        sales: {
          ordersCount,
          unitsSold,
          grossSalesMinor,
          currency: salesCurrency,
          definition:
            'READY_FOR_PROCESSING_PRODUCT_LINES_EXCLUDING_DELIVERY_AND_REFUNDS',
        },
        orderStatuses,
        fulfillmentStatuses,
        campaignPerformance,
        costs: {
          commissionCostMinor,
          totalAllegroCostMinor,
          allegroCreditsMinor,
          billingEntryCount,
          netAfterAllegroCostsMinor:
            grossSalesMinor -
            totalAllegroCostMinor +
            allegroCreditsMinor,
          currency: salesCurrency,
        },
        series,
      })
    } catch (error) {
      console.error(
        'Allegro dashboard summary failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            error instanceof Error
              ? error.message
              : 'Could not load Allegro dashboard summary',
        },
        502,
      )
    }
  },
)

type AllegroOfferForSync = {
  id: string
  name: string

  category?: {
    id?: string
  }

  external?: {
    id?: string | null
  }

sellingMode?: {
  price?: {
    amount?: string
    currency?: string
  }
}


  publication?: {
    status?: string
  }

  stock?: {
    available?: number
    sold?: number
  }

  marketplaces?: {
    base?: {
      id?: string
    }
    additional?: Array<{
      id?: string
    }>
  }

  additionalMarketplaces?: Record<
    string,
    {
      publication?: {
        state?: string
        status?: string
      }

      sellingMode?: {
        price?: {
          amount?: string
          currency?: string
        }

        priceAutomation?: {
          id?: string
          type?: string
          rule?: {
            id?: string
            type?: string
          }
        } | null
      }

      stock?: {
        sold?: number
      }
    }
  >

  isFulfillment?: boolean
}

type AllegroOffersForSyncResponse = {
  offers?: AllegroOfferForSync[]
  count?: number
  totalCount?: number
}

function priceToMinor(amount?: string) {
  if (!amount) {
    return null
  }

  const value = Number(amount.replace(',', '.'))

  if (!Number.isFinite(value)) {
    return null
  }

  return Math.round(value * 100)
}

function normalizeAllegroListingStatus(
  status?: string,
):
  | 'ACTIVE'
  | 'ACTIVATING'
  | 'INACTIVE'
  | 'ENDED'
  | 'UNKNOWN' {
  switch (status?.toUpperCase()) {
    case 'ACTIVE':
    case 'APPROVED':
      return 'ACTIVE'

    case 'IN_PROGRESS':
    case 'ACTIVATING':
      return 'ACTIVATING'

    case 'INACTIVE':
    case 'NOT_REQUESTED':
    case 'REFUSED':
      return 'INACTIVE'

    case 'ENDED':
      return 'ENDED'

    default:
      return 'UNKNOWN'
  }
}

allegroAuth.get(
  '/offer-debug/:offerId',
  async (context) => {
    await refreshAllegroSessionIfNeeded()

    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message: 'Allegro account is not connected',
        },
        401,
      )
    }

    const apiUrl = process.env.ALLEGRO_API_URL

    if (!apiUrl) {
      return context.json(
        {
          status: 'error',
          message: 'ALLEGRO_API_URL is missing',
        },
        500,
      )
    }

    const offerId =
      context.req.param('offerId')

    const response = await allegroFetch(
      apiUrl +
        '/sale/product-offers/' +
        encodeURIComponent(offerId),
      {
        headers: {
          Authorization:
            'Bearer ' + currentSession.accessToken,
          Accept:
            'application/vnd.allegro.public.v1+json',
          'Accept-Language': 'hu-HU',
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()

      return context.json(
        {
          status: 'error',
          allegroStatus: response.status,
          body,
        },
        502,
      )
    }

    const data =
      (await response.json()) as Record<string, unknown>

    return context.json({
      status: 'ok',
      offerId,
      data,
    })
  },
)

allegroAuth.get(
  '/open-offer/:offerId',
  async (context) => {
    await refreshAllegroSessionIfNeeded()

    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message: 'Allegro account is not connected',
        },
        401,
      )
    }

    const apiUrl = process.env.ALLEGRO_API_URL

    if (!apiUrl) {
      return context.json(
        {
          status: 'error',
          message: 'ALLEGRO_API_URL is missing',
        },
        500,
      )
    }

    const offerId = context.req.param('offerId')

    const response = await allegroFetch(
      apiUrl +
        '/sale/product-offers/' +
        encodeURIComponent(offerId),
      {
        headers: {
          Authorization:
            'Bearer ' + currentSession.accessToken,
          Accept:
            'application/vnd.allegro.public.v1+json',
          'Accept-Language': 'hu-HU',
        },
      },
    )

    if (!response.ok) {
      const body = await response.text()

      return context.json(
        {
          status: 'error',
          message: 'Could not load Allegro offer',
          allegroStatus: response.status,
          body,
        },
        502,
      )
    }

    const data = (await response.json()) as {
      name?: string | null
      productSet?: Array<{
        product?: {
          id?: string | null
        }
      }>
    }

    const productId =
      data.productSet?.[0]?.product?.id ?? null

    if (!productId) {
      return context.json(
        {
          status: 'error',
          message: 'Allegro product ID is not available',
        },
        404,
      )
    }

    const slug =
      (data.name ?? 'termek')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'termek'

    const storefrontUrl = apiUrl.includes(
      'allegrosandbox',
    )
      ? 'https://allegro.hu.allegrosandbox.pl'
      : 'https://allegro.hu'

    const targetUrl =
      storefrontUrl +
      '/termek/' +
      slug +
      '-' +
      productId +
      '?offerId=' +
      encodeURIComponent(offerId)

    return context.redirect(targetUrl, 302)
  },
)

allegroAuth.get('/offers-preview', async (context) => {
  await refreshAllegroSessionIfNeeded()

  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message:
          'Allegro account is not connected',
      },
      401,
    )
  }

  const apiUrl =
    process.env.ALLEGRO_API_URL

  if (!apiUrl) {
    return context.json(
      {
        status: 'error',
        message:
          'ALLEGRO_API_URL is missing',
      },
      500,
    )
  }

  const environment =
    assertAllegroEnvironmentConfiguration()

  const offersResponse =
    await allegroFetch(
      `${apiUrl}/sale/offers?limit=100`,
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',

          'Accept-Language':
            'hu-HU',
        },
      },
    )

  if (!offersResponse.ok) {
    const errorBody =
      await offersResponse.text()

    console.error(
      'Allegro offers preview request failed:',
      offersResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not load Allegro offers preview',
        httpStatus:
          offersResponse.status,
        allegroResponse:
          errorBody,
      },
      502,
    )
  }

  const data =
    (await offersResponse.json()) as
      AllegroOffersForSyncResponse

const baseMarketplaceId =
  currentSession.account.baseMarketplace?.id ?? null

  const offers =
    (data.offers ?? []).map(
      (offer) => {
        const isHuBaseMarketplace =
          baseMarketplaceId ===
          'allegro-hu'

        const huAdditionalState =
          offer.additionalMarketplaces?.[
            'allegro-hu'
          ]

        const hasHuMarketplace =
          isHuBaseMarketplace ||
          Boolean(huAdditionalState)

        const sku =
          offer.external?.id?.trim() ??
          null

        const priceMinor =
          isHuBaseMarketplace
            ? priceToMinor(
                offer.sellingMode
                  ?.price
                  ?.amount,
              )
            : huAdditionalState
              ? priceToMinor(
                  huAdditionalState
                    .sellingMode
                    ?.price
                    ?.amount,
                )
              : null

        const currency =
          isHuBaseMarketplace
            ? offer.sellingMode
                ?.price
                ?.currency ??
              null
            : huAdditionalState
                ?.sellingMode
                ?.price
                ?.currency ??
              null

        return {
          offerId:
            offer.id,

          sku,

          name:
            offer.name,

          categoryId:
            offer.category?.id ??
            null,

          hasHuMarketplace,

          marketplace:
        hasHuMarketplace
          ? 'allegro-hu'
          : null,

          priceMinor,

          currency,

          stockAvailable:
            offer.stock
              ?.available ??
            null,

          stockSold:
        isHuBaseMarketplace
          ? offer.stock
              ?.sold ??
            null
          : huAdditionalState
              ?.stock
              ?.sold ??
            offer.stock
              ?.sold ??
            null,

          publicationStatus:
            normalizeAllegroListingStatus(
              offer.publication
                ?.status,
            ),
        }
      },
    )

  const huOffers =
    offers.filter(
      (offer) =>
        offer.hasHuMarketplace,
    )

  const missingSku =
    huOffers.filter(
      (offer) =>
        !offer.sku,
    )

  return context.json({
    status: 'ok',

    mode: 'READ_ONLY_PREVIEW',

    environment,

    account: {
      id:
        currentSession.account.id,

      login:
        currentSession.account.login,

      baseMarketplace:
        currentSession.account
          .baseMarketplace
          ?.id ??
        null,
    },

    summary: {
      returned:
        offers.length,

      huMarketplace:
        huOffers.length,

      missingSku:
        missingSku.length,

      previewWritePerformed:
        false,
    },

    offers,
  })
})

allegroAuth.post('/sync', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  const databaseUrl = process.env.DATABASE_URL
  const apiUrl = process.env.ALLEGRO_API_URL

  const body =
    (await context.req.json().catch(() => null)) as
      | {
          offerIds?: unknown[]
        }
      | null

  if (!databaseUrl || !apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database or Allegro API configuration is missing',
      },
      500,
    )
  }

  const requestedOfferIds =
    new Set(
      (body?.offerIds ?? [])
        .filter(
          (value): value is string =>
            typeof value === 'string' &&
            value.trim().length > 0,
        )
        .map(
          (value) => value.trim(),
        ),
    )

  if (
    getAllegroEnvironment() === 'PRODUCTION' &&
    requestedOfferIds.size === 0
  ) {
    return context.json(
      {
        status: 'error',
        message:
          'Production Allegro sync requires explicit offerIds',
      },
      400,
    )
  }

  if (requestedOfferIds.size > 10) {
    return context.json(
      {
        status: 'error',
        message:
          'Maximum 10 offers can be imported during the production pilot',
      },
      400,
    )
  }

  const offersUrl =
    new URL(
      '/sale/offers',
      apiUrl,
    )

  if (requestedOfferIds.size > 0) {
    offersUrl.searchParams.set(
      'limit',
      String(requestedOfferIds.size),
    )

    for (const offerId of requestedOfferIds) {
      offersUrl.searchParams.append(
        'offer.id',
        offerId,
      )
    }
  } else {
    offersUrl.searchParams.set(
      'limit',
      '100',
    )
  }

  const offersResponse =
    await allegroFetch(
      offersUrl.toString(),
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,
          Accept:
            'application/vnd.allegro.public.v1+json',
        },
      },
    )

  if (!offersResponse.ok) {
    const errorBody =
      await offersResponse.text()

    console.error(
      'Allegro offers sync request failed:',
      offersResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Could not load Allegro offers',
        httpStatus:
          offersResponse.status,
      },
      500,
    )
  }

  const data =
    (await offersResponse.json()) as
      AllegroOffersForSyncResponse
  const availableOffers =
    data.offers ?? []

  const offersToImport =
    requestedOfferIds.size > 0
      ? availableOffers.filter(
          (offer) =>
            requestedOfferIds.has(offer.id),
        )
      : availableOffers

  if (
    requestedOfferIds.size > 0 &&
    offersToImport.length !==
      requestedOfferIds.size
  ) {
    const foundIds =
      new Set(
        offersToImport.map(
          (offer) => offer.id,
        ),
      )

    const missingOfferIds =
      [...requestedOfferIds].filter(
        (offerId) => !foundIds.has(offerId),
      )

    return context.json(
      {
        status: 'error',
        message:
          'One or more requested Allegro offers were not returned by the current sync scope',
        missingOfferIds,
      },
      409,
    )
  }


  const db = createDatabase(databaseUrl)
  const now = new Date()

  await db
    .delete(allegroChangeEvents)
    .where(
      lt(
        allegroChangeEvents.occurredAt,
        new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1000,
        ),
      ),
    )

  const [allegroPlatform] = await db
    .select({
      id: platforms.id,
    })
    .from(platforms)
    .where(eq(platforms.code, 'ALLEGRO'))
    .limit(1)

  if (!allegroPlatform) {
    return context.json(
      {
        status: 'error',
        message: 'ALLEGRO platform is missing from database',
      },
      500,
    )
  }

  const environment =
    assertAllegroEnvironmentConfiguration()

  const accountCode =
    `${currentSession.account.login.toUpperCase()}_${environment}`

  const [account] = await db
    .insert(platformAccounts)
    .values({
      platformId: allegroPlatform.id,
      code: accountCode,
      name: currentSession.account.login,
      externalAccountId: currentSession.account.id,
      marketplace:
        currentSession.account.baseMarketplace?.id ?? null,
      environment,
      active: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        platformAccounts.platformId,
        platformAccounts.code,
      ],
      set: {
        name: currentSession.account.login,
        externalAccountId: currentSession.account.id,
        marketplace:
          currentSession.account.baseMarketplace?.id ?? null,
        environment,
        active: true,
        updatedAt: now,
      },
    })
    .returning({
      id: platformAccounts.id,
    })

  let imported = 0
  let skipped = 0

  const skippedOffers: Array<{
    offerId: string
    name: string
    reason:
      | 'MISSING_HU_MARKETPLACE'
      | 'MISSING_SKU'
  }> = []

  const importedOffers: Array<{
    offerId: string
    sku: string
    marketplace: string
    priceMinor: number | null
    currency: string
    stockAvailable: number | null
    status: string
  }> = []

  const baseMarketplaceId =
  currentSession.account.baseMarketplace?.id ??
  null

  for (const offer of offersToImport) {
    const isHuBaseMarketplace =
  baseMarketplaceId ===
  'allegro-hu'

const huAdditionalState =
  offer.additionalMarketplaces?.[
    'allegro-hu'
  ]

const hasHuMarketplace =
  isHuBaseMarketplace ||
  Boolean(huAdditionalState)

if (!hasHuMarketplace) {
  skipped++

  skippedOffers.push({
    offerId: offer.id,
    name: offer.name,
    reason: 'MISSING_HU_MARKETPLACE',
  })

  continue
}

    const sku = offer.external?.id?.trim()

    if (!sku) {
      skipped++

      skippedOffers.push({
        offerId: offer.id,
        name: offer.name,
        reason: 'MISSING_SKU',
      })

      continue
    }

    const [product] = await db
      .insert(products)
      .values({
        sku,
        name: offer.name,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: products.sku,
        set: {
          updatedAt: now,
        },
      })
      .returning({
        id: products.id,
      })

    const [listing] = await db
      .insert(platformListings)
      .values({
        productId: product.id,
        platformId: allegroPlatform.id,
        accountId: account.id,

        externalListingId: offer.id,
        externalReference: sku,

        marketplace: 'allegro-hu',

        categoryId: offer.category?.id ?? null,
        listingName: offer.name,

        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          platformListings.platformId,
          platformListings.accountId,
          platformListings.externalListingId,
        ],
        set: {
          productId: product.id,
          externalReference: sku,
          marketplace: 'allegro-hu',
          categoryId: offer.category?.id ?? null,
          listingName: offer.name,
          updatedAt: now,
        },
      })
      .returning({
        id: platformListings.id,
      })

    const priceMinor =
  isHuBaseMarketplace
    ? priceToMinor(
        offer.sellingMode
          ?.price
          ?.amount,
      )
    : priceToMinor(
        huAdditionalState
          ?.sellingMode
          ?.price
          ?.amount,
      )

const currency =
  isHuBaseMarketplace
    ? offer.sellingMode
        ?.price
        ?.currency ??
      'HUF'
    : huAdditionalState
        ?.sellingMode
        ?.price
        ?.currency ??
      'HUF'

    let publicationStatus =
      normalizeAllegroListingStatus(
        offer.publication?.status,
      )

    if (environment === 'PRODUCTION') {
      try {
        const detailResponse =
          await allegroFetch(
            apiUrl +
              '/sale/product-offers/' +
              encodeURIComponent(offer.id),
            {
              headers: {
                Authorization:
                  'Bearer ' +
                  currentSession.accessToken,
                Accept:
                  'application/vnd.allegro.public.v1+json',
                'Accept-Language':
                  'hu-HU',
              },
            },
          )

        if (detailResponse.ok) {
          const detail =
            (await detailResponse.json()) as {
              publication?: {
                status?: string
              }
            }

          publicationStatus =
            normalizeAllegroListingStatus(
              detail.publication?.status,
            )
        } else {
          console.warn(
            'Allegro product-offer publication lookup failed; using list status:',
            offer.id,
            detailResponse.status,
          )
        }
      } catch (detailError) {
        console.warn(
          'Allegro product-offer publication lookup failed; using list status:',
          offer.id,
          detailError,
        )
      }
    }

    const stockAvailable =
      offer.stock?.available ?? null

    const stockSold =
  isHuBaseMarketplace
    ? offer.stock?.sold ??
      null
    : huAdditionalState
        ?.stock
        ?.sold ??
      offer.stock?.sold ??
      null

    const priceAutomation =
  isHuBaseMarketplace
    ? null
    : huAdditionalState
        ?.sellingMode
        ?.priceAutomation

    const priceAutomationRuleId =
      priceAutomation?.rule?.id ??
      priceAutomation?.id ??
      null

    const priceAutomationRuleType =
      priceAutomation?.rule?.type ??
      priceAutomation?.type ??
      null

    const activeCampaignRows = await db
      .select({
        desiredPriceMinor:
          listingCampaigns.desiredPriceMinor,
        externalCampaignId:
          listingCampaigns.externalCampaignId,
        validFrom:
          listingCampaigns.validFrom,
        validTo:
          listingCampaigns.validTo,
      })
      .from(listingCampaigns)
      .where(
        and(
          eq(
            listingCampaigns.listingId,
            listing.id,
          ),
          eq(
            listingCampaigns.campaignType,
            'DISCOUNT',
          ),
          eq(
            listingCampaigns.campaignStatus,
            'ACTIVE',
          ),
        ),
      )

    const activePromotion =
      activeCampaignRows
        .filter(
          (campaign) =>
            campaign.desiredPriceMinor !== null &&
            (
              !campaign.validFrom ||
              campaign.validFrom <= now
            ) &&
            (
              !campaign.validTo ||
              campaign.validTo >= now
            ),
        )
        .sort(
          (a, b) =>
            (a.desiredPriceMinor ?? Infinity) -
            (b.desiredPriceMinor ?? Infinity),
        )[0] ?? null

    const effectivePriceMinor =
      activePromotion?.desiredPriceMinor ??
      priceMinor

    const effectivePriceType =
      activePromotion
        ? 'PROMOTION'
        : 'REGULAR'

    const effectiveCampaignId =
      activePromotion?.externalCampaignId ??
      null

    const [lastPriceHistory] = await db
      .select({
        priceMinor:
          listingPriceHistory.priceMinor,
        basePriceMinor:
          listingPriceHistory.basePriceMinor,
        priceType:
          listingPriceHistory.priceType,
        externalCampaignId:
          listingPriceHistory.externalCampaignId,
        observedAt:
          listingPriceHistory.observedAt,
      })
      .from(listingPriceHistory)
      .where(
        eq(
          listingPriceHistory.listingId,
          listing.id,
        ),
      )
      .orderBy(
        desc(
          listingPriceHistory.observedAt,
        ),
      )
      .limit(1)

    const priceChangedSinceLastSnapshot =
      lastPriceHistory?.priceMinor !==
        effectivePriceMinor ||
      lastPriceHistory?.basePriceMinor !==
        priceMinor ||
      lastPriceHistory?.priceType !==
        effectivePriceType ||
      lastPriceHistory?.externalCampaignId !==
        effectiveCampaignId

    const dailyPriceSnapshotDue =
      !lastPriceHistory ||
      now.getTime() -
        lastPriceHistory.observedAt.getTime() >=
        24 * 60 * 60 * 1000

    const [previousRemoteState] = await db
      .select({
        priceMinor: listingRemoteStates.priceMinor,
        stockAvailable:
          listingRemoteStates.stockAvailable,
        publicationStatus:
          listingRemoteStates.publicationStatus,
      })
      .from(listingRemoteStates)
      .where(
        eq(
          listingRemoteStates.listingId,
          listing.id,
        ),
      )
      .limit(1)

    await db
      .insert(listingRemoteStates)
      .values({
        listingId: listing.id,

        priceMinor,
        currency,

        stockAvailable,
        stockSold,

        publicationStatus,

        priceAutomationRuleId,
        priceAutomationRuleType,

        isFulfillment:
          offer.isFulfillment ?? false,

        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: listingRemoteStates.listingId,
        set: {
          priceMinor,
          currency,

          stockAvailable,
          stockSold,

          publicationStatus,

          priceAutomationRuleId,
          priceAutomationRuleType,

          isFulfillment:
            offer.isFulfillment ?? false,

          lastSyncedAt: now,
          updatedAt: now,
        },
      })

    if (previousRemoteState) {
      const changeEvents: Array<{
        listingId: string
        eventType: string
        source: string
        oldValue: string | null
        newValue: string | null
        currency: string | null
        externalCampaignId: string | null
        metadataJson: string | null
        occurredAt: Date
      }> = []

      if (previousRemoteState.priceMinor !== priceMinor) {
        changeEvents.push({
          listingId: listing.id,
          eventType: 'PRICE',
          source: 'ALLEGRO_SYNC',
          oldValue:
            previousRemoteState.priceMinor === null
              ? null
              : String(previousRemoteState.priceMinor),
          newValue:
            priceMinor === null ? null : String(priceMinor),
          currency,
          externalCampaignId: null,
          metadataJson: null,
          occurredAt: now,
        })
      }

      if (
        previousRemoteState.stockAvailable !== stockAvailable
      ) {
        changeEvents.push({
          listingId: listing.id,
          eventType: 'STOCK',
          source: 'ALLEGRO_SYNC',
          oldValue:
            previousRemoteState.stockAvailable === null
              ? null
              : String(previousRemoteState.stockAvailable),
          newValue:
            stockAvailable === null
              ? null
              : String(stockAvailable),
          currency: null,
          externalCampaignId: null,
          metadataJson: null,
          occurredAt: now,
        })
      }

      if (
        previousRemoteState.publicationStatus !==
        publicationStatus
      ) {
        changeEvents.push({
          listingId: listing.id,
          eventType: 'STATUS',
          source: 'ALLEGRO_SYNC',
          oldValue:
            previousRemoteState.publicationStatus,
          newValue: publicationStatus,
          currency: null,
          externalCampaignId: null,
          metadataJson: null,
          occurredAt: now,
        })
      }

      if (changeEvents.length > 0) {
        await db
          .insert(allegroChangeEvents)
          .values(changeEvents)
      }
    }

    if (
      effectivePriceMinor !== null &&
      (
        priceChangedSinceLastSnapshot ||
        dailyPriceSnapshotDue
      )
    ) {
      await db
        .insert(listingPriceHistory)
        .values({
          listingId: listing.id,
          priceMinor:
            effectivePriceMinor,
          basePriceMinor:
            priceMinor,
          priceType:
            effectivePriceType,
          externalCampaignId:
            effectiveCampaignId,
          currency,
          source: 'ALLEGRO_SYNC',
          observedAt: now,
        })
    }

    await db
      .insert(listingDesiredStates)
      .values({
        listingId: listing.id,

        listPriceMinor: priceMinor,
        regularPriceMinor: priceMinor,

        desiredStock: stockAvailable,

        desiredPublicationStatus:
          publicationStatus === 'ACTIVE' ||
          publicationStatus === 'ACTIVATING'
            ? 'ACTIVE'
            : publicationStatus === 'INACTIVE'
              ? 'INACTIVE'
              : publicationStatus,

        priceLocked: false,
        stockLocked: false,

        autoPriceSync: false,
        autoStockSync: true,

        updatedBy: 'INITIAL_ALLEGRO_SYNC',

        updatedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: listingDesiredStates.listingId,
      })

    imported++

    importedOffers.push({
      offerId: offer.id,
      sku,
      marketplace: 'allegro-hu',
      priceMinor,
      currency,
      stockAvailable,
      status: publicationStatus,
    })
  }

  return context.json({
    status: 'ok',
    environment,
    marketplace: 'allegro-hu',

    allegroTotalOffers:
      data.totalCount ?? data.count ?? 0,

    imported,
    skipped,
    skippedOffers,

    offers: importedOffers,

    syncedAt: now.toISOString(),
  })
})

allegroAuth.post('/push-price/:listingId', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }


  assertAllegroWriteSafety()

  const databaseUrl = process.env.DATABASE_URL
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!databaseUrl || !apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database or Allegro API configuration is missing',
      },
      500,
    )
  }

  const listingId = context.req.param('listingId')
  const db = createDatabase(databaseUrl)

  const [row] = await db
    .select({
      listingId: platformListings.id,
      offerId: platformListings.externalListingId,
      marketplace: platformListings.marketplace,

      desiredPriceMinor:
        listingDesiredStates.regularPriceMinor,

      priceLocked:
        listingDesiredStates.priceLocked,
    })
    .from(platformListings)
    .innerJoin(
      listingDesiredStates,
      eq(
        listingDesiredStates.listingId,
        platformListings.id,
      ),
    )
    .where(
      eq(platformListings.id, listingId),
    )
    .limit(1)

  if (!row) {
    return context.json(
      {
        status: 'error',
        message: 'Listing or desired state was not found',
      },
      404,
    )
  }

  if (row.marketplace !== 'allegro-hu') {
    return context.json(
      {
        status: 'error',
        message: 'Only allegro-hu listings are supported',
      },
      400,
    )
  }

  if (row.desiredPriceMinor === null) {
    return context.json(
      {
        status: 'error',
        message: 'Desired price is missing',
      },
      400,
    )
  }

  const priceResolutionNow = new Date()

  const activeCampaignRowsForPrice =
    await db
      .select({
        desiredPriceMinor:
          listingCampaigns.desiredPriceMinor,

        validFrom:
          listingCampaigns.validFrom,

        validTo:
          listingCampaigns.validTo,
      })
      .from(listingCampaigns)
      .where(
        and(
          eq(
            listingCampaigns.listingId,
            listingId,
          ),
          eq(
            listingCampaigns.campaignType,
            'DISCOUNT',
          ),
          eq(
            listingCampaigns.campaignStatus,
            'ACTIVE',
          ),
        ),
      )

  const hasActiveAllegroCampaign =
    activeCampaignRowsForPrice.some(
      (campaign) =>
        (
          !campaign.validFrom ||
          campaign.validFrom <= priceResolutionNow
        ) &&
        (
          !campaign.validTo ||
          campaign.validTo >= priceResolutionNow
        ),
    )

  const enabledPriceSchedules =
    await db
      .select({
        promotionalPriceMinor:
          listingPriceSchedules
            .promotionalPriceMinor,

        validFrom:
          listingPriceSchedules.validFrom,

        validTo:
          listingPriceSchedules.validTo,
      })
      .from(listingPriceSchedules)
      .where(
        and(
          eq(
            listingPriceSchedules.listingId,
            listingId,
          ),
          eq(
            listingPriceSchedules.enabled,
            true,
          ),
        ),
      )

  const activePriceSchedule =
    enabledPriceSchedules
      .filter(
        (schedule) =>
          schedule.validFrom <=
            priceResolutionNow &&
          schedule.validTo >=
            priceResolutionNow,
      )
      .sort(
        (left, right) =>
          right.validFrom.getTime() -
          left.validFrom.getTime(),
      )[0] ?? null

  const effectiveDesiredPriceMinor =
    !hasActiveAllegroCampaign &&
    activePriceSchedule
      ? activePriceSchedule
          .promotionalPriceMinor
      : row.desiredPriceMinor

  const desiredPrice =
    effectiveDesiredPriceMinor / 100

  const commandId = randomUUID()

  const commandResponse = await allegroFetch(
    `${apiUrl}/sale/offer-price-change-commands/${commandId}`,
    {
      method: 'PUT',
      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Content-Type':
          'application/vnd.allegro.public.v1+json',
      },

      body: JSON.stringify({
        modification: {
          type: 'FIXED_PRICE',
          marketplaceId: 'allegro-hu',

          price: {
            amount: desiredPrice.toFixed(2),
            currency: 'HUF',
          },
        },

        offerCriteria: [
          {
            type: 'CONTAINS_OFFERS',

            offers: [
              {
                id: row.offerId,
              },
            ],
          },
        ],
      }),
    },
  )

  if (!commandResponse.ok) {
    const errorBody =
      await commandResponse.text()

    console.error(
      'Allegro price command failed:',
      commandResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message: 'Allegro rejected the price change command',
        httpStatus: commandResponse.status,
        allegroResponse: errorBody,
      },
      502,
    )
  }

  const sleep = (ms: number) =>
    new Promise((resolve) =>
      setTimeout(resolve, ms),
    )

  const refreshOfferPriceFromAllegro =
    async () => {
      const response =
        await allegroAuth.request(
          '/sync',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              offerIds: [row.offerId],
            }),
          },
        )

      return response.ok
    }

  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500)

    const taskResponse = await allegroFetch(
      `${apiUrl}/sale/offer-price-change-commands/${commandId}/tasks`,
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',
        },
      },
    )

    if (!taskResponse.ok) {
      continue
    }

    const taskData = (await taskResponse.json()) as {
      tasks?: Array<{
        offer?: {
          id?: string
        }

        status?: string
        message?: string
        field?: string
      }>
    }

    const task = taskData.tasks?.find(
      (item) =>
        item.offer?.id === row.offerId,
    )

    if (!task) {
      continue
    }

    if (task.status === 'FAILED') {
      return context.json(
        {
          status: 'error',
          message: 'Allegro price update failed',
          commandId,
          task,
        },
        502,
      )
    }

    if (task.status === 'SUCCESS') {
      await refreshOfferPriceFromAllegro()
      await sleep(4000)
      await refreshOfferPriceFromAllegro()

      return context.json({
        status: 'ok',
        message: 'Allegro HU price updated successfully',

        commandId,

        listingId: row.listingId,
        offerId: row.offerId,

        marketplace: 'allegro-hu',

        desiredPriceMinor:
          row.desiredPriceMinor,

        desiredPrice,

        allegroTaskStatus:
          task.status,
      })
    }
  }

  await refreshOfferPriceFromAllegro()
  await sleep(4000)
  await refreshOfferPriceFromAllegro()

  return context.json(
    {
      status: 'pending',
      message:
        'Allegro accepted the command, but it is still processing',

      commandId,
      listingId: row.listingId,
      offerId: row.offerId,

      desiredPriceMinor:
        row.desiredPriceMinor,
    },
    202,
  )
})

allegroAuth.post('/push-stock/:listingId', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }


  assertAllegroWriteSafety()

  const databaseUrl = process.env.DATABASE_URL
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!databaseUrl || !apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database or Allegro API configuration is missing',
      },
      500,
    )
  }

  const listingId = context.req.param('listingId')
  const db = createDatabase(databaseUrl)

  const [row] = await db
    .select({
      listingId: platformListings.id,
      offerId: platformListings.externalListingId,

      desiredStock:
        listingDesiredStates.desiredStock,

      stockLocked:
        listingDesiredStates.stockLocked,
    })
    .from(platformListings)
    .innerJoin(
      listingDesiredStates,
      eq(
        listingDesiredStates.listingId,
        platformListings.id,
      ),
    )
    .where(
      eq(platformListings.id, listingId),
    )
    .limit(1)

  if (!row) {
    return context.json(
      {
        status: 'error',
        message: 'Listing or desired state was not found',
      },
      404,
    )
  }

  if (row.desiredStock === null) {
    return context.json(
      {
        status: 'error',
        message: 'Desired stock is missing',
      },
      400,
    )
  }

  if (row.desiredStock < 0) {
    return context.json(
      {
        status: 'error',
        message: 'Desired stock cannot be negative',
      },
      400,
    )
  }

  const commandId = randomUUID()

  const commandResponse = await allegroFetch(
    `${apiUrl}/sale/offer-quantity-change-commands/${commandId}`,
    {
      method: 'PUT',

      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Content-Type':
          'application/vnd.allegro.public.v1+json',
      },

      body: JSON.stringify({
        modification: {
          changeType: 'FIXED',
          value: row.desiredStock,
        },

        offerCriteria: [
          {
            type: 'CONTAINS_OFFERS',

            offers: [
              {
                id: row.offerId,
              },
            ],
          },
        ],
      }),
    },
  )

  if (!commandResponse.ok) {
    const errorBody =
      await commandResponse.text()

    console.error(
      'Allegro stock command failed:',
      commandResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Allegro rejected the stock change command',

        httpStatus:
          commandResponse.status,

        allegroResponse:
          errorBody,
      },
      502,
    )
  }

  const sleep = (ms: number) =>
    new Promise((resolve) =>
      setTimeout(resolve, ms),
    )

  const refreshOfferFromAllegro =
    async () => {
      const response =
        await allegroAuth.request(
          '/sync',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              offerIds: [row.offerId],
            }),
          },
        )

      return response.ok
    }

  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500)

    const taskResponse = await allegroFetch(
      `${apiUrl}/sale/offer-quantity-change-commands/${commandId}/tasks`,
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',
        },
      },
    )

    if (!taskResponse.ok) {
      continue
    }

    const taskData = (await taskResponse.json()) as {
      tasks?: Array<{
        offer?: {
          id?: string
        }

        status?: string
        message?: string
        field?: string
      }>
    }

    const task = taskData.tasks?.find(
      (item) =>
        item.offer?.id === row.offerId,
    )

    if (!task) {
      continue
    }

    if (task.status === 'FAIL' || task.status === 'FAILED') {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro stock update failed',

          commandId,
          task,
        },
        502,
      )
    }

    if (task.status === 'SUCCESS') {
      await refreshOfferFromAllegro()
      return context.json({
        status: 'ok',

        message:
          'Allegro stock updated successfully',

        commandId,

        listingId:
          row.listingId,

        offerId:
          row.offerId,

        desiredStock:
          row.desiredStock,

        allegroTaskStatus:
          task.status,
      })
    }
  }

  await refreshOfferFromAllegro()
  await sleep(4000)
  await refreshOfferFromAllegro()

  return context.json(
    {
      status: 'pending',

      message:
        'Allegro accepted the command, but it is still processing',

      commandId,

      listingId:
        row.listingId,

      offerId:
        row.offerId,

      desiredStock:
        row.desiredStock,
    },
    202,
  )
})
allegroAuth.post('/push-status/:listingId', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }


  assertAllegroWriteSafety()

  const databaseUrl = process.env.DATABASE_URL
  const apiUrl = process.env.ALLEGRO_API_URL

  if (!databaseUrl || !apiUrl) {
    return context.json(
      {
        status: 'error',
        message:
          'Database or Allegro API configuration is missing',
      },
      500,
    )
  }

  const listingId = context.req.param('listingId')
  const db = createDatabase(databaseUrl)

  const [row] = await db
    .select({
      listingId:
        platformListings.id,

      offerId:
        platformListings.externalListingId,

      publicationStatus:
        listingRemoteStates.publicationStatus,

      desiredPublicationStatus:
        listingDesiredStates.desiredPublicationStatus,
    })
    .from(platformListings)
    .leftJoin(
      listingRemoteStates,
      eq(
        listingRemoteStates.listingId,
        platformListings.id,
      ),
    )
    .leftJoin(
      listingDesiredStates,
      eq(
        listingDesiredStates.listingId,
        platformListings.id,
      ),
    )
    .where(
      eq(
        platformListings.id,
        listingId,
      ),
    )
    .limit(1)

  if (!row) {
    return context.json(
      {
        status: 'error',
        message: 'Listing not found',
      },
      404,
    )
  }

  if (!row.offerId) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro offer ID is missing',
      },
      400,
    )
  }

  if (
    row.desiredPublicationStatus !== 'ACTIVE' &&
    row.desiredPublicationStatus !== 'INACTIVE'
  ) {
    return context.json(
      {
        status: 'error',
        message:
          'Desired publication status must be ACTIVE or INACTIVE',
      },
      400,
    )
  }

  const alreadyMatches =
    row.desiredPublicationStatus === 'ACTIVE'
      ? row.publicationStatus === 'ACTIVE' ||
        row.publicationStatus === 'ACTIVATING'
      : row.publicationStatus === 'INACTIVE' ||
        row.publicationStatus === 'ENDED'

  if (alreadyMatches) {
    return context.json({
      status: 'ok',
      message:
        'Publication status already matches the desired state',
      skipped: true,
      listingId: row.listingId,
      offerId: row.offerId,
      publicationStatus:
        row.publicationStatus,
      desiredPublicationStatus:
        row.desiredPublicationStatus,
    })
  }

  const action =
    row.desiredPublicationStatus === 'ACTIVE'
      ? 'ACTIVATE'
      : 'END'

  const commandId = randomUUID()

  const commandResponse = await allegroFetch(
    `${apiUrl}/sale/offer-publication-commands/${commandId}`,
    {
      method: 'PUT',

      headers: {
        Authorization:
          `Bearer ${currentSession.accessToken}`,

        Accept:
          'application/vnd.allegro.public.v1+json',

        'Content-Type':
          'application/vnd.allegro.public.v1+json',
      },

      body: JSON.stringify({
        publication: {
          action,
        },

        offerCriteria: [
          {
            type: 'CONTAINS_OFFERS',

            offers: [
              {
                id: row.offerId,
              },
            ],
          },
        ],
      }),
    },
  )

  if (!commandResponse.ok) {
    const errorBody =
      await commandResponse.text()

    console.error(
      'Allegro publication command failed:',
      commandResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message:
          'Allegro publication command failed',
        commandId,
        details: errorBody,
      },
      502,
    )
  }

  const sleep = (ms: number) =>
    new Promise((resolve) =>
      setTimeout(resolve, ms),
    )

  for (
    let attempt = 0;
    attempt < 10;
    attempt += 1
  ) {
    await sleep(500)

    const taskResponse = await allegroFetch(
      `${apiUrl}/sale/offer-publication-commands/${commandId}/tasks`,
      {
        headers: {
          Authorization:
            `Bearer ${currentSession.accessToken}`,

          Accept:
            'application/vnd.allegro.public.v1+json',
        },
      },
    )

    if (!taskResponse.ok) {
      continue
    }

    const taskData =
      (await taskResponse.json()) as {
        tasks?: Array<{
          offer?: {
            id?: string
          }

          status?: string
          message?: string
          field?: string
        }>
      }

    const task = taskData.tasks?.find(
      (item) =>
        item.offer?.id === row.offerId,
    )

    if (!task) {
      continue
    }

    if (task.status === 'FAIL' || task.status === 'FAILED') {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro publication status update failed',
          commandId,
          task,
        },
        502,
      )
    }

    if (task.status === 'SUCCESS') {
      return context.json({
        status: 'ok',
        message:
          'Allegro publication status updated successfully',
        commandId,
        listingId: row.listingId,
        offerId: row.offerId,
        action,
        desiredPublicationStatus:
          row.desiredPublicationStatus,
        allegroTaskStatus:
          task.status,
      })
    }
  }

  return context.json(
    {
      status: 'pending',
      message:
        'Allegro accepted the publication command, but it is still processing',
      commandId,
      listingId: row.listingId,
      offerId: row.offerId,
      action,
      desiredPublicationStatus:
        row.desiredPublicationStatus,
    },
    202,
  )
})
allegroAuth.post(
  '/stop-price-schedule/:scheduleId',
  async (context) => {
    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro account is not connected',
        },
        401,
      )
    }

    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message:
            'Database configuration is missing',
        },
        500,
      )
    }

    const scheduleId =
      context.req.param('scheduleId')

    const db =
      createDatabase(databaseUrl)

    try {
      const [schedule] =
        await db
          .select({
            id:
              listingPriceSchedules.id,

            listingId:
              listingPriceSchedules.listingId,

            validTo:
              listingPriceSchedules.validTo,

            startAppliedAt:
              listingPriceSchedules
                .startAppliedAt,

            endAppliedAt:
              listingPriceSchedules
                .endAppliedAt,
          })
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.id,
              scheduleId,
            ),
          )
          .limit(1)

      if (!schedule) {
        return context.json(
          {
            status: 'error',
            message:
              'Price schedule was not found',
          },
          404,
        )
      }

      if (
        schedule.startAppliedAt === null ||
        schedule.endAppliedAt !== null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Only an active price schedule can be stopped',
          },
          409,
        )
      }

      const now = new Date()

      const closedValidTo =
        new Date(now.getTime() - 1)

      const activeCampaignRows =
        await db
          .select({
            validFrom:
              listingCampaigns.validFrom,

            validTo:
              listingCampaigns.validTo,
          })
          .from(listingCampaigns)
          .where(
            and(
              eq(
                listingCampaigns.listingId,
                schedule.listingId,
              ),
              eq(
                listingCampaigns.campaignType,
                'DISCOUNT',
              ),
              eq(
                listingCampaigns.campaignStatus,
                'ACTIVE',
              ),
            ),
          )

      const hasActiveCampaign =
        activeCampaignRows.some(
          (campaign) =>
            (
              !campaign.validFrom ||
              campaign.validFrom <= now
            ) &&
            (
              !campaign.validTo ||
              campaign.validTo >= now
            ),
        )


      // Előbb lezárjuk az időablakot, hogy a push-price
      // már ne ezt a kedvezményes árat válassza ki.
      await db
        .update(listingPriceSchedules)
        .set({
          validTo: closedValidTo,
          updatedAt: now,
        })
        .where(
          eq(
            listingPriceSchedules.id,
            schedule.id,
          ),
        )


      // Ha hivatalos Allegro-kampány aktív,
      // nem írjuk felül annak árát.
      if (hasActiveCampaign) {
        await db
          .update(listingPriceSchedules)
          .set({
            endAppliedAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            eq(
              listingPriceSchedules.id,
              schedule.id,
            ),
          )

        return context.json({
          status: 'ok',
          data: {
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            stoppedAt: now.toISOString(),
            priceRestore:
              'SKIPPED_ACTIVE_CAMPAIGN',
          },
        })
      }


      // Nincs kampány: a push-price most már
      // a normál kívánt árat fogja kiválasztani.
      const priceResponse =
        await allegroAuth.request(
          `/push-price/${encodeURIComponent(
            schedule.listingId,
          )}`,
          {
            method: 'POST',
          },
        )

      if (!priceResponse.ok) {
        const responseBody =
          await priceResponse.text()

        // Ha az Allegro-visszaállítás nem sikerült,
        // visszaállítjuk az eredeti lejáratot,
        // így a schedule nem vész el.
        await db
          .update(listingPriceSchedules)
          .set({
            validTo: schedule.validTo,
            lastError:
              `Price restore failed: ${responseBody}`,
            updatedAt: new Date(),
          })
          .where(
            eq(
              listingPriceSchedules.id,
              schedule.id,
            ),
          )

        return context.json(
          {
            status: 'error',
            message:
              'Could not restore the normal Allegro price',
          },
          502,
        )
      }


      await db
        .update(listingPriceSchedules)
        .set({
          endAppliedAt: now,
          lastError: null,
          updatedAt: now,
        })
        .where(
          eq(
            listingPriceSchedules.id,
            schedule.id,
          ),
        )

      return context.json({
        status: 'ok',
        data: {
          scheduleId: schedule.id,
          listingId: schedule.listingId,
          stoppedAt: now.toISOString(),
          priceRestore: 'APPLIED',
        },
      })
    } catch (error) {
      console.error(
        'Stopping active price schedule failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not stop active price schedule',
        },
        500,
      )
    }
  },
)


allegroAuth.patch(
  '/price-schedule/:scheduleId',
  async (context) => {
    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message:
            'Database configuration is missing',
        },
        500,
      )
    }

    const db = createDatabase(databaseUrl)

    try {
      const scheduleId =
        context.req.param('scheduleId')

      const body = await context.req.json<{
        promotionalPrice: number
        validFrom?: string
        validTo: string
      }>()

      const promotionalPrice =
        Number(body.promotionalPrice)

      if (
        !Number.isFinite(promotionalPrice) ||
        promotionalPrice <= 0
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Invalid promotional price',
          },
          400,
        )
      }

      const promotionalPriceMinor =
        Math.round(promotionalPrice * 100)

      const [schedule] =
        await db
          .select({
            id:
              listingPriceSchedules.id,

            listingId:
              listingPriceSchedules.listingId,

            promotionalPriceMinor:
              listingPriceSchedules
                .promotionalPriceMinor,

            validFrom:
              listingPriceSchedules.validFrom,

            validTo:
              listingPriceSchedules.validTo,

            enabled:
              listingPriceSchedules.enabled,

            startAppliedAt:
              listingPriceSchedules
                .startAppliedAt,

            endAppliedAt:
              listingPriceSchedules
                .endAppliedAt,
          })
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.id,
              scheduleId,
            ),
          )
          .limit(1)

      if (!schedule) {
        return context.json(
          {
            status: 'error',
            message:
              'Price schedule was not found',
          },
          404,
        )
      }

      if (schedule.endAppliedAt !== null) {
        return context.json(
          {
            status: 'error',
            message:
              'Expired price schedule cannot be edited',
          },
          409,
        )
      }

      const [desiredState] =
        await db
          .select({
            regularPriceMinor:
              listingDesiredStates
                .regularPriceMinor,
          })
          .from(listingDesiredStates)
          .where(
            eq(
              listingDesiredStates.listingId,
              schedule.listingId,
            ),
          )
          .limit(1)

      if (
        !desiredState ||
        desiredState.regularPriceMinor === null
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Normal desired price is missing',
          },
          400,
        )
      }

      if (
        promotionalPriceMinor >=
        desiredState.regularPriceMinor
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Promotional price must be lower than the normal desired price',
          },
          400,
        )
      }

      const parsedValidTo =
        new Date(body.validTo)

      if (
        Number.isNaN(
          parsedValidTo.getTime(),
        )
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Invalid schedule end date',
          },
          400,
        )
      }

      const now = new Date()

      const isActive =
        schedule.startAppliedAt !== null &&
        schedule.endAppliedAt === null

      let nextValidFrom =
        schedule.validFrom

      if (!isActive) {
        const parsedValidFrom =
          new Date(body.validFrom ?? '')

        if (
          Number.isNaN(
            parsedValidFrom.getTime(),
          )
        ) {
          return context.json(
            {
              status: 'error',
              message:
                'Invalid schedule start date',
            },
            400,
          )
        }

        nextValidFrom =
          parsedValidFrom
      }

      if (
        parsedValidTo <= nextValidFrom
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Schedule end must be later than its start',
          },
          400,
        )
      }

      if (
        isActive &&
        parsedValidTo <= now
      ) {
        return context.json(
          {
            status: 'error',
            message:
              'Use delete to stop an active discount immediately',
          },
          400,
        )
      }

      const otherSchedules =
        await db
          .select({
            id:
              listingPriceSchedules.id,

            validFrom:
              listingPriceSchedules.validFrom,

            validTo:
              listingPriceSchedules.validTo,

            enabled:
              listingPriceSchedules.enabled,

            endAppliedAt:
              listingPriceSchedules
                .endAppliedAt,
          })
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.listingId,
              schedule.listingId,
            ),
          )

      const overlaps =
        otherSchedules.some(
          (other) =>
            other.id !== schedule.id &&
            other.enabled &&
            other.endAppliedAt === null &&
            nextValidFrom < other.validTo &&
            parsedValidTo > other.validFrom,
        )

      if (overlaps) {
        return context.json(
          {
            status: 'error',
            message:
              'Another enabled price schedule overlaps this period',
          },
          409,
        )
      }

      const oldValues = {
        promotionalPriceMinor:
          schedule.promotionalPriceMinor,

        validFrom:
          schedule.validFrom,

        validTo:
          schedule.validTo,

        enabled:
          schedule.enabled,
      }

      await db
        .update(listingPriceSchedules)
        .set({
          promotionalPriceMinor,
          validFrom: nextValidFrom,
          validTo: parsedValidTo,
          enabled: true,
          lastError: null,
          updatedAt: now,
        })
        .where(
          eq(
            listingPriceSchedules.id,
            schedule.id,
          ),
        )

      const priceChanged =
        promotionalPriceMinor !==
        schedule.promotionalPriceMinor

      if (isActive && priceChanged) {
        if (!currentSession) {
          await db
            .update(listingPriceSchedules)
            .set({
              ...oldValues,
              updatedAt: new Date(),
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          return context.json(
            {
              status: 'error',
              message:
                'Allegro account is not connected',
            },
            401,
          )
        }

        const activeCampaignRows =
          await db
            .select({
              validFrom:
                listingCampaigns.validFrom,

              validTo:
                listingCampaigns.validTo,
            })
            .from(listingCampaigns)
            .where(
              and(
                eq(
                  listingCampaigns.listingId,
                  schedule.listingId,
                ),
                eq(
                  listingCampaigns.campaignType,
                  'DISCOUNT',
                ),
                eq(
                  listingCampaigns.campaignStatus,
                  'ACTIVE',
                ),
              ),
            )

        const hasActiveCampaign =
          activeCampaignRows.some(
            (campaign) =>
              (
                !campaign.validFrom ||
                campaign.validFrom <= now
              ) &&
              (
                !campaign.validTo ||
                campaign.validTo >= now
              ),
          )

        if (!hasActiveCampaign) {
          const priceResponse =
            await allegroAuth.request(
              `/push-price/${encodeURIComponent(
                schedule.listingId,
              )}`,
              {
                method: 'POST',
              },
            )

          if (!priceResponse.ok) {
            const responseBody =
              await priceResponse.text()

            await db
              .update(listingPriceSchedules)
              .set({
                ...oldValues,
                lastError:
                  `Price update failed: ${responseBody}`,
                updatedAt: new Date(),
              })
              .where(
                eq(
                  listingPriceSchedules.id,
                  schedule.id,
                ),
              )

            return context.json(
              {
                status: 'error',
                message:
                  'Could not update the active Allegro discount price',
              },
              502,
            )
          }
        }
      }

      const [updated] =
        await db
          .select()
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.id,
              schedule.id,
            ),
          )
          .limit(1)

      return context.json({
        status: 'ok',
        data: updated,
      })
    } catch (error) {
      console.error(
        'Smart price schedule update failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not update price schedule',
        },
        500,
      )
    }
  },
)


allegroAuth.delete(
  '/price-schedule/:scheduleId',
  async (context) => {
    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message:
            'Database configuration is missing',
        },
        500,
      )
    }

    const db = createDatabase(databaseUrl)

    try {
      const scheduleId =
        context.req.param('scheduleId')

      const [schedule] =
        await db
          .select({
            id:
              listingPriceSchedules.id,

            listingId:
              listingPriceSchedules.listingId,

            enabled:
              listingPriceSchedules.enabled,

            startAppliedAt:
              listingPriceSchedules
                .startAppliedAt,

            endAppliedAt:
              listingPriceSchedules
                .endAppliedAt,
          })
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.id,
              scheduleId,
            ),
          )
          .limit(1)

      if (!schedule) {
        return context.json(
          {
            status: 'error',
            message:
              'Price schedule was not found',
          },
          404,
        )
      }

      const isActive =
        schedule.startAppliedAt !== null &&
        schedule.endAppliedAt === null

      if (isActive) {
        if (!currentSession) {
          return context.json(
            {
              status: 'error',
              message:
                'Allegro account is not connected',
            },
            401,
          )
        }

        const now = new Date()

        const activeCampaignRows =
          await db
            .select({
              validFrom:
                listingCampaigns.validFrom,

              validTo:
                listingCampaigns.validTo,
            })
            .from(listingCampaigns)
            .where(
              and(
                eq(
                  listingCampaigns.listingId,
                  schedule.listingId,
                ),
                eq(
                  listingCampaigns.campaignType,
                  'DISCOUNT',
                ),
                eq(
                  listingCampaigns.campaignStatus,
                  'ACTIVE',
                ),
              ),
            )

        const hasActiveCampaign =
          activeCampaignRows.some(
            (campaign) =>
              (
                !campaign.validFrom ||
                campaign.validFrom <= now
              ) &&
              (
                !campaign.validTo ||
                campaign.validTo >= now
              ),
          )

        if (!hasActiveCampaign) {
          await db
            .update(listingPriceSchedules)
            .set({
              enabled: false,
              updatedAt: now,
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          const priceResponse =
            await allegroAuth.request(
              `/push-price/${encodeURIComponent(
                schedule.listingId,
              )}`,
              {
                method: 'POST',
              },
            )

          if (!priceResponse.ok) {
            const responseBody =
              await priceResponse.text()

            await db
              .update(listingPriceSchedules)
              .set({
                enabled: schedule.enabled,
                lastError:
                  `Price restore failed: ${responseBody}`,
                updatedAt: new Date(),
              })
              .where(
                eq(
                  listingPriceSchedules.id,
                  schedule.id,
                ),
              )

            return context.json(
              {
                status: 'error',
                message:
                  'Could not restore the normal Allegro price',
              },
              502,
            )
          }
        }
      }

      await db
        .delete(listingPriceSchedules)
        .where(
          eq(
            listingPriceSchedules.id,
            schedule.id,
          ),
        )

      return context.json({
        status: 'ok',
        deletedId: schedule.id,
        restoredNormalPrice:
          isActive,
      })
    } catch (error) {
      console.error(
        'Smart price schedule deletion failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not delete price schedule',
        },
        500,
      )
    }
  },
)


allegroAuth.post(
  '/process-price-schedules',
  async (context) => {
    if (!currentSession) {
      return context.json(
        {
          status: 'error',
          message:
            'Allegro account is not connected',
        },
        401,
      )
    }

    const databaseUrl =
      process.env.DATABASE_URL

    if (!databaseUrl) {
      return context.json(
        {
          status: 'error',
          message:
            'Database configuration is missing',
        },
        500,
      )
    }

    const db = createDatabase(databaseUrl)

    try {
      const now = new Date()

      const schedules =
        await db
          .select({
            id:
              listingPriceSchedules.id,

            listingId:
              listingPriceSchedules.listingId,

            promotionalPriceMinor:
              listingPriceSchedules.promotionalPriceMinor,

            validFrom:
              listingPriceSchedules.validFrom,

            validTo:
              listingPriceSchedules.validTo,

            startAppliedAt:
              listingPriceSchedules
                .startAppliedAt,

            endAppliedAt:
              listingPriceSchedules
                .endAppliedAt,
          })
          .from(listingPriceSchedules)
          .where(
            eq(
              listingPriceSchedules.enabled,
              true,
            ),
          )

      let applied = 0
      let blocked = 0
      let failed = 0
      let skipped = 0

      const results: Array<{
        scheduleId: string
        listingId: string
        action:
          | 'START'
          | 'END'
          | 'SKIP'
        status:
          | 'APPLIED'
          | 'BLOCKED'
          | 'FAILED'
          | 'SKIPPED'
          | 'PENDING'
        message?: string
      }> = []

      for (const schedule of schedules) {
        if (schedule.endAppliedAt !== null) {
          // Cleanup completed price schedule
          await db
            .delete(listingPriceSchedules)
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          skipped += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: 'SKIP',
            status: 'SKIPPED',
            message:
              'Schedule already completed',
          })

          continue
        }

        const shouldStart =
          schedule.startAppliedAt === null &&
          now >= schedule.validFrom &&
          now <= schedule.validTo

        const shouldEnd =
          schedule.startAppliedAt !== null &&
          now > schedule.validTo

        if (
          schedule.startAppliedAt === null &&
          now > schedule.validTo
        ) {
          await db
            .update(listingPriceSchedules)
            .set({
              endAppliedAt: now,
              lastError:
                'Schedule expired before its start could be applied',
              updatedAt: now,
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          skipped += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: 'SKIP',
            status: 'SKIPPED',
            message:
              'Schedule expired before start',
          })

          continue
        }

        if (!shouldStart && !shouldEnd) {
          skipped += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: 'SKIP',
            status: 'SKIPPED',
            message:
              schedule.startAppliedAt === null
                ? 'Waiting for start time'
                : 'Schedule is currently active',
          })

          continue
        }

        const activeCampaignRows =
          await db
            .select({
              validFrom:
                listingCampaigns.validFrom,

              validTo:
                listingCampaigns.validTo,
            })
            .from(listingCampaigns)
            .where(
              and(
                eq(
                  listingCampaigns.listingId,
                  schedule.listingId,
                ),
                eq(
                  listingCampaigns.campaignType,
                  'DISCOUNT',
                ),
                eq(
                  listingCampaigns.campaignStatus,
                  'ACTIVE',
                ),
              ),
            )

        const hasActiveCampaign =
          activeCampaignRows.some(
            (campaign) =>
              (
                !campaign.validFrom ||
                campaign.validFrom <= now
              ) &&
              (
                !campaign.validTo ||
                campaign.validTo >= now
              ),
          )

        if (hasActiveCampaign) {
          const message =
            'Price schedule is temporarily blocked by an active Allegro campaign'

          await db
            .update(listingPriceSchedules)
            .set({
              lastError: message,
              updatedAt: now,
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          blocked += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: shouldStart
              ? 'START'
              : 'END',
            status: 'BLOCKED',
            message,
          })

          continue
        }

        const response =
          await allegroAuth.request(
            `/push-price/${encodeURIComponent(
              schedule.listingId,
            )}`,
            {
              method: 'POST',
            },
          )

        const responseData =
          await response
            .json()
            .catch(() => null) as
            | {
                message?: string
              }
            | null

        if (!response.ok) {
          const message =
            responseData?.message ??
            `Price push failed with HTTP ${response.status}`

          await db
            .update(listingPriceSchedules)
            .set({
              lastError: message,
              updatedAt: now,
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          failed += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: shouldStart
              ? 'START'
              : 'END',
            status: 'FAILED',
            message,
          })

          continue
        }

        if (response.status === 202) {
          skipped += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: shouldStart
              ? 'START'
              : 'END',
            status: 'PENDING',
            message:
              responseData?.message ??
              'Allegro price change is still being processed',
          })

          continue
        }

    /*
         * Sikeresen kiment egy automatikus Commerce Hub ár.
         *
         * Ez nem külső Allegro-változás, ezért az új árat
         * automatikusan elfogadott állapotként tároljuk.
         *
         * Emellett minden ilyen ármozgás bekerül a tartós
         * árhistorikába is.
         */
        const [scheduledState] =
          await db
            .select({
              regularPriceMinor:
                listingDesiredStates
                  .regularPriceMinor,

              stockAvailable:
                listingRemoteStates
                  .stockAvailable,

              publicationStatus:
                listingRemoteStates
                  .publicationStatus,
            })
            .from(listingDesiredStates)
            .leftJoin(
              listingRemoteStates,
              eq(
                listingRemoteStates.listingId,
                listingDesiredStates.listingId,
              ),
            )
            .where(
              eq(
                listingDesiredStates.listingId,
                schedule.listingId,
              ),
            )
            .limit(1)

        if (!scheduledState) {
          throw new Error(
            `Desired state missing for scheduled listing ${schedule.listingId}`,
          )
        }

        const appliedPriceMinor =
          shouldStart
            ? schedule.promotionalPriceMinor
            : scheduledState.regularPriceMinor

        if (appliedPriceMinor === null) {
          throw new Error(
            `Applied price is missing for scheduled listing ${schedule.listingId}`,
          )
        }

        await db
          .insert(listingAcceptedStates)
          .values({
            listingId:
              schedule.listingId,

            acceptedPriceMinor:
              appliedPriceMinor,

            acceptedStockAvailable:
              scheduledState.stockAvailable,

            acceptedPublicationStatus:
              scheduledState
                .publicationStatus ??
              'UNKNOWN',

            acceptedAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target:
              listingAcceptedStates.listingId,

            set: {
              acceptedPriceMinor:
                appliedPriceMinor,

              acceptedAt: now,
              updatedAt: now,
            },
          })

        await db
          .insert(listingPriceHistory)
          .values({
            listingId:
              schedule.listingId,

            priceMinor:
              appliedPriceMinor,

            basePriceMinor:
              scheduledState.regularPriceMinor,

            priceType:
              shouldStart
                ? 'SCHEDULED_PROMOTION'
                : 'REGULAR',

            externalCampaignId: null,

            currency: 'HUF',

            source:
              'COMMERCE_HUB_SCHEDULE',

            observedAt: now,
          })
        if (shouldStart) {
          await db
            .update(listingPriceSchedules)
            .set({
              startAppliedAt: now,
              lastError: null,
              updatedAt: now,
            })
            .where(
              eq(
                listingPriceSchedules.id,
                schedule.id,
              ),
            )

          applied += 1

          results.push({
            scheduleId: schedule.id,
            listingId: schedule.listingId,
            action: 'START',
            status: 'APPLIED',
          })

          continue
        }

        await db
          .update(listingPriceSchedules)
          .set({
            endAppliedAt: now,
            lastError: null,
            updatedAt: now,
          })
          .where(
            eq(
              listingPriceSchedules.id,
              schedule.id,
            ),
          )

        applied += 1

        results.push({
          scheduleId: schedule.id,
          listingId: schedule.listingId,
          action: 'END',
          status: 'APPLIED',
        })
      }

      return context.json({
        status: 'ok',
        checked: schedules.length,
        applied,
        blocked,
        failed,
        skipped,
        processedAt: now.toISOString(),
        results,
      })
    } catch (error) {
      console.error(
        'Price schedule processing failed:',
        error,
      )

      return context.json(
        {
          status: 'error',
          message:
            'Could not process price schedules',
        },
        500,
      )
    }
  },
)


allegroAuth.post('/sync-selected', async (context) => {
  if (!currentSession) {
    return context.json(
      {
        status: 'error',
        message: 'Allegro account is not connected',
      },
      401,
    )
  }

  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database configuration is missing',
      },
      500,
    )
  }

  const body = (await context.req
    .json()
    .catch(() => null)) as
    | {
        listingIds?: unknown[]
      }
    | null

  if (
    !body ||
    !Array.isArray(body.listingIds)
  ) {
    return context.json(
      {
        status: 'error',
        message: 'listingIds must be an array',
      },
      400,
    )
  }

  const listingIds = [
    ...new Set(
      body.listingIds
        .filter(
          (value: unknown): value is string =>
            typeof value === 'string' &&
            value.trim().length > 0,
        )
        .map((value: string) => value.trim()),
    ),
  ]

  if (listingIds.length === 0) {
    return context.json(
      {
        status: 'error',
        message: 'No listings selected',
      },
      400,
    )
  }

  if (listingIds.length > 100) {
    return context.json(
      {
        status: 'error',
        message:
          'Maximum 100 listings can be synchronized at once',
      },
      400,
    )
  }

  const db = createDatabase(databaseUrl)

  const results: Array<Record<string, unknown>> = []

  let attempted = 0
  let succeeded = 0
  let skipped = 0
  let failed = 0
  let pending = 0
  const refreshOfferIds =
    new Set<string>()

  for (const listingId of listingIds) {
    const [row] = await db
      .select({
        listingId: platformListings.id,

        externalListingId:
          platformListings.externalListingId,

        priceMinor:
          listingRemoteStates.priceMinor,

        stockAvailable:
          listingRemoteStates.stockAvailable,

        publicationStatus:
          listingRemoteStates.publicationStatus,

        desiredPriceMinor:
          listingDesiredStates.regularPriceMinor,

        desiredStock:
          listingDesiredStates.desiredStock,

        desiredPublicationStatus:
          listingDesiredStates.desiredPublicationStatus,
      })
      .from(platformListings)
      .leftJoin(
        listingRemoteStates,
        eq(
          listingRemoteStates.listingId,
          platformListings.id,
        ),
      )
      .leftJoin(
        listingDesiredStates,
        eq(
          listingDesiredStates.listingId,
          platformListings.id,
        ),
      )
      .where(
        eq(
          platformListings.id,
          listingId,
        ),
      )
      .limit(1)

    if (!row) {
      failed += 1

      results.push({
        listingId,
        status: 'failed',
        message: 'Listing not found',
      })

      continue
    }

    const priceResolutionNow =
      new Date()

    const activeCampaignRowsForBulkPrice =
      await db
        .select({
          validFrom:
            listingCampaigns.validFrom,

          validTo:
            listingCampaigns.validTo,
        })
        .from(listingCampaigns)
        .where(
          and(
            eq(
              listingCampaigns.listingId,
              listingId,
            ),
            eq(
              listingCampaigns.campaignType,
              'DISCOUNT',
            ),
            eq(
              listingCampaigns.campaignStatus,
              'ACTIVE',
            ),
          ),
        )

    const hasActiveAllegroCampaignForBulkPrice =
      activeCampaignRowsForBulkPrice.some(
        (campaign) =>
          (
            !campaign.validFrom ||
            campaign.validFrom <=
              priceResolutionNow
          ) &&
          (
            !campaign.validTo ||
            campaign.validTo >=
              priceResolutionNow
          ),
      )

    const enabledSchedulesForBulkPrice =
      hasActiveAllegroCampaignForBulkPrice
        ? []
        : await db
            .select({
              promotionalPriceMinor:
                listingPriceSchedules
                  .promotionalPriceMinor,

              validFrom:
                listingPriceSchedules.validFrom,

              validTo:
                listingPriceSchedules.validTo,
            })
            .from(listingPriceSchedules)
            .where(
              and(
                eq(
                  listingPriceSchedules.listingId,
                  listingId,
                ),
                eq(
                  listingPriceSchedules.enabled,
                  true,
                ),
              ),
            )

    const activeScheduleForBulkPrice =
      enabledSchedulesForBulkPrice
        .filter(
          (schedule) =>
            schedule.validFrom <=
              priceResolutionNow &&
            schedule.validTo >=
              priceResolutionNow,
        )
        .sort(
          (left, right) =>
            right.validFrom.getTime() -
            left.validFrom.getTime(),
        )[0] ?? null

    const effectiveDesiredPriceMinorForBulk =
      hasActiveAllegroCampaignForBulkPrice
        ? row.priceMinor
        : activeScheduleForBulkPrice
          ? activeScheduleForBulkPrice
              .promotionalPriceMinor
          : row.desiredPriceMinor

    const priceChanged =
      effectiveDesiredPriceMinorForBulk !== null &&
      row.priceMinor !==
        effectiveDesiredPriceMinorForBulk

    const isIntentionallyInactive =
      row.desiredPublicationStatus === 'INACTIVE' &&
      (
        row.publicationStatus === 'INACTIVE' ||
        row.publicationStatus === 'ENDED'
      )

    const stockChanged =
      !isIntentionallyInactive &&
      row.desiredStock !== null &&
      row.stockAvailable !== row.desiredStock

    const publicationChanged =
      row.desiredPublicationStatus === 'ACTIVE'
        ? row.publicationStatus !== 'ACTIVE' &&
          row.publicationStatus !== 'ACTIVATING'
        : row.desiredPublicationStatus === 'INACTIVE'
          ? row.publicationStatus !== 'INACTIVE' &&
            row.publicationStatus !== 'ENDED'
          : false

    if (
      !priceChanged &&
      !stockChanged &&
      !publicationChanged
    ) {
      skipped += 1

      results.push({
        listingId,
        status: 'skipped',
        price: 'not-needed',
        stock: 'not-needed',
        publication: 'not-needed',
      })

      continue
    }

    attempted += 1

    let priceStatus:
      | 'not-needed'
      | 'success'
      | 'pending'
      | 'failed' = 'not-needed'

    let stockStatus:
      | 'not-needed'
      | 'success'
      | 'pending'
      | 'failed' = 'not-needed'

    let publicationStatus:
      | 'not-needed'
      | 'success'
      | 'pending'
      | 'failed' = 'not-needed'

    let priceDetails: unknown = null
    let stockDetails: unknown = null
    let publicationDetails: unknown = null

    if (priceChanged) {
      const response =
        await allegroAuth.request(
          `/push-price/${encodeURIComponent(
            listingId,
          )}`,
          {
            method: 'POST',
          },
        )

      priceDetails = await response
        .json()
        .catch(() => null)

      if (!response.ok) {
        priceStatus = 'failed'
      } else if (response.status === 202) {
        priceStatus = 'pending'
      } else {
        priceStatus = 'success'
      }
    }

    if (stockChanged) {
      const response =
        await allegroAuth.request(
          `/push-stock/${encodeURIComponent(
            listingId,
          )}`,
          {
            method: 'POST',
          },
        )

      stockDetails = await response
        .json()
        .catch(() => null)

      if (!response.ok) {
        stockStatus = 'failed'
      } else if (response.status === 202) {
        stockStatus = 'pending'
      } else {
        stockStatus = 'success'
      }
    }

    if (publicationChanged) {
      const response =
        await allegroAuth.request(
          `/push-status/${encodeURIComponent(
            listingId,
          )}`,
          {
            method: 'POST',
          },
        )

      publicationDetails = await response
        .json()
        .catch(() => null)

      if (!response.ok) {
        publicationStatus = 'failed'
      } else if (response.status === 202) {
        publicationStatus = 'pending'
      } else {
        publicationStatus = 'success'
      }
    }

    const hasFailure =
      priceStatus === 'failed' ||
      stockStatus === 'failed' ||
      publicationStatus === 'failed'

    const hasPending =
      priceStatus === 'pending' ||
      stockStatus === 'pending' ||
      publicationStatus === 'pending'

    if (hasFailure) {
      failed += 1
    } else if (hasPending) {
      pending += 1
    } else {
      succeeded += 1
    }

    const hasWriteResult =
      priceStatus === 'success' ||
      priceStatus === 'pending' ||
      stockStatus === 'success' ||
      stockStatus === 'pending' ||
      publicationStatus === 'success' ||
      publicationStatus === 'pending'

    if (
      hasWriteResult &&
      row.externalListingId
    ) {
      refreshOfferIds.add(
        row.externalListingId,
      )
    }

    results.push({
      listingId,
      status: hasFailure
        ? 'failed'
        : hasPending
          ? 'pending'
          : 'success',
      price: priceStatus,
      stock: stockStatus,
      publication: publicationStatus,
      priceDetails,
      stockDetails,
      publicationDetails,
    })
  }

  let refreshStatus:
    | 'not-needed'
    | 'success'
    | 'failed' = 'not-needed'

  let refreshDetails: unknown = null

  if (refreshOfferIds.size > 0) {
    const offerIds =
      [...refreshOfferIds]

    const refreshBatches:
      string[][] = []

    for (
      let index = 0;
      index < offerIds.length;
      index += 10
    ) {
      refreshBatches.push(
        offerIds.slice(
          index,
          index + 10,
        ),
      )
    }

    const batchResults: Array<{
      offerIds: string[]
      ok: boolean
      status: number
      details: unknown
    }> = []

    for (const batch of refreshBatches) {
      const refreshResponse =
        await allegroAuth.request(
          '/sync',
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              offerIds: batch,
            }),
          },
        )

      const details =
        await refreshResponse
          .json()
          .catch(() => null)

      batchResults.push({
        offerIds: batch,
        ok: refreshResponse.ok,
        status: refreshResponse.status,
        details,
      })
    }

    refreshStatus =
      batchResults.every(
        (batch) => batch.ok,
      )
        ? 'success'
        : 'failed'

    refreshDetails = {
      refreshedOffers:
        offerIds.length,
      batchCount:
        refreshBatches.length,
      batches:
        batchResults,
    }
  }

  return context.json({
    status: failed > 0
      ? 'partial'
      : pending > 0
        ? 'pending'
        : 'ok',

    selected: listingIds.length,
    attempted,
    succeeded,
    skipped,
    failed,
    pending,

    refreshStatus,
    refreshDetails,

    results,
  })
})
