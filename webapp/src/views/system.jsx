import { useEffect, useState } from 'react';
import { Server, Database, Boxes, Plug, Bot } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { get } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function System() {
  const [h, setH] = useState(null);
  useEffect(() => {
    get('/api/system/health').then(setH).catch(() => {});
    const t = setInterval(() => get('/api/system/health').then(setH).catch(() => {}), 30000);
    return () => clearInterval(t);
  }, []);

  if (!h) return null;

  const ints = h.integrations || {};
  return (
    <div className="space-y-5">
      <PageHeader title="System Health" description="Storage engine, event queue and every external integration at a glance." />

      <div className="grid gap-5 md:grid-cols-3">
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Server className="h-4 w-4 text-primary" /><CardTitle>Application</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row k="Version" v={h.app.version} />
            <Row k="Node" v={h.app.node} />
            <Row k="Started" v={fmtDateTime(h.app.started_at)} />
            <Row k="Uptime" v={`${Math.round(h.app.uptime_seconds / 60)} min`} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Database className="h-4 w-4 text-primary" /><CardTitle>Database</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row k="Engine" v={h.database.engine} />
            <Row k="Location" v={h.database.location} />
            <Row k="Tables" v={String(h.database.tables)} />
            <Row k="Rows" v={Object.values(h.database.row_counts || {}).reduce((s, n) => s + n, 0).toLocaleString('en-IN')} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Boxes className="h-4 w-4 text-primary" /><CardTitle>Event queue</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row k="Pending / running" v={String(h.queue.pending)} />
            <Row k="Processed" v={String(h.queue.processed)} />
            <Row k="Failed" v={String(h.queue.failed)} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plug className="h-4 w-4 text-primary" /> Integrations</CardTitle>
          <CardDescription>{ints.banks_supported} banks in the catalog · {ints.bank_accounts.map((b) => `${b.source}: ${b.count}`).join(' · ') || 'no accounts'}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Integration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <IntegrationRow name="Decentro (banks)" cfg={ints.decentro} />
              <IntegrationRow name="GSTN / GSP" cfg={ints.gstn} extra={ints.gstn && ints.gstn.last_gstr2b ? `last 2B ${fmtDateTime(ints.gstn.last_gstr2b.fetched_at)}` : null} />
              <IntegrationRow name="Tally connector" cfg={ints.tally} />
              <IntegrationRow name="AI assistant" cfg={ints.ai} />
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Database className="h-4 w-4 text-primary" /> Row counts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
            {Object.entries(h.database.row_counts || {}).map(([t, n]) => (
              <div key={t} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span className="text-xs text-muted-foreground">{t}</span>
                <span className="num font-medium">{Number(n).toLocaleString('en-IN')}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-dashed pb-1.5 last:border-0">
      <span className="text-muted-foreground">{k}</span>
      <span className="max-w-[65%] truncate text-right font-medium" title={v}>{v}</span>
    </div>
  );
}

function IntegrationRow({ name, cfg, extra }) {
  if (!cfg) return null;
  const enabled = cfg.enabled || cfg.status === 'connected';
  const detail = cfg.mode ? `mode: ${cfg.mode}` : cfg.status || '';
  return (
    <TableRow>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell>
        <Badge variant={enabled ? 'success' : 'warning'}>{enabled ? 'Connected' : 'Not configured'}</Badge>
      </TableCell>
      <TableCell className="max-w-[420px] truncate text-xs text-muted-foreground" title={`${detail}${extra ? ' · ' + extra : ''}`}>
        {detail}{cfg.missing_env && cfg.missing_env.length ? ` · missing: ${cfg.missing_env.join(', ')}` : ''}{extra ? ` · ${extra}` : ''}
      </TableCell>
    </TableRow>
  );
}
