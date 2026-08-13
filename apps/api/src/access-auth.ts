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

type AccessConfiguration = {
  issuer: string
  audience: string
  adminEmails: Set<string>
  allowedEmails: Set<string>
}

const PUBLIC_PATHS = new Set(['/health'])

let cachedIssuer: string | null = null
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

function getAccessConfiguration(): AccessConfiguration | null {
  const teamDomain =
    process.env.COMMERCE_HUB_ACCESS_TEAM_DOMAIN?.trim()
  const audience =
    process.env.COMMERCE_HUB_ACCESS_AUDIENCE?.trim()

  if (!teamDomain || !audience) return null

  return {
    issuer: normalizeIssuer(teamDomain),
    audience,
    adminEmails: parseEmailSet(
      process.env.COMMERCE_HUB_ADMIN_EMAILS,
    ),
    allowedEmails: parseEmailSet(
      process.env.COMMERCE_HUB_ALLOWED_EMAILS,
    ),
  }
}

function getJwks(issuer: string) {
  if (!cachedJwks || cachedIssuer !== issuer) {
    cachedIssuer = issuer
    cachedJwks = createRemoteJWKSet(
      new URL('/cdn-cgi/access/certs', issuer),
    )
  }

  return cachedJwks
}

export function assertAccessConfiguration() {
  if (
    process.env.NODE_ENV === 'production' &&
    !getAccessConfiguration()
  ) {
    throw new Error(
      'Cloudflare Access configuration is required in production',
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

    const configuration = getAccessConfiguration()

    if (!configuration) {
      if (process.env.NODE_ENV === 'production') {
        return context.json(
          {
            status: 'error',
            message:
              'Cloudflare Access is not configured',
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

    const assertion = context.req.header(
      'Cf-Access-Jwt-Assertion',
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
        getJwks(configuration.issuer),
        {
          issuer: configuration.issuer,
          audience: configuration.audience,
        },
      )

      payload = verification.payload
    } catch (error) {
      console.warn(
        'Cloudflare Access token verification failed:',
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
      configuration.allowedEmails.size > 0 &&
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
