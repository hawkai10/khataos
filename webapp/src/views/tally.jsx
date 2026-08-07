import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Layers, RotateCcw, Activity, Upload, FileUp, CheckCircle2, AlertTriangle, Wand2, Link2, Save } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { StaleNote } from '../components/stale-note.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Progress } from '../components/ui/progress.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Select } from '../components/ui/select.jsx';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog.jsx';
import { Separator } from '../components/ui/separator.jsx';
import { get, post } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function Tally({ user }) {
  const [health, setHealth] = useState(null);
  const [logs, setLogs] = useState([]);
  const [mappings, setMappings] = useState(null);

  const load = async () => {
    try {
      const [h, l, m] = await Promise.all([get('/api/tally/health'), get('/api/tally/sync-logs'), get('/api/tally/mappings')]);
      setHealth(h);
      setLogs(l);
      setMappings(m);
    } catch { /* handled */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  async function act(fn, okMsg) {
    try {
      await fn();
      toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const canSync = user && ['cfo', 'finance_manager'].includes(user.role);
  const failed = logs.filter((l) => l.status === 'failed').length;
  const queued = health ? Number(health.queue_depth || 0) : 0;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tally Sync"
        description="Cloud path: export Groups, Ledgers &amp; Vouchers from Tally as XML and upload - the foundation of the platform."
        actions={
          <>
            {health && health.last_sync_at ? <StaleNote value={health.last_sync_at} /> : null}
            <ImportXmlDialog onDone={load} />
            <Button size="sm" variant="outline" onClick={() => act(() => post('/api/tally/pull-ledgers'), 'Ledger refresh complete')} disabled={!canSync}>
              <RefreshCw className="h-4 w-4" /> Refresh mappings
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-4">
        <KpiCard icon={Activity} label="Connector status" value={health ? health.status : '—'} sub={health ? health.version : ''} alert={health && health.status !== 'connected'} />
        <KpiCard icon={Layers} label="Queue depth" value={String(queued)} sub="pending sync operations" accent="bg-sky-100 text-sky-800" />
        <KpiCard icon={RotateCcw} label="Failed syncs" value={String(failed)} sub="in the recent window" accent="bg-red-100 text-red-800" alert={failed > 0} />
        <KpiCard icon={Activity} label="Uptime (30d)" value={health && health.uptime_30d != null ? `${health.uptime_30d}%` : 'Unavailable'} sub={health && health.uptime_30d != null ? `target ${health.uptime_target ?? 99.5}%` : 'no live Tally connection'} />
      </div>

      {health && health.uptime_30d != null ? (
        <Card>
          <CardHeader><CardTitle>Uptime vs target</CardTitle><CardDescription>{health.uptime_30d}% over the last 30 days — target {health.uptime_target ?? 99.5}%</CardDescription></CardHeader>
          <CardContent><Progress value={Math.min(100, Number(health.uptime_30d))} className="flex-1" /></CardContent>
        </Card>
      ) : null}

      <LedgerMappingCard data={mappings} canSync={canSync} onChange={load} />

      <Card>
        <CardHeader>
          <CardTitle>Sync log</CardTitle>
          <CardDescription>Vouchers, ledgers and payment entries synced to/from TallyPrime</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Queued</TableHead>
                <TableHead>Synced</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.slice(0, 60).map((l) => (
                <TableRow key={l.id}>
                  <TableCell><span className="font-medium">{l.entity}</span> <span className="text-xs text-muted-foreground">· {l.entity_id || ''}</span></TableCell>
                  <TableCell>{l.action}</TableCell>
                  <TableCell>
                    <Badge variant={l.status === 'synced' ? 'success' : l.status === 'failed' ? 'destructive' : l.status === 'unavailable' ? 'secondary' : 'warning'}>{l.status}</Badge>
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={l.error}>{l.error || '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDateTime(l.queued_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDateTime(l.synced_at)}</TableCell>
                  <TableCell className="text-right"></TableCell>
                </TableRow>
              ))}
              {!logs.length ? <TableRow><TableCell colSpan={7} className="py-10 text-center text-xs text-muted-foreground">No sync activity yet.</TableCell></TableRow> : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

const MAPPING_BADGE = {
  auto: { v: 'success', label: 'Auto-mapped' },
  manual: { v: 'info', label: 'Mapped' },
  suggested: { v: 'warning', label: 'Suggested' },
  review: { v: 'warning', label: 'Review' },
  dangling: { v: 'destructive', label: 'Re-map' },
  unmatched: { v: 'secondary', label: 'Unmatched' },
};

function LedgerMappingCard({ data, canSync, onChange }) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);

  async function save(vendorId, name) {
    setBusy(true);
    try {
      await post('/api/tally/mappings', { vendor_id: vendorId, ledger_name: name });
      toast.success('Ledger mapping saved');
      setDrafts((d) => { const n = { ...d }; delete n[vendorId]; return n; });
      await onChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function autoMap() {
    setBusy(true);
    try {
      const r = await post('/api/tally/mappings/auto');
      toast.success(`Auto-mapped ${r.updated ? r.updated.length : 0} vendor(s)`);
      setDrafts({});
      await onChange();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const rows = data ? data.rows : [];
  const ledgers = data ? data.ledgers : [];
  const s = data ? data.summary : null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Vendor to Tally ledger mapping</CardTitle>
          <CardDescription>
            Payments and GST/TDS tagging use the mapped Tally ledger. Auto-match runs after every XML import; review the amber rows.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={autoMap} disabled={!canSync || busy}>
          <Wand2 className="h-4 w-4" /> Auto-map
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {s ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="success">{s.mapped} mapped</Badge>
            <Badge variant="warning">{s.suggested} suggested</Badge>
            <Badge variant="warning">{s.review} review</Badge>
            {s.dangling ? <Badge variant="destructive">{s.dangling} re-map</Badge> : null}
            <Badge variant="secondary">{s.unmatched} unmatched</Badge>
            <span className="text-muted-foreground">{s.ledgers} Tally ledgers imported</span>
          </div>
        ) : null}
        {rows.length ? (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Vendor</TableHead>
                  <TableHead>Tally ledger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const draft = Object.prototype.hasOwnProperty.call(drafts, r.vendor_id) ? drafts[r.vendor_id] : r.current_ledger;
                  const b = MAPPING_BADGE[r.status] || MAPPING_BADGE.unmatched;
                  return (
                    <TableRow key={r.vendor_id}>
                      <TableCell>
                        <div className="font-medium">{r.vendor_name}</div>
                        <div className="text-xs text-muted-foreground">{r.vendor_gstin || 'no GSTIN'}{r.tds_section ? ` - TDS ${r.tds_section}` : ''}</div>
                      </TableCell>
                      <TableCell className="min-w-[260px]">
                        <Select
                          value={draft}
                          onChange={(e) => setDrafts((d) => ({ ...d, [r.vendor_id]: e.target.value }))}
                          disabled={!canSync}
                        >
                          {r.status === 'dangling' ? <option value={r.current_ledger}>{r.current_ledger} (missing in Tally import)</option> : null}
                          <option value={r.vendor_name}>{r.vendor_name} (no Tally ledger)</option>
                          {ledgers.map((l) => (
                            <option key={l.name} value={l.name}>{l.name}{l.group_name ? ` - ${l.group_name}` : ''}</option>
                          ))}
                        </Select>
                        {r.matched_ledger && r.matched_ledger !== draft ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">suggested: {r.matched_ledger}</p>
                        ) : null}
                      </TableCell>
                      <TableCell><Badge variant={b.v}>{b.label}</Badge></TableCell>
                      <TableCell className="text-right">
                        {canSync && draft !== r.current_ledger ? (
                          <Button size="sm" variant="ghost" onClick={() => save(r.vendor_id, draft)} disabled={busy}>
                            <Save className="h-3.5 w-3.5" /> Save
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            Import Tally masters (Groups + Ledgers) to map vendors to their Tally ledgers.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ImportXmlDialog({ onDone }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState('');

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      const text = await file.text();
      const r = await post('/api/tally/import-xml', { xml: text });
      setResult(r);
      toast.success('Tally XML imported');
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      e.target.value = '';
    }
  }

  const v = result ? result.validation : null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Upload className="h-4 w-4" /> Import Tally XML</Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Import Tally XML</DialogTitle>
          <DialogDescription>
            Cloud path: export <span className="font-medium">Groups, Ledgers &amp; Vouchers</span> from Tally as XML and upload.
            Voucher-only exports work too - missing ledgers are auto-created under standard Tally groups for review.
            Data is validated, then imported in sequence (Groups → Ledgers → Vouchers).
          </DialogDescription>
        </DialogHeader>

        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors hover:bg-accent">
          <FileUp className="h-6 w-6 text-muted-foreground" />
          <span className="text-sm font-medium">{fileName || (busy ? 'Parsing…' : 'Choose Tally export XML')}</span>
          <span className="text-xs text-muted-foreground">.xml from Tally's Export Data (masters and/or vouchers)</span>
          <input type="file" accept=".xml,text/xml" className="hidden" onChange={onFile} disabled={busy} />
        </label>

        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        ) : null}

        {result ? (
          <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2">
              <ImportStat label="Parsed" groups={result.parsed.groups} ledgers={result.parsed.ledgers} vouchers={result.parsed.vouchers} />
              <ImportStat label="Imported" groups={result.imported.groups.imported} ledgers={result.imported.ledgers.imported} vouchers={result.imported.vouchers.imported} />
              <ImportStat label="Updated" groups={result.imported.groups.updated || 0} ledgers={result.imported.ledgers.updated || 0} vouchers={result.imported.vouchers.updated || 0} />
              <ImportStat label="Skipped" groups={result.imported.groups.skipped} ledgers={result.imported.ledgers.skipped} vouchers={result.imported.vouchers.skipped} />
            </div>
            {result.company ? <p className="text-xs text-muted-foreground">Company detected: <span className="font-medium text-foreground">{result.company}</span></p> : null}
            {v && v.errors.length ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                <p className="mb-1.5 text-xs font-semibold text-red-800">{v.errors.length} validation error{v.errors.length === 1 ? '' : 's'} — invalid records were skipped</p>
                <ul className="slim-scroll max-h-28 space-y-1 overflow-y-auto">
                  {v.errors.slice(0, 12).map((e, i) => (
                    <li key={i} className="text-xs text-red-700">{e.type}: {e.record} — {e.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {v && v.warnings.length ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <p className="mb-1.5 text-xs font-semibold text-amber-800">{v.warnings.length} warning{v.warnings.length === 1 ? '' : 's'}</p>
                <ul className="slim-scroll max-h-24 space-y-1 overflow-y-auto">
                  {v.warnings.slice(0, 8).map((w, i) => (
                    <li key={i} className="text-xs text-amber-700">{w.type}: {w.record} — {w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {v && !v.errors.length && !v.warnings.length ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 className="h-4 w-4 shrink-0" /> Validation passed — all records imported cleanly.
              </div>
            ) : null}
            <Separator />
            <p className="text-[11px] text-muted-foreground">Re-uploading the same file is safe — duplicates are skipped per company.</p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ImportStat({ label, groups, ledgers, vouchers }) {
  return (
    <div className="rounded-lg border px-3 py-2 text-center">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="num mt-1 text-sm font-semibold">{groups} G · {ledgers} L · {vouchers} V</p>
    </div>
  );
}
