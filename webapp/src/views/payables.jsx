import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, CheckCircle2, XCircle, GitCompareArrows, Eye, ScanText, Wallet } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { KpiCard } from '../components/kpi-card.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.jsx';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '../components/ui/dialog.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Textarea } from '../components/ui/textarea.jsx';
import { Select } from '../components/ui/select.jsx';
import { InvoiceBadge } from '../components/status-badge.jsx';
import { get, post } from '../lib/api.js';
import { inr, fmtDate } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function Payables({ user }) {
  const [pending, setPending] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [detail, setDetail] = useState(null);
  const [aging, setAging] = useState(null);

  const load = async () => {
    try {
      const [p, invs, ag] = await Promise.all([get('/api/approvals/pending'), get('/api/invoices'), get('/api/payables/aging')]);
      setPending(p);
      setInvoices(invs);
      setAging(ag);
    } catch { /* handled */ }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const canApprove = user && ['cfo', 'finance_manager'].includes(user.role);

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
        title="Payables"
        description="Invoice capture, multi-level approvals and Tally three-way matching."
        actions={<CaptureDialog onDone={load} />}
      />

      {aging ? (
        <Card>
          <CardHeader><CardTitle>Payables aging (Tally)</CardTitle><CardDescription>From imported Tally purchase vouchers - {aging.items.length} voucher(s), {inr(aging.total)} total</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-4">
            <KpiCard icon={Wallet} label="Current (0-30d)" value={inr(aging.buckets.current)} sub="not yet due / due soon" />
            <KpiCard icon={Wallet} label="31-60 days" value={inr(aging.buckets['31-60'])} sub="overdue" accent="bg-amber-100 text-amber-800" />
            <KpiCard icon={Wallet} label="61-90 days" value={inr(aging.buckets['61-90'])} sub="overdue" accent="bg-amber-100 text-amber-800" />
            <KpiCard icon={Wallet} label="90+ days" value={inr(aging.buckets['90+'])} sub="critical" accent="bg-red-100 text-red-800" alert={aging.buckets['90+'] > 0} />
          </CardContent>
        </Card>
      ) : null}

      <Tabs defaultValue="pending">
        <TabsList>
          <TabsTrigger value="pending">Pending approval ({pending.length})</TabsTrigger>
          <TabsTrigger value="all">All invoices ({invoices.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="pending">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead>Required role</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pending.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <p className="font-medium">{a.invoice_no}</p>
                        <p className="text-[11px] text-muted-foreground">Level {a.level}</p>
                      </TableCell>
                      <TableCell>{a.vendor_name || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(a.due_date)}</TableCell>
                      <TableCell className="num text-right font-semibold">{inr(a.gross_amount)}</TableCell>
                      <TableCell><Badge variant="secondary">{a.required_role === 'cfo' ? 'CFO' : 'Finance Manager'}</Badge></TableCell>
                      <TableCell className="text-right">
                        {canApprove ? (
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" onClick={() => act(() => post(`/api/invoices/${a.invoice_id}/three-way-match`), 'Three-way match run')}>
                              <GitCompareArrows className="h-3.5 w-3.5" /> Match
                            </Button>
                            <Button size="sm" onClick={() => act(() => post(`/api/invoices/${a.invoice_id}/approve`), 'Invoice approved')}>
                              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => act(() => post(`/api/invoices/${a.invoice_id}/reject`), 'Invoice rejected')}>
                              <XCircle className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Read-only</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {!pending.length ? (
                    <TableRow><TableCell colSpan={6} className="py-10 text-center text-xs text-muted-foreground">No invoices awaiting approval — inbox zero. 🎉</TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="all">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Taxable</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((i) => (
                    <TableRow key={i.id}>
                      <TableCell className="font-medium">{i.invoice_no}</TableCell>
                      <TableCell className="max-w-[180px] truncate" title={i.vendor_name}>{i.vendor_name || '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(i.invoice_date)}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDate(i.due_date)}</TableCell>
                      <TableCell className="num text-right">{inr(i.taxable_amount)}</TableCell>
                      <TableCell className="num text-right font-semibold">{inr(i.gross_amount)}</TableCell>
                      <TableCell><InvoiceBadge status={i.status} /></TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setDetail(i)}><Eye className="h-3.5 w-3.5" /> View</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {!invoices.length ? (
                    <TableRow><TableCell colSpan={8} className="py-10 text-center text-xs text-muted-foreground">No invoices yet. Capture your first invoice.</TableCell></TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <InvoiceDetail invoice={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function CaptureDialog({ onDone }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('manual');
  const [vendors, setVendors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    vendor_id: '', invoice_no: '', invoice_date: '', due_date: '',
    taxable_amount: '', cgst: '', sgst: '', igst: '', gross_amount: '', tds_amount: '', gstin_vendor: '',
  });
  const [template, setTemplate] = useState('cement');
  const [ocrText, setOcrText] = useState('');
  const [ocrResult, setOcrResult] = useState(null);

  useEffect(() => {
    if (open) get('/api/vendors').then(setVendors).catch(() => {});
  }, [open]);

  async function submit() {
    setBusy(true);
    try {
      await post('/api/invoices/capture', {
        vendor_id: form.vendor_id || null,
        invoice_no: form.invoice_no,
        invoice_date: form.invoice_date,
        due_date: form.due_date || null,
        taxable_amount: Number(form.taxable_amount) || 0,
        cgst: Number(form.cgst) || 0,
        sgst: Number(form.sgst) || 0,
        igst: Number(form.igst) || 0,
        gross_amount: Number(form.gross_amount) || 0,
        tds_amount: Number(form.tds_amount) || 0,
        gstin_vendor: form.gstin_vendor || null,
      });
      toast.success('Invoice captured and routed for approval');
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function emailSim() {
    setBusy(true);
    try {
      const r = await post('/api/invoices/email-sim', { template });
      toast.success(`Captured ${r.invoice.invoice_no} from email`);
      setOpen(false);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function runOcr() {
    try {
      setOcrResult(await post('/api/invoices/ocr-preview', { text: ocrText }));
    } catch (e) {
      toast.error(e.message);
    }
  }

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm"><Plus className="h-4 w-4" /> Capture invoice</Button></DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Capture invoice</DialogTitle>
          <DialogDescription>Manual entry, email forwarding demo, or OCR pre-fill from pasted invoice text.</DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={setMode}>
          <TabsList className="w-full">
            <TabsTrigger value="manual" className="flex-1">Manual entry</TabsTrigger>
            <TabsTrigger value="email" className="flex-1">Email demo</TabsTrigger>
            <TabsTrigger value="ocr" className="flex-1"><ScanText className="mr-1 h-3.5 w-3.5" /> OCR pre-fill</TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Vendor</Label>
                <Select value={form.vendor_id} onChange={set('vendor_id')}>
                  <option value="">— select —</option>
                  {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </Select>
              </div>
              <div className="space-y-1.5"><Label>Invoice no.</Label><Input value={form.invoice_no} onChange={set('invoice_no')} placeholder="INV-2026-…" /></div>
              <div className="space-y-1.5"><Label>Invoice date</Label><Input type="date" value={form.invoice_date} onChange={set('invoice_date')} /></div>
              <div className="space-y-1.5"><Label>Due date</Label><Input type="date" value={form.due_date} onChange={set('due_date')} /></div>
              <div className="space-y-1.5"><Label>Taxable amount</Label><Input type="number" value={form.taxable_amount} onChange={set('taxable_amount')} /></div>
              <div className="space-y-1.5"><Label>Vendor GSTIN</Label><Input value={form.gstin_vendor} onChange={set('gstin_vendor')} placeholder="15-char GSTIN" /></div>
              <div className="space-y-1.5"><Label>CGST</Label><Input type="number" value={form.cgst} onChange={set('cgst')} /></div>
              <div className="space-y-1.5"><Label>SGST</Label><Input type="number" value={form.sgst} onChange={set('sgst')} /></div>
              <div className="space-y-1.5"><Label>IGST</Label><Input type="number" value={form.igst} onChange={set('igst')} /></div>
              <div className="space-y-1.5"><Label>TDS amount</Label><Input type="number" value={form.tds_amount} onChange={set('tds_amount')} /></div>
              <div className="col-span-2 space-y-1.5"><Label>Gross amount</Label><Input type="number" value={form.gross_amount} onChange={set('gross_amount')} placeholder="taxable + taxes − TDS" /></div>
            </div>
            <DialogFooter>
              <Button onClick={submit} disabled={busy || !form.invoice_no}>{busy ? 'Saving…' : 'Capture invoice'}</Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="email" className="space-y-3">
            <div className="space-y-1.5">
              <Label>Sample vendor invoice</Label>
              <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
                <option value="cement">Shree Cement Traders</option>
                <option value="apex">Apex Steel Works</option>
                <option value="freight">Global Freight LLP</option>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">Simulates the email-forwarding flow (forward to <span className="font-medium">forward@invoices.khataos.in</span>). OCR extracts GSTIN, HSNs and tax fields automatically.</p>
            <DialogFooter><Button onClick={emailSim} disabled={busy}>{busy ? 'Capturing…' : 'Simulate forwarded email'}</Button></DialogFooter>
          </TabsContent>

          <TabsContent value="ocr" className="space-y-3">
            <Textarea value={ocrText} onChange={(e) => setOcrText(e.target.value)} placeholder="Paste invoice text (or use the sample)…" className="min-h-28" />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOcrText('GSTIN: 29AABCS2345K1Z2\nInvoice No: INV-2026-119\nInvoice Date: 03/08/2026\nTaxable Amount: 18,50,000.00\nCGST: 1,58,760.00  SGST: 1,66,500.00\nGrand Total: 21,19,010.00')}>Load sample</Button>
              <Button size="sm" onClick={runOcr}><ScanText className="h-3.5 w-3.5" /> Extract fields</Button>
            </div>
            {ocrResult ? (
              <pre className="slim-scroll max-h-48 overflow-auto rounded-md bg-muted p-3 text-[11px]">{JSON.stringify(ocrResult, null, 2)}</pre>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function InvoiceDetail({ invoice, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    if (invoice) get(`/api/invoices/${invoice.id}`).then(setD).catch(() => setD(invoice));
    else setD(null);
  }, [invoice]);
  return (
    <Dialog open={!!d} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        {d ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">{d.invoice_no} <InvoiceBadge status={d.status} /></DialogTitle>
              <DialogDescription>{d.vendor_name || 'Unknown vendor'} · {fmtDate(d.invoice_date)}</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Detail label="Taxable" value={inr(d.taxable_amount)} />
              <Detail label="CGST / SGST / IGST" value={`${inr(d.cgst)} / ${inr(d.sgst)} / ${inr(d.igst)}`} />
              <Detail label="TDS" value={inr(d.tds_amount)} />
              <Detail label="Gross" value={inr(d.gross_amount)} strong />
              <Detail label="Net payable" value={inr(d.net_payable)} strong />
              <Detail label="Due" value={fmtDate(d.due_date)} />
              <Detail label="3-way match" value={d.three_way_match || 'none'} />
              <Detail label="Source" value={d.source} />
              <Detail label="Vendor GSTIN" value={d.gstin_vendor || '—'} />
            </div>
            {d.lines && d.lines.length ? (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Line items</p>
                <Table>
                  <TableHeader>
                    <TableRow><TableHead>HSN</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Taxable</TableHead></TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.lines.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="num">{l.hsn}</TableCell>
                        <TableCell className="max-w-[200px] truncate" title={l.description}>{l.description}</TableCell>
                        <TableCell className="num text-right">{l.qty}</TableCell>
                        <TableCell className="num text-right">{inr(l.taxable)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
            {d.approvals && d.approvals.length ? (
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Approval chain</p>
                <div className="space-y-1.5">
                  {d.approvals.map((a) => (
                    <div key={a.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span>Level {a.level} · {a.required_role === 'cfo' ? 'CFO' : 'Finance Manager'}</span>
                      <Badge variant={a.status === 'approved' ? 'success' : a.status === 'pending' ? 'warning' : 'destructive'}>{a.status}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value, strong }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`num truncate text-sm ${strong ? 'font-semibold' : ''}`} title={value}>{value}</p>
    </div>
  );
}
