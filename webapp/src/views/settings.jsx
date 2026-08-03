import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Save, ScrollText } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { get, put } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

export function Settings({ user }) {
  const [settings, setSettings] = useState(null);
  const [audit, setAudit] = useState([]);
  const [busy, setBusy] = useState(false);
  const isCfo = user && user.role === 'cfo';

  useEffect(() => {
    Promise.all([get('/api/settings'), get('/api/audit')])
      .then(([s, a]) => {
        setSettings(s);
        setAudit(a);
      })
      .catch(() => {});
  }, []);

  async function save() {
    setBusy(true);
    try {
      await put('/api/settings', settings);
      toast.success('Settings saved');
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k) => (e) => setSettings({ ...settings, [k]: Number(e.target.value) || 0 });

  return (
    <div className="space-y-5">
      <PageHeader title="Settings & Audit" description="Approval rules and the full activity trail." />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Approval thresholds</CardTitle>
            <CardDescription>{isCfo ? 'Change rules — affects new invoices and payments' : 'Read-only — CFO can edit'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {settings ? (
              <>
                <div className="space-y-1.5">
                  <Label>CFO invoice approval threshold (₹)</Label>
                  <Input type="number" value={settings.cfo_approval_threshold ?? 100000} onChange={set('cfo_approval_threshold')} disabled={!isCfo} />
                  <p className="text-xs text-muted-foreground">Invoices above this route to a second-level CFO approval.</p>
                </div>
                <div className="space-y-1.5">
                  <Label>Payment approval threshold (₹)</Label>
                  <Input type="number" value={settings.payment_approval_threshold ?? 500000} onChange={set('payment_approval_threshold')} disabled={!isCfo} />
                  <p className="text-xs text-muted-foreground">Payments above this require CFO approval before execution.</p>
                </div>
                <Button onClick={save} disabled={!isCfo || busy}><Save className="h-4 w-4" /> {busy ? 'Saving…' : 'Save settings'}</Button>
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ScrollText className="h-4 w-4 text-primary" /> Audit trail</CardTitle>
            <CardDescription>Every sensitive action is recorded — approvals, payments, settings, integrations</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <div className="slim-scroll max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.slice(0, 80).map((a) => (
                    <TableRow key={a.id}>
                      <TableCell><Badge variant="secondary">{a.action}</Badge></TableCell>
                      <TableCell className="max-w-[140px] truncate text-xs" title={`${a.entity} ${a.entity_id || ''}`}>{a.entity} {a.entity_id || ''}</TableCell>
                      <TableCell className="text-xs">{a.user_name || 'system'}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDateTime(a.at)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
