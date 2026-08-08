import {
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'

import AllegroPage from './pages/AllegroPage'
import ArukeresoPage from './pages/ArukeresoPage'
import CommerceHubPage from './pages/CommerceHubPage'

function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <Navigate
            to="/overview"
            replace
          />
        }
      />

      <Route
        path="/overview"
        element={
          <CommerceHubPage
            section="overview"
          />
        }
      />

      <Route
        path="/platforms"
        element={
          <CommerceHubPage
            section="platforms"
          />
        }
      />

      <Route
        path="/settings"
        element={
          <CommerceHubPage
            section="settings"
          />
        }
      />

      <Route
        path="/allegro/*"
        element={<AllegroPage />}
      />

      <Route
        path="/arukereso/*"
        element={<ArukeresoPage />}
      />

      <Route
        path="*"
        element={
          <Navigate
            to="/overview"
            replace
          />
        }
      />
    </Routes>
  )
}

export default App