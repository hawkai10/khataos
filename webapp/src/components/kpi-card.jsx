import { Card, CardContent } from './ui/card.jsx';
import { cn } from '../lib/utils.js';

export function KpiCard({ icon: Icon, label, value, sub, alert, accent = 'bg-primary/10 text-primary' }) {
  return (
    <Card className={cn('relative overflow-hidden', alert && 'ring-1 ring-amber-300')}>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="num mt-1.5 truncate text-xl font-semibold text-foreground" title={value}>{value}</p>
            {sub ? <p className="num mt-1 truncate text-xs text-muted-foreground" title={sub}>{sub}</p> : null}
          </div>
          {Icon ? (
            <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', accent)}>
              <Icon className="h-4.5 w-4.5" />
            </span>
          ) : null}
        </div>
        {alert ? <span className="absolute inset-x-0 top-0 h-0.5 bg-amber-400" /> : null}
      </CardContent>
    </Card>
  );
}
