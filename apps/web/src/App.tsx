import { MotionConfig } from 'motion/react';
import { RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';

import { UpdatePrompt } from '@web/components/app/UpdatePrompt';
import { AuthProvider } from '@web/context/AuthContext';
import { ThemeProvider } from '@web/context/ThemeContext';
import { useTheme } from '@web/context/useTheme';
import { IN_ISLAND_APP } from '@web/lib/islandApp';
import { router } from '@web/router';

/** Sonner paints its own surfaces, so it has to be told which theme it is sitting on. */
function ThemedToaster() {
  const { resolvedTheme } = useTheme();
  return <Toaster position="top-right" closeButton theme={resolvedTheme} />;
}

export function App() {
  return (
    <MotionConfig reducedMotion="user">
      {/* Outermost, because the theme decides what everything below it is painted on. */}
      <ThemeProvider>
        <AuthProvider>
          <RouterProvider router={router} />
          {/* The island's window is the size of the island: no room for toasts, and it loads
              each page fresh, so it has no offline copy to update. */}
          {IN_ISLAND_APP ? null : <UpdatePrompt />}
          {IN_ISLAND_APP ? null : <ThemedToaster />}
        </AuthProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
