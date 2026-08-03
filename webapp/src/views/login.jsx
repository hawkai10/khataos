import { useState } from 'react';
import { toast } from 'sonner';
import { Wallet, Lock, Mail } from 'lucide-react';
import { Button } from '../components/ui/button.jsx';
import { Input } from '../components/ui/input.jsx';
import { Label } from '../components/ui/label.jsx';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.jsx';
import { post, setSession } from '../lib/api.js';

const DEMO_USERS = [
  { label: 'CFO', email: 'cfo@acme.in', role: 'Everything incl. > ₹1L approvals' },
  { label: 'Manager', email: 'manager@acme.in', role: 'Approve ≤ ₹1L, reconcile' },
  { label: 'Executive', email: 'exec@acme.in', role: 'Capture & schedule payments' },
];

export function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await post('/api/auth/login', { email, password });
      setSession(data.token, data.user);
      onLogin(data.user);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/10">
            <Wallet className="h-5 w-5 text-white" />
          </span>
          <div className="leading-tight">
            <p className="text-xl font-semibold text-white">KhataOS</p>
            <p className="text-xs text-slate-400">Unified Finance Operating Platform</p>
          </div>
        </div>

        <Card className="shadow-2xl">
          <CardHeader>
            <CardTitle className="text-base">Sign in</CardTitle>
            <CardDescription>Cash, payables, payments, reconciliation and GST — in one place.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="login-email">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="login-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cfo@acme.in" className="pl-9" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input id="login-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="pl-9" />
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <div className="mt-6 rounded-lg border bg-muted/50 p-3">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Demo accounts</p>
              <div className="grid gap-1.5">
                {DEMO_USERS.map((u) => (
                  <button
                    key={u.email}
                    type="button"
                    onClick={() => {
                      setEmail(u.email);
                      setPassword('demo1234');
                    }}
                    className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <span className="font-medium">{u.label}</span>
                    <span className="text-muted-foreground">{u.role}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">Password for all demo users: demo1234</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
