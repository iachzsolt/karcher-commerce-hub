import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from '../config/api'

type PricingRow = {
  productId: string
  sku: string
  name: string | null
  included: boolean
  inclusionMode:
    | 'INHERIT'
    | 'FORCE_INCLUDE'
    | 'FORCE_EXCLUDE'
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  stockQuantity: number | null
  stockAvailable: boolean | null
  dataStatus: string | null
  reasonCode: string
  reasonDetails: {
    maxMinIndexBps: number
    maxMedianIndexBps: number
    maxAverageIndexBps: number
  }
}

type PreviewResponse = {
  summary?: Record<string, number>
  pagination?: {
    total: number
  }
  items?: PricingRow[]
  message?: string
}

const PAGE_SIZE = 100

function formatPercent(value: number | null) {
  if (value === null) {
    return '–'
  }

  const percent = Math.round(value) / 100

  return `${String(percent).replace('.', ',')}%`
}

function formatStock(row: PricingRow) {
  if (row.stockAvailable === null) {
    return 'Nincs adat'
  }

  return row.stockAvailable
    ? `Készleten (${row.stockQuantity})`
    : 'Nincs készleten'
}

function formatReason(row: PricingRow) {
  switch (row.reasonCode) {
    case 'FEED_ELIGIBLE_PRICING_RULES':
      return 'Minden aktív pricing szabály teljesül'
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
      return 'Nincs versenytárs, de ez engedélyezett'
    case 'FEED_BLOCKED_NO_COMPETITOR':
      return 'Nincs versenytárs'
    case 'FEED_ELIGIBLE_MISSING_PRICING':
      return 'Nincs pricing adat, de ez engedélyezett'
    case 'FEED_BLOCKED_MISSING_PRICING':
      return 'Nincs pricing adat'
    case 'FEED_ELIGIBLE_STALE_PRICING':
      return 'Elavult pricing adat, de ez engedélyezett'
    case 'FEED_BLOCKED_STALE_PRICING':
      return 'Elavult pricing adat'
    case 'FEED_BLOCKED_PARTIAL_MARKET_DATA':
      return 'Részleges piaci adat'
    case 'FEED_ELIGIBLE_MANUAL_OVERRIDE':
      return 'Manuális beállítással mindig feedben'
    case 'FEED_BLOCKED_MANUAL_OVERRIDE':
      return 'Manuális beállítással mindig kihagyva'
    default:
      return row.reasonCode
  }
}

function ArukeresoPricingPage() {
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] =
    useState('')
  const [status, setStatus] = useState<
    'all' | 'included' | 'excluded'
  >('all')
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<PricingRow[]>([])
  const [summary, setSummary] = useState<
    Record<string, number>
  >({})
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadPreview = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      })

      if (appliedSearch) {
        params.set('search', appliedSearch)
      }

      if (status !== 'all') {
        params.set(
          'included',
          status === 'included' ? 'true' : 'false',
        )
      }

      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/preview?${params.toString()}`,
      )
      const result =
        (await response.json()) as PreviewResponse

      if (!response.ok) {
        throw new Error(
          result.message ??
            'Az árpozíciós adatok betöltése sikertelen.',
        )
      }

      setItems(result.items ?? [])
      setSummary(result.summary ?? {})
      setTotal(result.pagination?.total ?? 0)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Az árpozíciós adatok betöltése sikertelen.',
      )
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [appliedSearch, page, status])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadPreview()
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [loadPreview])

  function applyFilters() {
    setAppliedSearch(search.trim())
    setPage(0)
  }

  const pageCount = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE),
  )

  return (
    <section className="campaigns-page arukereso-pricing-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">ÁRUKERESŐ FEED</p>
          <h2>Árpozíció</h2>
          <p className="campaigns-page-description">
            A termékek aktuális piaci helyzete és
            feed-jogosultsága.
          </p>
        </div>
        <Link
          className="secondary-button"
          to="/arukereso/products"
        >
          Felülírások kezelése
        </Link>
      </div>

      <div className="arukereso-pricing-summary">
        <div>
          <span>Feedben</span>
          <strong>{summary.included ?? 0}</strong>
        </div>
        <div>
          <span>Kihagyva</span>
          <strong>{summary.excluded ?? 0}</strong>
        </div>
        <div>
          <span>Index miatt blokkolva</span>
          <strong>
            {(summary.blockedByMinIndex ?? 0) +
              (summary.blockedByMedianIndex ?? 0) +
              (summary.blockedByAverageIndex ?? 0)}
          </strong>
        </div>
        <div>
          <span>Készlet miatt blokkolva</span>
          <strong>{summary.blockedByStock ?? 0}</strong>
        </div>
        <div>
          <span>Hiányzó aktív index</span>
          <strong>{summary.missingEnabledMetric ?? 0}</strong>
        </div>
      </div>

      <div className="campaign-offers-panel">
        <div className="arukereso-pricing-filters">
          <label>
            <span>Keresés</span>
            <input
              type="search"
              value={search}
              placeholder="SKU vagy terméknév"
              onChange={(event) =>
                setSearch(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  applyFilters()
                }
              }}
            />
          </label>
          <label>
            <span>Feed státusz</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(
                  event.target.value as
                    | 'all'
                    | 'included'
                    | 'excluded',
                )
                setPage(0)
              }}
            >
              <option value="all">Mind</option>
              <option value="included">Feedben</option>
              <option value="excluded">Kihagyva</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={applyFilters}
          >
            Szűrés
          </button>
        </div>

        {error ? (
          <div className="campaign-message campaign-message-error">
            {error}
          </div>
        ) : loading && items.length === 0 ? (
          <div className="campaign-message">
            Árpozíciós adatok betöltése…
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <h3>Nincs találat</h3>
            <p>A megadott szűrőknek nincs megfelelő termék.</p>
          </div>
        ) : (
          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table arukereso-pricing-table">
              <thead>
                <tr>
                  <th>Termék</th>
                  <th>Árindexek</th>
                  <th>Pricing státusz</th>
                  <th>Készlet</th>
                  <th>Feed-döntés</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.productId}>
                    <td>
                      <strong>{row.sku}</strong>
                      <small>{row.name ?? '–'}</small>
                    </td>
                    <td>
                      <span>Min {formatPercent(row.priceIndexBps)}</span>
                      <span>
                        Medián {formatPercent(row.medianIndexBps)}
                      </span>
                      <span>
                        Átlag {formatPercent(row.averageIndexBps)}
                      </span>
                    </td>
                    <td>{row.dataStatus ?? '–'}</td>
                    <td>{formatStock(row)}</td>
                    <td>
                      <span
                        className={`status-pill${
                          row.included ? '' : ' is-inactive'
                        }`}
                      >
                        {row.included ? 'Feedben' : 'Kihagyva'}
                      </span>
                      <small>{formatReason(row)}</small>
                      {row.inclusionMode !== 'INHERIT' && (
                        <small className="arukereso-manual-note">
                          Manuális felülírás
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
    </section>
  )
}

export default ArukeresoPricingPage
