export type PerformancePreset =
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'month'

export type DayPreset =
  | 'last7'
  | 'last30'
  | 'month'

// Completed-day ranges ending yesterday; today is
// never requested because intraday reports lag.
export function resolveCompletedRange(
  preset: DayPreset,
  now: Date,
): { from: string; to: string } {
  const to = shiftBudapestDate(now, -1)

  switch (preset) {
    case 'last7':
      return {
        from: shiftBudapestDate(now, -7),
        to,
      }
    case 'last30':
      return {
        from: shiftBudapestDate(now, -30),
        to,
      }
    case 'month':
      return {
        from: `${budapestDateString(now).slice(0, 7)}-01`,
        to,
      }
  }
}

export function budapestDateString(
  now: Date,
): string {
  const parts = new Intl.DateTimeFormat(
    'en-CA',
    {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).formatToParts(now)
  const value = (type: string) =>
    parts.find((part) => part.type === type)
      ?.value ?? ''

  return `${value('year')}-${value('month')}-${value('day')}`
}

export function shiftBudapestDate(
  now: Date,
  days: number,
): string {
  // Calendar-day arithmetic stays in UTC to avoid DST
  // edge cases; the Budapest "today" anchors the range.
  const base = new Date(
    `${budapestDateString(now)}T00:00:00Z`,
  )
  base.setUTCDate(base.getUTCDate() + days)

  return base.toISOString().slice(0, 10)
}

export function resolvePresetRange(
  preset: PerformancePreset,
  now: Date,
): { from: string; to: string } {
  if (preset === 'yesterday') {
    const day = shiftBudapestDate(now, -1)

    return { from: day, to: day }
  }

  return resolveCompletedRange(preset, now)
}

export type CustomRangeValidation =
  | { ok: true; dates: string[] }
  | { ok: false; message: string }

// Custom ranges end at yesterday at the latest:
// Heureka reports cover completed billing days only.
export function validateCustomRange(
  fromDate: string,
  toDate: string,
  today: string,
  maxDays: number,
): CustomRangeValidation {
  if (fromDate === '' || toDate === '') {
    return {
      ok: false,
      message: 'Adj meg kezdő és záró dátumot.',
    }
  }

  if (fromDate > toDate) {
    return {
      ok: false,
      message:
        'A kezdődátum nem lehet későbbi a záródátumnál.',
    }
  }

  if (toDate >= today) {
    return {
      ok: false,
      message:
        'A záródátum legfeljebb a tegnapi nap lehet.',
    }
  }

  const dates = eachDateInRange(fromDate, toDate)

  if (dates.length > maxDays) {
    return {
      ok: false,
      message: `A dátumtartomány legfeljebb ${maxDays} nap lehet.`,
    }
  }

  return { ok: true, dates }
}

export type PerformanceDayRow = {
  date: string
  productId: string | null
  sku: string | null
  productName: string | null
  normalizedProductCode: string
  productCardId: string
  sourceProductName: string | null
  clickSource: string
  matchStatus: 'MATCHED' | 'UNMATCHED'
  visits: number
  costGross: number
  costNet: number
  orders: number
  revenue: number
}

export type PerformanceSums = {
  visits: number
  costGross: number
  costNet: number
  orders: number
  revenue: number
}

export type PerformanceRatios = {
  roas: number | null
  crr: number | null
  cvr: number | null
  cpc: number | null
  aov: number | null
}

// Ratios are always derived from aggregated
// numerators/denominators, never averaged.
export function computeRatios(
  sums: PerformanceSums,
): PerformanceRatios {
  return {
    roas:
      sums.costGross > 0
        ? sums.revenue / sums.costGross
        : null,
    crr:
      sums.revenue > 0
        ? (sums.costGross / sums.revenue) * 100
        : null,
    cvr:
      sums.visits > 0
        ? (sums.orders / sums.visits) * 100
        : null,
    cpc:
      sums.visits > 0
        ? sums.costGross / sums.visits
        : null,
    aov:
      sums.orders > 0
        ? sums.revenue / sums.orders
        : null,
  }
}

export function sumDayRows(
  rows: PerformanceSums[],
): PerformanceSums {
  return rows.reduce(
    (total, row) => ({
      visits: total.visits + row.visits,
      costGross: total.costGross + row.costGross,
      costNet: total.costNet + row.costNet,
      orders: total.orders + row.orders,
      revenue: total.revenue + row.revenue,
    }),
    {
      visits: 0,
      costGross: 0,
      costNet: 0,
      orders: 0,
      revenue: 0,
    },
  )
}

export function eachDateInRange(
  from: string,
  to: string,
): string[] {
  const dates: string[] = []
  const current = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)

  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10))
    current.setUTCDate(current.getUTCDate() + 1)
  }

  return dates
}

