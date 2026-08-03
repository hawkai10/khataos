import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Circle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { Button } from '../components/ui/button.jsx';
import { Badge } from '../components/ui/badge.jsx';
import { get, post } from '../lib/api.js';
import { fmtDateTime } from '../lib/format.js';
import { PageHeader } from '../components/page-header.jsx';

const STEP_META = {
  connect_bank: ['Connect your first bank', '15 minutes — AA consent flow. See cash data before anything else.'],
  install_tally: ['Install the Tally connector', 'Windows service on the Tally server, guided installer.'],
  email_routing: ['Route invoice emails', 'Forward invoices to forward@invoices.khataos.in — no IT involved.'],
  vendor_import: ['Import vendor master', 'Ledgers, GSTINs, TDS sections and bank details from Tally.'],
};

export function Onboarding({ user }) {
  const [steps, setSteps] = useState([]);

  const load = () => get('/api/onboarding').then(setSteps).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  async function complete(step) {
    try {
      await post(`/api/onboarding/${step}/complete`);
      toast.success('Step completed');
      await load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const done = steps.filter((s) => s.status === 'done').length;
  const canComplete = user && ['cfo', 'finance_manager'].includes(user.role);

  return (
    <div className="space-y-5">
      <PageHeader title="Onboarding" description={`${done}/${steps.length} steps complete — self-serve, no implementation project.`} />

      <Card>
        <CardHeader>
          <CardTitle>Setup checklist</CardTitle>
          <CardDescription>Everything needed to go live within 15 minutes to a day</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {steps.map((s) => {
            const meta = STEP_META[s.step] || [s.step, ''];
            const isDone = s.status === 'done';
            return (
              <div key={s.step} className={`flex items-center gap-3 rounded-lg border p-3.5 ${isDone ? 'bg-emerald-50/50' : ''}`}>
                {isDone ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" /> : <Circle className="h-5 w-5 shrink-0 text-muted-foreground/40" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{meta[0]}</p>
                  <p className="text-xs text-muted-foreground">{meta[1]}</p>
                </div>
                <Badge variant={isDone ? 'success' : 'secondary'}>{isDone ? 'Done' : 'Pending'}</Badge>
                {!isDone && canComplete ? (
                  <Button size="sm" variant="outline" onClick={() => complete(s.step)}>Mark done</Button>
                ) : null}
                {s.at ? <span className="hidden text-[11px] text-muted-foreground sm:block">{fmtDateTime(s.at)}</span> : null}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
