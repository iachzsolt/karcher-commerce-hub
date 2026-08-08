import { Link } from 'react-router-dom'

import CommerceHubTopbar from '../components/CommerceHubTopbar'

import '../CommerceHub.css'

type CommerceHubSection =
  | 'overview'
  | 'platforms'
  | 'settings'

type CommerceHubPageProps = {
  section: CommerceHubSection
}



function PlatformCard({
  name,
  type,
  status,
  description,
  to,
  active,
}: {
  name: string
  type: string
  status: string
  description: string
  to: string
  active: boolean
}) {
  return (
    <Link
      className="platform-card"
      to={to}
    >
      <div className="platform-card-top">
        <div>
          <span className="platform-type">
            {type}
          </span>

          <h3>{name}</h3>
        </div>

        <span
          className={
            active
              ? 'platform-status platform-status-active'
              : 'platform-status platform-status-disconnected'
          }
        >
          <span className="platform-status-dot" />
          {status}
        </span>
      </div>

      <p className="platform-description">
        {description}
      </p>

      <span className="platform-card-action">
        Megnyitás →
      </span>
    </Link>
  )
}

function OverviewSection() {
  return (
    <>
      <section className="hub-page-heading">
        <div>
          <p className="section-label">
            COMMERCE HUB
          </p>

          <h2>Áttekintés</h2>

          <p>
            A csatlakoztatott platformok és
            adatkapcsolatok központi állapota.
          </p>
        </div>
      </section>

      <section className="hub-summary-grid">
        <article className="hub-summary-card">
          <span className="hub-summary-label">
            Platformok
          </span>

          <strong>2</strong>

          <span>
            1 aktív · 1 nincs bekötve
          </span>
        </article>

        <article className="hub-summary-card">
          <span className="hub-summary-label">
            Adatkapcsolatok
          </span>

          <strong>0</strong>

          <span>
            Még nincs beállítva
          </span>
        </article>

        <article className="hub-summary-card">
          <span className="hub-summary-label">
            Rendszerállapot
          </span>

          <strong className="hub-health-ok">
            Rendben
          </strong>

          <span>
            Commerce Hub elérhető
          </span>
        </article>
      </section>

      <section className="hub-section">
        <div className="hub-section-heading">
          <div>
            <h3>Platformok</h3>
            <p>
              A Commerce Hubhoz kapcsolódó
              értékesítési és adatplatformok.
            </p>
          </div>

          <Link
            className="hub-text-link"
            to="/platforms"
          >
            Összes platform →
          </Link>
        </div>

        <div className="platform-grid">
          <PlatformCard
            name="Allegro"
            type="MARKETPLACE"
            status="Aktív"
            description="Ajánlatok, kampányok és szinkronizáció kezelése."
            to="/allegro/overview"
            active
          />

          <PlatformCard
            name="Árukereső"
            type="PRICE COMPARISON"
            status="Nincs bekötve"
            description="Az integráció helye előkészítve, adatkapcsolat még nincs beállítva."
            to="/arukereso/overview"
            active={false}
          />
        </div>
      </section>
    </>
  )
}

function PlatformsSection() {
  return (
    <>
      <section className="hub-page-heading">
        <div>
          <p className="section-label">
            COMMERCE HUB
          </p>

          <h2>Platformok</h2>

          <p>
            A Commerce Hubhoz kapcsolódó
            külső platformok kezelése.
          </p>
        </div>
      </section>

      <div className="platform-grid">
        <PlatformCard
          name="Allegro"
          type="MARKETPLACE"
          status="Aktív"
          description="Az Allegro integráció működik. Ajánlatok, kampányok és szinkronizáció kezelhető."
          to="/allegro/overview"
          active
        />

        <PlatformCard
          name="Árukereső"
          type="PRICE COMPARISON"
          status="Nincs bekötve"
          description="A modul előkészítve. Az Árukereső integráció később kerül bekötésre."
          to="/arukereso/overview"
          active={false}
        />
      </div>
    </>
  )
}

function SettingsSection() {
  return (
    <>
      <section className="hub-page-heading">
        <div>
          <p className="section-label">
            COMMERCE HUB
          </p>

          <h2>Beállítások</h2>

          <p>
            Commerce Hub szintű adatforrások,
            kapcsolatok és automatizációk.
          </p>
        </div>
      </section>

      <section className="hub-section">
        <div className="hub-section-heading">
          <div>
            <h3>Adatkapcsolatok</h3>

            <p>
              Külső adatforrások csatlakoztatása
              a Commerce Hubhoz.
            </p>
          </div>

          <button
            className="hub-primary-button"
            type="button"
            disabled
            title="A Google Sheets kapcsolatot a következő lépésben építjük meg."
          >
            + Új adatkapcsolat
          </button>
        </div>

        <div className="connection-flow-placeholder">
          <div className="connection-node connection-node-source">
            <span className="connection-node-icon">
              +
            </span>

            <strong>Adatforrás</strong>

            <span>
              Google Sheets, API, CSV…
            </span>
          </div>

          <div className="connection-cable">
            <span className="connection-plug" />
            <span className="connection-line" />
            <span className="connection-arrow">
              ›
            </span>
          </div>

          <div className="connection-node connection-node-hub">
            <span className="connection-node-logo">
              CH
            </span>

            <strong>Commerce Hub</strong>

            <span>
              Adatfogadás és validáció
            </span>
          </div>
        </div>

        <div className="hub-empty-state">
          <strong>
            Még nincs adatkapcsolat
          </strong>

          <p>
            Elsőként a Google Sheets
            készletforrást fogjuk bekötni.
          </p>
        </div>
      </section>
    </>
  )
}

function CommerceHubPage({
  section,
}: CommerceHubPageProps) {
  return (
    <div className="app-shell">
      <CommerceHubTopbar />

      <main className="content">

        {section === 'overview' && (
          <OverviewSection />
        )}

        {section === 'platforms' && (
          <PlatformsSection />
        )}

        {section === 'settings' && (
          <SettingsSection />
        )}
      </main>
    </div>
  )
}

export default CommerceHubPage