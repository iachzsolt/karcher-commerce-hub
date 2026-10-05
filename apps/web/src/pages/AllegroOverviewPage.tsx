import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from '../config/api'

type RangeMode = 'week' | 'month' | 'year' | 'custom'
type ChartMode = 'revenue' | 'orders'
type PerfAttribution = 'all' | 'campaign' | 'nonCampaign'
type PerfSortKey = 'revenue' | 'orders' | 'units' | 'name'

type DashboardSeriesItem = {
  key: string
  label: string
  ordersCount: number
  unitsSold: number
  revenueMinor: number
  allegroCostMinor: number
  allegroCreditMinor: number
}

type CampaignProductPerformance = {
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
}

type CampaignPerformanceAnalysis = {
  campaignId: string
  campaignName: string
  totals: {
    campaignOrders: number
    outsideOrders: number
    campaignUnits: number
    outsideUnits: number
    campaignRevenueMinor: number
    outsideRevenueMinor: number
    totalOrders?: number
    totalUnits?: number
    totalRevenueMinor?: number
  }
  products: CampaignProductPerformance[]
}

type DashboardSummary = {
  status: 'ok'
  generatedAt: string
  period: {
    fromDate: string
    toDate: string
    groupBy: 'day' | 'month'
    timeZone: string
    from: string
    to: string
  }
  permissions: {
    offers: boolean
    orders: boolean
    billing: boolean
  }
  offers: {
    total: number
    active: number
    activating: number
    inactive: number
    ended: number
    unknown: number
  }
  sales: {
    ordersCount: number
    unitsSold: number
    grossSalesMinor: number
    currency: string
  }
  orderStatuses: {
    total: number
    bought: number
    filledIn: number
    readyForProcessing: number
    cancelled: number
    unknown: number
  }
  fulfillmentStatuses: Record<string, number>
  campaignPerformance: {
    campaigns: Array<{
      id: string
      name: string
      validFrom: string | null
      validTo: string | null
      offerCount: number
    }>
    analyses: CampaignPerformanceAnalysis[]
    attribution: string
  }
  costs: {
    commissionCostMinor: number
    totalAllegroCostMinor: number
    allegroCreditsMinor: number
    billingEntryCount: number
    netAfterAllegroCostsMinor: number
    currency: string
  }
  series: DashboardSeriesItem[]
}

function getBudapestDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Budapest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const getPart = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ''

  return {
    year: getPart('year'),
    month: getPart('month'),
    day: getPart('day'),
  }
}

function toDateValue(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getCurrentDateValue() {
  const parts = getBudapestDateParts()
  return `${parts.year}-${parts.month}-${parts.day}`
}

function getCurrentMonthValue() {
  const parts = getBudapestDateParts()
  return `${parts.year}-${parts.month}`
}

function getIsoWeekValue(dateValue = getCurrentDateValue()) {
  const date = new Date(`${dateValue}T00:00:00Z`)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const week = Math.ceil(
    (((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) /
      7,
  )

  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

function getIsoWeekRange(weekValue: string) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekValue)

  if (!match) return null

  const year = Number(match[1])
  const week = Number(match[2])
  const januaryFourth = new Date(Date.UTC(year, 0, 4))
  const januaryFourthDay = januaryFourth.getUTCDay() || 7
  const monday = new Date(januaryFourth)
  monday.setUTCDate(
    januaryFourth.getUTCDate() - januaryFourthDay + 1 + (week - 1) * 7,
  )
  const sunday = new Date(monday)
  sunday.setUTCDate(sunday.getUTCDate() + 6)

  return { from: toDateValue(monday), to: toDateValue(sunday) }
}

function getMonthRange(monthValue: string) {
  const [year, month] = monthValue.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0))

  return {
    from: `${monthValue}-01`,
    to: toDateValue(lastDay),
  }
}

function getYearRange(yearValue: string) {
  return {
    from: `${yearValue}-01-01`,
    to: `${yearValue}-12-31`,
  }
}

function getDayDifference(from: string, to: string) {
  return Math.floor(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  )
}

function formatMoney(valueMinor: number, currency: string) {
  return new Intl.NumberFormat('hu-HU', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'HUF' ? 0 : 2,
  }).format(valueMinor / 100)
}

function getNiceChartScale(maximumValue: number) {
  if (maximumValue <= 0) {
    return { maximum: 1, ticks: [0] }
  }

  const targetIntervals = 4
  const roughStep = maximumValue / targetIntervals
  const magnitude = 10 ** Math.floor(Math.log10(roughStep))
  const normalizedStep = roughStep / magnitude
  const niceMultiplier =
    normalizedStep <= 1
      ? 1
      : normalizedStep <= 2
        ? 2
        : normalizedStep <= 5
          ? 5
          : 10
  const step = niceMultiplier * magnitude
  const maximum = Math.ceil(maximumValue / step) * step
  const ticks: number[] = []

  for (let value = maximum; value >= 0; value -= step) {
    ticks.push(value)
  }

  return { maximum, ticks }
}

