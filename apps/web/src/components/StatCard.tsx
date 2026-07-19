import { clsx } from 'clsx';

export interface StatCardProps {
  label: string;
  value: string;
  tone?: 'sky' | 'emerald' | 'amber';
}

const toneClasses: Record<NonNullable<StatCardProps['tone']>, string> = {
  sky: 'from-sky-400/20 to-cyan-400/5 ring-sky-300/20',
  emerald: 'from-emerald-400/20 to-teal-400/5 ring-emerald-300/20',
  amber: 'from-amber-400/20 to-orange-400/5 ring-amber-300/20',
};

export function StatCard({ label, value, tone = 'sky' }: StatCardProps) {
  return (
    <div
      className={clsx(
        'rounded-3xl border border-white/10 bg-white/5 p-4 shadow-2xl shadow-slate-950/20 backdrop-blur-xl',
        'bg-gradient-to-br',
        toneClasses[tone],
      )}
    >
      <div className="text-xs uppercase tracking-[0.32em] text-slate-300/70">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
