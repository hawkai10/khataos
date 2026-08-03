import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Plus, Landmark, ArrowDownUp, ShieldCheck } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { CashChart } from '../components/cash-chart.jsx';
import { StaleNote } from '../components/stale-note.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Select } from '../components/ui/select.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.jsx';
import { ModeBadge } from '../components/status-badge.jsx';
import { get, post } from '../lib/api.js';
import { inr, fmtDate, signedInr, fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function Cash() {
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [trend, setTrend] = useState([]);
  const [decentro, setDecentro] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [acc, tr, trd, dc] = await Promise.all([
        get('/api/cash/accounts'),
        get('/api/cash/transactions?days=7'),
        get('/api/cash/trend?days=30'),
        get('/api/integrations/decentro/status').catch(() => null),
      ]);
      setAccounts(acc);
      setTxns(tr);
      setTrend(trd);
      setDecentro(dc);
    } catch {
      /* handled globally */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      const r = await post('/api/cash/refresh');
      toast.success(`Bank feed refreshed · ${r.added_transactions} new transactions · recon ${r.recon.accuracy}%`);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRefreshing(false);
    }
  }

  const total = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
  const uncleared = accounts.reduce((s, a) => s + Number(a.uncleared || 0), 0);
  const lastSync = accounts.map((a) => a.last_synced_at).filter(Boolean).sort().pop();

  return (
    <div className="space-y-5">
      <PageHeader
        title="Cash & Banks"
        description="Live balances across all connected accounts — AA consent or direct API."
        actions={
          <>
            <StaleNote value={lastSync} />
            <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh feeds
            </Button>
            <ConnectBankDialog onDone={load} decentro={decentro} />
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard icon={Landmark} label="Total available" value={inr(total)} sub={`${accounts.length} accounts · ${accounts.filter((a) => a.source === 'decentro').length} via Decentro`} />
        <KpiCard icon={ShieldCheck} label="Uncleared funds" value={inr(uncleared)} sub="Cheques / credits in clearing" accent="bg-amber-100 text-amber-800" />
        <KpiCard icon={ArrowDownUp} label="Last 7-day activity" value={String(txns.length)} sub="transactions across all accounts" accent="bg-sky-100 text-sky-800" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connected accounts</CardTitle>
          <CardDescription>Consolidated cash position per bank account</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bank / Account</TableHead>
                <TableHead>Account no.</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                <TableHead className="text-right">Uncleared</TableHead>
                <TableHead>Last sync</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <p className="font-medium">{a.account_name}</p>
                    <p className="text-xs text-muted-foreground">{a.bank_name}</p>
                  </TableCell>
                  <TableCell className="num text-muted-foreground">••••{String(a.account_number || '').slice(-4)}</TableCell>
                  <TableCell><Badge variant={a.source === 'decentro' ? 'info' : a.source === 'aa' ? 'success' : 'secondary'}>{a.source_label || a.source}</Badge></TableCell>
                  <TableCell className="num text-right font-semibold">{inr(a.balance)}</TableCell>
                  <TableCell className="num text-right text-amber-700">{a.uncleared ? inr(a.uncleared) : '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.last_synced_at ? fmtDateTime(a.last_synced_at) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Tabs defaultValue="txns">
        <TabsList>
          <TabsTrigger value="txns">7-day transactions</TabsTrigger>
          <TabsTrigger value="trend">30-day trend</TabsTrigger>
        </TabsList>
        <TabsContent value="txns">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txns.slice(0, 50).map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(t.txn_date)}</TableCell>
                      <TableCell className="max-w-[300px]">
                        <p className="truncate font-medium" title={t.description}>{t.description}</p>
                        <p className="text-[11px] text-muted-foreground">{t.bank_name} · {t.account_name}</p>
                      </TableCell>
                      <TableCell><ModeBadge mode={t.mode} /></TableCell>
                      <TableCell className="num text-xs text-muted-foreground">{t.ref_no || '—'}</TableCell>
                      <TableCell className={`num text-right font-medium ${Number(t.amount) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{signedInr(t.amount)}</TableCell>
                      <TableCell className="num text-right text-muted-foreground">{t.balance_after != null ? inr(t.balance_after) : '—'}</TableCell>
                    </TableRow>
                  ))}
                  {!txns.length ? (
                    <TableRow><TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">No transactions in the last 7 days.</TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="trend">
          <Card>
            <CardHeader>
              <CardTitle>Daily closing balance — last 30 days</CardTitle>
            </CardHeader>
            <CardContent><CashChart data={trend} height={300} /></CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ConnectBankDialog({ onDone, decentro }) {
  const [open, setOpen] = useState(false);
  const [banks, setBanks] = useState([]);
  const [step, setStep] = useState('form');
  const [consent, setConsent] = useState(null);
  const [form, setForm] = useState({ bank_code: 'ICIC', account_number: '' });
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      get('/api/banks').then(setBanks).catch(() => {});
      setStep('form');
      setConsent(null);
    }
  }, [open]);

  async function startConsent() {
    setBusy(true);
    try {
      const c = await post('/api/aa/consent/start', { bank_code: form.bank_code, account_number: form.account_number });
      setConsent(c);
      setStep('otp');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    try {
      await post('/api/aa/consent/verify', { consent_id: consent.consentId, otp, bank_code: form.bank_code, account_number: form.account_number });
      toast.success('Bank account linked — transactions synced');
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="h-4 w-4" /> Connect a bank</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a bank account</DialogTitle>
          <DialogDescription>
            Account Aggregator (AA) consent flow — legally compliant, consent-based access.
            {decentro && !decentro.enabled ? ' Decentro credentials not configured — using the simulator.' : ''}
          </DialogDescription>
        </DialogHeader>

        {step === 'form' ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Bank</Label>
              <Select value={form.bank_code} onChange={(e) => setForm({ ...form, bank_code: e.target.value })}>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>{b.name}{b.aa_supported ? ' · AA' : ''}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Account number</Label>
              <Input value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} placeholder="e.g. 918011112222" />
            </div>
            <DialogFooter>
              <Button onClick={startConsent} disabled={busy || !form.account_number}>{busy ? 'Requesting…' : 'Request consent + OTP'}</Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              OTP sent to <span className="font-medium text-foreground">{consent?.otpSentTo}</span>. Enter the 6-digit code to approve the consent.
            </p>
            <Input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit OTP" maxLength={6} inputMode="numeric" />
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('form')}>Back</Button>
              <Button onClick={verifyOtp} disabled={busy || otp.length !== 6}>{busy ? 'Verifying…' : 'Verify & link'}</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
