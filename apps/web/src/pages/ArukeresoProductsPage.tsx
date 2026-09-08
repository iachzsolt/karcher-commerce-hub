import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { API_BASE_URL } from '../config/api'

type InclusionMode =
  | 'INHERIT'
  | 'FORCE_INCLUDE'
  | 'FORCE_EXCLUDE'

type PriceKitStatus =
  | 'HAS_DATA'
  | 'NO_DATA'
  | 'STALE_DATA'
  | 'NO_COMPETITOR'
  | 'PARTIAL_DATA'

type StockStatus =
  | 'IN_STOCK'
  | 'OUT_OF_STOCK'
  | 'MISSING_STOCK'

type FeedProductRow = {
  productId: string
  sku: string
  name: string | null
  hasPriceKitData: boolean
  priceKitStatus: PriceKitStatus
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  stockQuantity: number | null
  stockAvailable: boolean | null
  stockStatus: StockStatus
  included: boolean
  inclusionMode: InclusionMode
  reasonCode: string
  reasonDetails: {
    maxMinIndexBps: number
    maxMedianIndexBps: number
    maxAverageIndexBps: number
  }
}

type FeedProductsResponse = {
  summary?: Record<string, number>
  pagination?: {
    total: number
  }
  items?: FeedProductRow[]
  message?: string
}

type ProductFilters = {
  search: string
  priceKitStatus:
    | 'ALL'
    | 'HAS_DATA'
    | 'NO_DATA'
    | 'STALE_DATA'
    | 'NO_COMPETITOR'
  feedStatus: 'ALL' | 'INCLUDED' | 'EXCLUDED'
  inclusionMode: 'ALL' | InclusionMode
  stockStatus: 'ALL' | StockStatus
}

const EMPTY_FILTERS: ProductFilters = {
  search: '',
  priceKitStatus: 'ALL',
  feedStatus: 'ALL',
  inclusionMode: 'ALL',
  stockStatus: 'ALL',
}

const PAGE_SIZE = 50

function formatPercent(value: number | null) {
  if (value === null) {
    return '–'
  }

  const percent = Math.round(value) / 100
  return `${String(percent).replace('.', ',')}%`
}

function formatStock(row: FeedProductRow) {
  if (row.stockStatus === 'MISSING_STOCK') {
    return 'Nincs adat'
  }

  return row.stockStatus === 'IN_STOCK'
    ? `${row.stockQuantity} db`
    : 'Nincs készleten'
}

function getPriceKitLabel(status: PriceKitStatus) {
  switch (status) {
    case 'HAS_DATA':
      return 'Van adat'
    case 'NO_DATA':
      return 'Nincs adat'
    case 'STALE_DATA':
      return 'Elavult'
    case 'NO_COMPETITOR':
      return 'Nincs competitor'
    case 'PARTIAL_DATA':
      return 'Hiányos adat'
  }
}

function formatFeedReason(row: FeedProductRow) {
  switch (row.reasonCode) {
    case 'FEED_ELIGIBLE_PRICING_RULES':
      return 'Minden aktív feed-szabály teljesül'
    case 'FEED_BLOCKED_MIN_INDEX':
      return `Minimum index ${formatPercent(row.priceIndexBps)} > ${formatPercent(row.reasonDetails.maxMinIndexBps)}`
    case 'FEED_BLOCKED_MEDIAN_INDEX':
      return `Medián index ${formatPercent(row.medianIndexBps)} > ${formatPercent(row.reasonDetails.maxMedianIndexBps)}`
    case 'FEED_BLOCKED_AVERAGE_INDEX':
      return `Átlagindex ${formatPercent(row.averageIndexBps)} > ${formatPercent(row.reasonDetails.maxAverageIndexBps)}`
    case 'FEED_BLOCKED_MISSING_MIN_INDEX':
      return 'Az aktív minimumindex-szabályhoz nincs adat'
    case 'FEED_BLOCKED_MISSING_MEDIAN_INDEX':
      return 'Az aktív mediánszabályhoz nincs adat'
    case 'FEED_BLOCKED_MISSING_AVERAGE_INDEX':
      return 'Az aktív átlagindex-szabályhoz nincs adat'
    case 'FEED_BLOCKED_OUT_OF_STOCK':
      return 'Nincs készleten'
    case 'FEED_BLOCKED_MISSING_STOCK':
      return 'Nincs készletadat'
    case 'FEED_ELIGIBLE_NO_COMPETITOR':
      return 'Competitor nélkül engedélyezve'
    case 'FEED_BLOCKED_NO_COMPETITOR':
      return 'Nincs competitor'
    case 'FEED_ELIGIBLE_MISSING_PRICING':
      return 'PriceKit adat nélkül engedélyezve'
    case 'FEED_BLOCKED_MISSING_PRICING':
      return 'Nincs PriceKit adat'
    case 'FEED_ELIGIBLE_STALE_PRICING':
      return 'Elavult PriceKit adattal engedélyezve'
    case 'FEED_BLOCKED_STALE_PRICING':
      return 'A PriceKit adat elavult'
    case 'FEED_BLOCKED_PARTIAL_MARKET_DATA':
      return 'A piaci adat hiányos'
    case 'FEED_ELIGIBLE_MANUAL_OVERRIDE':
      return 'Manuális felülírás'
    case 'FEED_BLOCKED_MANUAL_OVERRIDE':
      return 'Manuálisan kihagyva'
    default:
      return 'A feed-döntés részlete nem elérhető'
  }
}

