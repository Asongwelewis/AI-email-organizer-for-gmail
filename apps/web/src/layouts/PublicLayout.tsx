import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { Link } from 'react-router-dom';

import { BrandMark } from '@web/components/BrandMark';

export function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-shell">
      <header className="public-header">
        <BrandMark />
        <nav aria-label="Public navigation">
          <a href="#principles">Principles</a>
          <a href="#how-it-works">How it works</a>
          <Link className="header-login" to="/login">
            Sign in <ArrowUpRight aria-hidden="true" />
          </Link>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="public-footer">
        <BrandMark />
        <p>Thoughtful inbox organization. You stay in control.</p>
        <span>© {new Date().getFullYear()} MailMind AI</span>
      </footer>
    </div>
  );
}
