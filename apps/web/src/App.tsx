import { useEffect, useState } from 'react'
import './App.css'

type HealthResponse = {
  status: string
  service: string
  environment: string
  timestamp: string
}

type ServiceStatus = {
  name: string
  description: string
  status: 'Működik' | 'Nincs csatlakoztatva' | 'Tervezett'
}

function App() {
  const [apiHealth, setApiHealth] = useState<HealthResponse | null>(null)

  useEffect(() => {
    const checkApi = async () => {
      try {
        const response = await fetch('http://localhost:3000/health')

        if (!response.ok) {
          throw new Error('A backend nem válaszolt megfelelően.')
        }

        const data = (await response.json()) as HealthResponse
        setApiHealth(data)
      } catch {
        setApiHealth(null)
      }
    }

    void checkApi()
  }, [])

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
      description: 'Helyi fejlesztői adatbázis',
      status: 'Nincs csatlakoztatva',
    },
    {
      name: 'Allegro integráció',
      description: 'Először tesztadatokkal építjük meg',
      status: 'Tervezett',
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
                ? 'A frontend és a backend működik'
                : 'A frontend működik'}
            </h2>

            <p className="hero-text">
              {apiHealth
                ? 'A Commerce Hub adminfelülete sikeresen kapcsolódott a backend API-hoz. A következő lépésben létrehozzuk és csatlakoztatjuk a PostgreSQL-adatbázist.'
                : 'A frontend működik, de a backend API jelenleg nem érhető el.'}
            </p>
          </div>

          <div className="hero-status">
            <span className="status-dot" />
            {apiHealth ? 'Frontend és backend aktív' : 'Frontend aktív'}
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
          <div className="step-number">03</div>

          <div>
            <p className="section-label">KÖVETKEZŐ LÉPÉS</p>
            <h3>PostgreSQL-adatbázis létrehozása</h3>

            <p>
              Elkészítjük a helyi fejlesztői adatbázist, majd létrehozzuk az
              első adatbázis-kapcsolatot és ellenőrző végpontot.
            </p>
          </div>
        </section>
      </main>
    </div>
  )
}

export default App