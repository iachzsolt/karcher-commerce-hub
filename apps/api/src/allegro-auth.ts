import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { decryptSecret, encryptSecret } from './token-crypto.js'
import {
  createDatabase,
  listingDesiredStates,
  listingRemoteStates,
  platformAccountCredentials,
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
      const response = await fetch(tokenUrl, {
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

  const tokenResponse = await fetch(tokenUrl, {
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

  const profileResponse = await fetch(
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
    (process.env.ALLEGRO_ENV ?? 'SANDBOX').toUpperCase()

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
    account,
  }

  return context.json({
    status: 'ok',
    message: 'Allegro Sandbox connected successfully',
    environment: process.env.ALLEGRO_ENV,
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

  const response = await fetch(
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

  const response = await fetch(
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

  const response = await fetch(
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

  const response = await fetch(
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

  const response = await fetch(
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

  const response = await fetch(
    `${apiUrl}/sale/offers?limit=20`,
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

  const response = await fetch(
    `${apiUrl}/sale/offers?limit=100`,
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
    return context.json(
      {
        status: 'error',
        message:
          'Failed to check Allegro offers',
        httpStatus: response.status,
      },
      502,
    )
  }

  const data = JSON.parse(body) as {
    offers?: Array<{
      id: string
      name?: string
      external?: {
        id?: string | null
      }
      additionalMarketplaces?: Record<
        string,
        unknown
      >
    }>
  }

  const issues: Array<{
    offerId: string
    name: string
    issue:
      | 'MISSING_HU_MARKETPLACE'
      | 'MISSING_SKU'
  }> = []

  for (const offer of data.offers ?? []) {
    const huMarketplace =
      offer.additionalMarketplaces?.[
        'allegro-hu'
      ]

    if (!huMarketplace) {
      issues.push({
        offerId: offer.id,
        name:
          offer.name ??
          'Névtelen Allegro-ajánlat',
        issue: 'MISSING_HU_MARKETPLACE',
      })

      continue
    }

    const sku = offer.external?.id?.trim()

    if (!sku) {
      issues.push({
        offerId: offer.id,
        name:
          offer.name ??
          'Névtelen Allegro-ajánlat',
        issue: 'MISSING_SKU',
      })
    }
  }

  return context.json({
    status: 'ok',
    count: issues.length,
    data: issues,
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

type AllegroOfferForSync = {
  id: string
  name: string

  category?: {
    id?: string
  }

  external?: {
    id?: string | null
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

  if (!databaseUrl || !apiUrl) {
    return context.json(
      {
        status: 'error',
        message: 'Database or Allegro API configuration is missing',
      },
      500,
    )
  }

  const offersResponse = await fetch(
    `${apiUrl}/sale/offers?limit=100`,
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
    const errorBody = await offersResponse.text()

    console.error(
      'Allegro offers sync request failed:',
      offersResponse.status,
      errorBody,
    )

    return context.json(
      {
        status: 'error',
        message: 'Could not load Allegro offers',
        httpStatus: offersResponse.status,
      },
      500,
    )
  }

  const data =
    (await offersResponse.json()) as AllegroOffersForSyncResponse

  const db = createDatabase(databaseUrl)
  const now = new Date()

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
    (process.env.ALLEGRO_ENV ?? 'SANDBOX').toUpperCase()

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

  for (const offer of data.offers ?? []) {
    const huState =
      offer.additionalMarketplaces?.['allegro-hu']

    if (!huState) {
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

    const priceMinor = priceToMinor(
      huState.sellingMode?.price?.amount,
    )

    const currency =
      huState.sellingMode?.price?.currency ?? 'HUF'

    const publicationStatus =
      normalizeAllegroListingStatus(
        offer.publication?.status,
      )

    const stockAvailable =
      offer.stock?.available ?? null

    const stockSold =
      huState.stock?.sold ??
      offer.stock?.sold ??
      null

    const priceAutomation =
      huState.sellingMode?.priceAutomation

    const priceAutomationRuleId =
      priceAutomation?.rule?.id ??
      priceAutomation?.id ??
      null

    const priceAutomationRuleType =
      priceAutomation?.rule?.type ??
      priceAutomation?.type ??
      null

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

    await db
      .insert(listingDesiredStates)
      .values({
        listingId: listing.id,

        listPriceMinor: priceMinor,
        regularPriceMinor: priceMinor,

        desiredStock: stockAvailable,

        desiredPublicationStatus:
          publicationStatus,

        priceLocked: false,
        stockLocked: false,

        autoPriceSync: false,
        autoStockSync: false,

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

  const desiredPrice =
    row.desiredPriceMinor / 100

  const commandId = randomUUID()

  const commandResponse = await fetch(
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

  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500)

    const taskResponse = await fetch(
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

  const commandResponse = await fetch(
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

  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(500)

    const taskResponse = await fetch(
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

    if (task.status === 'FAILED') {
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

  const commandResponse = await fetch(
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

    const taskResponse = await fetch(
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

    if (task.status === 'FAILED') {
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

  for (const listingId of listingIds) {
    const [row] = await db
      .select({
        listingId: platformListings.id,

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

    const priceChanged =
      row.desiredPriceMinor !== null &&
      row.priceMinor !== row.desiredPriceMinor

    const stockChanged =
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

  if (attempted > 0) {
    const refreshResponse =
      await allegroAuth.request(
        '/sync',
        {
          method: 'POST',
        },
      )

    refreshDetails = await refreshResponse
      .json()
      .catch(() => null)

    refreshStatus = refreshResponse.ok
      ? 'success'
      : 'failed'
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