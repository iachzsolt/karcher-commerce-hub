import { useEffect, useState } from 'react'
import '../App.css'

type HealthResponse = {
  status: string
  service: string
  environment: string
  timestamp: string
}

type Platform = {
  id: string
  code: string
  name: string
  active: boolean
  createdAt: string
}

type ProductIdentifier = {
  id: string
  type: 'EAN' | 'MANUFACTURER_SKU' | 'SAP_ID' | 'OTHER'
  value: string
}

type Product = {
  id: string
  sku: string
  name: string
  productLine: 'HG' | 'PROFESSIONAL' | 'UNASSIGNED'
  category: string | null
  active: boolean
  createdAt: string
  updatedAt: string
  identifiers: ProductIdentifier[]
}

type AllegroListing = {
  id: string
  offerId: string
  marketplace: string
  categoryId: string | null
  sku: string
  productName: string
  accountName: string
  environment: string
  priceMinor: number | null
  currency: string
  stockAvailable: number | null
  stockSold: number | null
  publicationStatus:
    | 'ACTIVE'
    | 'ACTIVATING'
    | 'INACTIVE'
    | 'ENDED'
    | 'UNKNOWN'
  lastSyncedAt: string | null

  desiredPriceMinor: number | null
  desiredStock: number | null

  desiredPublicationStatus:
    | 'ACTIVE'
    | 'ACTIVATING'
    | 'INACTIVE'
    | 'ENDED'
    | 'UNKNOWN'
    | null

  priceLocked: boolean | null
  stockLocked: boolean | null

  autoPriceSync: boolean | null
  autoStockSync: boolean | null
}

type PlatformResponse = {
  status: string
  count: number
  data: Platform[]
}

type ProductResponse = {
  status: string
  count: number
  data: Product[]
}

type AllegroListingResponse = {
  status: string
  count: number
  data: AllegroListing[]
}

type AllegroImportIssue = {
  offerId: string
  name: string
  issue:
    | 'MISSING_HU_MARKETPLACE'
    | 'MISSING_SKU'
}

type AllegroImportIssueResponse = {
  status: string
  count: number
  data: AllegroImportIssue[]
}

type ServiceStatus = {
  name: string
  description: string
  status: 'working' | 'prepared' | 'disconnected'
}

function formatProductLine(value: Product['productLine']) {
  if (value === 'HG') return 'H&G'
  if (value === 'PROFESSIONAL') return 'Professional'
  return 'Nincs besorolva'
}

function statusLabel(status: ServiceStatus['status']) {
  if (status === 'working') return 'Működik'
  if (status === 'prepared') return 'Előkészítve'
  return 'Nincs csatlakoztatva'
}

function getPrimaryEan(product: Product) {
  return (
    product.identifiers.find(
      (identifier) => identifier.type === 'EAN',
    )?.value ?? '–'
  )
}

function formatMoney(
  priceMinor: number | null,
  currency: string,
) {
  if (priceMinor === null) {
    return '–'
  }

  return new Intl.NumberFormat('hu-HU', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'HUF' ? 0 : 2,
  }).format(priceMinor / 100)
}

function formatListingStatus(
  status: AllegroListing['publicationStatus'],
) {
  if (status === 'ACTIVE') return 'Aktív'
  if (status === 'ACTIVATING') return 'Aktiválás alatt'
  if (status === 'INACTIVE') return 'Inaktív'
  if (status === 'ENDED') return 'Lejárt'
  return 'Ismeretlen'
}

