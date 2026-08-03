import { Clock, AlertTriangle } from 'lucide-react';
import { timeAgo } from '../lib/format.js';
import { cn } from '../lib/utils.js';

const STALE_AFTER_MIN = 30;

export function StaleNote({ value, className }) {
  if (!value) return null;
  const label = timeAgo(value);
  if (!label) return null;
  const mins = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  const stale = mins > STALE_AFTER_MIN;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
        stale ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200',
        className
      )}
      title={`Last synced ${value}`}
    >
      {stale ? <AlertTriangle className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
      {stale ? 'Stale' : 'Live'} · synced {label}
    </span>
  );
}
