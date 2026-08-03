import { useEffect, useState } from 'react';
import { Banknote, CalendarClock, AlertTriangle, TrendingUp, Crosshair, Hourglass } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { CashChart } from '../components/cash-chart.jsx';
import { StaleNote } from '../components/stale-note.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Skeleton } from '../components/ui/skeleton.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { get } from '../lib/api.js';
import { inr, fmtDate } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

const KPI_ICONS = {
  cash: Banknote,
  due: CalendarClock,
  gst: AlertTriangle,
  runway: TrendingUp,
  recon: Crosshair,
  overdue: Hourglass,
};

export function Dashboard({ user }) {
  const [d, setD] = useState(null);
  const [invoices, setInvoices] = useState([]);

  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const [data, invs] = await Promise.all([get('/api/dashboard'), get('/api/invoices')]);
        if (live) {
          setD(data);
          setInvoices(invs);
        }
      } catch {
        /* 401 handled globally */
      }
    }
    load();
    const t = setInterval(load, 30000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  if (!d) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const now = new Date();
  const local = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const in7 = new Date(today);
  in7.setDate(in7.getDate() + 7);
  const dueRows = (invoices || []).filter((i) =>
    ['approved', 'scheduled', 'pending_approval'].includes(i.status) &&
    i.due_date >= local(today) &&
    i.due_date <= local(in7)
  );
  const overdueRows = (invoices || []).filter((i) =>
    ['approved', 'scheduled'].includes(i.status) &&
    i.due_date < local(today)
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${(user?.name || '').split(' ')[0]}`}
        description={d.cash.last_synced_at ? 'Here is your position as of the last bank sync.' : 'Connect your first bank account to go live.'}
        actions={d.cash.last_synced_at ? <StaleNote value={d.cash.last_synced_at} /> : null}
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {(d.kpis || []).map((k) => (
          <KpiCard key={k.key} icon={KPI_ICONS[k.key]} label={k.label} value={k.value} sub={k.sub} alert={k.alert} />
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle>30-day cash trend</CardTitle>
              <CardDescription>Daily consolidated closing balance across all accounts</CardDescription>
            </div>
            <Badge variant="secondary">{d.cash.accounts} account{d.cash.accounts === 1 ? '' : 's'}</Badge>
          </CardHeader>
          <CardContent>
            <CashChart data={d.trend || []} />
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-primary" /> Due this week</CardTitle>
              <CardDescription>{d.payments.due_this_week.count} payments · {inr(d.payments.due_this_week.amount)}</CardDescription>
            </CardHeader>
            <CardContent className="max-h-56 overflow-y-auto slim-scroll">
              <DueList rows={dueRows} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Hourglass className="h-4 w-4 text-amber-600" /> Overdue</CardTitle>
              <CardDescription>{d.payments.overdue.count} overdue · {inr(d.payments.overdue.amount)}</CardDescription>
            </CardHeader>
            <CardContent className="max-h-56 overflow-y-auto slim-scroll">
              <DueList rows={overdueRows} />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 md:grid-cols-3">
        <MiniStatus title="GST & ITC" rows={[
          ['ITC available', inr(d.gst.itc)],
          ['Liability', inr(d.gst.liability)],
          ['Open mismatches', String(d.gst.open_mismatches)],
          ['Period', d.gst.period || '—'],
        ]} />
        <MiniStatus title="Reconciliation" rows={[
          ['Accuracy', `${d.recon.accuracy}%`],
          ['Auto-matched', `${d.recon.auto_matched}/${d.recon.total}`],
          ['Target', `${d.recon.target}%`],
          ['As of', d.recon.as_of ? fmtDate(d.recon.as_of) : '—'],
        ]} />
        <MiniStatus title="Tally connector" rows={[
          ['Status', d.tally.status || '—'],
          ['Version', d.tally.version || '—'],
          ['Uptime (30d)', `${d.tally.uptime_30d ?? 0}%`],
          ['Last sync', d.tally.last_sync_at ? fmtDate(d.tally.last_sync_at) : '—'],
        ]} />
      </div>
    </div>
  );
}

function DueList({ rows }) {
  if (!rows.length) return <p className="py-4 text-center text-xs text-muted-foreground">Nothing here — all clear.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Due</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="font-medium">{r.invoice_no}</TableCell>
            <TableCell className="text-muted-foreground">{fmtDate(r.due_date)}</TableCell>
            <TableCell className="num text-right font-medium">{inr(r.net_payable)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function MiniStatus({ title, rows }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between border-b border-dashed pb-1.5 text-sm last:border-0">
            <span className="text-muted-foreground">{k}</span>
            <span className="num font-medium">{v}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
