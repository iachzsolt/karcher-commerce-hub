import {
  createDatabase,
  products,
} from '@karcher-commerce-hub/database'
import { Hono } from 'hono'

export const arukeresoPerformanceApi = new Hono()

const databaseUrl = process.env.DATABASE_URL

const db = databaseUrl
  ? createDatabase(databaseUrl)
  : null

function requireDatabase() {
  if (!db) {
    throw new Error(
      'DATABASE_URL is not configured.',
    )
  }

  return db
}

const HEUREKA_API_BASE_URL =
  'https://api.heureka.group/v1/reports/conversions'
const HEUREKA_API_KEY_ENV = 'ARUKERESO_REPORTS_API_KEY'
const HEUREKA_FETCH_TIMEOUT_MS = 30_000
const HEUREKA_FETCH_ATTEMPTS = 3
const HEUREKA_FETCH_BACKOFF_MS = [1000, 2000, 4000]

/* ============================================================
   Pure helpers (exported for focused tests)
   ============================================================ */

// Trailing "(11002400)" product code from the API name.
export function extractProductCode(
  name: unknown,
): string | null {
  if (typeof name !== 'string') {
    return null
  }

  const match = /\((\d+)\)\s*$/.exec(
    name.trim(),
  )

  return match?.[1] ?? null
}

// "1.100-240.0" -> "11002400" to match the API code.
export function normalizeHubSku(
  sku: string,
): string {
  return sku.replace(/\D/g, '')
}

function toFiniteNumber(value: unknown): number {
  const parsed =
    typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : typeof value === 'number'
        ? value
        : NaN

  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : 0
}

export function isValidDateParam(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
}

function budapestToday(): string {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(new Date())
  const value = (type: string) =>
    parts.find((part) => part.type === type)
      ?.value ?? ''

  return `${value('year')}-${value('month')}-${value('day')}`
}

// Heureka reports cover completed billing days only,
// so today (and any future day) is never fetchable.
export function isCompletedDay(
  date: string,
  todayDay: string,
): boolean {
  return date < todayDay
}

export type NormalizedHeurekaRow = {
  code: string | null
  productCardId: string
  sourceProductName: string | null
  clickSource: string
  onBiddedPosition: string | null
  currency: string | null
  visits: number
  costGross: number
  costNet: number
  orders: number
  revenue: number
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string'
    ? value
    : ''
}

function pickCurrency(
  raw: Record<string, unknown>,
): string | null {
  for (const key of ['currency', 'currencyCode']) {
    if (
      typeof raw[key] === 'string' &&
      (raw[key] as string).trim() !== ''
    ) {
      return (raw[key] as string).trim()
    }
  }

  for (const key of [
    'costs_with_vat',
    'costs_without_vat',
    'revenue',
  ]) {
    const group = raw[key]

    if (
      group !== null &&
      typeof group === 'object' &&
      !Array.isArray(group) &&
      typeof (group as Record<string, unknown>)[
        'currency'
      ] === 'string'
    ) {
      return (
        (group as Record<string, unknown>)[
          'currency'
        ] as string
      ).trim()
    }
  }

  return null
}

function groupTotal(
  group: unknown,
  key: 'total',
): number {
  if (
    group === null ||
    typeof group !== 'object' ||
    Array.isArray(group)
  ) {
    return 0
  }

  return toFiniteNumber(
    (group as Record<string, unknown>)[key],
  )
}

// Normalizes one raw API conversion row. Never throws
// for malformed rows; unparseable metrics become 0.
export function normalizeHeurekaRow(
  raw: unknown,
): NormalizedHeurekaRow {
  const row =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {}
  const shopItem = row['shop_item']

  const shopItemRecord =
    shopItem !== null &&
    typeof shopItem === 'object' &&
    !Array.isArray(shopItem)
      ? (shopItem as Record<string, unknown>)
      : {}
  const name =
    typeof shopItemRecord['name'] === 'string'
      ? shopItemRecord['name']
      : null

  return {
    code: extractProductCode(name),
    productCardId: textOrEmpty(
      row['product_card_id'],
    ),
    sourceProductName: name,
    clickSource: textOrEmpty(row['click_source']),
    onBiddedPosition:
      row['on_bidded_position'] === null ||
      row['on_bidded_position'] === undefined
        ? null
        : String(row['on_bidded_position']),
    currency: pickCurrency(row),
    visits: groupTotal(row['visits'], 'total'),
    costGross: groupTotal(
      row['costs_with_vat'],
      'total',
    ),
    costNet: groupTotal(
      row['costs_without_vat'],
      'total',
    ),
    orders: groupTotal(row['orders'], 'total'),
    revenue: groupTotal(row['revenue'], 'total'),
  }
}

export function matchProductCode(
  code: string | null,
  productByCode: Map<string, string>,
): string | null {
  if (code === null) {
    return null
  }

  return productByCode.get(code) ?? null
}

