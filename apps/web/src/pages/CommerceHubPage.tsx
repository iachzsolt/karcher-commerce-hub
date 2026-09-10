import DataConnectionsSettings from '../components/DataConnectionsSettings'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

import CommerceHubTopbar from '../components/CommerceHubTopbar'
import { API_BASE_URL } from '../config/api'

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
  accent,
}: {
  name: string
  type: string
  status: string
  description: string
  to: string
  active: boolean
  accent?: 'arukereso'
}) {
  return (
    <Link
      className={`platform-card${
        accent === 'arukereso'
          ? ' platform-card-arukereso'
          : ''
      }`}
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

function OverviewSection({
  arukeresoActive,
}: {
  arukeresoActive: boolean | null
}) {
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
            {arukeresoActive === null
              ? 'Állapot betöltése…'
              : arukeresoActive
                ? '2 aktív'
                : '1 aktív · 1 kikapcsolva'}
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
            status={
              arukeresoActive === null
                ? 'Betöltés…'
                : arukeresoActive
                  ? 'Aktív'
                  : 'Kikapcsolva'
            }
            description={
              arukeresoActive === null
                ? 'A feed csatorna állapotának betöltése folyamatban van.'
                : arukeresoActive
                  ? 'Az Árukereső feed generálása és publikus kiszolgálása aktív.'
                  : 'A feed előnézete elérhető, a generálás és publikus kiszolgálás ki van kapcsolva.'
            }
            to="/arukereso/overview"
            active={arukeresoActive === true}
            accent="arukereso"
          />
        </div>
      </section>
    </>
  )
}

function PlatformsSection({
  arukeresoActive,
}: {
  arukeresoActive: boolean | null
}) {
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
          status={
            arukeresoActive === null
              ? 'Betöltés…'
              : arukeresoActive
                ? 'Aktív'
                : 'Kikapcsolva'
          }
          description={
            arukeresoActive === null
              ? 'A feed csatorna állapotának betöltése folyamatban van.'
              : arukeresoActive
                ? 'Az Árukereső feed generálása és publikus kiszolgálása aktív.'
                : 'A feed előnézete elérhető, a generálás és publikus kiszolgálás ki van kapcsolva.'
          }
          to="/arukereso/overview"
          active={arukeresoActive === true}
          accent="arukereso"
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

      <DataConnectionsSettings />
    </>
  )
}

function CommerceHubPage({
  section,
}: CommerceHubPageProps) {
  const [arukeresoActive, setArukeresoActive] =
    useState<boolean | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    void fetch(
      `${API_BASE_URL}/arukereso/feed/settings`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          isActive?: boolean
        }

        if (response.ok) {
          setArukeresoActive(result.isActive === true)
        }
      })
      .catch(() => undefined)

    return () => controller.abort()
  }, [section])

  return (
    <div className="app-shell">
      <CommerceHubTopbar />

      <main className="content">

        {section === 'overview' && (
          <OverviewSection
            arukeresoActive={arukeresoActive}
          />
        )}

        {section === 'platforms' && (
          <PlatformsSection
            arukeresoActive={arukeresoActive}
          />
        )}

        {section === 'settings' && (
          <SettingsSection />
        )}
      </main>
    </div>
  )
}

export default CommerceHubPage
