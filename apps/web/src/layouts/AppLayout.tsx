import type { ReactNode } from 'react';
import { Mail, Sparkles } from 'lucide-react';
import { Toaster } from 'sonner';

import { APP_NAME } from '@mailmind/shared';

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(56,189,248,0.18),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(20,184,166,0.18),_transparent_32%),linear-gradient(180deg,_#040816_0%,_#09111f_48%,_#05070f_100%)]" />
      <div className="pointer-events-none absolute left-[-10%] top-[-15%] h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-10%] right-[-8%] h-80 w-80 rounded-full bg-emerald-400/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-6 md:px-10">
        <header className="flex items-center justify-between rounded-full border border-white/10 bg-white/5 px-5 py-3 shadow-2xl shadow-slate-950/10 backdrop-blur-xl">
          <div className="flex items-center gap-3 text-white">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/15">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-wide">{APP_NAME}</div>
              <div className="text-xs text-slate-300/70">AI Gmail organization</div>
            </div>
          </div>

          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-emerald-400/10 px-4 py-2 text-xs font-medium uppercase tracking-[0.24em] text-emerald-200 md:flex">
            <Sparkles className="h-3.5 w-3.5" />
            Human approval required
          </div>
        </header>

        <main className="flex flex-1 items-center">{children}</main>
      </div>

      <Toaster richColors position="top-right" />
    </div>
  );
}