type FetchImpl = (
  url: string,
  init: RequestInit,
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

// Bounded retry for temporary upstream failures
// (network errors, HTTP 5xx such as 521). Client
// errors (4xx) never retry.
export async function fetchWithRetry(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
  attempts: number = HEUREKA_FETCH_ATTEMPTS,
): Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}> {
  let lastError: unknown = null

  for (
    let attempt = 0;
    attempt < attempts;
    attempt += 1
  ) {
    try {
      const response = await fetchImpl(url, init)

      if (
        response.ok ||
        (response.status >= 400 && response.status < 500)
      ) {
        return response
      }

      lastError = new Error(
        `Heureka API responded with HTTP ${response.status}`,
      )
    } catch (error) {
      lastError = error
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          HEUREKA_FETCH_BACKOFF_MS[
            Math.min(
              attempt,
              HEUREKA_FETCH_BACKOFF_MS.length - 1,
            )
          ] ?? 1000,
        ),
      )
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Heureka API request failed.')
}

function getHeurekaApiKey(): string | null {
  const key = process.env[HEUREKA_API_KEY_ENV]?.trim()

  return key ? key : null
}

export type HeurekaDayRow = NormalizedHeurekaRow & {
  productId: string | null
  sku: string | null
  productName: string | null
  matchStatus: 'MATCHED' | 'UNMATCHED'
}

export type HubProductRef = {
  id: string
  sku: string
  name: string
}

export function enrichHeurekaRows(
  rows: NormalizedHeurekaRow[],
  hubProducts: HubProductRef[],
): HeurekaDayRow[] {
  const productByCode = new Map<
    string,
    { id: string; sku: string; name: string }
  >()

  for (const product of hubProducts) {
    const code = normalizeHubSku(product.sku)

    if (code !== '' && !productByCode.has(code)) {
      productByCode.set(code, {
        id: product.id,
        sku: product.sku,
        name: product.name,
      })
    }
  }

  return rows.map((row) => {
    const product =
      row.code !== null
        ? (productByCode.get(row.code) ?? null)
        : null

    return {
      ...row,
      productId: product?.id ?? null,
      sku: product?.sku ?? null,
      productName: product?.name ?? null,
      matchStatus:
        product !== null
          ? ('MATCHED' as const)
          : ('UNMATCHED' as const),
    }
  })
}

async function fetchHeurekaDayRows(
  date: string,
  apiKey: string,
  fetchImpl: FetchImpl = fetch,
): Promise<NormalizedHeurekaRow[]> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort()
  }, HEUREKA_FETCH_TIMEOUT_MS)

  try {
    const response = await fetchWithRetry(
      fetchImpl,
      `${HEUREKA_API_BASE_URL}?date=${date}`,
      {
        headers: {
          'x-heureka-api-key': apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      },
    )

    const body = (await response.json()) as {
      conversions?: unknown
    }

    // An empty conversions[] is a valid zero-activity day.
    const conversions = Array.isArray(
      body?.conversions,
    )
      ? body.conversions
      : []

    return conversions.map(normalizeHeurekaRow)
  } finally {
    clearTimeout(timeoutId)
  }
}

/* ============================================================
   Routes (backend acts as a secure proxy; nothing here is
   persisted — Heureka remains the source of truth)
   ============================================================ */

arukeresoPerformanceApi.get(
  '/day',
  async (context) => {
    const date = context.req.query('date')

    if (!isValidDateParam(date)) {
      return context.json(
        {
          status: 'error',
          message:
            'Érvénytelen dátum, YYYY-MM-DD formátum szükséges.',
        },
        400,
      )
    }

    if (!isCompletedDay(date, budapestToday())) {
      return context.json(
        {
          status: 'error',
          message:
            'A Heureka riportok lezárt napokra kérhetők le; a mai nap még nem elérhető.',
        },
        400,
      )
    }

    const apiKey = getHeurekaApiKey()

    if (!apiKey) {
      return context.json(
        {
          status: 'error',
          message: `${HEUREKA_API_KEY_ENV} nincs beállítva.`,
        },
        503,
      )
    }

    try {
      const database = requireDatabase()
      const [rows, hubProducts] =
        await Promise.all([
          fetchHeurekaDayRows(date, apiKey),
          database
            .select({
              id: products.id,
              sku: products.sku,
              name: products.name,
            })
            .from(products),
        ])

      const items: HeurekaDayRow[] =
        enrichHeurekaRows(rows, hubProducts)
      const matchedRows = items.filter(
        (item) => item.productId !== null,
      ).length

      return context.json({
        status: 'ok',
        date,
        sourceRows: items.length,
        matchedRows,
        unmatchedRows: items.length - matchedRows,
        rows: items,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Heureka day fetch failed.'

      console.error(
        'Heureka performance day failed:',
        date,
        message,
      )

      return context.json(
        { status: 'error', message },
        503,
      )
    }
  },
)
