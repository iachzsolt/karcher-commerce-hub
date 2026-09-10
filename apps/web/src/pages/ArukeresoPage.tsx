import CommerceHubTopbar from '../components/CommerceHubTopbar'
import {
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import ArukeresoCatalogPage from './ArukeresoCatalogPage'
import ArukeresoFeedPreviewPage from './ArukeresoFeedPreviewPage'
import ArukeresoProductsPage from './ArukeresoProductsPage'
import ArukeresoSettingsPage from './ArukeresoSettingsPage'

import '../CommerceHub.css'

function ArukeresoOverview({
  title,
}: {
  title: string
}) {
  return (
    <section className="module-placeholder">
      <div className="module-placeholder-status">
        <span className="platform-status-dot" />
        Aktív integráció
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
                title="Áttekintés"
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
