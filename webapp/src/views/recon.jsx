import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Link2, FilePlus2 } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { Progress } from '../components/ui/progress.jsx';
import { StaleNote } from '../components/stale-note.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { ModeBadge } from '../components/status-badge.jsx';
import { get, post } from '../lib/api.js';
import { inr, fmtDate, signedInr } from '../lib/format.js';
import { signRupees } from '../lib/money.js';
import { PageHeader } from '../components/page-header.jsx';

export function Recon({ user }) {
  const [summary, setSummary] = useState(null);
  const [unmatched, setUnmatched] = useState([]);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, u] = await Promise.all([get('/api/recon/summary'), get('/api/recon/unmatched')]);
      setSummary(s);
      setUnmatched(u);
    } catch { /* handled */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function run() {
    setRunning(true);
    try {
      const r = await post('/api/recon/run');
      toast.success(`Reconciliation run complete — accuracy ${r.score ? r.score.accuracy : r.accuracy}%`);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setRunning(false);
    }
  }

  async function act(fn, okMsg) {
    try {
      await fn();
      toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const canRecon = user && ['cfo', 'finance_manager'].includes(user.role);
  const acc = summary ? Number(summary.accuracy || 0) : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reconciliation"
        description="Auto-match bank transactions with platform payments and Tally vouchers."
        actions={
          <>
            {summary && summary.as_of ? <StaleNote value={summary.as_of} /> : null}
            <Button size="sm" onClick={run} disabled={running || !canRecon}>
              <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} /> Run reconciliation
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <KpiCard icon={Link2} label="Auto-match accuracy" value={summary ? `${acc}%` : '—'} sub={`target ${summary ? summary.target : 70}%`} alert={summary && acc < (summary.target || 70)} />
        <KpiCard icon={RefreshCw} label="Auto-matched" value={summary ? `${summary.auto_matched}/${summary.total}` : '—'} sub={`${summary ? summary.manual_matched || 0 : 0} manual matches`} accent="bg-sky-100 text-sky-800" />
        <KpiCard icon={FilePlus2} label="Unmatched" value={String(unmatched.length)} sub="ready for manual review" accent="bg-amber-100 text-amber-800" />
      </div>

      {summary ? (
        <Card>
          <CardHeader><CardTitle>Accuracy vs target</CardTitle><CardDescription>{summary.auto_matched} of {summary.total} bank transactions automatically matched</CardDescription></CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Progress value={Math.min(100, acc)} className="flex-1" />
              <span className="num text-sm font-semibold">{acc}%</span>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Unmatched transactions</CardTitle>
          <CardDescription>Match to a payment, or create a Tally voucher directly</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Suggested payment</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {unmatched.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(t.txn_date)}</TableCell>
                  <TableCell className="max-w-[280px]">
                    <p className="truncate font-medium" title={t.description}>{t.description}</p>
                    {t.mismatch_note ? <p className="mt-0.5 text-[11px] font-medium text-amber-700">{t.mismatch_note}</p> : null}
                  </TableCell>
                  <TableCell><ModeBadge mode={t.mode} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{t.bank_name}</TableCell>
                  <TableCell className={`num text-right font-medium ${signRupees(t.amount) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{signedInr(t.amount)}</TableCell>
                  <TableCell>
                    {t.suggested_payment ? (
                      <div className="text-xs">
                        <p className="font-medium">{t.suggested_payment.reference}</p>
                        <p className="num text-muted-foreground">{inr(t.suggested_payment.net_amount)}</p>
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {canRecon ? (
                      <div className="flex justify-end gap-1">
                        {t.suggested_payment ? (
                          <Button size="sm" variant="outline" onClick={() => act(() => post('/api/recon/manual-match', { bank_txn_id: t.id, payment_id: t.suggested_payment.id }), 'Matched to payment')}>
                            <Link2 className="h-3.5 w-3.5" /> Match
                          </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={() => act(() => post(`/api/recon/unmatched/${t.id}/voucher`), 'Tally voucher created')}>
                          <FilePlus2 className="h-3.5 w-3.5" /> Voucher
                        </Button>
                      </div>
                    ) : <Badge variant="secondary">Read-only</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {!unmatched.length ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-xs text-muted-foreground">Everything matched — clean books. 🎉</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent matches</CardTitle>
          <CardDescription>Source is labelled: Tally vouchers are authoritative; KhataOS invoices/payments are platform-side</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Bank description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Matched against</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(summary ? summary.recent || [] : []).slice(0, 25).map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(m.txn_date)}</TableCell>
                  <TableCell className="max-w-[240px]"><p className="truncate" title={m.description}>{m.description}</p></TableCell>
                  <TableCell className="num text-right">{signedInr(m.bank_amount)}</TableCell>
                  <TableCell className="text-xs">
                    {m.tally_voucher_no ? `Tally voucher #${m.tally_voucher_no}` : m.payment_id ? 'KhataOS payment' : 'KhataOS invoice'}
                  </TableCell>
                  <TableCell>
                    {m.status === 'mismatch'
                      ? <Badge variant="destructive">mismatch</Badge>
                      : <Badge variant="success">{m.match_type}</Badge>}
                  </TableCell>
                </TableRow>
              ))}
              {!(summary && summary.recent && summary.recent.length) ? (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-xs text-muted-foreground">No matches yet - run reconciliation.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
