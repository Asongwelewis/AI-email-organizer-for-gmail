import { RouterProvider } from 'react-router-dom';

import { router } from '@web/router';

export function App() {
  return <RouterProvider router={router} />;
}