function formatChartTick(
  value: number,
  mode: ChartMode,
  currency: string,
) {
  const displayValue = mode === 'revenue' ? value / 100 : value
  const compact = new Intl.NumberFormat('hu-HU', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(displayValue)

  if (mode === 'orders') return `${compact} rendelés`
  return currency === 'HUF' ? `${compact} Ft` : compact
}

function formatPeriod(from: string, to: string) {
  const formatter = new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })

  return `${formatter.format(new Date(`${from}T00:00:00Z`))} – ${formatter.format(new Date(`${to}T00:00:00Z`))}`
}

function formatFulfillmentStatus(status: string) {
  const labels: Record<string, string> = {
    NEW: 'Új',
    PROCESSING: 'Feldolgozás alatt',
    READY_FOR_SHIPMENT: 'Szállításra kész',
    READY_FOR_PICKUP: 'Átvételre kész',
    SENT: 'Elküldve',
    PICKED_UP: 'Átvéve',
    CANCELLED: 'Törölve',
    SUSPENDED: 'Felfüggesztve',
    RETURNED: 'Visszaküldve',
    UNKNOWN: 'Ismeretlen',
  }

  return labels[status] ?? status
}

type ProductPerformanceRow = {
  offerId: string
  name: string
  orders: number
  units: number
  revenueMinor: number
  campaignOrders: number
  campaignRevenueMinor: number
  outsideOrders: number
  outsideRevenueMinor: number
}

