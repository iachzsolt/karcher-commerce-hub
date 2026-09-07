import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

type FeedProductRow = {
  productId: string
  sku: string
  name: string | null
  included: boolean
  inclusionMode:
    | 'INHERIT'
    | 'FORCE_INCLUDE'
    | 'FORCE_EXCLUDE'
  priceIndexBps: number | null
  priceIndexPercent: number | null
  dataStatus: string | null
  observedAt: string | null
  reasonCode: string
  reasonDetails: {
    maxPriceIndexBps: number
    priceIndexBps: number | null
  }
}

type FeedProductsResponse = {
  status: string
  summary?: Record<string, number>
  pagination?: {
    limit: number
    offset: number
    total: number
  }
  items?: FeedProductRow[]
  message?: string
}

const REASON_CODES = [
  'FEED_ELIGIBLE_PRICE_INDEX',
  'FEED_BLOCKED_PRICE_INDEX',
  'FEED_ELIGIBLE_NO_COMPETITOR',
  'FEED_BLOCKED_NO_COMPETITOR',
  'FEED_ELIGIBLE_MANUAL_OVERRIDE',
  'FEED_BLOCKED_MANUAL_OVERRIDE',
  'FEED_ELIGIBLE_MISSING_PRICING',
  'FEED_BLOCKED_MISSING_PRICING',
  'FEED_ELIGIBLE_STALE_PRICING',
  'FEED_BLOCKED_STALE_PRICING',
  'FEED_BLOCKED_PARTIAL_MARKET_DATA',
]

function formatPercent(
  value: number | null,
) {
  if (value === null) {
    return '–'
  }

  const rounded =
    Math.round(value * 10) / 10

  return Number.isInteger(rounded)
    ? `${rounded}%`
    : `${String(rounded).replace('.', ',')}%`
}

function formatFeedReason(
  row: FeedProductRow,
): string {
  const price =
    row.priceIndexBps === null
      ? null
      : row.priceIndexBps / 100

  const max =
    row.reasonDetails.maxPriceIndexBps /
    100

  switch (row.reasonCode) {
    case 'FEED_ELIGIBLE_PRICE_INDEX':
      return `Feedben – árindex ${formatPercent(price)} ≤ ${formatPercent(max)}`
    case 'FEED_BLOCKED_PRICE_INDEX':
      return `Kihagyva – árindex ${formatPercent(price)} > ${formatPercent(max)}`
    case 'FEED_ELIGIBLE_NO_COMPETITOR':
      return 'Feedben – nincs competitor, engedélyezve'
    case 'FEED_BLOCKED_NO_COMPETITOR':
      return 'Kihagyva – nincs competitor'
    case 'FEED_ELIGIBLE_MANUAL_OVERRIDE':
      return 'Feedben – manuális override'
    case 'FEED_BLOCKED_MANUAL_OVERRIDE':
      return 'Kihagyva – manuális override'
    case 'FEED_ELIGIBLE_MISSING_PRICING':
      return 'Feedben – nincs pricing adat, engedélyezve'
    case 'FEED_BLOCKED_MISSING_PRICING':
      return 'Kihagyva – nincs pricing adat'
    case 'FEED_ELIGIBLE_STALE_PRICING':
      return 'Feedben – pricing adat elavult, engedélyezve'
    case 'FEED_BLOCKED_STALE_PRICING':
      return 'Kihagyva – pricing adat elavult'
    case 'FEED_BLOCKED_PARTIAL_MARKET_DATA':
      return 'Kihagyva – részleges piaci adat'
    default:
      return row.reasonCode
  }
}

const PAGE_SIZE = 50

