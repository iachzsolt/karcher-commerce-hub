import type { Context, MiddlewareHandler } from 'hono'
import {
  createRemoteJWKSet,
  jwtVerify,
} from 'jose'

export type CommerceHubRole =
  | 'VIEWER'
  | 'ADMIN'

export type CommerceHubUser = {
  email: string
  role: CommerceHubRole
  subject: string | null
}

export type AccessVariables = {
  commerceHubUser: CommerceHubUser
}

type AuthProvider = 'cloudflare' | 'google'

type AuthConfiguration = {
  provider: AuthProvider
  issuer: string | string[]
  audience: string
  jwksUrl: URL
  adminEmails: Set<string>
  allowedEmails: Set<string>
}

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/allegro/callback',
  '/arukereso/pricing/sync',
])

let cachedJwksUrl: string | null = null
let cachedJwks:
  | ReturnType<typeof createRemoteJWKSet>
  | null = null

function parseEmailSet(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )
}

function normalizeIssuer(value: string) {
  const withProtocol = /^https?:\/\//i.test(value)
    ? value
    : `https://${value}`
  const url = new URL(withProtocol)

  if (url.protocol !== 'https:') {
    throw new Error(
      'COMMERCE_HUB_ACCESS_TEAM_DOMAIN must use HTTPS',
    )
  }

  return url.origin
}

function getConfiguredProvider(): AuthProvider | null {
  const configured =
    process.env.COMMERCE_HUB_AUTH_PROVIDER
      ?.trim()
      .toLowerCase()

  if (configured) {
    if (
      configured !== 'cloudflare' &&
      configured !== 'google'
    ) {
      throw new Error(
        'COMMERCE_HUB_AUTH_PROVIDER must be cloudflare or google',
      )
    }

    return configured
  }

  if (
    process.env.COMMERCE_HUB_ACCESS_TEAM_DOMAIN?.trim() &&
    process.env.COMMERCE_HUB_ACCESS_AUDIENCE?.trim()
  ) {
    return 'cloudflare'
  }

  if (process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()) {
    return 'google'
  }

  return null
}

function getAuthConfiguration(): AuthConfiguration | null {
  const provider = getConfiguredProvider()

  if (!provider) return null

  const adminEmails = parseEmailSet(
    process.env.COMMERCE_HUB_ADMIN_EMAILS,
  )
  const allowedEmails = parseEmailSet(
    process.env.COMMERCE_HUB_ALLOWED_EMAILS,
  )

  if (provider === 'google') {
    const audience =
      process.env.GOOGLE_OAUTH_CLIENT_ID?.trim()

    if (!audience) return null

    return {
      provider,
      issuer: [
        'https://accounts.google.com',
        'accounts.google.com',
      ],
      audience,
      jwksUrl: new URL(
        'https://www.googleapis.com/oauth2/v3/certs',
      ),
      adminEmails,
      allowedEmails,
    }
  }

  const teamDomain =
    process.env.COMMERCE_HUB_ACCESS_TEAM_DOMAIN?.trim()
  const audience =
    process.env.COMMERCE_HUB_ACCESS_AUDIENCE?.trim()

  if (!teamDomain || !audience) return null

  const issuer = normalizeIssuer(teamDomain)

  return {
    provider,
    issuer,
    audience,
    jwksUrl: new URL('/cdn-cgi/access/certs', issuer),
    adminEmails,
    allowedEmails,
  }
}

function getJwks(jwksUrl: URL) {
  const url = jwksUrl.toString()

  if (!cachedJwks || cachedJwksUrl !== url) {
    cachedJwksUrl = url
    cachedJwks = createRemoteJWKSet(jwksUrl)
  }

  return cachedJwks
}

export function assertAccessConfiguration() {
  if (process.env.NODE_ENV !== 'production') return

  const configuration = getAuthConfiguration()

  if (!configuration) {
    throw new Error(
      'Commerce Hub authentication configuration is required in production',
    )
  }

  if (
    configuration.allowedEmails.size === 0 &&
    configuration.adminEmails.size === 0
  ) {
    throw new Error(
      'At least one allowed or administrator email is required in production',
    )
  }
}

export function getCommerceHubUser(
  context: Context,
) {
  return context.get(
    'commerceHubUser' as never,
  ) as CommerceHubUser | undefined
}

function getAssertion(
  context: Context,
  provider: AuthProvider,
) {
  if (provider === 'cloudflare') {
    return context.req.header(
      'Cf-Access-Jwt-Assertion',
    )
  }

  const authorization =
    context.req.header('Authorization')?.trim()
  const match = authorization?.match(/^Bearer\s+(.+)$/i)

  return match?.[1]?.trim() || null
}

export const accessAuthMiddleware:
  MiddlewareHandler<{
    Variables: AccessVariables
  }> = async (context, next) => {
    if (
      context.req.method === 'OPTIONS' ||
      PUBLIC_PATHS.has(context.req.path)
    ) {
      await next()
      return
    }

    const configuration = getAuthConfiguration()

    if (!configuration) {
      if (process.env.NODE_ENV === 'production') {
        return context.json(
          {
            status: 'error',
            message:
              'Commerce Hub authentication is not configured',
          },
          503,
        )
      }

      context.set('commerceHubUser', {
        email:
          'local-development@commerce-hub.invalid',
        role: 'ADMIN',
        subject: null,
      })

      await next()
      return
    }

    const assertion = getAssertion(
      context,
      configuration.provider,
    )

    if (!assertion) {
      return context.json(
        {
          status: 'error',
          message: 'Authentication is required',
        },
        401,
      )
    }

    let payload

    try {
      const verification = await jwtVerify(
        assertion,
        getJwks(configuration.jwksUrl),
        {
          issuer: configuration.issuer,
          audience: configuration.audience,
        },
      )

      payload = verification.payload
    } catch (error) {
      console.warn(
        'Commerce Hub token verification failed:',
        error instanceof Error
          ? error.message
          : 'Unknown verification error',
      )

      return context.json(
        {
          status: 'error',
          message: 'Authentication is invalid or expired',
        },
        401,
      )
    }

    if (
      configuration.provider === 'google' &&
      payload.email_verified !== true
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'The Google account email address is not verified',
        },
        403,
      )
    }

    const email =
      typeof payload.email === 'string'
        ? payload.email.trim().toLowerCase()
        : null

    if (!email) {
      return context.json(
        {
          status: 'error',
          message:
            'The authenticated account has no email address',
        },
        403,
      )
    }

    if (
      !configuration.allowedEmails.has(email) &&
      !configuration.adminEmails.has(email)
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'This account is not allowed to use Commerce Hub',
        },
        403,
      )
    }

    const role: CommerceHubRole =
      configuration.adminEmails.has(email)
        ? 'ADMIN'
        : 'VIEWER'

    context.set('commerceHubUser', {
      email,
      role,
      subject:
        typeof payload.sub === 'string'
          ? payload.sub
          : null,
    })

    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(
        context.req.method,
      ) &&
      role !== 'ADMIN'
    ) {
      return context.json(
        {
          status: 'error',
          message:
            'Administrator permission is required for changes',
        },
        403,
      )
    }

    await next()
  }
