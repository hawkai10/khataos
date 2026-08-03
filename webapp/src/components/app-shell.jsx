import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Landmark, FileText, Send, RefreshCw, Percent,
  Layers, Activity, Settings as SettingsIcon, LogOut, Sparkles, Wallet, CheckCircle2,
} from 'lucide-react';
import { cn } from '../lib/utils.js';
import { Button } from './ui/button.jsx';
import { Separator } from './ui/separator.jsx';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu.jsx';
import { get } from '../lib/api.js';
import { AiAssistant } from './ai-assistant.jsx';

const NAV = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['cash', 'Cash & Banks', Landmark],
  ['payables', 'Payables', FileText],
  ['payments', 'Payments', Send],
  ['recon', 'Reconciliation', RefreshCw],
  ['gst', 'GST & Compliance', Percent],
  ['tally', 'Tally Sync', Layers],
  ['onboarding', 'Onboarding', CheckCircle2],
  ['system', 'System Health', Activity],
  ['settings', 'Settings & Audit', SettingsIcon],
];

const TITLES = {
  dashboard: ['Dashboard', 'Your four morning questions, answered in real time'],
  cash: ['Cash & Banks', 'Consolidated multi-bank cash position and transactions'],
  payables: ['Payables', 'Invoice capture, approvals and three-way matching'],
  payments: ['Payments', 'Execute, schedule and track vendor payments'],
  recon: ['Reconciliation', 'Auto-match bank transactions with payments and Tally'],
  gst: ['GST & Compliance', 'ITC, liabilities and GSTR-2B reconciliation'],
  tally: ['Tally Sync', 'Integration health, sync queue and vouchers'],
  onboarding: ['Onboarding', 'Self-serve setup checklist'],
  system: ['System Health', 'Database, queue and integration status'],
  settings: ['Settings & Audit', 'Approval rules and activity trail'],
};

export function AppShell({ user, view, onNavigate, onLogout, children }) {
  const [aiOpen, setAiOpen] = useState(false);
  const [pending, setPending] = useState(0);

  useEffect(() => {
    get('/api/approvals/pending')
      .then((rows) => setPending(Array.isArray(rows) ? rows.length : 0))
      .catch(() => setPending(0));
  }, [view]);

  const title = TITLES[view] || [view, ''];

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-60 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2.5 border-b border-sidebar-border px-5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
            <Wallet className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <p className="text-sm font-semibold tracking-tight">KhataOS</p>
            <p className="text-[10px] text-sidebar-foreground/50">Finance OS · India</p>
          </div>
        </div>

        <nav className="slim-scroll flex-1 space-y-0.5 overflow-y-auto p-2.5">
          {NAV.map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => onNavigate(key)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                view === key
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {key === 'payables' && pending > 0 ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-400 px-1.5 text-[10px] font-semibold text-amber-950">
                  {pending}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        <div className="border-t border-sidebar-border p-3">
          <div className="flex items-center gap-2.5 rounded-lg bg-sidebar-accent/50 px-3 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
              {(user?.name || 'U').split(' ').map((s) => s[0]).slice(0, 2).join('')}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-xs font-medium">{user?.name}</p>
              <p className="truncate text-[10px] text-sidebar-foreground/50">{roleLabel(user?.role)}</p>
            </div>
            <button onClick={onLogout} title="Log out" className="rounded-md p-1.5 text-sidebar-foreground/60 transition-colors hover:bg-white/10 hover:text-sidebar-foreground">
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>

      <div className="ml-60 flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-card/90 px-6 backdrop-blur">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">{title[0]}</h2>
            <p className="hidden text-[11px] text-muted-foreground sm:block">{title[1]}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAiOpen(true)}>
              <Sparkles className="h-4 w-4 text-primary" /> Copilot
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-[12px] font-semibold text-primary-foreground">
                    {(user?.name || 'U').split(' ').map((s) => s[0]).slice(0, 2).join('')}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{user?.name}<br /><span className="text-[10px] font-normal text-muted-foreground">{user?.email} · {roleLabel(user?.role)}</span></DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onLogout}><LogOut className="h-4 w-4" /> Log out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="slim-scroll flex-1 overflow-y-auto p-6">{children}</main>
        <footer className="flex items-center justify-between border-t px-6 py-3 text-[11px] text-muted-foreground">
          <span>KhataOS MVP · RBI data-localized (AWS Mumbai)</span>
          <Separator className="hidden" />
          <span>{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
        </footer>
      </div>

      <AiAssistant open={aiOpen} onOpenChange={setAiOpen} onNavigate={onNavigate} />
    </div>
  );
}

function roleLabel(role) {
  return {
    cfo: 'CFO / Admin',
    finance_manager: 'Finance Manager',
    finance_executive: 'Finance Executive',
  }[role] || role || '';
}
