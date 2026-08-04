import { useEffect, useState } from 'react'
import './App.css'

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

function App() {
  const [apiHealth, setApiHealth] =
    useState<HealthResponse | null>(null)

  const [platforms, setPlatforms] =
    useState<Platform[]>([])

  const [products, setProducts] =
    useState<Product[]>([])

  const [allegroListings, setAllegroListings] =
    useState<AllegroListing[]>([])

  const [desiredPriceDrafts, setDesiredPriceDrafts] =
    useState<Record<string, string>>({})

  const [savingDesiredPrice, setSavingDesiredPrice] =
    useState<string | null>(null)

  const [syncingListingId, setSyncingListingId] =
    useState<string | null>(null)

  const [loading, setLoading] = useState(true)

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
  const pushDesiredPriceToAllegro = async (
    listing: AllegroListing,
  ) => {
    if (
      listing.desiredPriceMinor === null ||
      listing.priceMinor === listing.desiredPriceMinor
    ) {
      return
    }

    const confirmed = window.confirm(
      `Biztosan módosítod az Allegro HU árat?\n\n` +
        `${formatMoney(
          listing.priceMinor,
          listing.currency,
        )} → ${formatMoney(
          listing.desiredPriceMinor,
          listing.currency,
        )}`,
    )

    if (!confirmed) {
      return
    }

    setSyncingListingId(listing.id)

    try {
      const pushResponse = await fetch(
        `http://localhost:3000/auth/allegro/push-price/${listing.id}`,
        {
          method: 'POST',
        },
      )

      const pushData = (await pushResponse.json()) as {
        status: string
        message?: string
      }

      if (!pushResponse.ok) {
        if (pushResponse.status === 401) {
          throw new Error(
            'Az Allegro-fiók nincs csatlakoztatva.',
          )
        }

        throw new Error(
          pushData.message ??
            'Az Allegro árfrissítés sikertelen.',
        )
      }

      if (pushData.status !== 'ok') {
        throw new Error(
          'Az Allegro még feldolgozza az árváltozást.',
        )
      }

      const syncResponse = await fetch(
        'http://localhost:3000/auth/allegro/sync',
        {
          method: 'POST',
        },
      )

      if (!syncResponse.ok) {
        throw new Error(
          'Az ár módosult, de az új állapot visszaolvasása sikertelen.',
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

      window.alert(
        'Az Allegro HU ár sikeresen frissült.',
      )
    } catch (error) {
      console.error(
        'Allegro price synchronization failed:',
        error,
      )

      window.alert(
        error instanceof Error
          ? error.message
          : 'Az Allegro szinkronizálás sikertelen.',
      )
    } finally {
      setSyncingListingId(null)
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

        <section className="allegro-section">
          <div className="section-heading">
            <div>
              <p className="section-label">
                ALLEGRO MAGYARORSZÁG
              </p>

              <h3>Ajánlatok</h3>
            </div>

            <span>
              {loading
                ? 'Betöltés...'
                : `${allegroListings.length} ajánlat`}
            </span>
          </div>

          <div className="table-card">
            <table className="products-table allegro-table">
              <thead>
                <tr>
                  <th>Cikkszám</th>
                  <th>Terméknév</th>
                  <th>Offer ID</th>
                  <th>Aktuális ár</th>
                  <th>Kívánt ár</th>
                  <th>Aktuális készlet</th>
                  <th>Kívánt készlet</th>
                  <th>Eltérés</th>
                  <th>Művelet</th>
                  <th>Státusz</th>
                  <th>Utolsó szinkron</th>
                </tr>
              </thead>

              <tbody>
                {allegroListings.map((listing) => (
                  <tr key={listing.id}>
                    <td className="sku-cell">
                      {listing.sku}
                    </td>

                    <td>{listing.productName}</td>

                    <td className="offer-id-cell">
                      {listing.offerId}
                    </td>

                    <td className="price-cell">
                      {formatMoney(
                        listing.priceMinor,
                        listing.currency,
                      )}
                    </td>

                    <td className="desired-price-cell">
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
                    </td>

                    <td>
                      {listing.stockAvailable ?? '–'} db
                    </td>

                    <td>
                      {listing.desiredStock ?? '–'} db
                    </td>

                    <td>
                      {listing.priceMinor ===
                        listing.desiredPriceMinor &&
                      listing.stockAvailable ===
                        listing.desiredStock ? (
                        <span className="sync-match">
                          Rendben
                        </span>
                      ) : (
                        <span className="sync-difference">
                          Eltérés
                        </span>
                      )}
                    </td>

                    <td>
                      <button
                        className="sync-price-button"
                        type="button"
                        disabled={
                          listing.desiredPriceMinor === null ||
                          listing.priceMinor ===
                            listing.desiredPriceMinor ||
                          syncingListingId === listing.id
                        }
                        onClick={() =>
                          void pushDesiredPriceToAllegro(
                            listing,
                          )
                        }
                      >
                        {syncingListingId === listing.id
                          ? 'Szinkron...'
                          : 'Küldés az Allegróra'}
                      </button>
                    </td>

                    <td>
                      <span
                        className={`listing-status listing-${listing.publicationStatus.toLowerCase()}`}
                      >
                        {formatListingStatus(
                          listing.publicationStatus,
                        )}
                      </span>
                    </td>

                    <td className="sync-cell">
                      {formatDate(
                        listing.lastSyncedAt,
                      )}
                    </td>
                  </tr>
                ))}

                {!loading &&
                  allegroListings.length === 0 && (
                    <tr>
                      <td
                        colSpan={11}
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

export default App