import * as Sentry from '@sentry/react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import { ProtectedRoute } from '@web/components/ProtectedRoute';
import { VisualRoot } from '@web/components/MailAtmosphere';
import { RouteErrorBoundary } from '@web/components/RouteErrorBoundary';
import { ToInbox } from '@web/components/ToInbox';
import { AppShell } from '@web/layouts/AppShell';
import { PublicLayout } from '@web/layouts/PublicLayout';
import { AuthCallbackPage } from '@web/pages/AuthCallbackPage';
import { LandingPage } from '@web/pages/LandingPage';
import { LoginPage } from '@web/pages/LoginPage';
import { DataDeletionPage } from '@web/pages/DataDeletionPage';
import { FeedbackPage } from '@web/pages/FeedbackPage';
import { PrivacyPolicy } from '@web/pages/PrivacyPolicy';
import { SupportPage } from '@web/pages/SupportPage';
import { TermsOfService } from '@web/pages/TermsOfService';
import { ActivityPage } from '@web/pages/ActivityPage';
import { FavoritesPage } from '@web/pages/FavoritesPage';
import { FindPage } from '@web/pages/FindPage';
import { InboxPage } from '@web/pages/InboxPage';
import { MenuPage } from '@web/pages/MenuPage';
import { NotificationsPage } from '@web/pages/NotificationsPage';
import { SetupPage } from '@web/pages/SetupPage';
import { PivotPage } from '@web/pages/PivotPage';
import { AboutPage } from '@web/pages/AboutPage';
import { AccountPage } from '@web/pages/AccountPage';
import { CookiesPage } from '@web/pages/CookiesPage';
import { FaqPage } from '@web/pages/FaqPage';
import { SecurityPage } from '@web/pages/SecurityPage';
import { isSentryEnabled } from '@web/instrument';

/**
 * The marketing and sign-in surfaces keep their editorial treatment. The signed-in app does not:
 * decorative motion behind a screen you use every day is noise, so the atmosphere stops at the
 * door and the three screens are laid out plainly.
 */
const publicRoutes: RouteObject[] = [
  {
    path: '/',
    element: (
      <PublicLayout>
        <LandingPage />
      </PublicLayout>
    ),
  },
  { path: '/login', element: <LoginPage /> },
  { path: '/auth/callback', element: <AuthCallbackPage /> },
  /*
   * Real documents, not placeholders, and public: Google's restricted-scope verification needs a
   * privacy policy, terms, a support page and an in-app deletion path, all reachable without
   * signing in. Deletion is signed-out-aware rather than protected — the page has to be linkable
   * from a policy and from the Cloud Console.
   */
  { path: '/privacy', element: <PrivacyPolicy /> },
  { path: '/terms', element: <TermsOfService /> },
  { path: '/support', element: <SupportPage /> },
  { path: '/about', element: <AboutPage /> },
  { path: '/faq', element: <FaqPage /> },
  { path: '/security', element: <SecurityPage /> },
  { path: '/cookies', element: <CookiesPage /> },
  /*
   * Public, and it has to be: the people whose opinion is most worth having are the ones who
   * bounced off the app before making an account. It is also, until the operator details in
   * `legal-contact.ts` are filled in, the only working way to reach whoever runs this deployment.
   */
  { path: '/feedback', element: <FeedbackPage /> },
  { path: '/data-deletion', element: <DataDeletionPage /> },
];

const appRoutes: RouteObject[] = [
  { path: '/setup', element: <SetupPage /> },
  { path: '/inbox', element: <InboxPage /> },
  { path: '/find', element: <FindPage /> },
  { path: '/favorites', element: <FavoritesPage /> },
  { path: '/folders', element: <PivotPage /> },
  { path: '/activity', element: <ActivityPage /> },
  { path: '/menu', element: <MenuPage /> },
  { path: '/notifications', element: <NotificationsPage /> },
  { path: '/account', element: <AccountPage /> },
];

const sentryCreateBrowserRouter = isSentryEnabled
  ? Sentry.wrapCreateBrowserRouterV7(createBrowserRouter)
  : createBrowserRouter;

export const router = sentryCreateBrowserRouter([
  {
    element: <VisualRoot />,
    errorElement: <RouteErrorBoundary />,
    children: publicRoutes,
  },
  {
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    errorElement: <RouteErrorBoundary />,
    children: appRoutes,
  },
  // Retired surfaces; keep old links working rather than bouncing them to the landing page.
  // Review and Approve are gone for now and will come back redesigned; until then they lead home.
  { path: '/sorted', element: <ToInbox /> },
  { path: '/review', element: <Navigate to="/inbox" replace /> },
  { path: '/approve', element: <Navigate to="/inbox" replace /> },
  { path: '/dashboard/*', element: <Navigate to="/inbox" replace /> },
  { path: '/labels', element: <Navigate to="/inbox" replace /> },
  { path: '/automation', element: <Navigate to="/activity" replace /> },
  { path: '/settings/*', element: <Navigate to="/inbox" replace /> },
  { path: '*', element: <Navigate to="/" replace /> },
]);
