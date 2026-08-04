import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Download, BadgeCheck, AlertTriangle, Landmark, KeyRound } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { StaleNote } from '../components/stale-note.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { get, post, download } from '../lib/api.js';
import { inr, fmtDate, fmtDateTime } from '../lib/format.js';
import { signRupees } from '../lib/money.js';
import { PageHeader } from '../components/page-header.jsx';

export function Gst() {
  const [g, setG] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    try {
      setG(await get('/api/gst/summary'));
    } catch { /* handled */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await post('/api/gst/refresh');
      toast.success(`GSTR-2B refreshed — ${r.mismatches} mismatch${r.mismatches === 1 ? '' : 'es'} flagged`);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  async function exportCsv(type) {
    try {
      await download(`/api/gst/export?type=${type}&period=${encodeURIComponent(g.period || '')}`, `${type}_${g.period || ''}.csv`);
      toast.success(`${type.toUpperCase()} export downloaded`);
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="GST & Compliance"
        description="ITC visibility, liabilities and GSTR-2B reconciliation — native to Indian workflows."
        actions={
          <>
            {g && g.fetched_at ? <StaleNote value={g.fetched_at} /> : null}
            <Button variant="outline" size="sm" onClick={() => exportCsv('gstr2b')}><Download className="h-4 w-4" /> GSTR-2B CSV</Button>
            <Button variant="outline" size="sm" onClick={() => exportCsv('gstr3b')}><Download className="h-4 w-4" /> GSTR-3B CSV</Button>
            <Button size="sm" onClick={refresh} disabled={refreshing}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh 2B</Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={BadgeCheck} label="ITC available" value={g ? inr(g.itc) : '—'} sub={g ? `period ${g.period}` : ''} />
        <KpiCard icon={Landmark} label="GST liability" value={g ? inr(g.liability) : '—'} sub={g ? `committed ${inr(g.committed)}` : ''} />
        <KpiCard icon={AlertTriangle} label="Open mismatches" value={g ? String(g.mismatch_count) : '—'} sub="GSTR-2B vs platform invoices" alert={g && g.mismatch_count > 0} />
        <KpiCard icon={BadgeCheck} label="ITC breakdown" value={g ? inr((g.itc_cgst || 0) + (g.itc_sgst || 0) + (g.itc_igst || 0)) : '—'} sub={g ? `CGST ${inr(g.itc_cgst)} · SGST ${inr(g.itc_sgst)} · IGST ${inr(g.itc_igst)}` : ''} accent="bg-emerald-100 text-emerald-800" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>GSTR-2B mismatches</CardTitle>
            <CardDescription>Supplier filings that don't match your platform invoice data — potential ITC leakage</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Platform ITC</TableHead>
                  <TableHead className="text-right">GSTR-2B</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(g?.mismatches || []).map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.invoice_no}</TableCell>
                    <TableCell className="max-w-[140px] truncate" title={m.vendor_name}>{m.vendor_name || m.vendor_gstin}</TableCell>
                    <TableCell className="num text-right">{inr(m.platform_amount)}</TableCell>
                    <TableCell className="num text-right">{inr(m.gstr2b_amount)}</TableCell>
                    <TableCell className={`num text-right font-semibold ${signRupees(m.variance) > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{inr(m.variance)}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={m.note}>{m.note}</TableCell>
                  </TableRow>
                ))}
                {!g || !g.mismatches || !g.mismatches.length ? (
                  <TableRow><TableCell colSpan={6} className="py-10 text-center text-xs text-muted-foreground">No open mismatches — ITC fully reconciled. 🎉</TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <GstnCard />
      </div>
    </div>
  );
}

function GstnCard() {
  const [cfg, setCfg] = useState(null);
  const [otpOpen, setOtpOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCfg = () => get('/api/gstn/config').then(setCfg).catch(() => {});
  useEffect(() => {
    loadCfg();
  }, []);

  async function requestOtp() {
    setBusy(true);
    try {
      const r = await post('/api/gstn/otp/request');
      toast.success(`OTP requested (${r.mode} mode)`);
      setOtpOpen(true);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function validateOtp() {
    setBusy(true);
    try {
      const r = await post('/api/gstn/otp/validate', { otp });
      toast.success(`Authenticated for ${r.expiry_minutes} minutes`);
      setOtpOpen(false);
      setOtp('');
      await loadCfg();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const live = cfg && cfg.mode === 'live';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> GSTN / GSP connection</CardTitle>
        <CardDescription>GSTR-2B and e-invoice contract via a GST Suvidha Provider</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-sm">Mode</span>
          <Badge variant={live ? 'success' : 'secondary'}>{live ? 'Live (GSP)' : 'Simulator'}</Badge>
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-sm">GSTIN</span>
          <span className="num text-sm font-medium">{cfg?.gstin || '—'}</span>
        </div>
        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <span className="text-sm">Endpoint</span>
          <span className="max-w-[55%] truncate text-xs text-muted-foreground" title={cfg?.base_url}>{cfg?.base_url}</span>
        </div>
        {cfg && !live ? (
          <p className="text-xs text-muted-foreground">
            Set <span className="font-mono">GSTN_GSTIN, GSTN_USERNAME, GSTN_APP_KEY, GSTN_CLIENT_ID, GSTN_CLIENT_SECRET</span> to go live.
            Missing: {cfg.missing_env?.join(', ') || '—'}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="flex-1" onClick={requestOtp} disabled={busy}>{busy ? 'Sending…' : 'Request OTP'}</Button>
          <Dialog open={otpOpen} onOpenChange={setOtpOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Validate OTP</DialogTitle>
                <DialogDescription>Enter the 6-digit OTP from your registered mobile/email to obtain the GSTN auth token (valid ~6 hours).</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label>OTP</Label>
                <Input value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={6} inputMode="numeric" placeholder="6-digit OTP" />
              </div>
              <DialogFooter>
                <Button onClick={validateOtp} disabled={busy || otp.length !== 6}>{busy ? 'Validating…' : 'Validate & authenticate'}</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-[10px] text-muted-foreground">{cfg ? `${cfg.provider} · token validity ${cfg.token_valid_minutes} min · ${cfg.gstr2b_endpoint}` : ''}</p>
      </CardContent>
    </Card>
  );
}
