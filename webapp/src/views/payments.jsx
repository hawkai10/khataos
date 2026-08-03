import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Play, CheckCircle2 } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Select } from '../components/ui/select.jsx';
import { PaymentBadge, ModeBadge } from '../components/status-badge.jsx';
import { get, post } from '../lib/api.js';
import { inr, fmtDate, fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function Payments({ user }) {
  const [payments, setPayments] = useState([]);

  const load = async () => {
    try {
      setPayments(await get('/api/payments'));
    } catch { /* handled */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  const canAct = user && ['cfo', 'finance_manager'].includes(user.role);

  async function act(fn, okMsg) {
    try {
      await fn();
      toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payments"
        description="UPI · IMPS · NEFT · RTGS — execute, schedule and track vendor payments."
        actions={<CreatePayment onDone={load} user={user} />}
      />

      <Card>
        <CardHeader>
          <CardTitle>Payment tracker</CardTitle>
          <CardDescription>Status updates automatically as the gateway processes each payment</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Net (post-TDS)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <p className="font-medium">{p.reference}</p>
                    <p className="text-[11px] text-muted-foreground">{p.gateway ? p.gateway.toUpperCase() : ''} {p.gateway_txn_id ? `· ${p.gateway_txn_id}` : ''}</p>
                  </TableCell>
                  <TableCell className="max-w-[160px] truncate" title={p.vendor_name}>{p.vendor_name || '—'}</TableCell>
                  <TableCell><ModeBadge mode={p.mode} /></TableCell>
                  <TableCell className="num text-right">{inr(p.amount)}</TableCell>
                  <TableCell className="num text-right font-semibold">{inr(p.net_amount)}</TableCell>
                  <TableCell><PaymentBadge status={p.status} /></TableCell>
                  <TableCell className="text-muted-foreground">{p.scheduled_date ? fmtDate(p.scheduled_date) : '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {p.status === 'pending_approval' && canAct ? (
                        <Button size="sm" variant="outline" onClick={() => act(() => post(`/api/payments/${p.id}/approve`), 'Payment approved')}>
                          <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                        </Button>
                      ) : null}
                      {['approved', 'pending_approval'].includes(p.status) && canAct ? (
                        <Button size="sm" onClick={() => act(() => post(`/api/payments/${p.id}/execute`), 'Payment sent for execution')}>
                          <Play className="h-3.5 w-3.5" /> Execute now
                        </Button>
                      ) : null}
                      {p.status === 'failed' ? <Badge variant="destructive">Retry via new payment</Badge> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!payments.length ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-xs text-muted-foreground">No payments yet. Create your first payment.</TableCell></TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function CreatePayment({ onDone, user }) {
  const [open, setOpen] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ vendor_id: '', invoice_ids: [], mode: 'NEFT', type: 'instant', account_id: '', scheduled_date: '' });

  useEffect(() => {
    if (!open) return;
    Promise.all([get('/api/vendors'), get('/api/invoices?status=approved'), get('/api/cash/accounts')])
      .then(([v, i, a]) => {
        setVendors(v);
        setInvoices(i);
        setAccounts(a);
      })
      .catch(() => {});
  }, [open]);

  const vendorInvoices = useMemo(
    () => invoices.filter((i) => !form.vendor_id || i.vendor_id === form.vendor_id),
    [invoices, form.vendor_id]
  );

  function toggleInvoice(id) {
    setForm((f) => ({
      ...f,
      invoice_ids: f.invoice_ids.includes(id) ? f.invoice_ids.filter((x) => x !== id) : [...f.invoice_ids, id],
    }));
  }

  async function submit() {
    setBusy(true);
    try {
      await post('/api/payments', {
        vendor_id: form.vendor_id,
        invoice_ids: form.invoice_ids,
        mode: form.mode,
        type: form.type,
        account_id: form.account_id || null,
        scheduled_date: form.type === 'scheduled' ? form.scheduled_date : null,
      });
      toast.success('Payment created');
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const total = vendorInvoices.filter((i) => form.invoice_ids.includes(i.id)).reduce((s, i) => s + Number(i.gross_amount || 0), 0);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" /> Create payment</Button></DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Create vendor payment</DialogTitle>
          <DialogDescription>GST ledger and TDS section are auto-tagged from vendor master. Large payments route to CFO approval.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Vendor</Label>
              <Select value={form.vendor_id} onChange={set('vendor_id')}>
                <option value="">— select —</option>
                {vendors.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.tds_section || 'no TDS'} {v.tds_rate ? `${v.tds_rate * 100}%` : ''}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select value={form.mode} onChange={set('mode')}>
                {['NEFT', 'IMPS', 'UPI', 'RTGS'].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onChange={set('type')}>
                <option value="instant">Instant execution</option>
                <option value="batch">Batch</option>
                <option value="scheduled">Scheduled</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Debit account</Label>
              <Select value={form.account_id} onChange={set('account_id')}>
                <option value="">— select —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_name} · {inr(a.balance)}</option>)}
              </Select>
            </div>
            {form.type === 'scheduled' ? (
              <div className="space-y-1.5">
                <Label>Scheduled date</Label>
                <Input type="date" value={form.scheduled_date} onChange={set('scheduled_date')} />
              </div>
            ) : null}
          </div>

          <div>
            <Label className="mb-1.5 block">Invoices ({form.invoice_ids.length} selected · {inr(total)})</Label>
            <div className="slim-scroll max-h-44 space-y-1 overflow-y-auto rounded-md border p-2">
              {vendorInvoices.map((i) => (
                <label key={i.id} className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                  <input type="checkbox" checked={form.invoice_ids.includes(i.id)} onChange={() => toggleInvoice(i.id)} className="h-3.5 w-3.5 accent-primary" />
                  <span className="flex-1">{i.invoice_no} · {i.vendor_name || '—'}</span>
                  <span className="num text-xs text-muted-foreground">due {fmtDate(i.due_date)}</span>
                  <span className="num text-xs font-medium">{inr(i.gross_amount)}</span>
                </label>
              ))}
              {!vendorInvoices.length ? <p className="p-2 text-xs text-muted-foreground">No approved invoices{form.vendor_id ? ' for this vendor' : ''}.</p> : null}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={busy || !form.vendor_id || !form.invoice_ids.length}>
            {busy ? 'Creating…' : `Create payment · ${inr(total)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
