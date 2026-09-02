import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

import { BrandMark } from '@web/components/BrandMark';
import { ThemeToggle } from '@web/components/ThemeToggle';

export function PublicLayout({ children }: { children: ReactNode }) {
  // Passed as router state rather than a query parameter: it is context for whoever reads the
  // note, not something that belongs in a shareable URL.
  const { pathname } = useLocation();

  return (
    <div className="public-shell">
      <header className="public-header">
        <BrandMark />
        <nav aria-label="Public navigation">
          <Link to="/about">About</Link>
          <Link to="/faq">FAQ</Link>
          <Link to="/security">Security</Link>
          <ThemeToggle variant="compact" />
          <Link className="header-login" to="/login">
            Sign in <ArrowUpRight aria-hidden="true" />
          </Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="public-footer">
        <BrandMark />
        <p>Thoughtful inbox organization. You stay in control.</p>
        <nav className="public-footer__links" aria-label="Footer">
          <Link to="/about">About</Link>
          <Link to="/faq">FAQ</Link>
          <Link to="/security">Security</Link>
          <Link to="/cookies">Cookies</Link>
          <Link to="/feedback" state={{ from: pathname }}>
            Send feedback
          </Link>
          <Link to="/support">Support</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
        <span>© {new Date().getFullYear()} MailMind AI</span>
      </footer>
    </div>
  );
}
