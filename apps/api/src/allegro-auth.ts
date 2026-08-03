import { createHash, randomBytes } from 'node:crypto'
import { Hono } from 'hono'

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
  account: AllegroAccount
}

const pendingAuthorizations = new Map<
  string,
  PendingAuthorization
>()

let currentSession: AllegroSession | null = null

const SESSION_TTL_MS = 10 * 60 * 1000

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

  currentSession = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt:
      Date.now() + tokenData.expires_in * 1000,
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