function formatDate(value: string | null) {
  if (!value) {
    return '–'
  }

  return new Intl.DateTimeFormat('hu-HU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

type HomePageProps = {
  view?: 'home' | 'allegroOffers'
}

function HomePage({
  view = 'home',
}: HomePageProps) {
  const hasPublicationDifference = (
    listing: AllegroListing,
  ) => {
    if (
      listing.desiredPublicationStatus === 'ACTIVE'
    ) {
      return (
        listing.publicationStatus !== 'ACTIVE' &&
        listing.publicationStatus !== 'ACTIVATING'
      )
    }

    if (
      listing.desiredPublicationStatus === 'INACTIVE'
    ) {
      return (
        listing.publicationStatus !== 'INACTIVE' &&
        listing.publicationStatus !== 'ENDED'
      )
    }

    return false
  }

  const [apiHealth, setApiHealth] =
    useState<HealthResponse | null>(null)

  const [platforms, setPlatforms] =
    useState<Platform[]>([])

  const [products, setProducts] =
    useState<Product[]>([])

  const [allegroListings, setAllegroListings] =
    useState<AllegroListing[]>([])

  const [allegroImportIssues, setAllegroImportIssues] =
    useState<AllegroImportIssue[]>([])

  const [desiredPriceDrafts, setDesiredPriceDrafts] =
    useState<Record<string, string>>({})

  const [savingDesiredPrice, setSavingDesiredPrice] =
    useState<string | null>(null)

  const [desiredStockDrafts, setDesiredStockDrafts] =
    useState<Record<string, string>>({})

  const [savingDesiredStock, setSavingDesiredStock] =
    useState<string | null>(null)

  const [desiredStatusDrafts, setDesiredStatusDrafts] =
    useState<Record<string, 'ACTIVE' | 'INACTIVE'>>({})

  const [savingDesiredStatus, setSavingDesiredStatus] =
    useState<string | null>(null)

  const [selectedListingIds, setSelectedListingIds] =
    useState<string[]>([])

  const [bulkSyncing, setBulkSyncing] =
    useState(false)

  const [syncingWholeListingId, setSyncingWholeListingId] =
    useState<string | null>(null)


  const [loading, setLoading] = useState(true)

  const [refreshingAllegro, setRefreshingAllegro] =
    useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [
          healthResponse,
          platformResponse,
          productResponse,
          allegroResponse,
        ] = await Promise.all([
          fetch('http://localhost:3000/health'),
          fetch('http://localhost:3000/platforms'),
          fetch('http://localhost:3000/products'),
          fetch('http://localhost:3000/allegro/listings'),
        ])

        if (
          !healthResponse.ok ||
          !platformResponse.ok ||
          !productResponse.ok ||
          !allegroResponse.ok
        ) {
          throw new Error('API request failed')
        }

        const healthData =
          (await healthResponse.json()) as HealthResponse

        const platformData =
          (await platformResponse.json()) as PlatformResponse

        const productData =
          (await productResponse.json()) as ProductResponse

        const allegroData =
          (await allegroResponse.json()) as AllegroListingResponse

        setApiHealth(healthData)
        setPlatforms(platformData.data)
        setProducts(productData.data)
        setAllegroListings(allegroData.data)

        try {
          const importIssuesResponse = await fetch(
            'http://localhost:3000/auth/allegro/import-issues',
          )

          if (importIssuesResponse.ok) {
            const importIssuesData =
              (await importIssuesResponse.json()) as AllegroImportIssueResponse

            setAllegroImportIssues(
              importIssuesData.data,
            )
          } else {
            setAllegroImportIssues([])
          }
        } catch {
          setAllegroImportIssues([])
        }

        setDesiredPriceDrafts(
          Object.fromEntries(
            allegroData.data.map((listing) => [
              listing.id,
              listing.desiredPriceMinor !== null
                ? String(listing.desiredPriceMinor / 100)
                : '',
            ]),
          ),
        )

        setDesiredStockDrafts(
          Object.fromEntries(
            allegroData.data.map((listing) => [
              listing.id,
              listing.desiredStock !== null
                ? String(listing.desiredStock)
                : '',
            ]),
          ),
        )
      } catch (error) {
        console.error(
          'Commerce Hub data loading failed:',
          error,
        )

        setApiHealth(null)
        setPlatforms([])
        setProducts([])
        setAllegroListings([])
      } finally {
        setLoading(false)
      }
    }

    void loadData()
  }, [])

  const refreshAllegroData = async () => {
    setRefreshingAllegro(true)

    try {
      const syncResponse = await fetch(
        'http://localhost:3000/auth/allegro/sync',
        {
          method: 'POST',
        },
      )

      if (!syncResponse.ok) {
        const errorData = (await syncResponse
          .json()
          .catch(() => null)) as
          | {
              message?: string
            }
          | null

        throw new Error(
          errorData?.message ??
            'Nem sikerült frissíteni az Allegro-ajánlatokat.',
        )
      }

      const [
        listingsResponse,
        issuesResponse,
      ] = await Promise.all([
        fetch(
          'http://localhost:3000/allegro/listings',
        ),
        fetch(
          'http://localhost:3000/auth/allegro/import-issues',
        ),
      ])

      if (!listingsResponse.ok) {
        throw new Error(
          'Nem sikerült betölteni a frissített ajánlatokat.',
        )
      }

      const listingsData =
        (await listingsResponse.json()) as AllegroListingResponse

      setAllegroListings(listingsData.data)

      setDesiredPriceDrafts(
        Object.fromEntries(
          listingsData.data.map((listing) => [
            listing.id,
            listing.desiredPriceMinor !== null
              ? String(
                  listing.desiredPriceMinor / 100,
                )
              : '',
          ]),
        ),
      )

      setDesiredStockDrafts(
        Object.fromEntries(
          listingsData.data.map((listing) => [
            listing.id,
            listing.desiredStock !== null
              ? String(listing.desiredStock)
              : '',
          ]),
        ),
      )

      if (issuesResponse.ok) {
        const issuesData =
          (await issuesResponse.json()) as AllegroImportIssueResponse

        setAllegroImportIssues(
          issuesData.data,
        )
      } else {
        setAllegroImportIssues([])
      }

      setSelectedListingIds((current) =>
        current.filter((id) =>
          listingsData.data.some(
            (listing) => listing.id === id,
          ),
        ),
      )
    } catch (error) {
      console.error(
        'Allegro refresh failed:',
        error,
      )

      window.alert(
        error instanceof Error
          ? error.message
          : 'Nem sikerült frissíteni az Allegro-ajánlatokat.',
      )
    } finally {
      setRefreshingAllegro(false)
    }
  }
  const saveDesiredPrice = async (
    listing: AllegroListing,
  ) => {
    const draft = desiredPriceDrafts[listing.id] ?? ''

    const desiredPrice = Number(
      draft.replace(',', '.'),
    )

    if (
      !Number.isFinite(desiredPrice) ||
      desiredPrice < 0
    ) {
      window.alert('Adj meg egy érvényes árat.')
      return
    }

    setSavingDesiredPrice(listing.id)

    try {
      const response = await fetch(
        `http://localhost:3000/allegro/listings/${listing.id}/desired-price`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredPrice,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt ár mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredPriceMinor: number
          priceLocked: boolean
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredPriceMinor:
                  result.data.desiredPriceMinor,
                priceLocked:
                  result.data.priceLocked,
              }
            : item,
        ),
      )

      setDesiredPriceDrafts((current) => ({
        ...current,
        [listing.id]: String(
          result.data.desiredPriceMinor / 100,
        ),
      }))
    } catch (error) {
      console.error(
        'Desired price save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt árat.',
      )
    } finally {
      setSavingDesiredPrice(null)
    }
  }
  const saveDesiredStock = async (
    listing: AllegroListing,
  ) => {
    const draft =
      desiredStockDrafts[listing.id] ?? ''

    const desiredStock = Number(draft)

    if (
      !Number.isInteger(desiredStock) ||
      desiredStock < 0
    ) {
      window.alert(
        'Adj meg egy érvényes egész készletértéket.',
      )
      return
    }

    setSavingDesiredStock(listing.id)

    try {
      const response = await fetch(
        `http://localhost:3000/allegro/listings/${listing.id}/desired-stock`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredStock,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt készlet mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredStock: number
          stockLocked: boolean
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredStock:
                  result.data.desiredStock,
                stockLocked:
                  result.data.stockLocked,
              }
            : item,
        ),
      )

      setDesiredStockDrafts((current) => ({
        ...current,
        [listing.id]: String(
          result.data.desiredStock,
        ),
      }))
    } catch (error) {
      console.error(
        'Desired stock save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt készletet.',
      )
    } finally {
      setSavingDesiredStock(null)
    }
  }
  const saveDesiredStatus = async (
    listing: AllegroListing,
  ) => {
    const desiredStatus =
      desiredStatusDrafts[listing.id] ??
      (
        listing.desiredPublicationStatus === 'ACTIVE' ||
        listing.desiredPublicationStatus === 'INACTIVE'
          ? listing.desiredPublicationStatus
          : listing.publicationStatus === 'ACTIVE' ||
              listing.publicationStatus === 'ACTIVATING'
            ? 'ACTIVE'
            : 'INACTIVE'
      )

    setSavingDesiredStatus(listing.id)

    try {
      const response = await fetch(
        `http://localhost:3000/allegro/listings/${listing.id}/desired-status`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            desiredStatus,
          }),
        },
      )

      if (!response.ok) {
        throw new Error(
          'A kívánt státusz mentése sikertelen.',
        )
      }

      const result = (await response.json()) as {
        status: string
        data: {
          desiredPublicationStatus:
            | 'ACTIVE'
            | 'INACTIVE'
        }
      }

      setAllegroListings((current) =>
        current.map((item) =>
          item.id === listing.id
            ? {
                ...item,
                desiredPublicationStatus:
                  result.data.desiredPublicationStatus,
              }
            : item,
        ),
      )

      setDesiredStatusDrafts((current) => ({
        ...current,
        [listing.id]:
          result.data.desiredPublicationStatus,
      }))
    } catch (error) {
      console.error(
        'Desired publication status save failed:',
        error,
      )

      window.alert(
        'Nem sikerült elmenteni a kívánt státuszt.',
      )
    } finally {
      setSavingDesiredStatus(null)
    }
  }
  const toggleListingSelection = (
    listingId: string,
  ) => {
    setSelectedListingIds((current) =>
      current.includes(listingId)
        ? current.filter((id) => id !== listingId)
        : [...current, listingId],
    )
  }

  const toggleAllListings = () => {
    const allSelected =
      allegroListings.length > 0 &&
      allegroListings.every((listing) =>
        selectedListingIds.includes(listing.id),
      )

    setSelectedListingIds(
      allSelected
        ? []
        : allegroListings.map(
            (listing) => listing.id,
          ),
    )
  }

  const allListingsSelected =
    allegroListings.length > 0 &&
    allegroListings.every((listing) =>
      selectedListingIds.includes(listing.id),
    )

  const syncSelectedListingsToAllegro = async () => {
    if (selectedListingIds.length === 0) {
      return
    }

    const changedListings = allegroListings.filter(
      (listing) =>
        selectedListingIds.includes(listing.id) &&
        (
          (listing.desiredPriceMinor !== null &&
            listing.priceMinor !==
              listing.desiredPriceMinor) ||
          (listing.desiredStock !== null &&
            listing.stockAvailable !==
              listing.desiredStock) ||
          hasPublicationDifference(listing)
        ),
    )

    if (changedListings.length === 0) {
      window.alert(
        'A kijelölt ajánlatoknál nincs szinkronizálandó eltérés.',
      )
      return
    }

    const confirmed = window.confirm(
      `${selectedListingIds.length} ajánlat van kijelölve.

${changedListings.length} ajánlatnál találtunk eltérést.

Biztosan szinkronizálod őket az Allegróval?`,
    )

    if (!confirmed) {
      return
    }

    setBulkSyncing(true)

    try {
      const response = await fetch(
        'http://localhost:3000/auth/allegro/sync-selected',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingIds: selectedListingIds,
          }),
        },
      )

      const data = (await response.json()) as {
        status: string
        selected?: number
        attempted?: number
        succeeded?: number
        skipped?: number
        failed?: number
        pending?: number
        message?: string
      }

      if (!response.ok) {
        throw new Error(
          data.message ??
            'A kijelölt ajánlatok szinkronizálása sikertelen.',
        )
      }

      window.alert(
        `Szinkronizálás kész.

Sikeres: ${data.succeeded ?? 0}
Kihagyva: ${data.skipped ?? 0}
Hibás: ${data.failed ?? 0}
Folyamatban: ${data.pending ?? 0}`,
      )

      window.location.reload()
    } catch (error) {
      console.error('Bulk Allegro sync failed:', error)

      window.alert(
        error instanceof Error
          ? error.message
          : 'A szinkronizálás sikertelen.',
      )
    } finally {
      setBulkSyncing(false)
    }
  }
  const syncWholeListingToAllegro = async (
    listing: AllegroListing,
  ) => {
    const priceChanged =
      listing.desiredPriceMinor !== null &&
      listing.priceMinor !== listing.desiredPriceMinor

    const stockChanged =
      listing.desiredStock !== null &&
      listing.stockAvailable !== listing.desiredStock

    const publicationChanged =
      hasPublicationDifference(listing)

    if (
      !priceChanged &&
      !stockChanged &&
      !publicationChanged
    ) {
      return
    }

    const changes: string[] = []

    if (priceChanged) {
      changes.push(
        `Ár: ${formatMoney(
          listing.priceMinor,
          listing.currency,
        )} → ${formatMoney(
          listing.desiredPriceMinor,
          listing.currency,
        )}`,
      )
    }

    if (stockChanged) {
      changes.push(
        `Készlet: ${listing.stockAvailable ?? 0} db → ${listing.desiredStock} db`,
      )
    }

    if (publicationChanged) {
      const desiredStatusLabel =
        listing.desiredPublicationStatus === 'ACTIVE'
          ? 'Aktív'
          : 'Inaktív'

      changes.push(
        `Státusz: ${formatListingStatus(
          listing.publicationStatus,
        )} → ${desiredStatusLabel}`,
      )
    }

    const confirmed = window.confirm(
      `Biztosan szinkronizálod az ajánlatot?

${changes.join('\n')}`,
    )

    if (!confirmed) {
      return
    }

    setSyncingWholeListingId(listing.id)

    try {
      if (priceChanged) {
        const response = await fetch(
          `http://localhost:3000/auth/allegro/push-price/${listing.id}`,
          { method: 'POST' },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ?? 'Az ár szinkronizálása sikertelen.',
          )
        }
      }

      if (stockChanged) {
        const response = await fetch(
          `http://localhost:3000/auth/allegro/push-stock/${listing.id}`,
          { method: 'POST' },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ?? 'A készlet szinkronizálása sikertelen.',
          )
        }
      }

      if (publicationChanged) {
        const response = await fetch(
          `http://localhost:3000/auth/allegro/push-status/${listing.id}`,
          {
            method: 'POST',
          },
        )

        const data = (await response.json()) as {
          status: string
          message?: string
        }

        if (!response.ok) {
          throw new Error(
            data.message ??
              'A státusz szinkronizálása sikertelen.',
          )
        }
      }

      const syncResponse = await fetch(
        'http://localhost:3000/auth/allegro/sync',
        { method: 'POST' },
      )

      if (!syncResponse.ok) {
        throw new Error(
          'A visszaellenőrző szinkron sikertelen.',
        )
      }

      const listingResponse = await fetch(
        'http://localhost:3000/allegro/listings',
      )

      if (!listingResponse.ok) {
        throw new Error(
          'Nem sikerült frissíteni az ajánlatlistát.',
        )
      }

      const listingData =
        (await listingResponse.json()) as AllegroListingResponse

      setAllegroListings(listingData.data)

      setDesiredPriceDrafts(
        Object.fromEntries(
          listingData.data.map((item) => [
            item.id,
            item.desiredPriceMinor !== null
              ? String(item.desiredPriceMinor / 100)
              : '',
          ]),
        ),
      )

      setDesiredStockDrafts(
        Object.fromEntries(
          listingData.data.map((item) => [
            item.id,
            item.desiredStock !== null
              ? String(item.desiredStock)
              : '',
          ]),
        ),
      )

      window.alert('Az ajánlat sikeresen szinkronizálva.')
    } catch (error) {
      console.error('Listing sync failed:', error)

      window.alert(
        error instanceof Error
          ? error.message
          : 'A szinkronizálás sikertelen.',
      )
    } finally {
      setSyncingWholeListingId(null)
    }
  }
  const allegro = platforms.find(
    (platform) => platform.code === 'ALLEGRO',
  )

  const arukereso = platforms.find(
    (platform) => platform.code === 'ARUKERESO',
  )

  const services: ServiceStatus[] = [
    {
      name: 'Adminfelület',
      description: 'React + TypeScript alkalmazás',
      status: 'working',
    },
    {
      name: 'Backend API',
      description: apiHealth
        ? `Kapcsolódva • ${apiHealth.service}`
        : 'A backend jelenleg nem érhető el',
      status: apiHealth ? 'working' : 'disconnected',
    },
    {
      name: 'PostgreSQL adatbázis',
      description: 'Neon PostgreSQL kapcsolat',
      status: apiHealth ? 'working' : 'disconnected',
    },
    {
      name: 'Allegro',
      description:
        allegro && allegroListings.length > 0
          ? `${allegroListings.length} magyar ajánlat szinkronizálva`
          : allegro
            ? 'Platform csatlakoztatva'
            : 'A platform nem érhető el',
      status: allegro ? 'working' : 'disconnected',
    },
    {
      name: 'Árukereső',
      description: arukereso
        ? 'Platform előkészítve az integrációhoz'
        : 'A platform nem érhető el',
      status: arukereso ? 'prepared' : 'disconnected',
    },
  ]

  if (view === 'allegroOffers') {
    return (
      <div className="allegro-offers-view">


        <section className="allegro-section">
          <div className="section-heading">
            <div>
              <p className="section-label">
                ALLEGRO MAGYARORSZÁG
              </p>

              <h3>Ajánlatok</h3>
            </div>

            <div className="allegro-heading-actions">
              <span>
                {loading
                  ? 'Betöltés...'
                  : `${allegroListings.length} ajánlat`}
              </span>

              <button
                className="refresh-allegro-button"
                type="button"
                disabled={
                  loading ||
                  refreshingAllegro
                }
                onClick={() =>
                  void refreshAllegroData()
                }
              >
                {refreshingAllegro
                  ? 'Frissítés...'
                  : 'Ajánlatok frissítése'}
              </button>
            </div>
          </div>

          {allegroImportIssues.length > 0 && (
            <div className="import-issues-panel">
              <div className="import-issues-heading">
                <strong>
                  Ellenőrzést igénylő ajánlatok
                </strong>

                <span>
                  {allegroImportIssues.length} ajánlatot
                  nem sikerült importálni.
                </span>
              </div>

              <div className="import-issues-list">
                {allegroImportIssues.map((issue) => (
                  <div
                    className="import-issue-row"
                    key={issue.offerId}
                  >
                    <div className="import-issue-offer">
                      <strong>{issue.name}</strong>
                      <span>
                        Offer ID: {issue.offerId}
                      </span>
                    </div>

                    <span className="import-issue-message">
                      {issue.issue === 'MISSING_SKU'
                        ? 'Hiányzik a cikkszám (SKU).'
                        : 'Az ajánlat nincs publikálva az Allegro.hu piactéren.'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bulk-toolbar">
            <label className="select-all-control">
              <input
                type="checkbox"
                checked={allListingsSelected}
                onChange={toggleAllListings}
              />
              <span>Összes kijelölése</span>
            </label>

            <div className="bulk-toolbar-right">
              <span>
                {selectedListingIds.length} kijelölve
              </span>

                <button
                  className="bulk-sync-button"
                  type="button"
                  disabled={
                    selectedListingIds.length === 0 ||
                    bulkSyncing
                  }
                  onClick={() =>
                    void syncSelectedListingsToAllegro()
                  }
                >
                  {bulkSyncing
                    ? 'Szinkronizálás...'
                    : 'Kijelöltek szinkronizálása'}
                </button>

            </div>
          </div>

          <div className="table-card">
            <table className="products-table allegro-table">
              <thead>
                <tr>
                  <th className="selection-column" />
                  <th>Cikkszám</th>
                  <th>Terméknév</th>
                  <th>Offer ID</th>
                  <th>Árkezelés</th>
                  <th>Készletkezelés</th>
                  <th>Eltérés</th>
                  <th>Státusz</th>
                  <th>Utolsó szinkron</th>
                  <th>Szinkron</th>
                </tr>
              </thead>

              <tbody>
                {allegroListings.map((listing) => (
                  <tr key={listing.id}>
                      <td className="selection-column">
                        <input
                          type="checkbox"
                          checked={selectedListingIds.includes(
                            listing.id,
                          )}
                          onChange={() =>
                            toggleListingSelection(
                              listing.id,
                            )
                          }
                          aria-label={`${listing.sku} kijelölése`}
                        />
                      </td>
                    <td className="sku-cell">
                      {listing.sku}
                    </td>

                    <td>{listing.productName}</td>

                    <td className="offer-id-cell">
                      {listing.offerId}
                    </td>

                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Aktuális
                        </span>

                        <strong>
                          {formatMoney(
                            listing.priceMinor,
                            listing.currency,
                          )}
                        </strong>
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-price-editor">
                          <div className="price-input-wrapper">
                            <input
                              className="price-input"
                              type="number"
                              min="0"
                              step="1"
                              value={
                                desiredPriceDrafts[
                                  listing.id
                                ] ?? ''
                              }
                              onChange={(event) =>
                                setDesiredPriceDrafts(
                                  (current) => ({
                                    ...current,
                                    [listing.id]:
                                      event.target.value,
                                  }),
                                )
                              }
                            />

                            <span>Ft</span>
                          </div>

                          <button
                            className="save-price-button"
                            type="button"
                            disabled={
                              savingDesiredPrice ===
                              listing.id
                            }
                            onClick={() =>
                              void saveDesiredPrice(
                                listing,
                              )
                            }
                          >
                            {savingDesiredPrice ===
                            listing.id
                              ? 'Mentés...'
                              : 'Mentés'}
                          </button>
                        </div>
                      </div>
                    </td>

                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Aktuális
                        </span>

                        <strong>
                          {listing.stockAvailable ?? '–'} db
                        </strong>
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-stock-editor">
                          <div className="stock-input-wrapper">
                            <input
                              className="stock-input"
                              type="number"
                              min="0"
                              step="1"
                              value={
                                desiredStockDrafts[
                                  listing.id
                                ] ?? ''
                              }
                              onChange={(event) =>
                                setDesiredStockDrafts(
                                  (current) => ({
                                    ...current,
                                    [listing.id]:
                                      event.target.value,
                                  }),
                                )
                              }
                            />

                            <span>db</span>
                          </div>

                          <button
                            className="save-stock-button"
                            type="button"
                            disabled={
                              savingDesiredStock ===
                              listing.id
                            }
                            onClick={() =>
                              void saveDesiredStock(
                                listing,
                              )
                            }
                          >
                            {savingDesiredStock ===
                            listing.id
                              ? 'Mentés...'
                              : 'Mentés'}
                          </button>
                        </div>
                      </div>
                    </td>

                    <td>
                      {listing.priceMinor ===
                        listing.desiredPriceMinor &&
                      listing.stockAvailable ===
                        listing.desiredStock &&
                      !hasPublicationDifference(
                        listing,
                      ) ? (
                        <span className="sync-match">
                          Rendben
                        </span>
                      ) : (
                        <span className="sync-difference">
                          Eltérés
                        </span>
                      )}
                    </td>



                    <td className="management-cell">
                      <div className="management-current">
                        <span className="management-label">
                          Aktuális
                        </span>

                        <span
                          className={`listing-status listing-${listing.publicationStatus.toLowerCase()}`}
                        >
                          {formatListingStatus(
                            listing.publicationStatus,
                          )}
                        </span>
                      </div>

                      <div className="management-desired">
                        <span className="management-label">
                          Kívánt
                        </span>

                        <div className="desired-price-editor">
                          <select
                            className="price-input status-select"
                            value={
                              desiredStatusDrafts[
                                listing.id
                              ] ??
                              (
                                listing.desiredPublicationStatus ===
                                  'ACTIVE' ||
                                listing.desiredPublicationStatus ===
                                  'INACTIVE'
                                  ? listing.desiredPublicationStatus
                                  : listing.publicationStatus ===
                                        'ACTIVE' ||
                                      listing.publicationStatus ===
                                        'ACTIVATING'
                                    ? 'ACTIVE'
                                    : 'INACTIVE'
                              )
                            }
                            onChange={(event) =>
                              setDesiredStatusDrafts(
                                (current) => ({
                                  ...current,
                                  [listing.id]:
                                    event.target.value as
                                      | 'ACTIVE'
                                      | 'INACTIVE',
                                }),
                              )
                            }
                          >
                            <option value="ACTIVE">
                              Aktív
                            </option>

                            <option value="INACTIVE">
                              Inaktív
                            </option>
                          </select>

                          <button
                            className="save-price-button"
                            type="button"
                            disabled={
                              savingDesiredStatus ===
                              listing.id
                            }
                            onClick={() =>
                              void saveDesiredStatus(
                                listing,
                              )
                            }
                          >
                            {savingDesiredStatus ===
                            listing.id
                              ? 'Mentés...'
                              : 'Mentés'}
                          </button>
                        </div>
                      </div>
                    </td>

                    <td className="sync-cell">
                      {formatDate(
                        listing.lastSyncedAt,
                      )}
                    </td>
                    <td className="row-sync-cell">
                      <button
                        className="row-sync-button"
                        type="button"
                        disabled={
                          (listing.priceMinor ===
                            listing.desiredPriceMinor &&
                            listing.stockAvailable ===
                              listing.desiredStock &&
                            !hasPublicationDifference(
                              listing,
                            )) ||
                          syncingWholeListingId ===
                            listing.id
                        }
                        onClick={() =>
                          void syncWholeListingToAllegro(
                            listing,
                          )
                        }
                      >
                        {syncingWholeListingId ===
                        listing.id
                          ? 'Szinkron...'
                          : 'Szinkronizálás'}
                      </button>
                    </td>
                  </tr>
                ))}

                {!loading &&
                  allegroListings.length === 0 && (
                    <tr>
                      <td
                        colSpan={10}
                        className="empty-state"
                      >
                        Nincs szinkronizált Allegro
                        ajánlat.
                      </td>
                    </tr>
                  )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" />

          <div>
            <p className="eyebrow">KÄRCHER</p>
            <h1>Commerce Hub</h1>
          </div>
        </div>

        <div className="environment-badge">
          Helyi fejlesztői környezet
        </div>
      </header>

      <main className="content">
        <section className="hero">
          <div>
            <p className="section-label">RENDSZERÁLLAPOT</p>

            <h2>
              {apiHealth
                ? 'A Commerce Hub működik'
                : 'A frontend működik'}
            </h2>

            <p className="hero-text">
              A rendszer már valódi termék- és Allegro-adatokat
              olvas a Neon PostgreSQL-adatbázisból.
            </p>
          </div>

          <div className="hero-status">
            <span className="status-dot" />
            {apiHealth ? 'Rendszer aktív' : 'Frontend aktív'}
          </div>
        </section>

        <section>
          <div className="section-heading">
            <div>
              <p className="section-label">KOMPONENSEK</p>
              <h3>Fejlesztési állapot</h3>
            </div>

            <span>{services.length} komponens</span>
          </div>

          <div className="status-grid">
            {services.map((service) => (
              <article
                className="status-card"
                key={service.name}
              >
                <div className="card-header">
                  <h4>{service.name}</h4>

                  <span
                    className={`status-pill status-${service.status}`}
                  >
                    {statusLabel(service.status)}
                  </span>
                </div>

                <p>{service.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="products-section">
          <div className="section-heading">
            <div>
              <p className="section-label">TERMÉKTÖRZS</p>
              <h3>Termékek</h3>
            </div>

            <span>
              {loading
                ? 'Betöltés...'
                : `${products.length} termék`}
            </span>
          </div>

          <div className="table-card">
            <table className="products-table">
              <thead>
                <tr>
                  <th>Cikkszám</th>
                  <th>EAN</th>
                  <th>Terméknév</th>
                  <th>Termékvonal</th>
                  <th>Kategória</th>
                  <th>Státusz</th>
                </tr>
              </thead>

              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="sku-cell">
                      {product.sku}
                    </td>

                    <td>{getPrimaryEan(product)}</td>

                    <td>{product.name}</td>

                    <td>
                      {formatProductLine(
                        product.productLine,
                      )}
                    </td>

                    <td>{product.category ?? '–'}</td>

                    <td>
                      <span
                        className={`product-status ${
                          product.active
                            ? 'product-active'
                            : 'product-inactive'
                        }`}
                      >
                        {product.active
                          ? 'Aktív'
                          : 'Inaktív'}
                      </span>
                    </td>
                  </tr>
                ))}

                {!loading && products.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="empty-state"
                    >
                      Nincs megjeleníthető termék.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="next-step">
          <div className="step-number">06</div>

          <div>
            <p className="section-label">
              KÖVETKEZŐ LÉPÉS
            </p>

            <h3>Kívánt állapot és szinkron</h3>

            <p>
              Következőként összekötjük az Allegro aktuális
              állapotát a Commerce Hub kívánt állapotával, így
              kezelhetővé válik az ár, a készlet és később a
              kampányárak módosítása.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default HomePage