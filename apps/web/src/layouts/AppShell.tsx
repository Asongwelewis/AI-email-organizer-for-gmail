import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { motion } from 'motion/react';
import { Outlet, useLocation } from 'react-router-dom';

import { Avatar } from '@web/components/Avatar';
import { BrandMark } from '@web/components/BrandMark';
import { ConfirmDialog } from '@web/components/ConfirmDialog';
import { MotionTabs } from '@web/components/MotionTabs';
import { useAuth } from '@web/context/useAuth';

export function AppShell() {
  const { user, logout, logoutAll } = useAuth();
  const location = useLocation();
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);

  if (!user) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <BrandMark />
        <MotionTabs />
        <div className="app-header__user">
          <div className="app-header__identity">
            <strong>{user.displayName ?? 'MailMind member'}</strong>
            <span>{user.email}</span>
          </div>
          <Avatar name={user.displayName} email={user.email} src={user.avatarUrl} />
          <button
            className="icon-button"
            type="button"
            onClick={() => void logout()}
            aria-label="Log out"
          >
            <LogOut aria-hidden="true" />
          </button>
        </div>
        <button
          className="mobile-logout icon-button"
          type="button"
          onClick={() => void logout()}
          aria-label="Log out"
        >
          <LogOut aria-hidden="true" />
        </button>
      </header>

      <motion.main
        className="app-content"
        key={location.pathname}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
      >
        <Outlet context={{ openLogoutAll: () => setLogoutAllOpen(true) }} />
      </motion.main>

      <ConfirmDialog
        open={logoutAllOpen}
        title="End every MailMind session?"
        description="You will be signed out on this device and every other browser where MailMind is active."
        confirmLabel="Log out everywhere"
        destructive
        onCancel={() => setLogoutAllOpen(false)}
        onConfirm={() => void logoutAll()}
      />
    </div>
  );
}
