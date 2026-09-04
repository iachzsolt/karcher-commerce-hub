import CommerceHubTopbar from '../components/CommerceHubTopbar'
import {
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import ArukeresoCatalogPage from './ArukeresoCatalogPage'

import '../CommerceHub.css'

function ArukeresoPlaceholder({
  title,
}: {
  title: string
}) {
  return (
    <section className="module-placeholder">
      <div className="module-placeholder-status">
        <span className="platform-status-dot" />
        Nincs bekötve
      </div>

      <h3>{title}</h3>

      <p>
        Az Árukereső integráció helye már
        elő van készítve, de az adatkapcsolat
        még nincs beállítva.
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

            <NavLink to="/arukereso/pricing">
              Árpozíció
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
              <ArukeresoPlaceholder
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
              <ArukeresoPlaceholder
                title="Termékek"
              />
            }
          />

          <Route
            path="pricing"
            element={
              <ArukeresoPlaceholder
                title="Árpozíció"
              />
            }
          />

          <Route
            path="settings"
            element={
              <ArukeresoPlaceholder
                title="Beállítások"
              />
            }
          />
        </Routes>
      </main>
    </div>
  )
}

export default ArukeresoPage