function ProductPerformanceList({
  rows,
  detailed,
  barTone,
  currency,
}: {
  rows: ProductPerformanceRow[]
  detailed: boolean
  barTone: 'campaign' | 'outside'
  currency: string
}) {
  const maximum = Math.max(
    1,
    ...rows.flatMap((row) =>
      detailed
        ? [row.campaignRevenueMinor, row.outsideRevenueMinor]
        : [row.revenueMinor],
    ),
  )

  return (
    <div className="allegro-campaign-product-list">
      {rows.map((row) => (
        <div className="allegro-campaign-product-row is-performance" key={row.offerId}>
          <div className="allegro-campaign-product-name" title={row.name}>
            <div>
              <strong>{row.name}</strong>
            </div>
            <span>Offer {row.offerId}</span>
          </div>
          <div className="allegro-campaign-product-figures">
            <span>
              <strong>{row.orders}</strong> rendelés
            </span>
            <span>
              <strong>{row.units}</strong> db
            </span>
            <span>
              <strong>{formatMoney(row.revenueMinor, currency)}</strong>
            </span>
            {detailed ? (
              <span className="is-breakdown">
                ebből kampányos: {row.campaignOrders} rendelés ·{' '}
                {formatMoney(row.campaignRevenueMinor, currency)}
              </span>
            ) : null}
          </div>
          <div className="allegro-campaign-product-bars">
            {detailed ? (
              <>
                <div className="allegro-campaign-product-bar-row">
                  <div className="allegro-campaign-product-track">
                    <span
                      className="is-campaign-sale"
                      style={{ width: `${(row.campaignRevenueMinor / maximum) * 100}%` }}
                    />
                  </div>
                  <strong>{formatMoney(row.campaignRevenueMinor, currency)}</strong>
                </div>
                <div className="allegro-campaign-product-bar-row">
                  <div className="allegro-campaign-product-track">
                    <span
                      className="is-outside-sale"
                      style={{ width: `${(row.outsideRevenueMinor / maximum) * 100}%` }}
                    />
                  </div>
                  <strong>{formatMoney(row.outsideRevenueMinor, currency)}</strong>
                </div>
              </>
            ) : (
              <div className="allegro-campaign-product-bar-row">
                <div className="allegro-campaign-product-track">
                  <span
                    className={
                      barTone === 'campaign'
                        ? 'is-campaign-sale'
                        : 'is-outside-sale'
                    }
                    style={{ width: `${(row.revenueMinor / maximum) * 100}%` }}
                  />
                </div>
                <strong>{formatMoney(row.revenueMinor, currency)}</strong>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string
  value: string
  detail: string
  tone?: 'neutral' | 'active' | 'warning' | 'ended'
}) {
  return (
    <article
      className={`allegro-overview-metric allegro-overview-metric-${tone}`}
    >
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function SalesChart({
  data,
  currency,
}: {
  data: DashboardSeriesItem[]
  currency: string
}) {
  const [mode, setMode] = useState<ChartMode>('revenue')
  const scale = getNiceChartScale(
    Math.max(
      0,
      ...data.flatMap((item) =>
        mode === 'revenue'
          ? [
              item.revenueMinor + item.allegroCreditMinor,
              item.allegroCostMinor,
            ]
          : [item.ordersCount],
      ),
    ),
  )
  const minimumWidth = Math.max(620, data.length * 48)

  return (
    <div className="allegro-sales-chart-card">
      <div className="allegro-sales-chart-header">
        <div>
          <h4>Értékesítési grafikon</h4>
          <p>
            {mode === 'revenue'
              ? 'Teljes bevétel Allegro-jóváírásokkal, valamint az Allegro-díjak.'
              : 'A fizetett, feldolgozható rendelések száma.'}
          </p>
        </div>
        <div className="allegro-sales-chart-controls">
          <div className="allegro-sales-chart-mode" aria-label="Grafikon adata">
            <button
              type="button"
              className={mode === 'revenue' ? 'is-active' : ''}
              aria-pressed={mode === 'revenue'}
              onClick={() => setMode('revenue')}
            >
              Bevétel
            </button>
            <button
              type="button"
              className={mode === 'orders' ? 'is-active' : ''}
              aria-pressed={mode === 'orders'}
              onClick={() => setMode('orders')}
            >
              Rendelésszám
            </button>
          </div>
          <div className="allegro-sales-chart-legend">
            {mode === 'revenue' ? (
              <>
                <span className="is-revenue">Teljes bevétel</span>
                <span className="is-cost">Allegro-díj</span>
              </>
            ) : (
              <span className="is-orders">Fizetett rendelés</span>
            )}
          </div>
        </div>
      </div>

      <div className="allegro-sales-chart-body">
        <div className="allegro-sales-chart-axis" aria-hidden="true">
          {scale.ticks.map((tick) => (
            <span key={tick}>{formatChartTick(tick, mode, currency)}</span>
          ))}
        </div>
        <div className="allegro-sales-chart-scroll">
          <div
            className="allegro-sales-chart"
            style={{ minWidth: `${minimumWidth}px` }}
          >
          <div className="allegro-sales-chart-grid" aria-hidden="true">
            {scale.ticks.map((tick) => (
              <span key={tick} />
            ))}
          </div>
          {data.map((item) => {
            const totalRevenueMinor =
              item.revenueMinor + item.allegroCreditMinor
            const revenueHeight =
              totalRevenueMinor > 0
                ? Math.max(3, (totalRevenueMinor / scale.maximum) * 100)
                : 0
            const costHeight =
              item.allegroCostMinor > 0
                ? Math.max(3, (item.allegroCostMinor / scale.maximum) * 100)
                : 0
            const ordersHeight =
              item.ordersCount > 0
                ? Math.max(3, (item.ordersCount / scale.maximum) * 100)
                : 0

            return (
              <div className="allegro-sales-chart-column" key={item.key}>
                <div className="allegro-sales-chart-bars">
                  {mode === 'revenue' ? (
                    <>
                      <div
                        className="allegro-sales-chart-bar is-revenue"
                        style={{ height: `${revenueHeight}%` }}
                        title={`Teljes bevétel: ${formatMoney(totalRevenueMinor, currency)} · ebből Allegro-jóváírás: ${formatMoney(item.allegroCreditMinor, currency)}`}
                      />
                      <div
                        className="allegro-sales-chart-bar is-cost"
                        style={{ height: `${costHeight}%` }}
                        title={`Allegro-díj: ${formatMoney(item.allegroCostMinor, currency)}`}
                      />
                    </>
                  ) : (
                    <div
                      className="allegro-sales-chart-bar is-orders"
                      style={{ height: `${ordersHeight}%` }}
                      title={`${item.ordersCount} fizetett rendelés · ${item.unitsSold} eladott darab`}
                    />
                  )}
                </div>
                <span>{item.label}</span>
              </div>
            )
          })}
          </div>
        </div>
      </div>
    </div>
  )
}

function AllegroOverviewPage() {
  const currentDate = useMemo(getCurrentDateValue, [])
  const [rangeMode, setRangeMode] = useState<RangeMode>('month')
  const [week, setWeek] = useState(getIsoWeekValue)
  const [month, setMonth] = useState(getCurrentMonthValue)
  const [year, setYear] = useState(() => getBudapestDateParts().year)
  const [customFrom, setCustomFrom] = useState(() => `${getCurrentMonthValue()}-01`)
  const [customTo, setCustomTo] = useState(getCurrentDateValue)
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [perfFrom, setPerfFrom] = useState('')
  const [perfTo, setPerfTo] = useState('')
  const [perfRangeReady, setPerfRangeReady] = useState(false)
  const [perfAttribution, setPerfAttribution] =
    useState<PerfAttribution>('all')
  const [perfCampaignId, setPerfCampaignId] = useState('')
  const [perfSortKey, setPerfSortKey] =
    useState<PerfSortKey>('revenue')
  const [perfSummary, setPerfSummary] =
    useState<DashboardSummary | null>(null)
  const [perfLoading, setPerfLoading] = useState(false)
  const [perfError, setPerfError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const selectedRange = useMemo(() => {
    const range =
      rangeMode === 'week'
        ? getIsoWeekRange(week)
        : rangeMode === 'month'
          ? getMonthRange(month)
          : rangeMode === 'year'
            ? getYearRange(year)
            : { from: customFrom, to: customTo }

    if (
      range &&
      range.from <= currentDate &&
      range.to > currentDate
    ) {
      return { ...range, to: currentDate }
    }

    return range
  }, [
    currentDate,
    customFrom,
    customTo,
    month,
    rangeMode,
    week,
    year,
  ])

  const rangeValidationError = useMemo(() => {
    if (!selectedRange?.from || !selectedRange.to) {
      return 'Adj meg érvényes időszakot.'
    }

    const difference = getDayDifference(
      selectedRange.from,
      selectedRange.to,
    )

    if (difference < 0) return 'A kezdő dátum nem lehet későbbi a záró dátumnál.'
    if (difference > 366) return 'Legfeljebb 367 napos időszak választható.'
    return null
  }, [selectedRange])

  const loadSummary = useCallback(async () => {
    if (!selectedRange || rangeValidationError) return

    setLoading(true)
    setError(null)

    try {
      const groupBy =
        rangeMode === 'year' ||
        getDayDifference(selectedRange.from, selectedRange.to) > 62
          ? 'month'
          : 'day'
      const params = new URLSearchParams({
        from: selectedRange.from,
        to: selectedRange.to,
        groupBy,
      })
      const response = await fetch(
        `${API_BASE_URL}/auth/allegro/dashboard-summary?${params.toString()}`,
      )
      const body = (await response.json()) as
        | DashboardSummary
        | { status?: string; message?: string }

      if (!response.ok || body.status !== 'ok') {
        throw new Error(
          'message' in body && body.message
            ? body.message
            : 'Nem sikerült betölteni az Allegro-áttekintést.',
        )
      }

      setSummary(body as DashboardSummary)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Nem sikerült betölteni az Allegro-áttekintést.',
      )
    } finally {
      setLoading(false)
    }
  }, [rangeMode, rangeValidationError, selectedRange])

  useEffect(() => {
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    if (!perfRangeReady && selectedRange && !rangeValidationError) {
      setPerfFrom(selectedRange.from)
      setPerfTo(selectedRange.to)
      setPerfRangeReady(true)
    }
  }, [perfRangeReady, rangeValidationError, selectedRange])

  const perfRangeError = useMemo(() => {
    if (!perfFrom || !perfTo) {
      return 'Adj meg érvényes időszakot.'
    }

    const difference = getDayDifference(perfFrom, perfTo)

    if (difference < 0) return 'A kezdő dátum nem lehet későbbi a záró dátumnál.'
    if (difference > 366) return 'Legfeljebb 367 napos időszak választható.'
    return null
  }, [perfFrom, perfTo])

  const loadPerformance = useCallback(async () => {
    if (!perfFrom || !perfTo || perfRangeError) return

    setPerfLoading(true)
    setPerfError(null)

    try {
      const params = new URLSearchParams({
        from: perfFrom,
        to: perfTo,
        groupBy:
          getDayDifference(perfFrom, perfTo) > 62
            ? 'month'
            : 'day',
      })
      const response = await fetch(
        `${API_BASE_URL}/auth/allegro/dashboard-summary?${params.toString()}`,
      )
      const body = (await response.json()) as
        | DashboardSummary
        | { status?: string; message?: string }

      if (!response.ok || body.status !== 'ok') {
        throw new Error(
          'message' in body && body.message
            ? body.message
            : 'Nem sikerült betölteni a termékteljesítményt.',
        )
      }

      setPerfSummary(body as DashboardSummary)
    } catch (loadError) {
      setPerfError(
        loadError instanceof Error
          ? loadError.message
          : 'Nem sikerült betölteni a termékteljesítményt.',
      )
    } finally {
      setPerfLoading(false)
    }
  }, [perfFrom, perfRangeError, perfTo])

  useEffect(() => {
    void loadPerformance()
  }, [loadPerformance])

  const perfCampaigns =
    perfSummary?.campaignPerformance.campaigns.filter(
      (campaign) => campaign.id !== 'ALL_ALLEGRO_CAMPAIGNS',
    ) ?? []
  const perfAllProducts =
    perfSummary?.campaignPerformance.analyses.find(
      (analysis) => analysis.campaignId === 'ALL_PRODUCTS',
    ) ?? null
  const perfAllCampaigns =
    perfSummary?.campaignPerformance.analyses.find(
      (analysis) => analysis.campaignId === 'ALL_ALLEGRO_CAMPAIGNS',
    ) ?? null
  const perfSpecificCampaign =
    perfAttribution === 'campaign' && perfCampaignId
      ? (perfSummary?.campaignPerformance.analyses.find(
          (analysis) => analysis.campaignId === perfCampaignId,
        ) ?? perfAllCampaigns)
      : null
  const perfSource =
    perfAttribution === 'campaign'
      ? (perfSpecificCampaign ?? perfAllCampaigns)
      : perfAllProducts

  const perfRows = useMemo((): ProductPerformanceRow[] => {
    if (!perfSource) return []

    const rows = perfSource.products
      .map((product) => {
        if (perfAttribution === 'campaign') {
          return {
            offerId: product.offerId,
            name: product.name,
            orders: product.campaignOrders,
            units: product.campaignUnits,
            revenueMinor: product.campaignRevenueMinor,
            campaignOrders: product.campaignOrders,
            campaignRevenueMinor: product.campaignRevenueMinor,
            outsideOrders: product.outsideOrders,
            outsideRevenueMinor: product.outsideRevenueMinor,
          }
        }

        if (perfAttribution === 'nonCampaign') {
          return {
            offerId: product.offerId,
            name: product.name,
            orders: product.outsideOrders,
            units: product.outsideUnits,
            revenueMinor: product.outsideRevenueMinor,
            campaignOrders: product.campaignOrders,
            campaignRevenueMinor: product.campaignRevenueMinor,
            outsideOrders: product.outsideOrders,
            outsideRevenueMinor: product.outsideRevenueMinor,
          }
        }

        return {
          offerId: product.offerId,
          name: product.name,
          orders: product.campaignOrders + product.outsideOrders,
          units: product.campaignUnits + product.outsideUnits,
          revenueMinor:
            product.campaignRevenueMinor + product.outsideRevenueMinor,
          campaignOrders: product.campaignOrders,
          campaignRevenueMinor: product.campaignRevenueMinor,
          outsideOrders: product.outsideOrders,
          outsideRevenueMinor: product.outsideRevenueMinor,
        }
      })
      .filter(
        (row) => row.orders > 0 || row.revenueMinor > 0,
      )

    return [...rows].sort((left, right) =>
      perfSortKey === 'name'
        ? left.name.localeCompare(right.name, 'hu')
        : perfSortKey === 'orders'
          ? right.orders - left.orders
          : perfSortKey === 'units'
            ? right.units - left.units
            : right.revenueMinor - left.revenueMinor,
    )
  }, [perfAttribution, perfSortKey, perfSource])

  const perfTotals = useMemo(() => {
    const totals = {
      orders: 0,
      units: 0,
      revenueMinor: 0,
      campaignRevenueMinor: 0,
    }

    for (const row of perfRows) {
      totals.orders += row.orders
      totals.units += row.units
      totals.revenueMinor += row.revenueMinor
      totals.campaignRevenueMinor += row.campaignRevenueMinor
    }

    return totals
  }, [perfRows])

  const needsReauthorization = Boolean(
    summary &&
      (!summary.permissions.orders || !summary.permissions.billing),
  )
  const waitingOrders = summary
    ? summary.orderStatuses.bought + summary.orderStatuses.filledIn
    : 0

  return (
    <div className="allegro-overview-page">
      <section className="allegro-overview-heading">
        <div>
          <p className="section-label">ALLEGRO</p>
          <h2>Áttekintés</h2>
          <p>
            Ajánlatállapotok, értékesítés és tényleges
            Allegro-költségek egy helyen.
          </p>
        </div>

        <div className="allegro-overview-filter">
          <div className="allegro-overview-filter-tabs">
            {([
              ['week', 'Heti'],
              ['month', 'Havi'],
              ['year', 'Éves'],
              ['custom', 'Egyéni'],
            ] as Array<[RangeMode, string]>).map(([value, label]) => (
              <button
                type="button"
                className={rangeMode === value ? 'is-active' : ''}
                key={value}
                onClick={() => setRangeMode(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="allegro-overview-filter-inputs">
            {rangeMode === 'week' && (
              <input type="week" value={week} onChange={(event) => setWeek(event.target.value)} />
            )}
            {rangeMode === 'month' && (
              <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
            )}
            {rangeMode === 'year' && (
              <input
                type="number"
                min="2020"
                max={getBudapestDateParts().year}
                value={year}
                onChange={(event) => setYear(event.target.value)}
              />
            )}
            {rangeMode === 'custom' && (
              <>
                <input
                  aria-label="Kezdő dátum"
                  type="date"
                  max={customTo || currentDate}
                  value={customFrom}
                  onChange={(event) => setCustomFrom(event.target.value)}
                />
                <span>–</span>
                <input
                  aria-label="Záró dátum"
                  type="date"
                  min={customFrom}
                  max={currentDate}
                  value={customTo}
                  onChange={(event) => setCustomTo(event.target.value)}
                />
              </>
            )}
          </div>
        </div>
      </section>

      {rangeValidationError && (
        <div className="allegro-overview-message allegro-overview-message-error">
          <span>{rangeValidationError}</span>
        </div>
      )}

      {error && (
        <div className="allegro-overview-message allegro-overview-message-error">
          <span>{error}</span>
          <button type="button" onClick={() => void loadSummary()}>
            Újrapróbálás
          </button>
        </div>
      )}

      {needsReauthorization && (
        <div className="allegro-overview-message allegro-overview-message-warning">
          <div>
            <strong>Az értékesítési és költségadatokhoz új Allegro-jóváhagyás szükséges.</strong>
            <span>A kapcsolat még nem tartalmazza a rendelési és billing olvasási jogosultságokat.</span>
          </div>
          <Link to="/allegro/settings">Kapcsolat beállításai →</Link>
        </div>
      )}

      <section className="allegro-overview-section">
        <div className="allegro-overview-section-heading">
          <div>
            <h3>Ajánlatok állapota</h3>
            <p>Az Allegro aktuális, élő ajánlatlistája.</p>
          </div>
          <span>{summary ? `${summary.offers.total} ajánlat` : loading ? 'Betöltés…' : '—'}</span>
        </div>
        <div className="allegro-overview-metrics">
          <MetricCard label="Aktív" value={summary ? String(summary.offers.active) : '—'} detail="Jelenleg megvásárolható" tone="active" />
          <MetricCard label="Lejárt" value={summary ? String(summary.offers.ended) : '—'} detail="Lezárt ajánlat" tone="ended" />
          <MetricCard label="Inaktív piszkozat" value={summary ? String(summary.offers.inactive) : '—'} detail="Még nincs publikálva" tone="warning" />
          <MetricCard label="Aktiválás alatt" value={summary ? String(summary.offers.activating) : '—'} detail="Feldolgozás alatt az Allegrón" />
        </div>
      </section>

      <section className="allegro-overview-section allegro-overview-section-campaign">
        <div className="allegro-overview-section-heading allegro-campaign-performance-heading">
          <div>
            <h3>Termékteljesítmény</h3>
            <p>Rendelések és bevétel termékenként a kiválasztott időszakban.</p>
          </div>
          <div className="allegro-campaign-performance-controls">
            <div className="allegro-product-performance-dates">
              <input
                aria-label="Kezdő dátum"
                type="date"
                max={perfTo || currentDate}
                value={perfFrom}
                onChange={(event) => setPerfFrom(event.target.value)}
              />
              <span>–</span>
              <input
                aria-label="Záró dátum"
                type="date"
                min={perfFrom}
                max={currentDate}
                value={perfTo}
                onChange={(event) => setPerfTo(event.target.value)}
              />
            </div>
            <div className="allegro-sales-chart-mode" aria-label="Megoszlás">
              {(
                [
                  ['all', 'Összes'],
                  ['campaign', 'Kampányos'],
                  ['nonCampaign', 'Nem kampányos'],
                ] as Array<[PerfAttribution, string]>
              ).map(([value, label]) => (
                <button
                  type="button"
                  className={perfAttribution === value ? 'is-active' : ''}
                  aria-pressed={perfAttribution === value}
                  key={value}
                  onClick={() => setPerfAttribution(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {perfAttribution === 'campaign' ? (
              <select
                aria-label="Kampány kiválasztása"
                value={perfCampaignId}
                onChange={(event) => setPerfCampaignId(event.target.value)}
              >
                <option value="">Összes kampány</option>
                {perfCampaigns.map((campaign) => (
                  <option value={campaign.id} key={campaign.id}>
                    {campaign.name} · {campaign.offerCount} ajánlat
                  </option>
                ))}
              </select>
            ) : null}
            <select
              aria-label="Termékek rendezése"
              value={perfSortKey}
              onChange={(event) =>
                setPerfSortKey(
                  event.target.value as PerfSortKey,
                )
              }
            >
              <option value="revenue">Bevétel</option>
              <option value="orders">Rendelésszám</option>
              <option value="units">Eladott darab</option>
              <option value="name">Terméknév</option>
            </select>
          </div>
        </div>

        {perfRangeError ? (
          <div className="allegro-campaign-performance-empty">
            {perfRangeError}
          </div>
        ) : perfLoading && !perfSummary ? (
          <div className="allegro-campaign-performance-empty">
            Betöltés…
          </div>
        ) : perfError ? (
          <div className="allegro-overview-message allegro-overview-message-error">
            <span>{perfError}</span>
            <button type="button" onClick={() => void loadPerformance()}>
              Újrapróbálás
            </button>
          </div>
        ) : !perfSummary?.permissions.orders ? (
          <div className="allegro-campaign-performance-empty">
            A kampányeredményekhez rendelésolvasási jogosultság szükséges.
          </div>
        ) : (
          <>
            <div className="allegro-overview-metrics allegro-campaign-performance-metrics">
              {perfAttribution === 'all' ? (
                <>
                  <MetricCard
                    label="Összes rendelés"
                    value={String(perfTotals.orders)}
                    detail={`A kiválasztott időszak rendelései${perfLoading ? ' · Frissítés…' : ''}`}
                  />
                  <MetricCard
                    label="Eladott darab"
                    value={String(perfTotals.units)}
                    detail="Összes terméksor mennyisége"
                  />
                  <MetricCard
                    label="Összes bevétel"
                    value={formatMoney(perfTotals.revenueMinor, perfSummary.sales.currency)}
                    detail="Termékárbevétel a kiválasztott időszakban"
                    tone="active"
                  />
                  <MetricCard
                    label="Kampányos arány"
                    value={
                      perfTotals.revenueMinor > 0
                        ? `${Math.round((perfTotals.campaignRevenueMinor / perfTotals.revenueMinor) * 100)}%`
                        : '—'
                    }
                    detail="Kampányos bevétel aránya"
                  />
                </>
              ) : (
                <>
                  <MetricCard
                    label={perfAttribution === 'campaign' ? 'Kampányos rendelések' : 'Nem kampányos rendelések'}
                    value={String(perfTotals.orders)}
                    detail={perfAttribution === 'campaign' ? 'CAMPAIGN jelöléssel a kiválasztott időszakban' : 'Kampányjelölés nélküli eladások'}
                    tone={perfAttribution === 'campaign' ? 'active' : 'neutral'}
                  />
                  <MetricCard
                    label="Eladott darab"
                    value={String(perfTotals.units)}
                    detail="Összes terméksor mennyisége"
                  />
                  <MetricCard
                    label={perfAttribution === 'campaign' ? 'Kampányos bevétel' : 'Nem kampányos bevétel'}
                    value={formatMoney(perfTotals.revenueMinor, perfSummary.sales.currency)}
                    detail="Termékárbevétel a kiválasztott időszakban"
                    tone={perfAttribution === 'campaign' ? 'active' : 'neutral'}
                  />
                  <MetricCard
                    label="Átlagos rendelési érték"
                    value={
                      perfTotals.orders > 0
                        ? formatMoney(
                            Math.round(
                              perfTotals.revenueMinor /
                                perfTotals.orders,
                            ),
                            perfSummary.sales.currency,
                          )
                        : '—'
                    }
                    detail="Bevétel / rendelésszám"
                  />
                </>
              )}
            </div>
            {perfRows.length === 0 ? (
              <div className="allegro-campaign-performance-empty">
                {perfAttribution === 'campaign'
                  ? perfCampaignId
                    ? 'Nincs ehhez a kampányhoz köthető rendelés a kiválasztott időszakban.'
                    : 'Nincs kampányhoz köthető rendelés a kiválasztott időszakban.'
                  : perfAttribution === 'nonCampaign'
                    ? 'Nincs kampányon kívüli rendelés a kiválasztott időszakban.'
                    : 'Nincs rendelési adat a kiválasztott időszakban.'}
              </div>
            ) : (
              <ProductPerformanceList
                rows={perfRows}
                detailed={perfAttribution === 'all'}
                barTone={perfAttribution === 'nonCampaign' ? 'outside' : 'campaign'}
                currency={perfSummary.sales.currency}
              />
            )}
            <p className="allegro-campaign-performance-note">
              Kampányosnak csak az a rendelési sor számít, amelyet az Allegro
              CAMPAIGN jelöléssel adott vissza. A név szerinti
              kampánykövetés 2026. szeptember 1-től, a Commerce Hubban
              rögzített kampánytagságok alapján indul.
            </p>
          </>
        )}
      </section>

      <section className="allegro-overview-section allegro-overview-section-sales">
        <div className="allegro-overview-section-heading">
          <div>
            <h3>Eladási összesítő</h3>
            <p>
              {selectedRange ? formatPeriod(selectedRange.from, selectedRange.to) : '—'} · Allegro.hu · termékérték, szállítás nélkül
            </p>
          </div>
          <button className="allegro-overview-refresh" type="button" disabled={loading || Boolean(rangeValidationError)} onClick={() => void loadSummary()}>
            {loading ? 'Frissítés…' : 'Frissítés'}
          </button>
        </div>

        <div className="allegro-overview-metrics allegro-overview-sales-metrics">
          <MetricCard label="Fizetett rendelések" value={summary?.permissions.orders ? String(summary.sales.ordersCount) : '—'} detail="Feldolgozásra kész értékesítések" />
          <MetricCard label="Eladott darab" value={summary?.permissions.orders ? String(summary.sales.unitsSold) : '—'} detail="Összes terméksor mennyisége" />
          <MetricCard label="Teljes bevétel" value={summary?.permissions.orders && summary.permissions.billing ? formatMoney(summary.sales.grossSalesMinor + summary.costs.allegroCreditsMinor, summary.sales.currency) : '—'} detail="Termékárbevétel + Allegro-jóváírás; szállítás nélkül" tone="active" />
        </div>

        {summary?.permissions.orders && (
          <SalesChart data={summary.series} currency={summary.sales.currency} />
        )}
      </section>

      <section className="allegro-overview-section allegro-overview-section-orders">
        <div className="allegro-overview-section-heading">
          <div>
            <h3>Összes rendelés</h3>
            <p>A kiválasztott időszak rendelései fizetési és teljesítési állapot szerint.</p>
          </div>
          <span>{summary?.permissions.orders ? `${summary.orderStatuses.total} rendelés` : '—'}</span>
        </div>

        <div className="allegro-overview-order-statuses">
          <MetricCard label="Fizetésre vár" value={summary?.permissions.orders ? String(waitingOrders) : '—'} detail="BOUGHT és FILLED_IN" tone="warning" />
          <MetricCard label="Fizetett / feldolgozható" value={summary?.permissions.orders ? String(summary.orderStatuses.readyForProcessing) : '—'} detail="READY_FOR_PROCESSING" tone="active" />
          <MetricCard label="Törölt" value={summary?.permissions.orders ? String(summary.orderStatuses.cancelled) : '—'} detail="Vevő vagy Allegro által törölve" tone="ended" />
        </div>

        {summary?.permissions.orders && (
          <div className="allegro-overview-fulfillment">
            <span>Teljesítési állapot:</span>
            {Object.entries(summary.fulfillmentStatuses)
              .sort((left, right) => right[1] - left[1])
              .map(([status, count]) => (
                <span className={`allegro-overview-fulfillment-pill is-${status.toLowerCase()}`} key={status}>
                  {formatFulfillmentStatus(status)} <strong>{count}</strong>
                </span>
              ))}
          </div>
        )}
      </section>

      <section className="allegro-overview-section allegro-overview-section-billing">
        <div className="allegro-overview-section-heading">
          <div>
            <h3>Allegro-elszámolás</h3>
            <p>A kiválasztott időszak tényleges díjai és jóváírásai.</p>
          </div>
          <span>{summary?.permissions.billing ? `${summary.costs.billingEntryCount} tétel` : 'Nincs jogosultság'}</span>
        </div>
        <div className="allegro-overview-metrics allegro-overview-cost-metrics">
          <MetricCard label="Értékesítési jutalék" value={summary?.permissions.billing ? formatMoney(summary.costs.commissionCostMinor, summary.costs.currency) : '—'} detail="Negatív SUC jutaléktételek" tone="warning" />
          <MetricCard label="Összes Allegro-díj" value={summary?.permissions.billing ? formatMoney(summary.costs.totalAllegroCostMinor, summary.costs.currency) : '—'} detail="Negatív billing tételek" tone="ended" />
          <MetricCard label="Allegro-jóváírás" value={summary?.permissions.billing ? formatMoney(summary.costs.allegroCreditsMinor, summary.costs.currency) : '—'} detail="Pozitív billing tételek, például Allegro Ceny támogatás" tone="active" />
          <MetricCard label="Árbevétel elszámolás után" value={summary?.permissions.orders && summary.permissions.billing ? formatMoney(summary.costs.netAfterAllegroCostsMinor, summary.costs.currency) : '—'} detail="Termékárbevétel − díjak + jóváírások" tone="active" />
        </div>
      </section>

      <p className="allegro-overview-footnote allegro-overview-footnote-last">
        Az árbevétel a READY_FOR_PROCESSING rendeléseket számolja. A szállítási díj, termékbeszerzési költség és visszatérítések még nem részei a nettó eredménynek.
      </p>
    </div>
  )
}

export default AllegroOverviewPage
