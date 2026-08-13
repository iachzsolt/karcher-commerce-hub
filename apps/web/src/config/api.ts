const DEFAULT_API_BASE_URL = 'http://localhost:3000'

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL?.trim() ||
  DEFAULT_API_BASE_URL
).replace(/\/+$/, '')

let apiBearerToken: string | null = null

const AUTHENTICATION_ERROR_MESSAGES = new Set([
  'Commerce Hub authentication is required',
  'Authentication is required',
  'Authentication is invalid or expired',
])

export function setApiBearerToken(
  token: string | null,
) {
  apiBearerToken = token
}

function isApiRequest(input: RequestInfo | URL) {
  if (typeof window === 'undefined') return false

  const value =
    input instanceof Request ? input.url : input.toString()
  const requestUrl = new URL(value, window.location.href)
  const apiUrl = new URL(
    `${API_BASE_URL}/`,
    window.location.href,
  )

  return (
    requestUrl.origin === apiUrl.origin &&
    requestUrl.pathname.startsWith(apiUrl.pathname)
  )
}

if (typeof window !== 'undefined') {
  const nativeFetch = window.fetch.bind(window)

  window.fetch = async (input, init) => {
    const isApi = isApiRequest(input)

    if (!isApi) {
      return nativeFetch(input, init)
    }

    const headers = new Headers(
      input instanceof Request
        ? input.headers
        : undefined,
    )

    if (init?.headers) {
      new Headers(init.headers).forEach(
        (value, key) => headers.set(key, value),
      )
    }

    if (apiBearerToken) {
      headers.set(
        'Authorization',
        `Bearer ${apiBearerToken}`,
      )
    }

    const response = await nativeFetch(input, {
      ...init,
      headers,
    })

    if (
      apiBearerToken &&
      response.status === 401
    ) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as
        | { message?: unknown }
        | null

      if (
        typeof body?.message === 'string' &&
        AUTHENTICATION_ERROR_MESSAGES.has(body.message)
      ) {
        window.dispatchEvent(
          new Event('commerce-hub:auth-required'),
        )
      }
    }

    return response
  }
}
