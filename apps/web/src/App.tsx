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
                  <th>Ár</th>
                  <th>Készlet</th>
                  <th>Eladott</th>
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

                    <td>
                      {listing.stockAvailable ?? '–'} db
                    </td>

                    <td>{listing.stockSold ?? 0} db</td>

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
                        colSpan={8}
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