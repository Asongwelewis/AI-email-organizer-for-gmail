import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, CheckCircle2, CircleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';

import { BrandMark } from '@web/components/BrandMark';
import { MagneticButton } from '@web/components/MagneticButton';
import { queryKeys } from '@web/queries/queryKeys';

const statuses = {
  login_success: {
    kind: 'success',
    title: 'Welcome to MailMind.',
    copy: 'Your secure session is ready.',
    destination: '/dashboard',
  },
  login_succeeded: {
    kind: 'success',
    title: 'Welcome to MailMind.',
    copy: 'Your secure session is ready.',
    destination: '/dashboard',
  },
  login_failed: {
    kind: 'error',
    title: 'Sign-in paused.',
    copy: 'Google sign-in could not be completed. Please try again.',
    destination: '/login?status=login_failed',
  },
  gmail_connected: {
    kind: 'success',
    title: 'Gmail is connected.',
    copy: 'The connection is ready for future MailMind organization tools.',
    destination: '/settings/connections',
  },
  gmail_denied: {
    kind: 'error',
    title: 'Gmail stayed private.',
    copy: 'Access was not approved. Your MailMind login is still active.',
    destination: '/settings/connections',
  },
  gmail_permission_incomplete: {
    kind: 'error',
    title: 'One permission is missing.',
    copy: 'Reconnect and approve the requested Gmail access to complete setup.',
    destination: '/settings/connections',
  },
  gmail_reauth_required: {
    kind: 'error',
    title: 'A fresh connection is needed.',
    copy: 'Reconnect Gmail to renew MailMind’s access.',
    destination: '/settings/connections',
  },
  gmail_connection_failed: {
    kind: 'error',
    title: 'Connection interrupted.',
    copy: 'Gmail could not be connected. Your MailMind account is unchanged.',
    destination: '/settings/connections',
  },
  gmail_failed: {
    kind: 'error',
    title: 'Connection interrupted.',
    copy: 'Gmail could not be connected. Your MailMind account is unchanged.',
    destination: '/settings/connections',
  },
} as const;

export function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [seconds, setSeconds] = useState(2);
  const statusKey = searchParams.get('status') ?? '';
  const status = useMemo(
    () =>
      statuses[statusKey as keyof typeof statuses] ?? {
        kind: 'error' as const,
        title: 'We could not finish that step.',
        copy: 'No sensitive details were accepted from this URL. Please continue safely.',
        destination: '/login',
      },
    [statusKey],
  );

  useEffect(() => {
    if (statusKey === 'login_success' || statusKey === 'login_succeeded') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
    }
    if (statusKey.startsWith('gmail_')) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gmailConnection });
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe });
    }
    const tick = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000);
    const redirect = window.setTimeout(() => navigate(status.destination, { replace: true }), 1900);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(redirect);
    };
  }, [navigate, queryClient, status.destination, statusKey]);

  const Icon = status.kind === 'success' ? CheckCircle2 : CircleAlert;

  return (
    <main className="callback-page" aria-live="polite">
      <BrandMark />
      <motion.section
        className={`callback-card callback-card--${status.kind}`}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
      >
        <div className="callback-card__icon">
          <Icon aria-hidden="true" />
        </div>
        <span className="eyebrow">Secure handoff</span>
        <h1>{status.title}</h1>
        <p>{status.copy}</p>
        <div className="callback-progress" aria-label={`Continuing in ${seconds} seconds`}>
          <motion.span
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1.9, ease: 'linear' }}
          />
        </div>
        <MagneticButton onClick={() => navigate(status.destination, { replace: true })}>
          Continue now <ArrowRight aria-hidden="true" />
        </MagneticButton>
      </motion.section>
    </main>
  );
}
