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

type PlatformResponse = {
  status: string
  count: number
  data: Platform[]
}

type ServiceStatus = {
  name: string
  description: string
  status: 'Működik' | 'Nincs csatlakoztatva' | 'Tervezett'
}

function App() {
  const [apiHealth, setApiHealth] = useState<HealthResponse | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])

  useEffect(() => {
    const loadSystemStatus = async () => {
      try {
        const [healthResponse, platformResponse] = await Promise.all([
          fetch('http://localhost:3000/health'),
          fetch('http://localhost:3000/platforms'),
        ])

        if (!healthResponse.ok || !platformResponse.ok) {
          throw new Error('API request failed')
        }

        const healthData = (await healthResponse.json()) as HealthResponse
        const platformData = (await platformResponse.json()) as PlatformResponse

        setApiHealth(healthData)
        setPlatforms(platformData.data)
      } catch {
        setApiHealth(null)
        setPlatforms([])
      }
    }

    void loadSystemStatus()
  }, [])

  const allegro = platforms.find((platform) => platform.code === 'ALLEGRO')
  const arukereso = platforms.find((platform) => platform.code === 'ARUKERESO')

  const services: ServiceStatus[] = [
    {
      name: 'Adminfelület',
      description: 'React + TypeScript alkalmazás',
      status: 'Működik',
    },
    {
      name: 'Backend API',
      description: apiHealth
        ? `Kapcsolódva • ${apiHealth.service}`
        : 'A backend jelenleg nem érhető el',
      status: apiHealth ? 'Működik' : 'Nincs csatlakoztatva',
    },
    {
      name: 'PostgreSQL adatbázis',
      description: 'Neon PostgreSQL kapcsolat aktív',
      status: apiHealth ? 'Működik' : 'Nincs csatlakoztatva',
    },
    {
      name: 'Allegro',
      description: allegro
        ? 'Platform rekord betöltve a Neon adatbázisból'
        : 'A platform még nem érhető el',
      status: allegro ? 'Működik' : 'Nincs csatlakoztatva',
    },
    {
      name: 'Árukereső',
      description: arukereso
        ? 'Platform rekord betöltve a Neon adatbázisból'
        : 'A platform még nem érhető el',
      status: arukereso ? 'Működik' : 'Nincs csatlakoztatva',
    },
  ]

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true" />
          <div>
            <p className="eyebrow">KÄRCHER</p>
            <h1>Commerce Hub</h1>
          </div>
        </div>

        <div className="environment-badge">Helyi fejlesztői környezet</div>
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
              {apiHealth
                ? 'A Commerce Hub adminfelülete sikeresen kapcsolódik a backend API-hoz és a Neon PostgreSQL-adatbázishoz.'
                : 'A frontend működik, de a háttérrendszer jelenleg nem érhető el.'}
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
                    className={`status-pill status-${service.status
                      .toLowerCase()
                      .replaceAll(' ', '-')}`}
                  >
                    {service.status}
                  </span>
                </div>

                <p>{service.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="next-step">
          <div className="step-number">04</div>

          <div>
            <p className="section-label">KÖVETKEZŐ LÉPÉS</p>
            <h3>Első termékadat betöltése</h3>

            <p>
              Létrehozunk egy tesztterméket a központi terméktörzsben,
              hozzáadjuk az EAN-azonosítóját, majd API-n keresztül lekérjük a
              frontend számára.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App