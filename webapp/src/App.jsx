import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Login } from './views/login.jsx';
import { Dashboard } from './views/dashboard.jsx';
import { Cash } from './views/cash.jsx';
import { Payables } from './views/payables.jsx';
import { Payments } from './views/payments.jsx';
import { Recon } from './views/recon.jsx';
import { Gst } from './views/gst.jsx';
import { Tally } from './views/tally.jsx';
import { Onboarding } from './views/onboarding.jsx';
import { System } from './views/system.jsx';
import { Settings } from './views/settings.jsx';
import { AppShell } from './components/app-shell.jsx';
import { getUser, clearSession, setUnauthorizedHandler } from './lib/api.js';

export default function App() {
  const [user, setUser] = useState(getUser());
  const [view, setView] = useState('dashboard');

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setView('dashboard');
      toast.warning('Session expired — please log in again.');
    });
  }, []);

  if (!user) {
    return <Login onLogin={setUser} />;
  }

  return (
    <AppShell user={user} view={view} onNavigate={setView} onLogout={() => { clearSession(); setUser(null); }}>
      {view === 'dashboard' ? <Dashboard user={user} /> : null}
      {view === 'cash' ? <Cash /> : null}
      {view === 'payables' ? <Payables user={user} /> : null}
      {view === 'payments' ? <Payments user={user} /> : null}
      {view === 'recon' ? <Recon user={user} /> : null}
      {view === 'gst' ? <Gst /> : null}
      {view === 'tally' ? <Tally user={user} /> : null}
      {view === 'onboarding' ? <Onboarding user={user} /> : null}
      {view === 'system' ? <System /> : null}
      {view === 'settings' ? <Settings user={user} /> : null}
    </AppShell>
  );
}
