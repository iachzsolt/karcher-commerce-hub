interface Env {
  COMMERCE_HUB_API_ORIGIN: string
}

const ACCESS_ASSERTION_HEADER =
  'Cf-Access-Jwt-Assertion'

const SAFE_METHODS = new Set([
  'GET',
  'HEAD',
  'OPTIONS',
])

function errorResponse(
  status: number,
  message: string,
) {
  return Response.json(
    {
      status: 'error',
      message,
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )
}

function getApiOrigin(value: string | undefined) {
  if (!value?.trim()) return null

  try {
    const url = new URL(value.trim())

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }

    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`

    return url
  } catch {
    return null
  }
}

function getProxyPath(
  value: string | string[] | undefined,
) {
  const segments = Array.isArray(value)
    ? value
    : value
      ? [value]
      : []

  return segments
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

export const onRequest:
  PagesFunction<Env, 'path'> = async (context) => {
    const assertion = context.request.headers.get(
      ACCESS_ASSERTION_HEADER,
    )

    if (!assertion) {
      return errorResponse(
        401,
        'Cloudflare Access authentication is required',
      )
    }

    const requestUrl = new URL(context.request.url)

    if (!SAFE_METHODS.has(context.request.method)) {
      const requestOrigin =
        context.request.headers.get('Origin')

      if (requestOrigin !== requestUrl.origin) {
        return errorResponse(
          403,
          'Cross-origin changes are not allowed',
        )
      }
    }

    const apiOrigin = getApiOrigin(
      context.env.COMMERCE_HUB_API_ORIGIN,
    )

    if (!apiOrigin) {
      return errorResponse(
        503,
        'Commerce Hub API origin is not configured',
      )
    }

    const proxyPath = getProxyPath(
      context.params.path,
    )
    const targetUrl = new URL(proxyPath, apiOrigin)
    targetUrl.search = requestUrl.search

    const headers = new Headers(
      context.request.headers,
    )

    headers.delete('Host')
    headers.delete('Content-Length')
    headers.set('X-Forwarded-Host', requestUrl.host)
    headers.set('X-Forwarded-Proto', 'https')

    let response: Response

    try {
      response = await fetch(targetUrl, {
        method: context.request.method,
        headers,
        body: SAFE_METHODS.has(context.request.method)
          ? undefined
          : context.request.body,
        redirect: 'manual',
      })
    } catch (error) {
      console.error(
        'Commerce Hub API proxy failed:',
        error,
      )

      return errorResponse(
        502,
        'Commerce Hub API is unavailable',
      )
    }

    const responseHeaders = new Headers(
      response.headers,
    )
    responseHeaders.set('Cache-Control', 'no-store')

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    })
  }
