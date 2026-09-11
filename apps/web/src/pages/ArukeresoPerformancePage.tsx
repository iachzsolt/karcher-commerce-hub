import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'
import ArukeresoTrendChart, {
  type TrendChartSeries,
} from '../components/ArukeresoTrendChart'
import {
  aggregateProducts,
  applyProductView,
  budapestDateString,
  computeRatios,
  eachDateInRange,
  formatCount,
  formatMoney,
  formatRatioPercent,
  formatRoas,
  groupTrendPoints,
  last7CompletedDays,
  resolvePresetRange,
  shiftBudapestDate,
  sumDayRows,
  validateCustomRange,
  type AggregatedProduct,
  type PerformanceDayRow,
  type PerformancePreset,
  type PerformanceRatios,
} from '../utils/arukeresoPerformance'

type DayLoadState =
  | { status: 'pending' | 'loading' }
  | { status: 'ok'; rows: PerformanceDayRow[] }
  | { status: 'error'; message: string }

type MetricKey =
  | 'visits'
  | 'orders'
  | 'cost'
  | 'revenue'
  | 'roas'
  | 'crr'
  | 'cvr'
  | 'cpc'
  | 'aov'

type MetricDef = {
  key: MetricKey
  label: string
  color: string
  unit: 'count' | 'money' | 'percent' | 'ratio'
  format: (value: number | null) => string
}

const METRICS: MetricDef[] = [
  {
    key: 'visits',
    label: 'Kattintás',
    color: '#0873c5',
    unit: 'count',
    format: formatCount,
  },
  {
    key: 'orders',
    label: 'Rendelés',
    color: '#237523',
    unit: 'count',
    format: formatCount,
  },
  {
    key: 'cost',
    label: 'Költség',
    color: '#c24e00',
    unit: 'money',
    format: (value) => formatMoney(value, null),
  },
  {
    key: 'revenue',
    label: 'Bevétel',
    color: '#6b4fa1',
    unit: 'money',
    format: (value) => formatMoney(value, null),
  },
  {
    key: 'roas',
    label: 'ROAS',
    color: '#0e7490',
    unit: 'ratio',
    format: formatRoas,
  },
  {
    key: 'crr',
    label: 'CRR',
    color: '#a16207',
    unit: 'percent',
    format: formatRatioPercent,
  },
  {
    key: 'cvr',
    label: 'CVR',
    color: '#4d7c0f',
    unit: 'percent',
    format: formatRatioPercent,
  },
  {
    key: 'cpc',
    label: 'CPC',
    color: '#9a3412',
    unit: 'money',
    format: (value) => formatMoney(value, null),
  },
  {
    key: 'aov',
    label: 'AOV',
    color: '#6d28d9',
    unit: 'money',
    format: (value) => formatMoney(value, null),
  },
]

const METRIC_BY_KEY: Record<MetricKey, MetricDef> =
  Object.fromEntries(
    METRICS.map((metric) => [metric.key, metric]),
  ) as Record<MetricKey, MetricDef>

type SortKey =
  | 'sku'
  | 'name'
  | 'visits'
  | 'orders'
  | 'cost'
  | 'revenue'
  | 'roas'
  | 'crr'
  | 'cvr'
  | 'cpc'
  | 'aov'

const SORT_COLUMNS: Array<{
  key: SortKey
  label: string
  numeric: boolean
}> = [
  { key: 'sku', label: 'SKU', numeric: false },
  { key: 'name', label: 'Termék', numeric: false },
  { key: 'visits', label: 'Kattintás', numeric: true },
  { key: 'orders', label: 'Rendelés', numeric: true },
  { key: 'cost', label: 'Költség', numeric: true },
  { key: 'revenue', label: 'Bevétel', numeric: true },
  { key: 'roas', label: 'ROAS', numeric: true },
  { key: 'crr', label: 'CRR', numeric: true },
  { key: 'cvr', label: 'CVR', numeric: true },
  { key: 'cpc', label: 'CPC', numeric: true },
  { key: 'aov', label: 'AOV', numeric: true },
]

const PAGE_SIZE = 50
const LOAD_CONCURRENCY = 3
const MAX_RANGE_DAYS = 366

function defaultDates(): string[] {
  return last7CompletedDays(
    budapestDateString(new Date()),
  )
}

