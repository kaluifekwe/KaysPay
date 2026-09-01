import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { supabase } from './lib/supabase';
import LoginPage from './pages/LoginPage';
import BootstrapPage from './pages/BootstrapPage';
import DashboardPage from './pages/DashboardPage';
import TransactionsPage from './pages/TransactionsPage';
import UserLookupPage from './pages/UserLookupPage';
import ServiceControlsPage from './pages/ServiceControlsPage';
import PricingPage from './pages/PricingPage';
import AdminsPage from './pages/AdminsPage';
import SecurityAlertsPage from './pages/SecurityAlertsPage';
import SettingsPage from './pages/SettingsPage';
import OnboardingPage from './pages/OnboardingPage';
import CampaignsPage from './pages/CampaignsPage';
import OperationsPage from './pages/OperationsPage';
import AiAssistantPage from './pages/AiAssistantPage';
import IncidentsPage from './pages/IncidentsPage';
import BusinessIntelligencePage from './pages/BusinessIntelligencePage';
import MfaPage from './pages/MfaPage';
import CryptoRecoveryPage from './pages/CryptoRecoveryPage';

function Shell() {
  const { role, session } = useAuth();
  const [aiOpen, setAiOpen] = useState(false);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>KaysPay Admin</h1>
        <div className="role-badge">{role === 'super_admin' ? 'Super Admin' : 'Support'}</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/onboarding">Onboarding</NavLink>
          {role === 'super_admin' && <NavLink to="/campaigns">Campaigns</NavLink>}
          <NavLink to="/operations">Operations</NavLink>
          <NavLink to="/incidents">Incident Centre</NavLink>
          <NavLink to="/business-intelligence">Business Intelligence</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/users">User Lookup</NavLink>
          <NavLink to="/services">Kill Switches</NavLink>
          <NavLink to="/pricing">Pricing</NavLink>
          <NavLink to="/security">Security Alerts</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          {role === 'super_admin' && <NavLink to="/admins">Admins</NavLink>}
          {role === 'super_admin' && <NavLink to="/crypto-recovery">Crypto Recovery</NavLink>}
        </nav>
        <div className="muted" style={{ fontSize: 11, marginTop: 24, wordBreak: 'break-all' }}>
          {session?.user.email}
        </div>
        <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/onboarding" element={<OnboardingPage />} />
          {role === 'super_admin' && <Route path="/campaigns" element={<CampaignsPage />} />}
          <Route path="/operations" element={<OperationsPage />} />
          <Route path="/incidents" element={<IncidentsPage />} />
          <Route path="/business-intelligence" element={<BusinessIntelligencePage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/users" element={<UserLookupPage />} />
          <Route path="/services" element={<ServiceControlsPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/security" element={<SecurityAlertsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {role === 'super_admin' && <Route path="/admins" element={<AdminsPage />} />}
          {role === 'super_admin' && <Route path="/crypto-recovery" element={<CryptoRecoveryPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <button className={`ai-copilot-launcher${aiOpen ? ' open' : ''}`} onClick={() => setAiOpen((v) => !v)}>
        <span>AI</span> {aiOpen ? 'Close assistant' : 'Ask AI'}
      </button>
      <div className={`ai-copilot-backdrop${aiOpen ? ' open' : ''}`} onClick={() => setAiOpen(false)} />
      <div className={`ai-copilot-panel${aiOpen ? ' open' : ''}`}>
        <button className="ai-copilot-close" onClick={() => setAiOpen(false)}>×</button>
        <AiAssistantPage />
      </div>
    </div>
  );
}

function NotAuthorized() {
  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Not authorized</h1>
        <p className="muted">Your KaysPay account doesn't have admin access. Ask a super admin to invite you.</p>
        <button className="secondary" style={{ width: '100%' }} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  const { loading, session, role, needsBootstrap, currentLevel, nextLevel } = useAuth();

  if (loading) return <div className="login-shell"><p style={{ color: '#fff' }}>Loading…</p></div>;
  if (!session) return <LoginPage />;
  if (nextLevel === 'aal2' && currentLevel !== 'aal2') return <MfaPage />;
  if (!role && needsBootstrap) return <BootstrapPage />;
  if (!role) return <NotAuthorized />;
  return <Shell />;
}
