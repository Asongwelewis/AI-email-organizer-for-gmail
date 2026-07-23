import { MotionConfig } from 'motion/react';
import { RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';

import { CustomCursor } from '@web/components/CustomCursor';
import { AuthProvider } from '@web/context/AuthContext';
import { router } from '@web/router';

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      <AuthProvider>
        <RouterProvider router={router} />
        <CustomCursor />
        <Toaster position="top-right" closeButton theme="light" />
      </AuthProvider>
    </MotionConfig>
  );
}
