import HomePage from './HomePage'

import {
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'

function AllegroOverview() {
  return (
    <section>
      <p className="section-label">ALLEGRO</p>
      <h2>Áttekintés</h2>
      <p>
        Itt jelennek majd meg az Allegro fő statisztikái,
        figyelmeztetései és legfontosabb állapotai.
      </p>
    </section>
  )
}

function AllegroOffers() {
  return <HomePage view="allegroOffers" />
}

function AllegroCampaigns() {
  return (
    <section>
      <p className="section-label">ALLEGRO</p>
      <h2>Kampányok</h2>
      <p>
        Itt kezeljük majd a kampányokat és kampányárakat.
      </p>
    </section>
  )
}

function AllegroSettings() {
  return (
    <section>
      <p className="section-label">ALLEGRO</p>
      <h2>Beállítások</h2>
      <p>
        Ide kerülnek majd az adatforrások és a
        szinkronizálási beállítások.
      </p>
    </section>
  )
}

function AllegroPage() {
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
          Allegro
        </div>
      </header>

      <main className="content">
        <section className="allegro-module-header">
          <div>
            <p className="section-label">
              MARKETPLACE
            </p>
            <h2>Allegro</h2>
          </div>

          <nav className="allegro-navigation">
            <NavLink to="/allegro/overview">
              Áttekintés
            </NavLink>

            <NavLink to="/allegro/offers">
              Ajánlatok
            </NavLink>

            <NavLink to="/allegro/campaigns">
              Kampányok
            </NavLink>

            <NavLink to="/allegro/settings">
              Beállítások
            </NavLink>
          </nav>
        </section>

        <Routes>
          <Route
            index
            element={
              <Navigate
                to="/allegro/overview"
                replace
              />
            }
          />

          <Route
            path="overview"
            element={<AllegroOverview />}
          />

          <Route
            path="offers"
            element={<AllegroOffers />}
          />

          <Route
            path="campaigns"
            element={<AllegroCampaigns />}
          />

          <Route
            path="settings"
            element={<AllegroSettings />}
          />
        </Routes>
      </main>
    </div>
  )
}

export default AllegroPage