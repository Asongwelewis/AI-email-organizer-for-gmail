import * as Sentry from '@sentry/react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import { ProtectedRoute } from '@web/components/ProtectedRoute';
import { VisualRoot } from '@web/components/MailAtmosphere';
import { RouteErrorBoundary } from '@web/components/RouteErrorBoundary';
import { AppShell } from '@web/layouts/AppShell';
import { PublicLayout } from '@web/layouts/PublicLayout';
import { AuthCallbackPage } from '@web/pages/AuthCallbackPage';
import { ConnectionsPage } from '@web/pages/ConnectionsPage';
import { ClassificationPage } from '@web/pages/ClassificationPage';
import { DashboardPage } from '@web/pages/DashboardPage';
import { LandingPage } from '@web/pages/LandingPage';
import { LoginPage } from '@web/pages/LoginPage';
import { LegalPlaceholder } from '@web/pages/LegalPlaceholder';
import { LabelDiscoveryPage } from '@web/pages/LabelDiscoveryPage';
import { AutomationPage } from '@web/pages/AutomationPage';
import { isSentryEnabled } from '@web/instrument';

const routes: RouteObject[] = [
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
  {
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/settings/connections', element: <ConnectionsPage /> },
      { path: '/dashboard/classification', element: <ClassificationPage /> },
      { path: '/dashboard/labels/discover', element: <LabelDiscoveryPage /> },
      { path: '/dashboard/automation', element: <AutomationPage /> },
    ],
  },
  { path: '/privacy', element: <LegalPlaceholder title="Privacy Policy" /> },
  { path: '/terms', element: <LegalPlaceholder title="Terms of Service" /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

const sentryCreateBrowserRouter = isSentryEnabled
  ? Sentry.wrapCreateBrowserRouterV7(createBrowserRouter)
  : createBrowserRouter;

export const router = sentryCreateBrowserRouter([
  {
    element: <VisualRoot />,
    errorElement: <RouteErrorBoundary />,
    children: routes,
  },
]);
