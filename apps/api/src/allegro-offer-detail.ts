/**
 * Allegro product-offer detail lookups and upstream error mapping.
 *
 * Pure and injectable: the HTTP call is passed in, so the classification
 * rules are testable without the Allegro API or a session.
 */
import {
  boundedResponseText,
  sanitizeAllegroErrorList,
  type AllegroTaskError,
} from './allegro-remote-verification.js'

/**
 * Outcome of `GET /sale/product-offers/{offerId}`.
 *
 * Only an explicit HTTP 404 is NOT_FOUND. Authentication failures, rate
 * limits, timeouts, transport errors, 5xx and unreadable bodies are
 * UNAVAILABLE: they say nothing about whether the offer exists.
 */
export type OfferDetailLookup =
  | { kind: 'FOUND'; publicationStatus: string | undefined }
  | { kind: 'NOT_FOUND'; httpStatus: 404 }
  | {
      kind: 'UNAVAILABLE'
      httpStatus: number | null
      failure: 'AUTH' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'REQUEST_FAILED' | 'INVALID_RESPONSE'
    }

function isTimeout(error: unknown) {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : null
  return name === 'TimeoutError' || name === 'AbortError'
}

export async function lookupOfferDetail(
  fetchDetail: () => Promise<Response>,
): Promise<OfferDetailLookup> {
  let response: Response

  try {
    response = await fetchDetail()
  } catch (error) {
    return { kind: 'UNAVAILABLE', httpStatus: null, failure: isTimeout(error) ? 'TIMEOUT' : 'REQUEST_FAILED' }
  }

  if (response.status === 404) return { kind: 'NOT_FOUND', httpStatus: 404 }

  if (!response.ok) {
    return {
      kind: 'UNAVAILABLE',
      httpStatus: response.status,
      failure: response.status === 401 || response.status === 403
        ? 'AUTH'
        : response.status === 429
          ? 'RATE_LIMITED'
          : 'UPSTREAM_ERROR',
    }
  }

  try {
    const detail = await response.json() as { publication?: { status?: string } } | null
    return { kind: 'FOUND', publicationStatus: detail?.publication?.status }
  } catch (error) {
    return {
      kind: 'UNAVAILABLE',
      httpStatus: response.status,
      failure: isTimeout(error) ? 'TIMEOUT' : 'INVALID_RESPONSE',
    }
  }
}

/* ------------------------------------------------------------------ *
 * offer-debug upstream error mapping
 * ------------------------------------------------------------------ */

const RETRY_AFTER_SECONDS = /^\d{1,6}$/

/** Accept only delta-seconds or a parseable HTTP date; never echo arbitrary header text. */
export function sanitizeRetryAfter(value: string | null): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed || trimmed.length > 64) return null
  if (RETRY_AFTER_SECONDS.test(trimmed)) return trimmed
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null
}

function parseErrors(bodyText: string): AllegroTaskError[] {
  try {
    const parsed = JSON.parse(bodyText) as { errors?: unknown }
    return sanitizeAllegroErrorList(parsed?.errors)
  } catch {
    return []
  }
}

export type OfferDebugErrorResponse = {
  status: 404 | 429 | 502
  retryAfter: string | null
  body: {
    status: 'error'
    error: 'OFFER_NOT_FOUND' | 'RATE_LIMITED' | 'UPSTREAM_ERROR'
    offerId: string
    upstreamStatus: number
    /** Kept for existing readers; same value as upstreamStatus. */
    allegroStatus: number
    allegroErrors: AllegroTaskError[]
    /** Kept for existing readers; bounded upstream body text. */
    body: string
  }
}

/**
 * Map a non-2xx Allegro product-offer response for `offer-debug`.
 *
 * 404 and 429 keep their meaning; any other upstream failure is a 502
 * with the original upstream status. Only the documented error fields of
 * the body are structured; no upstream header except a validated
 * Retry-After is forwarded.
 */
export function offerDebugUpstreamError(input: {
  offerId: string
  upstreamStatus: number
  retryAfter: string | null
  bodyText: string
}): OfferDebugErrorResponse {
  const status = input.upstreamStatus === 404 ? 404 : input.upstreamStatus === 429 ? 429 : 502

  return {
    status,
    retryAfter: status === 429 ? sanitizeRetryAfter(input.retryAfter) : null,
    body: {
      status: 'error',
      error: status === 404 ? 'OFFER_NOT_FOUND' : status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
      offerId: input.offerId,
      upstreamStatus: input.upstreamStatus,
      allegroStatus: input.upstreamStatus,
      allegroErrors: parseErrors(input.bodyText),
      body: boundedResponseText(input.bodyText),
    },
  }
}
