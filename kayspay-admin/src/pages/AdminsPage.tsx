import { FormEvent, useEffect, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { useAuth } from '../AuthContext';

interface AdminRow {
  user_id: string;
  role: 'support' | 'super_admin';
  email: string | null;
  disabled_at: string | null;
  created_at: string;
}

export default function AdminsPage() {
  const { session } = useAuth();
  const [admins, setAdmins] = useState<AdminRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'support' | 'super_admin'>('support');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    callAdmin<{ admins: AdminRow[] }>('admin-manage')
      .then((r) => setAdmins(r.admins))
      .catch((e) => setError(e instanceof AdminApiError ? e.message : 'Could not load admins'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    setInviteMsg(null);
    setError(null);
    setInviting(true);
    try {
      const r = await callAdmin<{ already_had_account: boolean }>('admin-invite', {
        method: 'POST',
        body: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteMsg(
        r.already_had_account
          ? 'This person already had a Kay\'s Pay account — admin access was granted directly.'
          : 'Invite sent. They\'ll receive an email to set their password.',
      );
      setInviteEmail('');
      load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not send invite');
    } finally {
      setInviting(false);
    }
  };

  const act = async (userId: string, action: 'disable' | 'enable', role?: string) => {
    setError(null);
    setBusy(userId);
    try {
      await callAdmin('admin-manage', { method: 'POST', body: { action, user_id: userId, role } });
      load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const setRole = async (userId: string, role: 'support' | 'super_admin') => {
    setError(null);
    setBusy(userId);
    try {
      await callAdmin('admin-manage', { method: 'POST', body: { action: 'set_role', user_id: userId, role } });
      load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not change role');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2>Admins</h2>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Invite a new admin</h3>
        <form onSubmit={handleInvite} className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 1, marginBottom: 0 }}>
            <label>Email</label>
            <input type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Role</label>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'support' | 'super_admin')}>
              <option value="support">Support</option>
              <option value="super_admin">Super admin</option>
            </select>
          </div>
          <button className="primary" type="submit" disabled={inviting}>{inviting ? 'Sending…' : 'Invite'}</button>
        </form>
        {inviteMsg && <p className="muted" style={{ marginTop: 12 }}>{inviteMsg}</p>}
      </div>

      {error && <div className="error-text">{error}</div>}

      <div className="card">
        {loading ? <p className="muted">Loading…</p> : (
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.user_id}>
                  <td>{a.email || a.user_id}{a.user_id === session?.user.id && <span className="muted"> (you)</span>}</td>
                  <td>
                    <select
                      value={a.role}
                      disabled={busy === a.user_id}
                      onChange={(e) => setRole(a.user_id, e.target.value as 'support' | 'super_admin')}
                    >
                      <option value="support">Support</option>
                      <option value="super_admin">Super admin</option>
                    </select>
                  </td>
                  <td><span className={`badge ${a.disabled_at ? 'disabled' : 'enabled'}`}>{a.disabled_at ? 'Disabled' : 'Active'}</span></td>
                  <td>
                    {a.disabled_at ? (
                      <button className="secondary" disabled={busy === a.user_id} onClick={() => act(a.user_id, 'enable')}>Re-enable</button>
                    ) : (
                      <button className="danger" disabled={busy === a.user_id} onClick={() => act(a.user_id, 'disable')}>Disable</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
