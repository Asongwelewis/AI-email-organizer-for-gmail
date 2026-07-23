import { motion } from 'motion/react';
import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/dashboard/classification', label: 'Review' },
  { to: '/dashboard/labels/discover', label: 'Labels' },
  { to: '/settings/connections', label: 'Connections' },
] as const;

export function MotionTabs() {
  return (
    <nav className="motion-tabs" aria-label="Primary navigation">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className="motion-tabs__item">
          {({ isActive }) => (
            <>
              {isActive && (
                <motion.span
                  className="motion-tabs__active"
                  layoutId="active-navigation-tab"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
              <span className="motion-tabs__label">{tab.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