function ArukeresoProductsPage() {
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] =
    useState('')

  const [includedFilter, setIncludedFilter] =
    useState<'all' | 'included' | 'excluded'>(
      'all',
    )

  const [modeFilter, setModeFilter] = useState<
    | 'all'
    | 'INHERIT'
    | 'FORCE_INCLUDE'
    | 'FORCE_EXCLUDE'
  >('all')

  const [reasonFilter, setReasonFilter] =
    useState('all')

  const [page, setPage] = useState(0)

  const [items, setItems] = useState<
    FeedProductRow[]
  >([])

  const [total, setTotal] = useState(0)

  const [loading, setLoading] =
    useState(true)

  const [error, setError] = useState<
    string | null
  >(null)

  const [message, setMessage] = useState<
    string | null
  >(null)

  const [savingProductId, setSavingProductId] =
    useState<string | null>(null)

  const loadProducts = useCallback(
    async (pageIndex: number) => {
      setLoading(true)
      setError(null)

      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(
            pageIndex * PAGE_SIZE,
          ),
        })

        if (appliedSearch.trim()) {
          params.set(
            'search',
            appliedSearch.trim(),
          )
        }

        if (modeFilter !== 'all') {
          params.set(
            'inclusionMode',
            modeFilter,
          )
        }

        if (includedFilter !== 'all') {
          params.set(
            'included',
            includedFilter === 'included'
              ? 'true'
              : 'false',
          )
        }

        if (reasonFilter !== 'all') {
          params.set(
            'reasonCode',
            reasonFilter,
          )
        }

        const response = await fetch(
          `${API_BASE_URL}/arukereso/feed/preview?${params.toString()}`,
        )

        const result =
          (await response.json()) as FeedProductsResponse

        if (!response.ok) {
          throw new Error(
            result.message ??
              'A terméklista betöltése sikertelen.',
          )
        }

        setItems(result.items ?? [])
        setTotal(
          result.pagination?.total ?? 0,
        )
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'A terméklista betöltése sikertelen.',
        )
        setItems([])
        setTotal(0)
      } finally {
        setLoading(false)
      }
    },
    [
      appliedSearch,
      includedFilter,
      modeFilter,
      reasonFilter,
    ],
  )

  useEffect(() => {
    void loadProducts(page)
  }, [loadProducts, page])

  function applyFilters() {
    setAppliedSearch(search)
    setPage(0)
  }

  async function changeOverride(
    productId: string,
    inclusionMode:
      | 'INHERIT'
      | 'FORCE_INCLUDE'
      | 'FORCE_EXCLUDE',
  ) {
    setSavingProductId(productId)
    setMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/products/${productId}/override`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            inclusionMode,
          }),
        },
      )

      const result = (await response.json()) as {
        status: string
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Az override mentése sikertelen.',
        )
      }

      setMessage(
        inclusionMode === 'INHERIT'
          ? 'Felülírás törölve, globális szabály érvényes.'
          : 'Felülírás elmentve.',
      )

      await loadProducts(page)
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : 'Az override mentése sikertelen.',
      )
    } finally {
      setSavingProductId(null)
    }
  }

  const pageCount = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE),
  )

  return (
    <section className="campaigns-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">
            ÁRUKERESŐ FEED
          </p>

          <h2>Termék-jogosultság</h2>

          <p className="campaigns-page-description">
            Feed-jogosultság termékenként,
            a backend döntése alapján.
            {total > 0 &&
              ` Összesen ${total} termék.`}
          </p>
        </div>
      </div>

      <div className="campaign-offers-panel">
        <div className="campaign-offers-heading">
          <div>
            <p className="section-label">
              SZŰRŐK
            </p>

            <h4>Keresés és szűrés</h4>
          </div>
        </div>

        <div className="campaign-offers-table-wrapper">
          <table className="campaign-offers-table">
            <tbody>
              <tr>
                <td>Keresés (SKU/név)</td>
                <td>
                  <input
                    type="search"
                    value={search}
                    onChange={(event) =>
                      setSearch(
                        event.target.value,
                      )
                    }
                    placeholder="SKU vagy terméknév"
                  />
                </td>
              </tr>

              <tr>
                <td>Feed státusz</td>
                <td>
                  <select
                    value={includedFilter}
                    onChange={(event) =>
                      setIncludedFilter(
                        event.target.value as
                          | 'all'
                          | 'included'
                          | 'excluded',
                      )
                    }
                  >
                    <option value="all">
                      Mind
                    </option>
                    <option value="included">
                      Feedben
                    </option>
                    <option value="excluded">
                      Kihagyva
                    </option>
                  </select>
                </td>
              </tr>

              <tr>
                <td>Szabály</td>
                <td>
                  <select
                    value={modeFilter}
                    onChange={(event) =>
                      setModeFilter(
                        event.target.value as
                          | 'all'
                          | 'INHERIT'
                          | 'FORCE_INCLUDE'
                          | 'FORCE_EXCLUDE',
                      )
                    }
                  >
                    <option value="all">
                      Mind
                    </option>
                    <option value="INHERIT">
                      Globális szabály
                    </option>
                    <option value="FORCE_INCLUDE">
                      Mindig feedben
                    </option>
                    <option value="FORCE_EXCLUDE">
                      Mindig kihagyva
                    </option>
                  </select>
                </td>
              </tr>

              <tr>
                <td>Döntés oka</td>
                <td>
                  <select
                    value={reasonFilter}
                    onChange={(event) =>
                      setReasonFilter(
                        event.target.value,
                      )
                    }
                  >
                    <option value="all">
                      Mind
                    </option>
                    {REASON_CODES.map(
                      (code) => (
                        <option
                          key={code}
                          value={code}
                        >
                          {code}
                        </option>
                      ),
                    )}
                  </select>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="campaign-submit-bar">
          <span>
            {total} találat
          </span>

          <div className="campaign-submit-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={applyFilters}
            >
              Szűrés
            </button>
          </div>
        </div>
      </div>

      {message && (
        <div className="campaign-preparation-message">
          {message}
        </div>
      )}

      {error ? (
        <div className="campaign-message campaign-message-error">
          {error}
        </div>
      ) : loading && items.length === 0 ? (
        <div className="campaign-message">
          Terméklista betöltése…
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>Nincs találat</h3>

          <p>
            A megadott szűrőknek egyetlen
            termék sem felel meg.
          </p>
        </div>
      ) : (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Terméknév</th>
                  <th>Árindex</th>
                  <th>Pricing státusz</th>
                  <th>Feed státusz</th>
                  <th>Szabály</th>
                  <th>Művelet</th>
                </tr>
              </thead>

              <tbody>
                {items.map((row) => (
                  <tr key={row.productId}>
                    <td>{row.sku}</td>

                    <td>
                      {row.name ?? '–'}
                    </td>

                    <td>
                      {formatPercent(
                        row.priceIndexPercent,
                      )}
                    </td>

                    <td>
                      {row.dataStatus ??
                        '–'}
                    </td>

                    <td>
                      <span className="status-pill">
                        {row.included
                          ? 'Feedben'
                          : 'Kihagyva'}
                      </span>

                      <div>
                        {formatFeedReason(
                          row,
                        )}
                      </div>
                    </td>

                    <td>
                      {row.inclusionMode ===
                      'FORCE_INCLUDE' ? (
                        <span
                          className="status-pill"
                          title="Cockpit pricing szabályok figyelmen kívül hagyva"
                        >
                          Mindig feedben –
                          Cockpit pricing
                          szabályok figyelmen
                          kívül hagyva
                        </span>
                      ) : row.inclusionMode ===
                        'FORCE_EXCLUDE' ? (
                        <span
                          className="status-pill"
                          title="Manuálisan kizárva"
                        >
                          Mindig kihagyva –
                          manuálisan kizárva
                        </span>
                      ) : (
                        'Globális szabály'
                      )}
                    </td>

                    <td>
                      <select
                        value={
                          row.inclusionMode
                        }
                        disabled={
                          savingProductId ===
                          row.productId
                        }
                        onChange={(
                          event,
                        ) =>
                          void changeOverride(
                            row.productId,
                            event.target
                              .value as
                              | 'INHERIT'
                              | 'FORCE_INCLUDE'
                              | 'FORCE_EXCLUDE',
                          )
                        }
                      >
                        <option value="INHERIT">
                          Globális szabály
                        </option>
                        <option value="FORCE_INCLUDE">
                          Mindig feedben
                        </option>
                        <option value="FORCE_EXCLUDE">
                          Mindig kihagyva
                        </option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="campaign-submit-bar">
            <span>
              {page * PAGE_SIZE + 1}–
              {Math.min(
                (page + 1) * PAGE_SIZE,
                total,
              )}{' '}
              / {total}
            </span>

            <div className="campaign-submit-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={
                  loading || page === 0
                }
                onClick={() =>
                  setPage(page - 1)
                }
              >
                Előző
              </button>

              <button
                type="button"
                className="secondary-button"
                disabled={
                  loading ||
                  page + 1 >= pageCount
                }
                onClick={() =>
                  setPage(page + 1)
                }
              >
                Következő
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default ArukeresoProductsPage
