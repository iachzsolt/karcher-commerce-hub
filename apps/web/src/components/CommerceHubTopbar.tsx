import {
  NavLink,
  useLocation,
} from 'react-router-dom'

function CommerceHubTopbar() {
  const location = useLocation()

  const platformSectionActive =
    location.pathname === '/platforms' ||
    location.pathname.startsWith(
      '/allegro',
    ) ||
    location.pathname.startsWith(
      '/arukereso',
    )

  return (
    <header className="topbar hub-topbar">
      <div className="hub-topbar-brand">
        <div className="hub-brand-accent" />

        <div className="hub-brand-copy">
          <p className="eyebrow">
            KÄRCHER
          </p>

          <h1>Commerce Hub</h1>
        </div>
      </div>

      <nav className="hub-navigation">
        <NavLink
          to="/overview"
          className={({ isActive }) =>
            isActive ? 'active' : undefined
          }
        >
          Áttekintés
        </NavLink>

        <NavLink
          to="/platforms"
          className={() =>
            platformSectionActive
              ? 'active'
              : undefined
          }
        >
          Platformok
        </NavLink>

        <NavLink
          to="/settings"
          className={({ isActive }) =>
            isActive ? 'active' : undefined
          }
        >
          Beállítások
        </NavLink>
      </nav>

      <div className="hub-topbar-spacer" />
    </header>
  )
}

export default CommerceHubTopbar