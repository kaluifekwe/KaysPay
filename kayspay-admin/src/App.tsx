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

function Shell() {
  const { role, session } = useAuth();
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Kay's Pay Admin</h1>
        <div className="role-badge">{role === 'super_admin' ? 'Super Admin' : 'Support'}</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          <NavLink to="/users">User Lookup</NavLink>
          <NavLink to="/services">Kill Switches</NavLink>
          <NavLink to="/pricing">Pricing</NavLink>
          <NavLink to="/security">Security Alerts</NavLink>
          {role === 'super_admin' && <NavLink to="/admins">Admins</NavLink>}
        </nav>
        <div className="muted" style={{ fontSize: 11, marginTop: 24, wordBreak: 'break-all' }}>
          {session?.user.email}
        </div>
        <button className="signout" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          <Route path="/users" element={<UserLookupPage />} />
          <Route path="/services" element={<ServiceControlsPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/security" element={<SecurityAlertsPage />} />
          {role === 'super_admin' && <Route path="/admins" element={<AdminsPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function NotAuthorized() {
  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Not authorized</h1>
        <p className="muted">Your Kay's Pay account doesn't have admin access. Ask a super admin to invite you.</p>
        <button className="secondary" style={{ width: '100%' }} onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>
  );
}

export default function App() {
  const { loading, session, role, needsBootstrap } = useAuth();

  if (loading) return <div className="login-shell"><p style={{ color: '#fff' }}>Loading…</p></div>;
  if (!session) return <LoginPage />;
  if (!role && needsBootstrap) return <BootstrapPage />;
  if (!role) return <NotAuthorized />;
  return <Shell />;
}
