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
import ArukeresoPerformancePage from './ArukeresoPerformancePage'
import ArukeresoProductsPage from './ArukeresoProductsPage'
import ArukeresoSettingsPage from './ArukeresoSettingsPage'
import { API_BASE_URL } from '../config/api'

import '../CommerceHub.css'

function ArukeresoOverview({
  title,
  isActive,
}: {
  title: string
  isActive: boolean | null
}) {
  return (
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

      <h3>{title}</h3>

      <p>
        Az Árukereső katalógus, termékszabályok,
        feed-előnézet és feed-generálás a fenti
        menüpontokból kezelhető.
      </p>
    </section>
  )
}

function ArukeresoPage() {
  const location = useLocation()
  const [isActive, setIsActive] =
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

        if (
          response.ok &&
          typeof result.isActive === 'boolean'
        ) {
          setIsActive(result.isActive)
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

            <NavLink to="/arukereso/performance">
              Teljesítmény
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
                title="Áttekintés"
                isActive={isActive}
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

          <Route
            path="performance"
            element={<ArukeresoPerformancePage />}
          />
        </Routes>
      </main>
    </div>
  )
}

export default ArukeresoPage
