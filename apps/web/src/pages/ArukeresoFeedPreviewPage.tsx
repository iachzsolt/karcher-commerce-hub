import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { Link } from 'react-router-dom'
import { API_BASE_URL } from '../config/api'

type PriceKitStatus =
  | 'HAS_DATA'
  | 'NO_DATA'
  | 'NO_COMPETITOR'
  | 'PARTIAL_DATA'

type StockStatus =
  | 'IN_STOCK'
  | 'OUT_OF_STOCK'
  | 'MISSING_STOCK'

type InclusionMode =
  | 'INHERIT'
  | 'FORCE_INCLUDE'
  | 'FORCE_EXCLUDE'

type PreviewItem = {
  productId: string
  sku: string
  identifier: string
  name: string
  inFeed: boolean
  included: boolean
  inclusionMode: InclusionMode
  reasonCode: string
  priceKitStatus: PriceKitStatus
  priceIndexBps: number | null
  medianIndexBps: number | null
  averageIndexBps: number | null
  stockQuantity: number | null
  stockStatus: StockStatus
  productNumber: string
  outputDeliveryTime: string | null
  reasonDetails: {
    maxMinIndexBps: number
    maxMedianIndexBps: number
    maxAverageIndexBps: number
  }
}

type FeedSettings = {
  useMinIndex: boolean
  maxMinIndexBps: number
  useMedianIndex: boolean
  maxMedianIndexBps: number
  useAverageIndex: boolean
  maxAverageIndexBps: number
  useStockRule: boolean
  allowNoCompetitor: boolean
}

type PreviewResponse = {
  isActive?: boolean
  summary?: Record<string, number>
  settings?: FeedSettings
  safety?: { minIncludedItems: number }
  pagination?: {
    limit: number
    offset: number
    total: number
  }
  sample?: PreviewItem[]
  message?: string
}

type LatestRun = {
  runId: string
  status: string
  includedRows: number
  excludedRows: number
  outputRows: number
  finishedAt: string | null
  generatorVersion?: string | null
}

type PreviewFilters = {
  search: string
  feedStatus:
    | 'ALL'
    | 'IN_FEED'
    | 'ACTIVE'
    | 'DISABLED'
    | 'OMITTED'
  priceKitStatus:
    | 'ALL'
    | 'HAS_DATA'
    | 'NO_DATA'
    | 'HAS_COMPETITOR'
    | 'NO_COMPETITOR'
    | 'PARTIAL_DATA'
  stockStatus: 'ALL' | StockStatus
  reasonCategory:
    | 'ALL'
    | 'INDEX'
    | 'STOCK'
    | 'NO_PRICEKIT'
    | 'NO_COMPETITOR'
    | 'MANUAL'
}

const EMPTY_FILTERS: PreviewFilters = {
  search: '',
  feedStatus: 'ALL',
  priceKitStatus: 'ALL',
  stockStatus: 'ALL',
  reasonCategory: 'ALL',
}

const PAGE_SIZE = 50

function formatPercent(value: number | null) {
  if (value === null) {
    return '–'
  }

  return `${String(Math.round(value) / 100).replace('.', ',')}%`
}

function priceKitLabel(status: PriceKitStatus) {
  switch (status) {
    case 'HAS_DATA':
      return 'Van competitor adat'
    case 'NO_DATA':
      return 'Nincs PriceKit adat'
    case 'NO_COMPETITOR':
      return 'Nincs competitor adat'
    case 'PARTIAL_DATA':
      return 'Részleges pricing adat'
  }
}

function stockLabel(item: PreviewItem) {
  if (item.stockStatus === 'MISSING_STOCK') {
    return 'Nincs adat'
  }

  return item.stockStatus === 'IN_STOCK'
    ? `${item.stockQuantity} db`
    : 'Nincs készleten'
}

function ruleLabel(mode: InclusionMode) {
  switch (mode) {
    case 'INHERIT':
      return 'Globális'
    case 'FORCE_INCLUDE':
      return 'Mindig aktív'
    case 'FORCE_EXCLUDE':
      return 'Manuálisan letiltva'
  }
}

