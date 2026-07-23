import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';

import { ProtectedRoute } from '@web/components/ProtectedRoute';
import { VisualRoot } from '@web/components/MailAtmosphere';
import { AppShell } from '@web/layouts/AppShell';
import { PublicLayout } from '@web/layouts/PublicLayout';
import { AuthCallbackPage } from '@web/pages/AuthCallbackPage';
import { ConnectionsPage } from '@web/pages/ConnectionsPage';
import { ClassificationPage } from '@web/pages/ClassificationPage';
import { DashboardPage } from '@web/pages/DashboardPage';
import { LandingPage } from '@web/pages/LandingPage';
import { LoginPage } from '@web/pages/LoginPage';
import { LegalPlaceholder } from '@web/pages/LegalPlaceholder';

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
    ],
  },
  { path: '/privacy', element: <LegalPlaceholder title="Privacy Policy" /> },
  { path: '/terms', element: <LegalPlaceholder title="Terms of Service" /> },
  { path: '*', element: <Navigate to="/" replace /> },
];

export const router = createBrowserRouter([{ element: <VisualRoot />, children: routes }]);
