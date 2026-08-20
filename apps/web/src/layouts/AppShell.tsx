import { CheckCheck, History, LayoutGrid, LogOut } from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { useAuth } from '@web/context/useAuth';

/**
 * One layout, one breakpoint. Below 768px the navigation is a bottom tab bar; above it, a left
 * rail beside a max-width column. The same three destinations either way — a phone layout stretched
 * across a desktop is the failure this avoids.
 */
const NAV = [
  { to: '/sorted', label: 'Sorted', Icon: LayoutGrid },
  { to: '/approve', label: 'Approve', Icon: CheckCheck },
  { to: '/activity', label: 'Activity', Icon: History },
] as const;

export function AppShell() {
  const { user, logout } = useAuth();

  if (!user) return null;

  return (
    <div className="shell">
      <nav className="shell__rail" aria-label="Primary">
        <span className="shell__brand">MailMind</span>
        <ul className="shell__nav">
          {NAV.map(({ to, label, Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) => `nav-item${isActive ? ' nav-item--active' : ''}`}
              >
                <Icon aria-hidden="true" strokeWidth={1.5} />
                <span>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="shell__account">
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          <span className="shell__email">{user.email}</span>
          <button
            className="button button--icon"
            type="button"
            onClick={() => void logout()}
            aria-label="Log out"
          >
            <LogOut aria-hidden="true" strokeWidth={1.5} />
          </button>
        </div>
      </nav>

      <main className="shell__main">
        <div className="shell__column">
          <Outlet />
        </div>
      </main>

      <nav className="shell__tabs" aria-label="Primary">
        {NAV.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `tab-item${isActive ? ' tab-item--active' : ''}`}
          >
            <Icon aria-hidden="true" strokeWidth={1.5} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
