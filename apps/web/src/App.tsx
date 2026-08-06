import { Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import AllegroPage from './pages/AllegroPage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/allegro/*" element={<AllegroPage />} />
    </Routes>
  )
}

export default App