function ArukeresoPerformancePage() {
  const [preset, setPreset] = useState<
    PerformancePreset | 'custom'
  >('last7')
  const [from, setFrom] = useState(() => {
    const range = resolvePresetRange(
      'last7',
      new Date(),
    )

    return range.from
  })
  const [to, setTo] = useState(() => {
    const range = resolvePresetRange(
      'last7',
      new Date(),
    )

    return range.to
  })
  const [dates, setDates] = useState<string[]>(
    () => defaultDates(),
  )
  const [dayData, setDayData] = useState<
    Record<string, DayLoadState>
  >({})
  const [rangeError, setRangeError] = useState<
    string | null
  >(null)
  const runRef = useRef(0)

  const [search, setSearch] = useState('')
  const [sort, setSort] =
    useState<SortKey>('cost')
  const [order, setOrder] = useState<'asc' | 'desc'>(
    'desc',
  )
  const [hasCost, setHasCost] = useState(false)
  const [hasOrders, setHasOrders] = useState(false)
  const [hasRevenue, setHasRevenue] = useState(false)
  const [trendGroup, setTrendGroup] = useState<
    'day' | 'week' | 'month'
  >('day')
  const [trendPrimary, setTrendPrimary] =
    useState<MetricKey>('revenue')
  const [trendSecondary, setTrendSecondary] =
    useState<MetricKey | 'none'>('cost')
  const [page, setPage] = useState(0)

  const loadDates = useCallback(
    async (
      fetchDates: string[],
      nextDates: string[],
    ) => {
      const run = runRef.current + 1
      runRef.current = run
      setDates(nextDates)
      setRangeError(null)
      setDayData((previous) => {
        const next = { ...previous }

        for (const date of fetchDates) {
          next[date] = { status: 'pending' }
        }

        return next
      })

      let cursor = 0

      async function worker() {
        while (runRef.current === run) {
          const index = cursor
          cursor += 1

          if (index >= fetchDates.length) {
            return
          }

          const date = fetchDates[index]

          setDayData((previous) => ({
            ...previous,
            [date]: { status: 'loading' },
          }))

          try {
            const response = await fetch(
              `${API_BASE_URL}/arukereso/performance/day?date=${date}`,
            )
            const body = (await response.json()) as {
              rows?: PerformanceDayRow[]
              message?: string
            }

            if (
              runRef.current !== run ||
              !response.ok ||
              !Array.isArray(body.rows)
            ) {
              if (runRef.current !== run) {
                return
              }

              throw new Error(
                body.message ??
                  `A(z) ${date} nap betöltése sikertelen.`,
              )
            }

            const rows = body.rows.map((row) => ({
              ...row,
              date,
            }))
            setDayData((previous) => ({
              ...previous,
              [date]: { status: 'ok', rows },
            }))
          } catch (loadError) {
            if (runRef.current !== run) {
              return
            }

            setDayData((previous) => ({
              ...previous,
              [date]: {
                status: 'error',
                message:
                  loadError instanceof Error
                    ? loadError.message
                    : `A(z) ${date} nap betöltése sikertelen.`,
              },
            }))
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: LOAD_CONCURRENCY },
          () => worker(),
        ),
      )
    },
    [],
  )

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadDates(defaultDates(), defaultDates())
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [loadDates])

  const maxSelectableDate = useMemo(
    () => shiftBudapestDate(new Date(), -1),
    [],
  )

  function applyCustomRange() {
    const validated = validateCustomRange(
      from,
      to,
      budapestDateString(new Date()),
      MAX_RANGE_DAYS,
    )

    if (!validated.ok) {
      setRangeError(validated.message)
      return
    }

    setPage(0)
    void loadDates(validated.dates, validated.dates)
  }

  function applyPreset(preset: PerformancePreset) {
    const range = resolvePresetRange(preset, new Date())
    setPreset(preset)
    setFrom(range.from)
    setTo(range.to)
    setPage(0)
    void loadDates(
      eachDateInRange(range.from, range.to),
      eachDateInRange(range.from, range.to),
    )
  }

  function retryFailedDays() {
    const failed = dates.filter(
      (date) =>
        dayData[date]?.status === 'error',
    )

    if (failed.length === 0) {
      return
    }

    void loadDates(failed, dates)
  }

  const loadedDays = useMemo(
    () =>
      dates.map((date) => ({
        date,
        state: dayData[date] ?? {
          status: 'pending' as const,
        },
      })),
    [dates, dayData],
  )
  const doneCount = loadedDays.filter(
    (day) =>
      day.state.status === 'ok' ||
      day.state.status === 'error',
  ).length
  const failedDays = loadedDays.filter(
    (day) => day.state.status === 'error',
  )
  const loadingActive = doneCount < dates.length

  const allRows = useMemo(
    () =>
      loadedDays.flatMap((day) =>
        day.state.status === 'ok'
          ? (day.state.rows ?? [])
          : [],
      ),
    [loadedDays],
  )

  const sums = useMemo(
    () => sumDayRows(allRows),
    [allRows],
  )
  const ratios: PerformanceRatios = useMemo(
    () => computeRatios(sums),
    [sums],
  )

  const trendBuckets = useMemo(
    () => groupTrendPoints(allRows, trendGroup),
    [allRows, trendGroup],
  )
  const trendPoints = trendBuckets.map(
    (bucket) => ({
      bucket: bucket.bucket,
      values: {
        visits: bucket.sums.visits,
        orders: bucket.sums.orders,
        cost: bucket.sums.costGross,
        revenue: bucket.sums.revenue,
        roas: bucket.ratios.roas,
        crr: bucket.ratios.crr,
        cvr: bucket.ratios.cvr,
        cpc: bucket.ratios.cpc,
        aov: bucket.ratios.aov,
      } as Record<string, number | null>,
    }),
  )

  const productItems: AggregatedProduct[] = useMemo(
    () =>
      applyProductView(aggregateProducts(allRows), {
        search,
        sort: sort as string,
        order,
        hasCost,
        hasOrders,
        hasRevenue,
      }),
    [
      allRows,
      search,
      sort,
      order,
      hasCost,
      hasOrders,
      hasRevenue,
    ],
  )
  const total = productItems.length
  const pageItems = productItems.slice(
    page * PAGE_SIZE,
    (page + 1) * PAGE_SIZE,
  )

  const primaryDef = METRIC_BY_KEY[trendPrimary]
  const secondaryDef =
    trendSecondary === 'none'
      ? null
      : METRIC_BY_KEY[trendSecondary]
  const trendSeries: TrendChartSeries[] = [
    {
      key: primaryDef.key,
      label: primaryDef.label,
      color: primaryDef.color,
      axis: 'left',
      format: primaryDef.format,
    },
    ...(secondaryDef
      ? [
          {
            key: secondaryDef.key,
            label: secondaryDef.label,
            color: secondaryDef.color,
            axis:
              secondaryDef.unit === primaryDef.unit
                ? ('left' as const)
                : ('right' as const),
            format: secondaryDef.format,
          },
        ]
      : []),
  ]

  const showPlaceholders = doneCount === 0
  const allFailed =
    dates.length > 0 &&
    failedDays.length === dates.length

  const kpis: Array<{
    label: string
    value: string
  }> = [
    {
      label: 'Kattintások',
      value: formatCount(
        showPlaceholders ? null : sums.visits,
      ),
    },
    {
      label: 'Rendelések',
      value: formatCount(
        showPlaceholders ? null : sums.orders,
      ),
    },
    {
      label: 'Költség',
      value: formatMoney(
        showPlaceholders ? null : sums.costGross,
        null,
      ),
    },
    {
      label: 'Bevétel',
      value: formatMoney(
        showPlaceholders ? null : sums.revenue,
        null,
      ),
    },
    {
      label: 'ROAS',
      value: formatRoas(
        showPlaceholders ? null : ratios.roas,
      ),
    },
    {
      label: 'CRR',
      value: formatRatioPercent(
        showPlaceholders ? null : ratios.crr,
      ),
    },
    {
      label: 'CVR',
      value: formatRatioPercent(
        showPlaceholders ? null : ratios.cvr,
      ),
    },
    {
      label: 'CPC',
      value: formatMoney(
        showPlaceholders ? null : ratios.cpc,
        null,
      ),
    },
    {
      label: 'AOV',
      value: formatMoney(
        showPlaceholders ? null : ratios.aov,
        null,
      ),
    },
  ]

  const pageCount = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE),
  )

  function changeSort(column: SortKey) {
    const nextOrder: 'asc' | 'desc' =
      sort === column
        ? order === 'asc'
          ? 'desc'
          : 'asc'
        : column === 'sku' || column === 'name'
          ? 'asc'
          : 'desc'
    setSort(column)
    setOrder(nextOrder)
    setPage(0)
  }

  return (
    <section className="campaigns-page ap-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">
            ÁRUKERESŐ TELJESÍTMÉNY
          </p>
          <h2>Teljesítmény</h2>
          <p className="campaigns-page-description">
            Heureka hirdetési teljesítmény:
            kattintások, rendelések, költség és
            bevétel.
          </p>
        </div>
      </div>

      <div className="ap-toolbar">
        <div
          className="ap-presets"
          role="group"
          aria-label="Időszak"
        >
          {(
            [
              ['last7', 'Utolsó 7 nap'],
              ['last30', '30 nap'],
              ['month', 'Aktuális hónap'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={
                preset === value
                  ? 'secondary-button ap-preset-active'
                  : 'secondary-button'
              }
              onClick={() => applyPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <label>
          <span>Mettől</span>
          <input
            type="date"
            value={from}
            max={maxSelectableDate}
            onChange={(event) => {
              setFrom(event.target.value)
              setPreset('custom')
            }}
          />
        </label>

        <label>
          <span>Meddig</span>
          <input
            type="date"
            value={to}
            max={maxSelectableDate}
            onChange={(event) => {
              setTo(event.target.value)
              setPreset('custom')
            }}
          />
        </label>

        <button
          type="button"
          className="campaign-primary-button"
          onClick={() => {
            if (preset === 'custom') {
              applyCustomRange()
            } else {
              void loadDates(dates, dates)
            }
          }}
        >
          Frissítés
        </button>

        <label className="ap-search">
          <span>Keresés</span>
          <input
            type="search"
            value={search}
            placeholder="SKU vagy terméknév"
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
        </label>

        <label className="ap-check">
          <input
            type="checkbox"
            checked={hasCost}
            onChange={(event) => {
              setHasCost(event.target.checked)
              setPage(0)
            }}
          />
          <span>Költség &gt; 0</span>
        </label>

        <label className="ap-check">
          <input
            type="checkbox"
            checked={hasOrders}
            onChange={(event) => {
              setHasOrders(event.target.checked)
              setPage(0)
            }}
          />
          <span>Rendelés &gt; 0</span>
        </label>

        <label className="ap-check">
          <input
            type="checkbox"
            checked={hasRevenue}
            onChange={(event) => {
              setHasRevenue(event.target.checked)
              setPage(0)
            }}
          />
          <span>Bevétel &gt; 0</span>
        </label>
      </div>

      {rangeError && (
        <div className="campaign-message campaign-message-error">
          {rangeError}
        </div>
      )}

      <div className="ap-progress">
        <div className="ap-progress-top">
          <strong>
            {loadingActive
              ? 'Árukereső adatok betöltése'
              : `${doneCount} / ${dates.length} nap betöltve`}
          </strong>
          <span>
            {doneCount} / {dates.length} nap
          </span>
        </div>
        <div
          className="ap-progress-bar"
          role="progressbar"
          aria-valuenow={doneCount}
          aria-valuemin={0}
          aria-valuemax={dates.length}
        >
          <span
            style={{
              width:
                dates.length === 0
                  ? '0%'
                  : `${Math.round(
                      (doneCount / dates.length) *
                        100,
                    )}%`,
            }}
          />
        </div>
        {!loadingActive && failedDays.length > 0 && (
          <div className="ap-progress-failed">
            <span>
              Részleges adatok –{' '}
              {failedDays.length} sikertelen
              nap:{' '}
              {failedDays
                .map((day) => day.date)
                .join(', ')}
            </span>
            <button
              type="button"
              className="secondary-button"
              onClick={retryFailedDays}
            >
              {failedDays.length} sikertelen nap
              újrapróbálása
            </button>
          </div>
        )}
      </div>

      {allFailed ? (
        <div className="campaign-message campaign-message-error">
          <span>
            Az időszak egyetlen napját sem
            sikerült betölteni. Ellenőrizd a
            kapcsolatot, majd próbáld újra.
          </span>
          <div>
            <button
              type="button"
              className="secondary-button"
              onClick={retryFailedDays}
            >
              Újrapróbálás
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="ap-kpis">
            {kpis.map((kpi) => (
              <div key={kpi.label}>
                <span>{kpi.label}</span>
                <strong>{kpi.value}</strong>
              </div>
            ))}
          </div>

          <article className="ap-card">
            <header className="ap-card-header">
              <h3>Trend</h3>
              <div className="ap-trend-controls">
                <label>
                  <span>Csoportosítás</span>
                  <select
                    value={trendGroup}
                    onChange={(event) => {
                      setTrendGroup(
                        event.target.value as
                          | 'day'
                          | 'week'
                          | 'month',
                      )
                    }}
                  >
                    <option value="day">
                      Napi
                    </option>
                    <option value="week">
                      Heti
                    </option>
                    <option value="month">
                      Havi
                    </option>
                  </select>
                </label>
                <label>
                  <span>1. metrika</span>
                  <select
                    value={trendPrimary}
                    onChange={(event) => {
                      setTrendPrimary(
                        event.target
                          .value as MetricKey,
                      )
                    }}
                  >
                    {METRICS.map((metric) => (
                      <option
                        key={metric.key}
                        value={metric.key}
                      >
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>2. metrika</span>
                  <select
                    value={trendSecondary}
                    onChange={(event) => {
                      setTrendSecondary(
                        event.target
                          .value as
                          | MetricKey
                          | 'none',
                      )
                    }}
                  >
                    <option value="none">
                      Nincs
                    </option>
                    {METRICS.map((metric) => (
                      <option
                        key={metric.key}
                        value={metric.key}
                      >
                        {metric.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </header>

            {showPlaceholders ? (
              <p className="hub-muted-line">
                Trend betöltése…
              </p>
            ) : trendBuckets.length === 0 ? (
              <p className="hub-muted-line">
                Nincs teljesítményadat a
                kiválasztott időszakban.
              </p>
            ) : (
              <ArukeresoTrendChart
                points={trendPoints}
                series={trendSeries}
              />
            )}
          </article>

          <div className="campaign-offers-panel">
            <div className="campaign-offers-table-wrapper">
              <table className="campaign-offers-table ap-table">
                <thead>
                  <tr>
                    {SORT_COLUMNS.map(
                      (column) => (
                        <th
                          key={column.key}
                          className={
                            column.numeric
                              ? 'ap-num'
                              : undefined
                          }
                          aria-sort={
                            sort === column.key
                              ? order === 'asc'
                                ? 'ascending'
                                : 'descending'
                              : undefined
                          }
                        >
                          <button
                            type="button"
                            className="ap-sort"
                            onClick={() =>
                              changeSort(column.key)
                            }
                          >
                            {column.label}
                            {sort === column.key &&
                              (order === 'asc'
                                ? ' ↑'
                                : ' ↓')}
                          </button>
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.key}>
                      <td>
                        <strong>
                          {item.sku ??
                            item.normalizedProductCode}
                        </strong>
                      </td>
                      <td
                        className="ap-name"
                        title={
                          item.productName ??
                          item.normalizedProductCode
                        }
                      >
                        {item.productName ??
                          item.normalizedProductCode}
                        {item.matchStatus ===
                          'UNMATCHED' && (
                          <small>
                            {' '}
                            · nincs egyezés
                          </small>
                        )}
                      </td>
                      <td className="ap-num">
                        {formatCount(
                          item.sums.visits,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatCount(
                          item.sums.orders,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatMoney(
                          item.sums.costGross,
                          null,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatMoney(
                          item.sums.revenue,
                          null,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatRoas(
                          item.ratios.roas,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatRatioPercent(
                          item.ratios.crr,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatRatioPercent(
                          item.ratios.cvr,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatMoney(
                          item.ratios.cpc,
                          null,
                        )}
                      </td>
                      <td className="ap-num">
                        {formatMoney(
                          item.ratios.aov,
                          null,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {pageItems.length === 0 &&
              !loadingActive && (
                <div className="empty-state">
                  <h3>Nincs találat</h3>
                  <p>
                    Nincs teljesítményadat a
                    kiválasztott időszakban.
                  </p>
                </div>
              )}

            <div className="campaign-submit-bar">
              <span>
                {total === 0
                  ? '0 találat'
                  : `${page * PAGE_SIZE + 1}–${Math.min(
                      (page + 1) * PAGE_SIZE,
                      total,
                    )} / ${total}`}
              </span>
              <div className="campaign-submit-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                >
                  Előző
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage(page + 1)}
                >
                  Következő
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default ArukeresoPerformancePage
