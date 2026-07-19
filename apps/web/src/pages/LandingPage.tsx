import { ArrowRight, BrainCircuit, FolderTree, ShieldCheck, Sparkles } from 'lucide-react';

import { Button } from '@mailmind/ui';

import { APP_NAME, APP_TAGLINE } from '@mailmind/shared';

import { StatCard } from '@web/components/StatCard';

const labelPreview = [
  'Newsletters > AI > OpenAI',
  'Work > Product > Launches',
  'Personal > Finance > Banking',
  'Travel > Receipts > Hotels',
];

export function LandingPage() {
  return (
    <section className="grid w-full gap-8 py-10 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
      <div className="max-w-3xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-100">
          <Sparkles className="h-3.5 w-3.5" />
          Production-ready foundation
        </div>

        <h1 className="mt-6 text-5xl font-semibold tracking-tight text-white md:text-7xl">
          Let your inbox organize itself without losing control.
        </h1>

        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300/85 md:text-xl">
          {APP_NAME} analyzes inbox patterns, proposes hierarchical Gmail labels, and waits for your
          approval before anything is applied. {APP_TAGLINE}
        </p>

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center">
          <Button disabled className="min-w-[190px]">
            Connect Gmail
            <ArrowRight className="h-4 w-4" />
          </Button>

          <div className="text-sm text-slate-300/75">
            OAuth flow is scaffolded and disabled until Gmail wiring is complete.
          </div>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          <StatCard label="Inbox patterns" value="Analyzed" tone="sky" />
          <StatCard label="Label tree" value="Generated" tone="emerald" />
          <StatCard label="User control" value="Approval first" tone="amber" />
        </div>
      </div>

      <div className="relative">
        <div className="absolute inset-0 rounded-[2rem] bg-white/5 blur-3xl" />
        <div className="relative rounded-[2rem] border border-white/10 bg-slate-950/45 p-5 shadow-[0_28px_80px_rgba(2,6,23,0.45)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-white/10 pb-4">
            <div>
              <div className="text-sm font-semibold text-white">Suggested label hierarchy</div>
              <div className="text-xs uppercase tracking-[0.28em] text-slate-400">Preview only</div>
            </div>
            <FolderTree className="h-5 w-5 text-cyan-200" />
          </div>

          <div className="mt-5 space-y-3">
            {labelPreview.map((label, index) => (
              <div
                key={label}
                className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/5 px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400/10 text-cyan-100 ring-1 ring-cyan-200/20">
                    {index + 1}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white">{label}</div>
                    <div className="text-xs text-slate-400">Confidence {92 - index * 4}%</div>
                  </div>
                </div>
                <ShieldCheck className="h-5 w-5 text-emerald-300" />
              </div>
            ))}
          </div>

          <div className="mt-6 rounded-2xl border border-cyan-300/10 bg-cyan-300/5 p-4 text-sm leading-6 text-slate-200">
            <div className="mb-2 flex items-center gap-2 font-semibold text-cyan-100">
              <BrainCircuit className="h-4 w-4" />
              AI workflow
            </div>
            Gmail access, inbox analysis, label proposal, approval, and execution are separated into
            explicit stages so the user always sees what is about to change.
          </div>
        </div>
      </div>
    </section>
  );
}
