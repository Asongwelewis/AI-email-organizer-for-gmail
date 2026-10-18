import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth } from '@web/context/useAuth';
import { RouteLoader } from './RouteLoader';

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <RouteLoader />;
  if (!isAuthenticated) {
    const safeReturnPath = [
      '/inbox',
      '/favorites',
      '/find',
      '/folders',
      '/activity',
      '/menu',
      '/notifications',
      '/account',
    ].includes(location.pathname)
      ? location.pathname
      : '/inbox';
    return <Navigate to="/login" replace state={{ returnTo: safeReturnPath }} />;
  }
  return children;
}
