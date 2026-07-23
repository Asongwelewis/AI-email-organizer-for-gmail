import { useEffect } from 'react';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { Navigate, useSearchParams } from 'react-router-dom';

import loginImage from '@web/assets/mailmind-secure-sort.png';
import { BrandMark } from '@web/components/BrandMark';
import { MagneticButton } from '@web/components/MagneticButton';
import { RouteLoader } from '@web/components/RouteLoader';
import { useAuth } from '@web/context/useAuth';

const safeLoginErrors: Record<string, string> = {
  login_failed: 'Google sign-in could not be completed. Nothing was connected—please try again.',
  all_sessions_ended: 'Every MailMind session has been securely ended.',
};

export function LoginPage() {
  const { isAuthenticated, isLoading, isRedirecting, login } = useAuth();
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status') ?? '';
  const message = safeLoginErrors[status];

  useEffect(() => {
    document.title = 'Sign in · MailMind AI';
  }, []);

  if (isLoading) return <RouteLoader />;
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  return (
    <main className="login-page">
      <section className="login-panel">
        <BrandMark />
        <motion.div
          className="login-panel__content"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.62, ease: [0.22, 1, 0.36, 1] }}
        >
          <span className="eyebrow">A calmer starting point</span>
          <h1>
            Sign in.
            <br />
            <em>Keep the keys.</em>
          </h1>
          <p>Organize your inbox intelligently while keeping you in control.</p>

          {message && (
            <div className="safe-alert" role="alert">
              {message}
            </div>
          )}

          <MagneticButton className="google-button" onClick={login} disabled={isRedirecting}>
            <GoogleGlyph />
            {isRedirecting ? 'Opening Google…' : 'Continue with Google'}
            <ArrowRight aria-hidden="true" />
          </MagneticButton>

          <div className="login-assurances">
            <span>
              <LockKeyhole /> Secure HttpOnly session
            </span>
            <span>
              <ShieldCheck /> No Gmail permission at sign-in
            </span>
          </div>
        </motion.div>
        <footer className="login-panel__footer">
          <a href="/privacy">Privacy Policy</a>
          <a href="/terms">Terms of Service</a>
        </footer>
      </section>
      <motion.figure
        className="login-art"
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.8 }}
      >
        <img src={loginImage} alt="Paper envelope passing through a precise sorting gate" />
        <figcaption>
          <span>Identity is one permission.</span>
          <strong>Your inbox is another.</strong>
        </figcaption>
      </motion.figure>
    </main>
  );
}

function GoogleGlyph() {
  return (
    <svg className="google-glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.23-.2-1.78H12v3.4h5.52a4.74 4.74 0 0 1-2.05 3.02l-.02.11 2.97 2.3.2.02c1.84-1.7 2.98-4.2 2.98-7.07Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.68 0 4.93-.88 6.58-2.4l-3.15-2.44c-.84.57-1.98.97-3.43.97a5.95 5.95 0 0 1-5.63-4.1l-.1.01-3.09 2.4-.04.1A9.94 9.94 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.37 14.03A6.13 6.13 0 0 1 6.04 12c0-.7.12-1.38.32-2.03v-.12L3.23 7.42l-.1.05A10 10 0 0 0 2 12c0 1.63.39 3.17 1.14 4.53l3.23-2.5Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.87c1.87 0 3.13.81 3.85 1.48l2.8-2.74A9.47 9.47 0 0 0 12 2a9.94 9.94 0 0 0-8.86 5.47l3.22 2.5A5.97 5.97 0 0 1 12 5.87Z"
      />
    </svg>
  );
}
