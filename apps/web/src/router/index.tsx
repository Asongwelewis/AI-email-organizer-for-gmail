import { createBrowserRouter } from 'react-router-dom';

import { AppLayout } from '@web/layouts/AppLayout';
import { LandingPage } from '@web/pages/LandingPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: (
      <AppLayout>
        <LandingPage />
      </AppLayout>
    ),
  },
]);
