import CommerceHubTopbar from '../components/CommerceHubTopbar'
import HomePage from './HomePage'
import AllegroCampaignsPage from './AllegroCampaignsPage'
import AllegroHistoryPage from './AllegroHistoryPage'
import AllegroOverviewPage from './AllegroOverviewPage'
import AllegroSettingsPage from './AllegroSettingsPage'

import {
  NavLink,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'

function AllegroOffers() {
  return <HomePage view="allegroOffers" />
}

function AllegroCampaigns() {
  return <AllegroCampaignsPage />
}

function AllegroSettings() {
  return <AllegroSettingsPage />
}

function AllegroPage() {
  return (
    <div className="app-shell">
      <CommerceHubTopbar />

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

            <NavLink to="/allegro/history">
              Előzmények
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
            element={<AllegroOverviewPage />}
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
            path="history"
            element={<AllegroHistoryPage />}
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