// Last 7 completed calendar days ending yesterday
// (today is never requested by default).
export function last7CompletedDays(
  today: string,
): string[] {
  const end = new Date(`${today}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() - 1)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 6)

  return eachDateInRange(
    start.toISOString().slice(0, 10),
    end.toISOString().slice(0, 10),
  )
}

// ISO week bucket: "2026-W37". Month: "2026-09".
export function bucketKey(
  date: string,
  group: 'day' | 'week' | 'month',
): string {
  if (group === 'day') {
    return date
  }

  if (group === 'month') {
    return date.slice(0, 7)
  }

  const utc = new Date(`${date}T00:00:00Z`)
  const day = (utc.getUTCDay() + 6) % 7
  const thursday = new Date(utc)
  thursday.setUTCDate(utc.getUTCDate() - day + 3)
  const year = thursday.getUTCFullYear()
  const firstThursday = new Date(
    Date.UTC(year, 0, 4),
  )
  const week =
    1 +
    Math.round(
      (thursday.getTime() -
        firstThursday.getTime()) /
        (7 * 24 * 60 * 60 * 1000),
    )

  return `${year}-W${String(week).padStart(2, '0')}`
}

export type AggregatedProduct = {
  key: string
  productId: string | null
  sku: string | null
  productName: string | null
  normalizedProductCode: string
  productCardId: string
  matchStatus: 'MATCHED' | 'UNMATCHED'
  sums: PerformanceSums
  ratios: PerformanceRatios
}

export function aggregateProducts(
  rows: PerformanceDayRow[],
): AggregatedProduct[] {
  const byKey = new Map<string, AggregatedProduct>()

  for (const row of rows) {
    const key =
      row.productId !== null
        ? `p:${row.productId}`
        : `u:${row.normalizedProductCode}`
    const existing = byKey.get(key)

    if (!existing) {
      byKey.set(key, {
        key,
        productId: row.productId,
        sku: row.sku,
        productName:
          row.productName ?? row.sourceProductName,
        normalizedProductCode:
          row.normalizedProductCode,
        productCardId: row.productCardId,
        matchStatus: row.matchStatus,
        sums: {
          visits: row.visits,
          costGross: row.costGross,
          costNet: row.costNet,
          orders: row.orders,
          revenue: row.revenue,
        },
        ratios: {
          roas: null,
          crr: null,
          cvr: null,
          cpc: null,
          aov: null,
        },
      })
      continue
    }

    existing.sums.visits += row.visits
    existing.sums.costGross += row.costGross
    existing.sums.costNet += row.costNet
    existing.sums.orders += row.orders
    existing.sums.revenue += row.revenue
  }

  return [...byKey.values()].map((item) => ({
    ...item,
    ratios: computeRatios(item.sums),
  }))
}

function productSortValue(
  item: AggregatedProduct,
  field: string,
): string | number | null {
  switch (field) {
    case 'sku':
      return (
        item.sku ?? item.normalizedProductCode
      )
    case 'name':
      return item.productName ?? ''
    case 'visits':
      return item.sums.visits
    case 'orders':
      return item.sums.orders
    case 'cost':
      return item.sums.costGross
    case 'revenue':
      return item.sums.revenue
    case 'roas':
      return item.ratios.roas
    case 'crr':
      return item.ratios.crr
    case 'cvr':
      return item.ratios.cvr
    case 'cpc':
      return item.ratios.cpc
    case 'aov':
      return item.ratios.aov
    default:
      return item.sums.costGross
  }
}

export const METRIC_HELP: Record<string, string> = {
  visits:
    'Az Árukeresőről a webshopba érkező látogatások száma.',
  orders:
    'Az Árukereső konverzióméréséhez kapcsolt rendelések száma.',
  cost: 'Az Árukereső által riportált bruttó kattintási költség.',
  revenue:
    'Az Árukereső konverzióméréséhez kapcsolt rendelések bevétele.',
  roas:
    'Return on Ad Spend. Megmutatja, hogy 1 Ft költség hány Ft bevételt hozott. A magasabb érték kedvezőbb.',
  crr: 'Cost Revenue Ratio. A költség a bevétel százalékában. Az alacsonyabb érték kedvezőbb.',
  cvr: 'Conversion Rate. Megmutatja, hogy a kattintások hány százalékából lett rendelés.',
  cpc: 'Cost per Click. Egy kattintás átlagos költsége.',
  aov: 'Average Order Value. Egy rendelés átlagos értéke.',
}

export type ProductViewFilters = {
  search: string
  sort: string
  order: 'asc' | 'desc'
  hasCost: boolean
  hasOrders: boolean
  hasRevenue: boolean
}

export function applyProductView(
  items: AggregatedProduct[],
  filters: ProductViewFilters,
): AggregatedProduct[] {
  const needle = filters.search.trim().toLowerCase()
  const direction = filters.order === 'asc' ? 1 : -1

  return items
    .filter((item) => {
      if (
        filters.hasCost &&
        item.sums.costGross <= 0
      ) {
        return false
      }

      if (
        filters.hasOrders &&
        item.sums.orders <= 0
      ) {
        return false
      }

      if (
        filters.hasRevenue &&
        item.sums.revenue <= 0
      ) {
        return false
      }

      if (needle === '') {
        return true
      }

      return (
        (item.sku ?? '')
          .toLowerCase()
          .includes(needle) ||
        (item.productName ?? '')
          .toLowerCase()
          .includes(needle) ||
        item.normalizedProductCode
          .toLowerCase()
          .includes(needle)
      )
    })
    .sort((left, right) => {
      const leftValue = productSortValue(
        left,
        filters.sort,
      )
      const rightValue = productSortValue(
        right,
        filters.sort,
      )

      if (
        typeof leftValue === 'string' ||
        typeof rightValue === 'string'
      ) {
        return (
          String(leftValue ?? '').localeCompare(
            String(rightValue ?? ''),
            'hu',
          ) * direction
        )
      }

      return (
        (Number(leftValue ?? 0) -
          Number(rightValue ?? 0)) *
        direction
      )
    })
}

export type TrendBucket = {
  bucket: string
  sums: PerformanceSums
  ratios: PerformanceRatios
}

export function groupTrendPoints(
  rows: Array<
    PerformanceDayRow & { date: string }
  >,
  group: 'day' | 'week' | 'month',
): TrendBucket[] {
  const byBucket = new Map<string, PerformanceSums>()

  for (const row of rows) {
    const key = bucketKey(row.date, group)
    const sums = byBucket.get(key) ?? {
      visits: 0,
      costGross: 0,
      costNet: 0,
      orders: 0,
      revenue: 0,
    }

    sums.visits += row.visits
    sums.costGross += row.costGross
    sums.costNet += row.costNet
    sums.orders += row.orders
    sums.revenue += row.revenue
    byBucket.set(key, sums)
  }

  return [...byBucket.entries()]
    .sort(([left], [right]) =>
      left < right ? -1 : 1,
    )
    .map(([bucket, sums]) => ({
      bucket,
      sums,
      ratios: computeRatios(sums),
    }))
}

const huInteger = new Intl.NumberFormat('hu-HU', {
  maximumFractionDigits: 0,
})

const huMoney = new Intl.NumberFormat('hu-HU', {
  style: 'currency',
  currency: 'HUF',
  maximumFractionDigits: 0,
})

export function formatMoney(
  value: number | null,
  currency?: string | null,
): string {
  if (value === null || !Number.isFinite(value)) {
    return '–'
  }

  if (!currency || currency === 'HUF') {
    return huMoney.format(value)
  }

  return `${huInteger.format(value)} ${currency}`
}

export function formatCount(
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) {
    return '–'
  }

  return huInteger.format(Math.round(value))
}

// Ratio as stored (e.g. ROAS 20.14) with Hungarian decimals.
export function formatRoas(
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) {
    return '–'
  }

  const rounded = Math.round(value * 100) / 100

  return `${String(rounded).replace('.', ',')}×`
}

// Percent-style metrics (CRR/CVR), e.g. 4.96 -> "4,96%".
export function formatRatioPercent(
  value: number | null,
): string {
  if (value === null || !Number.isFinite(value)) {
    return '–'
  }

  const rounded = Math.round(value * 100) / 100

  return `${String(rounded).replace('.', ',')}%`
}