function ArukeresoProductsPage() {
  const [filters, setFilters] =
    useState<ProductFilters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] =
    useState<ProductFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<
    FeedProductRow[]
  >([])
  const [summary, setSummary] = useState<
    Record<string, number>
  >({})
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<
    string | null
  >(null)
  const [message, setMessage] = useState<
    string | null
  >(null)
  const [savingProductId, setSavingProductId] =
    useState<string | null>(null)

  function updateFilter<K extends keyof ProductFilters>(
    key: K,
    value: ProductFilters[K],
  ) {
    setFilters((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const loadProducts = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })

      if (appliedFilters.search) {
        params.set('search', appliedFilters.search)
      }

      if (appliedFilters.priceKitStatus !== 'ALL') {
        params.set(
          'priceKitStatus',
          appliedFilters.priceKitStatus,
        )
      }

      if (appliedFilters.feedStatus !== 'ALL') {
        params.set(
          'included',
          appliedFilters.feedStatus === 'INCLUDED'
            ? 'true'
            : 'false',
        )
      }

      if (appliedFilters.inclusionMode !== 'ALL') {
        params.set(
          'inclusionMode',
          appliedFilters.inclusionMode,
        )
      }

      if (appliedFilters.stockStatus !== 'ALL') {
        params.set(
          'stockStatus',
          appliedFilters.stockStatus,
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
      setSummary(result.summary ?? {})
      setTotal(result.pagination?.total ?? 0)
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
  }, [appliedFilters, page])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadProducts()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [loadProducts])

  function applyFilters() {
    setAppliedFilters({
      ...filters,
      search: filters.search.trim(),
    })
    setPage(0)
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setAppliedFilters(EMPTY_FILTERS)
    setPage(0)
  }

  async function changeOverride(
    productId: string,
    inclusionMode: InclusionMode,
  ) {
    setSavingProductId(productId)
    setMessage(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/products/${productId}/override`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inclusionMode }),
        },
      )
      const result = (await response.json()) as {
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          result.message ??
            'A felülírás mentése sikertelen.',
        )
      }

      setMessage(
        inclusionMode === 'INHERIT'
          ? 'A globális feed-szabály ismét érvényes.'
          : 'A manuális felülírás mentése sikerült.',
      )
      await loadProducts()
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : 'A felülírás mentése sikertelen.',
      )
    } finally {
      setSavingProductId(null)
    }
  }

  const pageCount = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE),
  )

  const kpis = [
    ['Összes termék', summary.products ?? 0],
    ['PriceKit adattal', summary.priceKitWithData ?? 0],
    [
      'PriceKit adat nélkül',
      summary.priceKitWithoutData ?? 0,
    ],
    ['Feedben', summary.included ?? 0],
    ['Kihagyva', summary.excluded ?? 0],
    ['Készleten', summary.inStock ?? 0],
    ['Manuális felülírás', summary.manualOverride ?? 0],
  ] as const

  return (
    <section className="campaigns-page arukereso-products-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">ÁRUKERESŐ FEED</p>
          <h2>Termékek</h2>
          <p className="campaigns-page-description">
            A termékek PriceKit adatai, készletállapota és
            Árukereső feed-jogosultsága egy helyen.
          </p>
        </div>
      </div>

      <div className="arukereso-product-kpis">
        {kpis.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>

      <div className="campaign-offers-panel arukereso-filter-panel">
        <div className="arukereso-product-filters">
          <label className="arukereso-filter-search">
            <span>Keresés</span>
            <input
              type="search"
              value={filters.search}
              placeholder="SKU vagy terméknév"
              onChange={(event) =>
                updateFilter('search', event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  applyFilters()
                }
              }}
            />
          </label>

          <label>
            <span>PriceKit adat</span>
            <select
              value={filters.priceKitStatus}
              onChange={(event) =>
                updateFilter(
                  'priceKitStatus',
                  event.target.value as
                    ProductFilters['priceKitStatus'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <option value="HAS_DATA">Van adat</option>
              <option value="NO_DATA">Nincs adat</option>
              <option value="STALE_DATA">Elavult</option>
              <option value="NO_COMPETITOR">
                Nincs competitor
              </option>
            </select>
          </label>

          <label>
            <span>Feed státusz</span>
            <select
              value={filters.feedStatus}
              onChange={(event) =>
                updateFilter(
                  'feedStatus',
                  event.target.value as
                    ProductFilters['feedStatus'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <option value="INCLUDED">Feedben</option>
              <option value="EXCLUDED">Kihagyva</option>
            </select>
          </label>

          <label>
            <span>Szabály</span>
            <select
              value={filters.inclusionMode}
              onChange={(event) =>
                updateFilter(
                  'inclusionMode',
                  event.target.value as
                    ProductFilters['inclusionMode'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <option value="INHERIT">Globális</option>
              <option value="FORCE_INCLUDE">
                Mindig feedben
              </option>
              <option value="FORCE_EXCLUDE">
                Mindig kihagyva
              </option>
            </select>
          </label>

          <label>
            <span>Készlet</span>
            <select
              value={filters.stockStatus}
              onChange={(event) =>
                updateFilter(
                  'stockStatus',
                  event.target.value as
                    ProductFilters['stockStatus'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <option value="IN_STOCK">Készleten</option>
              <option value="OUT_OF_STOCK">
                Nincs készleten
              </option>
              <option value="MISSING_STOCK">
                Nincs készletadat
              </option>
            </select>
          </label>
        </div>

        <div className="arukereso-filter-actions">
          <span>{total} találat</span>
          <div>
            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={resetFilters}
            >
              Szűrők törlése
            </button>
            <button
              type="button"
              className="campaign-primary-button"
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
          <p>A megadott szűrőknek nincs megfelelő termék.</p>
        </div>
      ) : (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table arukereso-products-table">
              <thead>
                <tr>
                  <th>SKU / Termék</th>
                  <th>PriceKit</th>
                  <th>Árpozíció</th>
                  <th>Készlet</th>
                  <th>Feed státusz</th>
                  <th>Szabály / Művelet</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    className={
                      row.inclusionMode === 'INHERIT'
                        ? undefined
                        : 'has-manual-override'
                    }
                    key={row.productId}
                  >
                    <td>
                      <strong>{row.sku}</strong>
                      <small>{row.name ?? '–'}</small>
                    </td>
                    <td>
                      <span
                        className={`arukereso-pricekit-badge is-${row.priceKitStatus.toLowerCase()}`}
                      >
                        {getPriceKitLabel(row.priceKitStatus)}
                      </span>
                    </td>
                    <td className="arukereso-index-cell">
                      <span>
                        Min: {formatPercent(row.priceIndexBps)}
                      </span>
                      <span>
                        Medián:{' '}
                        {formatPercent(row.medianIndexBps)}
                      </span>
                      <span>
                        Átlag: {formatPercent(row.averageIndexBps)}
                      </span>
                    </td>
                    <td>{formatStock(row)}</td>
                    <td className="arukereso-feed-cell">
                      <span
                        className={`arukereso-feed-badge ${
                          row.included
                            ? 'is-included'
                            : 'is-excluded'
                        }`}
                      >
                        {row.included ? 'Feedben' : 'Kihagyva'}
                      </span>
                      <small>{formatFeedReason(row)}</small>
                    </td>
                    <td className="arukereso-override-cell">
                      <select
                        value={row.inclusionMode}
                        disabled={
                          savingProductId === row.productId
                        }
                        onChange={(event) =>
                          void changeOverride(
                            row.productId,
                            event.target.value as InclusionMode,
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
                      {row.inclusionMode === 'FORCE_INCLUDE' && (
                        <small>
                          Pricing- és készletszabályok felülírva
                        </small>
                      )}
                      {row.inclusionMode === 'FORCE_EXCLUDE' && (
                        <small>Manuálisan kizárva</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
                disabled={loading || page === 0}
                onClick={() => setPage(page - 1)}
              >
                Előző
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={loading || page + 1 >= pageCount}
                onClick={() => setPage(page + 1)}
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
