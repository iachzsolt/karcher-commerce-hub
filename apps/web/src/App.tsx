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

type Product = {
  id: string
  sku: string
  name: string
  productLine: 'HG' | 'PROFESSIONAL' | 'UNASSIGNED'
  category: string | null
  active: boolean
  createdAt: string
  updatedAt: string
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

function App() {
  const [apiHealth, setApiHealth] = useState<HealthResponse | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [healthResponse, platformResponse, productResponse] =
          await Promise.all([
            fetch('http://localhost:3000/health'),
            fetch('http://localhost:3000/platforms'),
            fetch('http://localhost:3000/products'),
          ])

        if (
          !healthResponse.ok ||
          !platformResponse.ok ||
          !productResponse.ok
        ) {
          throw new Error('API request failed')
        }

        const healthData =
          (await healthResponse.json()) as HealthResponse

        const platformData =
          (await platformResponse.json()) as PlatformResponse

        const productData =
          (await productResponse.json()) as ProductResponse

        setApiHealth(healthData)
        setPlatforms(platformData.data)
        setProducts(productData.data)
      } catch {
        setApiHealth(null)
        setPlatforms([])
        setProducts([])
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
      description: allegro
        ? 'Platform előkészítve az integrációhoz'
        : 'A platform nem érhető el',
      status: allegro ? 'prepared' : 'disconnected',
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
                ? 'A teljes alapinfrastruktúra működik'
                : 'A frontend működik'}
            </h2>

            <p className="hero-text">
              A Commerce Hub már valódi adatokat olvas a Neon
              PostgreSQL-adatbázisból.
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
              <article className="status-card" key={service.name}>
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
              {loading ? 'Betöltés...' : `${products.length} termék`}
            </span>
          </div>

          <div className="table-card">
            <table className="products-table">
              <thead>
                <tr>
                  <th>Cikkszám</th>
                  <th>Terméknév</th>
                  <th>Termékvonal</th>
                  <th>Kategória</th>
                  <th>Státusz</th>
                </tr>
              </thead>

              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="sku-cell">{product.sku}</td>
                    <td>{product.name}</td>
                    <td>{formatProductLine(product.productLine)}</td>
                    <td>{product.category ?? '–'}</td>
                    <td>
                      <span
                        className={`product-status ${
                          product.active
                            ? 'product-active'
                            : 'product-inactive'
                        }`}
                      >
                        {product.active ? 'Aktív' : 'Inaktív'}
                      </span>
                    </td>
                  </tr>
                ))}

                {!loading && products.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-state">
                      Nincs megjeleníthető termék.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="next-step">
          <div className="step-number">05</div>

          <div>
            <p className="section-label">KÖVETKEZŐ LÉPÉS</p>
            <h3>Termékazonosítók és Allegro-ajánlatok</h3>

            <p>
              Következőként az EAN-okat kapcsoljuk a termékekhez,
              majd elkezdjük felépíteni az Allegro-ajánlatok
              adatmodelljét és importfolyamatát.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App