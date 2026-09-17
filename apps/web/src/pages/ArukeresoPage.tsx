import CommerceHubTopbar from '../components/CommerceHubTopbar'
import { useEffect, useState } from 'react'
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import ArukeresoCatalogPage from './ArukeresoCatalogPage'
import ArukeresoFeedPreviewPage from './ArukeresoFeedPreviewPage'
import ArukeresoPerformanceView from '../components/ArukeresoPerformanceView'
import ArukeresoProductsPage from './ArukeresoProductsPage'
import ArukeresoSettingsPage from './ArukeresoSettingsPage'
import { API_BASE_URL } from '../config/api'

import '../CommerceHub.css'

type FeedDiagnostics = {
  feedCurrent: boolean
  inventoryStale: boolean
  pricingStale: boolean
  feedFinishedAt: string | null
  inventoryUpdatedAt: string | null
  pricingUpdatedAt: string | null
}

function formatFeedTime(value: string | null) {
  if (!value) {
    return 'nincs adat'
  }

  return new Intl.DateTimeFormat('hu-HU', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function ArukeresoOverview({
  isActive,
  feedDiagnostics,
}: {
  isActive: boolean | null
  feedDiagnostics: FeedDiagnostics | null
}) {
  return (
    <>
      <section className="module-placeholder">
        <div
          className={`module-placeholder-status${
            isActive === false ? ' is-inactive' : ''
          }`}
        >
          <span className="platform-status-dot" />
          {isActive === null
            ? 'Állapot betöltése…'
            : isActive
              ? 'Bekötve'
              : 'Kikapcsolva'}
        </div>

        <h3>Áttekintés</h3>

        <p>
          Az Árukereső teljesítménye a
          kiválasztott időszakban. A mutatók,
          trendek és termékszintű eredmények
          közvetlenül az Árukereső adataiból
          töltődnek be.
        </p>

        <div className="arukereso-feed-health">
          <div className="arukereso-feed-health-heading">
            <strong>Feed állapota</strong>
            <span>
              {feedDiagnostics === null
                ? 'Betöltés…'
                : feedDiagnostics.feedCurrent
                  ? 'Naprakész'
                  : 'Frissítés szükséges'}
            </span>
          </div>

          <div className="arukereso-feed-health-grid">
            <div
              className={
                feedDiagnostics?.pricingStale
                  ? 'is-stale'
                  : 'is-current'
              }
            >
              <span>Pricing Cockpit</span>
              <strong>
                {feedDiagnostics === null
                  ? 'Betöltés…'
                  : feedDiagnostics.pricingStale
                    ? 'Újabb, mint a feed'
                    : 'Naprakész'}
              </strong>
              <small>
                {formatFeedTime(
                  feedDiagnostics?.pricingUpdatedAt ??
                    null,
                )}
              </small>
            </div>

            <div
              className={
                feedDiagnostics?.inventoryStale
                  ? 'is-stale'
                  : 'is-current'
              }
            >
              <span>Készlet</span>
              <strong>
                {feedDiagnostics === null
                  ? 'Betöltés…'
                  : feedDiagnostics.inventoryStale
                    ? 'Újabb, mint a feed'
                    : 'Naprakész'}
              </strong>
              <small>
                {formatFeedTime(
                  feedDiagnostics?.inventoryUpdatedAt ??
                    null,
                )}
              </small>
            </div>
          </div>

          <small className="arukereso-feed-health-footnote">
            Utolsó feed:{' '}
            {formatFeedTime(
              feedDiagnostics?.feedFinishedAt ?? null,
            )}
          </small>
        </div>
      </section>

      <ArukeresoPerformanceView />
    </>
  )
}

function ArukeresoPage() {
  const location = useLocation()
  const [isActive, setIsActive] =
    useState<boolean | null>(null)
  const [feedDiagnostics, setFeedDiagnostics] =
    useState<FeedDiagnostics | null>(null)

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

        if (
          response.ok &&
          typeof result.isActive === 'boolean'
        ) {
          setIsActive(result.isActive)
        }
      })
      .catch(() => undefined)

    void fetch(
      `${API_BASE_URL}/arukereso/feed/latest`,
      { signal: controller.signal },
    )
      .then(async (response) => {
        const result = (await response.json()) as {
          diagnostics?: FeedDiagnostics
        }

        if (response.ok && result.diagnostics) {
          setFeedDiagnostics(result.diagnostics)
        }
      })
      .catch(() => undefined)

    return () => controller.abort()
  }, [location.pathname])

  return (
    <div className="app-shell">
      <CommerceHubTopbar />

      <main className="content">
        <a
          className="hub-back-link"
          href="/platforms"
        >
          ← Platformok
        </a>

        <section className="allegro-module-header">
          <div>
            <p className="section-label">
              PRICE COMPARISON
            </p>

            <h2>Árukereső</h2>
          </div>

          <nav className="allegro-navigation">
            <NavLink to="/arukereso/overview">
              Áttekintés
            </NavLink>

            <NavLink to="/arukereso/catalog">
              Katalógus
            </NavLink>

            <NavLink to="/arukereso/products">
              Termékek
            </NavLink>

            <NavLink to="/arukereso/feed-preview">
              Feed előnézet
            </NavLink>

            <NavLink to="/arukereso/settings">
              Beállítások
            </NavLink>
          </nav>
        </section>

        <Routes>
          <Route
            index
            element={
              <Navigate
                to="/arukereso/overview"
                replace
              />
            }
          />

          <Route
            path="overview"
            element={
              <ArukeresoOverview
                isActive={isActive}
                feedDiagnostics={feedDiagnostics}
              />
            }
          />

          <Route
            path="catalog"
            element={
              <ArukeresoCatalogPage />
            }
          />

          <Route
            path="products"
            element={
              <ArukeresoProductsPage />
            }
          />

          <Route
            path="settings"
            element={<ArukeresoSettingsPage />}
          />

          <Route
            path="feed-preview"
            element={<ArukeresoFeedPreviewPage />}
          />
        </Routes>
      </main>
    </div>
  )
}

export default ArukeresoPage
