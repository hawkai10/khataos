import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { inrCompact } from '../lib/format.js';

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-md">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="num text-sm font-semibold">{inrCompact(payload[0].value)}</p>
    </div>
  );
}

export function CashChart({ data = [], height = 240 }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="cashFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.25} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickFormatter={(v) => {
            const d = new Date(v + 'T00:00:00');
            return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
          }}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickFormatter={(v) => inrCompact(v)}
          tickLine={false}
          axisLine={false}
          width={64}
          domain={['auto', 'auto']}
        />
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey="balance" stroke="var(--chart-1)" strokeWidth={2} fill="url(#cashFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