function reasonLabel(item: PreviewItem) {
  switch (item.reasonCode) {
    case 'FEED_ELIGIBLE_PRICING_RULES':
      return 'Aktív – pricing szabályok teljesülnek'
    case 'FEED_BLOCKED_MIN_INDEX':
      return `Letiltva – minimum index túl magas (${formatPercent(item.priceIndexBps)} > ${formatPercent(item.reasonDetails.maxMinIndexBps)})`
    case 'FEED_BLOCKED_MEDIAN_INDEX':
      return `Letiltva – medián index túl magas (${formatPercent(item.medianIndexBps)} > ${formatPercent(item.reasonDetails.maxMedianIndexBps)})`
    case 'FEED_BLOCKED_AVERAGE_INDEX':
      return `Letiltva – átlagindex túl magas (${formatPercent(item.averageIndexBps)} > ${formatPercent(item.reasonDetails.maxAverageIndexBps)})`
    case 'FEED_BLOCKED_MISSING_MIN_INDEX':
      return 'Letiltva – az aktív minimumindex-szabályhoz nincs adat'
    case 'FEED_BLOCKED_MISSING_MEDIAN_INDEX':
      return 'Letiltva – az aktív mediánszabályhoz nincs adat'
    case 'FEED_BLOCKED_MISSING_AVERAGE_INDEX':
      return 'Letiltva – az aktív átlagindex-szabályhoz nincs adat'
    case 'FEED_BLOCKED_OUT_OF_STOCK':
      return 'Letiltva – nincs készleten'
    case 'FEED_BLOCKED_MISSING_STOCK':
      return 'Letiltva – nincs készletadat'
    case 'FEED_ELIGIBLE_NO_COMPETITOR':
      return 'Aktív – competitor nélkül engedélyezve'
    case 'FEED_BLOCKED_NO_COMPETITOR':
      return 'Letiltva – nincs competitor adat'
    case 'FEED_ELIGIBLE_NO_CURRENT_PRICEKIT':
      return 'Aktív – PriceKit adat nélkül engedélyezve'
    case 'FEED_BLOCKED_NO_CURRENT_PRICEKIT':
      return 'Nincs feedben – nincs PriceKit adat'
    case 'FEED_BLOCKED_PARTIAL_MARKET_DATA':
      return 'Letiltva – a piaci adat hiányos'
    case 'FEED_ELIGIBLE_MANUAL_OVERRIDE':
      return 'Manuálisan hozzáadva – globális szabályok figyelmen kívül hagyva'
    case 'FEED_BLOCKED_MANUAL_OVERRIDE':
      return item.inFeed
        ? 'Letiltva – manuálisan letiltva'
        : 'Nincs feedben – manuális kizárás'
    default:
      return 'A döntés részlete nem elérhető'
  }
}

