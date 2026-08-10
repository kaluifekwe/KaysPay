import { useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { useAuth } from '../AuthContext';

export default function BootstrapPage() {
  const { refreshRole, session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleBootstrap = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await callAdmin('admin-bootstrap', { method: 'POST' });
      await refreshRole();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not complete setup');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Set up admin access</h1>
        <p className="muted">
          No admin exists yet. Signed in as <strong>{session?.user.email}</strong>. Completing this
          makes this account the first super admin — you'll be able to invite others afterward.
        </p>
        {error && <div className="error-text">{error}</div>}
        <button className="primary" onClick={handleBootstrap} disabled={submitting} style={{ width: '100%' }}>
          {submitting ? 'Setting up…' : 'Become the first super admin'}
        </button>
      </div>
    </div>
  );
}