function formatDate(value: string | null) {
  if (!value) {
    return '–'
  }

  return new Intl.DateTimeFormat('hu-HU', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function ArukeresoFeedPreviewPage() {
  const [filters, setFilters] =
    useState<PreviewFilters>(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] =
    useState<PreviewFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [items, setItems] = useState<PreviewItem[]>([])
  const [summary, setSummary] = useState<
    Record<string, number>
  >({})
  const [settings, setSettings] =
    useState<FeedSettings | null>(null)
  const [isActive, setIsActive] =
    useState<boolean | null>(null)
  const [minIncludedItems, setMinIncludedItems] =
    useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latestRun, setLatestRun] =
    useState<LatestRun | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [downloadingCsv, setDownloadingCsv] =
    useState(false)
  const [generatedRun, setGeneratedRun] =
    useState<LatestRun | null>(null)

  function updateFilter<K extends keyof PreviewFilters>(
    key: K,
    value: PreviewFilters[K],
  ) {
    setFilters((current) => ({
      ...current,
      [key]: value,
    }))
  }

  const loadPreview = useCallback(
    async (quiet = false) => {
      if (quiet) {
        setRefreshing(true)
      } else {
        setLoading(true)
      }
      setError(null)

      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
        })

        if (appliedFilters.search) {
          params.set('search', appliedFilters.search)
        }
        if (appliedFilters.feedStatus !== 'ALL') {
          params.set(
            'feedState',
            appliedFilters.feedStatus,
          )
        }
        if (appliedFilters.priceKitStatus !== 'ALL') {
          params.set(
            'priceKitStatus',
            appliedFilters.priceKitStatus,
          )
        }
        if (appliedFilters.stockStatus !== 'ALL') {
          params.set(
            'stockStatus',
            appliedFilters.stockStatus,
          )
        }
        if (appliedFilters.reasonCategory !== 'ALL') {
          params.set(
            'reasonCategory',
            appliedFilters.reasonCategory,
          )
        }

        const response = await fetch(
          `${API_BASE_URL}/arukereso/feed/output-preview?${params.toString()}`,
        )
        const result =
          (await response.json()) as PreviewResponse

        if (!response.ok) {
          throw new Error(
            result.message ??
              'A feed előnézet betöltése sikertelen.',
          )
        }

        setItems(result.sample ?? [])
        setSummary(result.summary ?? {})
        setSettings(result.settings ?? null)
        setIsActive(
          typeof result.isActive === 'boolean'
            ? result.isActive
            : null,
        )
        setMinIncludedItems(
          result.safety?.minIncludedItems ?? 1,
        )
        setTotal(result.pagination?.total ?? 0)
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : 'A feed előnézet betöltése sikertelen.',
        )
        setItems([])
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [appliedFilters, page],
  )

  const loadLatestRun = useCallback(async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/latest`,
      )
      const result = (await response.json()) as {
        latestRun?: LatestRun | null
      }

      if (response.ok) {
        const nextRun = result.latestRun ?? null
        setLatestRun(nextRun)
        return nextRun
      }
    } catch {
      setLatestRun(null)
    }

    return null
  }, [])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void Promise.all([
        loadPreview(),
        loadLatestRun(),
      ])
    }, 0)

    return () => window.clearTimeout(timeoutId)
  }, [loadLatestRun, loadPreview])

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

  async function generateFeed() {
    setGenerating(true)
    setError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ confirm: true }),
        },
      )
      const result = (await response.json()) as {
        status?: string
        code?: string
        runId?: string
        summary?: {
          includedRows: number
          excludedRows: number
          outputRows: number
        }
        message?: string
      }

      if (response.status === 401) {
        throw new Error(
          'A munkamenet lejárt. Jelentkezz be újra.',
        )
      }

      if (
        result.status === 'skipped' &&
        result.code === 'CHANNEL_INACTIVE'
      ) {
        setIsActive(false)
      }

      if (!response.ok || !result.runId || !result.summary) {
        throw new Error(
          result.message ??
            'A feed generálása sikertelen.',
        )
      }

      const run: LatestRun = {
        runId: result.runId,
        status: 'COMPLETED',
        includedRows: result.summary.includedRows,
        excludedRows: result.summary.excludedRows,
        outputRows: result.summary.outputRows,
        finishedAt: null,
      }
      setGeneratedRun(run)
      setLatestRun(run)
      setShowConfirm(false)
      const [, latest] = await Promise.all([
        loadPreview(true),
        loadLatestRun(),
      ])

      if (latest?.runId === result.runId) {
        setGeneratedRun(latest)
      }
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : 'A feed generálása sikertelen.',
      )
      setShowConfirm(false)
    } finally {
      setGenerating(false)
    }
  }

  async function downloadCsv(runId: string) {
    // Plain browser navigation cannot send the
    // Authorization header, so the protected CSV
    // endpoint must be fetched with the shared
    // authenticated request layer instead.
    setDownloadingCsv(true)
    setError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/arukereso/feed/runs/${runId}/csv`,
      )

      if (response.status === 401) {
        throw new Error(
          'A munkamenet lejárt. Jelentkezz be újra.',
        )
      }

      if (!response.ok) {
        const result = (await response
          .json()
          .catch(() => null)) as {
          message?: string
        } | null

        throw new Error(
          result?.message ??
            'A CSV letöltése sikertelen.',
        )
      }

      const blob = await response.blob()
      const objectUrl =
        window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = 'arukereso-feed.csv'
      document.body.append(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(objectUrl)
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : 'A CSV letöltése sikertelen.',
      )
    } finally {
      setDownloadingCsv(false)
    }
  }

  const generationBlocked =
    (summary.outputRows ?? 0) < minIncludedItems
  const pageCount = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE),
  )
  const kpis = [
    ['Forrássorok', summary.sourceRows ?? 0],
    ['PriceKit feed-alap', summary.priceKitBaseRows ?? 0],
    ['Manuálisan hozzáadva', summary.manuallyAddedRows ?? 0],
    ['Feedben', summary.outputRows ?? 0],
    ['Aktív ajánlatok', summary.activeRows ?? 0],
    ['Letiltott ajánlatok', summary.disabledRows ?? 0],
    ['Nincs feedben', summary.omittedRows ?? 0],
  ] as const

  return (
    <section className="campaigns-page arukereso-feed-preview-page">
      <div className="campaigns-page-header">
        <div>
          <p className="section-label">ÁRUKERESŐ FEED</p>
          <h2>Feed előnézet</h2>
          <p className="campaigns-page-description">
            Az előnézet minden aktuális, párosított CMS-sort
            megmutat. A PriceKit-lefedettség adja a V4 feed
            alapját; a szabályok az ajánlat DeliveryTime
            értékét vezérlik.
          </p>
          <small className="arukereso-preview-readonly-note">
            Az előnézet nem hoz létre új feed-verziót.
          </small>
          <span
            className={`arukereso-channel-status${
              isActive === true ? ' is-active' : ''
            }`}
          >
            <span className="platform-status-dot" />
            {isActive === null
              ? 'Csatornaállapot betöltése…'
              : isActive
                ? 'Csatorna aktív'
                : 'Csatorna kikapcsolva'}
          </span>
        </div>
        <div className="arukereso-preview-header-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={loading || refreshing || generating}
            onClick={() => void loadPreview(true)}
          >
            {refreshing ? 'Frissítés…' : 'Frissítés'}
          </button>
          <button
            type="button"
            className="campaign-primary-button"
            disabled={
              loading ||
              generating ||
              generationBlocked ||
              isActive !== true
            }
            onClick={() => setShowConfirm(true)}
          >
            Feed generálása
          </button>
        </div>
      </div>

      {isActive === false && !loading && (
        <div className="arukereso-preview-inactive-banner">
          <div>
            <strong>Az Árukereső integráció ki van kapcsolva.</strong>
            <span>
              Az előnézet a normál feed várható állapotát
              mutatja. A publikus URL jelenleg leállító feedet
              szolgál ki, amelyben minden DeliveryTime=NO.
            </span>
          </div>
          <Link to="/arukereso/settings">
            Aktiválási beállítások
          </Link>
        </div>
      )}

      {generationBlocked && !loading && (
        <div className="arukereso-preview-safety-warning">
          <strong>A feed jelenleg nem generálható.</strong>
          <span>
            Túl kevés sor tartozik a normál V4 feed
            populációjába.
            Minimum:{' '}
            {minIncludedItems}, jelenleg:{' '}
            {summary.outputRows ?? 0}.
          </span>
        </div>
      )}

      {error && (
        <div className="campaign-message campaign-message-error">
          {error}
        </div>
      )}

      <div className="arukereso-preview-kpis">
        {kpis.map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{loading ? '–' : value}</strong>
          </div>
        ))}
        <div>
          <span>Safety minimum</span>
          <strong>{minIncludedItems}</strong>
        </div>
      </div>

      {settings && (
        <article className="allegro-settings-card arukereso-preview-rules-card">
          <header className="allegro-settings-card-header">
            <div>
              <span className="allegro-settings-eyebrow">
                READ-ONLY
              </span>
              <h3>Aktív szabályok</h3>
              <p>
                A generálás ezeket a globális szabályokat és a
                termékszintű felülírásokat alkalmazza.
              </p>
            </div>
            <Link
              className="secondary-button"
              to="/arukereso/settings"
            >
              Beállítások módosítása
            </Link>
          </header>
          <div className="arukereso-preview-rules-grid">
            <div>
              <span>Minimum index</span>
              <strong>
                {settings.useMinIndex
                  ? `max. ${formatPercent(settings.maxMinIndexBps)}`
                  : 'Kikapcsolva'}
              </strong>
            </div>
            <div>
              <span>Medián index</span>
              <strong>
                {settings.useMedianIndex
                  ? `max. ${formatPercent(settings.maxMedianIndexBps)}`
                  : 'Kikapcsolva'}
              </strong>
            </div>
            <div>
              <span>Átlagindex</span>
              <strong>
                {settings.useAverageIndex
                  ? `max. ${formatPercent(settings.maxAverageIndexBps)}`
                  : 'Kikapcsolva'}
              </strong>
            </div>
            <div>
              <span>Készlet</span>
              <strong>
                {settings.useStockRule
                  ? 'Figyelembe véve'
                  : 'Nincs szűrés'}
              </strong>
            </div>
            <div>
              <span>Competitor nélkül</span>
              <strong>
                {settings.allowNoCompetitor
                  ? 'Engedélyezett'
                  : 'Nem engedélyezett'}
              </strong>
            </div>
          </div>
        </article>
      )}

      {(generatedRun || latestRun) && (
        <article className="arukereso-preview-latest">
          <div>
            <span className="section-label">
              {generatedRun
                ? 'FEED SIKERESEN ELKÉSZÜLT'
                : 'LEGUTÓBBI GENERÁLT FEED'}
            </span>
            <strong>
              {(generatedRun ?? latestRun)?.outputRows} CSV-sor ·{' '}
              {(generatedRun ?? latestRun)?.generatorVersion ===
                'ARUKERESO_FILTERED_CMS_CSV_V3'
                ? 'legacy V3'
                : `${(generatedRun ?? latestRun)?.excludedRows} DeliveryTime=NO`}
            </strong>
            <small>
              {formatDate(
                (generatedRun ?? latestRun)?.finishedAt ?? null,
              )}{' '}
              · Run:{' '}
              {(generatedRun ?? latestRun)?.runId.slice(0, 8)}…
            </small>
          </div>
          <button
            type="button"
            className="campaign-primary-button"
            disabled={downloadingCsv}
            onClick={() => {
              const runId = (
                generatedRun ?? latestRun
              )?.runId

              if (runId) {
                void downloadCsv(runId)
              }
            }}
          >
            {downloadingCsv
              ? 'Letöltés…'
              : generatedRun
                ? 'CSV letöltése'
                : 'Legutóbbi CSV letöltése'}
          </button>
        </article>
      )}

      <div className="campaign-offers-panel arukereso-preview-filter-panel">
        <div className="arukereso-preview-filters">
          <label className="arukereso-preview-search">
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
            <span>Feed állapot</span>
            <select
              value={filters.feedStatus}
              onChange={(event) =>
                updateFilter(
                  'feedStatus',
                  event.target.value as
                    PreviewFilters['feedStatus'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <option value="IN_FEED">Feedben</option>
              <option value="ACTIVE">Aktív</option>
              <option value="DISABLED">Letiltott</option>
              <option value="OMITTED">Nincs feedben</option>
            </select>
          </label>
          <label>
            <span>PriceKit</span>
            <select
              value={filters.priceKitStatus}
              onChange={(event) =>
                updateFilter(
                  'priceKitStatus',
                  event.target.value as
                    PreviewFilters['priceKitStatus'],
                )
              }
            >
              <option value="ALL">Mind</option>
              <optgroup label="PriceKit lefedettség">
                <option value="HAS_DATA">
                  Van PriceKit adat
                </option>
                <option value="NO_DATA">
                  Nincs PriceKit adat
                </option>
              </optgroup>
              <optgroup label="Competitor állapot">
                <option value="HAS_COMPETITOR">
                  Van competitor adat
                </option>
                <option value="NO_COMPETITOR">
                  Nincs competitor adat
                </option>
                <option value="PARTIAL_DATA">
                  Részleges pricing adat
                </option>
              </optgroup>
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
                    PreviewFilters['stockStatus'],
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
          <label>
            <span>Indok</span>
            <select
              value={filters.reasonCategory}
              onChange={(event) =>
                updateFilter(
                  'reasonCategory',
                  event.target.value as
                    PreviewFilters['reasonCategory'],
                )
              }
            >
              <option value="ALL">Minden indok</option>
              <option value="INDEX">Árindex</option>
              <option value="STOCK">Készlet</option>
              <option value="NO_PRICEKIT">
                Nincs PriceKit adat
              </option>
              <option value="NO_COMPETITOR">
                Nincs competitor adat
              </option>
              <option value="MANUAL">
                Manuális döntés
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

      {loading && items.length === 0 ? (
        <div className="campaign-message">
          Feed előnézet betöltése…
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <h3>Nincs találat</h3>
          <p>A megadott szűrőknek nincs megfelelő feed-sor.</p>
        </div>
      ) : (
        <div className="campaign-offers-panel">
          <div className="campaign-offers-table-wrapper">
            <table className="campaign-offers-table arukereso-preview-table">
              <thead>
                <tr>
                  <th>SKU / Termék</th>
                  <th>PriceKit</th>
                  <th>Árpozíció</th>
                  <th>Készlet</th>
                  <th>Feed státusz</th>
                  <th>Indok</th>
                  <th>Szabály</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.productId}>
                    <td>
                      <strong>{item.sku}</strong>
                      <small>{item.name}</small>
                    </td>
                    <td>
                      <span
                        className={`arukereso-pricekit-badge is-${item.priceKitStatus.toLowerCase()}`}
                      >
                        {priceKitLabel(item.priceKitStatus)}
                      </span>
                    </td>
                    <td className="arukereso-index-cell">
                      <span>
                        Min: {formatPercent(item.priceIndexBps)}
                      </span>
                      <span>
                        Medián:{' '}
                        {formatPercent(item.medianIndexBps)}
                      </span>
                      <span>
                        Átlag: {formatPercent(item.averageIndexBps)}
                      </span>
                    </td>
                    <td>{stockLabel(item)}</td>
                    <td>
                      <span
                        className={`arukereso-feed-badge ${
                          item.inFeed && item.included
                            ? 'is-included'
                            : 'is-excluded'
                        }`}
                      >
                        {!item.inFeed
                          ? 'Nincs feedben'
                          : item.included
                            ? 'Feedben · Aktív'
                            : 'Feedben · Letiltva'}
                      </span>
                      <small className="arukereso-preview-delivery">
                        {!item.inFeed
                          ? 'Nincs generált CSV-sor'
                          : `DeliveryTime: ${item.outputDeliveryTime ?? '–'}`}
                      </small>
                    </td>
                    <td className="arukereso-preview-reason">
                      {reasonLabel(item)}
                    </td>
                    <td>{ruleLabel(item.inclusionMode)}</td>
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

      <div className="arukereso-preview-management-link">
        Felülírást a{' '}
        <Link to="/arukereso/products">Termékek oldalon</Link>{' '}
        módosíthatsz.
      </div>

      {showConfirm && (
        <div
          className="arukereso-preview-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              if (!generating) {
                setShowConfirm(false)
              }
            }
          }}
        >
          <div
            className="arukereso-preview-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feed-generation-title"
          >
            <span className="section-label">NAPLÓZOTT MŰVELET</span>
            <h3 id="feed-generation-title">
              Új feed-verzió generálása
            </h3>
            <p>
              Az aktuális szabályok alapján új, naplózott
              feed-verzió készül.
            </p>
            <div className="arukereso-preview-dialog-summary">
              <span>
                <strong>{summary.outputRows ?? 0}</strong>
                Generált CSV-sor
              </span>
              <span>
                <strong>{summary.activeRows ?? 0}</strong>
                Aktív ajánlat
              </span>
              <span>
                <strong>{summary.disabledRows ?? 0}</strong>
                DeliveryTime=NO
              </span>
            </div>
            <div className="arukereso-preview-dialog-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={generating}
                onClick={() => setShowConfirm(false)}
              >
                Mégse
              </button>
              <button
                type="button"
                className="campaign-primary-button"
                disabled={generating}
                onClick={() => void generateFeed()}
              >
                {generating ? 'Generálás…' : 'Generálás'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

export default ArukeresoFeedPreviewPage
