import { useEffect, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { useAuth } from '../AuthContext';

interface AppSetting {
  key: string;
  value: string;
  updated_at: string;
}

const LABELS: Record<string, string> = {
  support_whatsapp_number: 'Support WhatsApp number',
  support_whatsapp_group_url: 'WhatsApp group invite link',
};

const HINTS: Record<string, string> = {
  support_whatsapp_number:
    'International format, no + or spaces — e.g. 2349068446111. A local 0906… number is converted automatically. Used by the Support tab, Contact Support in More and Profile, and the delete-account message.',
  support_whatsapp_group_url:
    'Must be a chat.whatsapp.com invite link. WhatsApp’s tracking params (?s=cl…) are stripped automatically. Shown in the founder welcome email new users receive ~10 minutes after signing up.',
};

export default function SettingsPage() {
  const { role } = useAuth();
  const canEdit = role === 'super_admin';
  const [settings, setSettings] = useState<AppSetting[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await callAdmin<{ settings: AppSetting[] }>('admin-app-settings');
      setSettings(result.settings);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async (key: string) => {
    const current = settings.find((item) => item.key === key);
    const value = (inputs[key] ?? current?.value ?? '').trim();
    setError(null);
    setSaved(null);
    if (!value) {
      setError('Enter a value before saving.');
      return;
    }
    setBusy(key);
    try {
      const result = await callAdmin<{ setting: AppSetting }>('admin-app-settings', {
        method: 'POST', body: { key, value },
      });
      setSettings((items) => items.map((item) => item.key === key ? result.setting : item));
      // Clear the draft so the field falls back to showing the server's own
      // normalised value (e.g. a pasted "+234 906…" comes back as 234906…).
      setInputs((current) => { const next = { ...current }; delete next[key]; return next; });
      setSaved(key);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Could not save the setting');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h2>Settings</h2>
      <p className="muted">
        Changes take effect the next time a customer opens the app — no app update needed.
      </p>
      {!canEdit && <p className="muted">You have view-only access. Only super admins can change settings.</p>}
      {error && <div className="error-text">{error}</div>}

      {loading ? <p className="muted">Loading…</p> : (
        <div className="card">
          <table>
            <thead>
              <tr><th>Setting</th><th>Value</th><th>Updated</th>{canEdit && <th />}</tr>
            </thead>
            <tbody>
              {settings.map((setting) => (
                <tr key={setting.key}>
                  <td>
                    {LABELS[setting.key] || setting.key}
                    {HINTS[setting.key] && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4, maxWidth: 420 }}>
                        {HINTS[setting.key]}
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      className="mono"
                      style={{ width: 200 }}
                      value={inputs[setting.key] ?? setting.value}
                      disabled={!canEdit}
                      onChange={(event) => setInputs((current) => ({ ...current, [setting.key]: event.target.value }))}
                    />
                  </td>
                  <td className="muted">{new Date(setting.updated_at).toLocaleString('en-GB')}</td>
                  {canEdit && (
                    <td>
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <button
                          className="primary"
                          style={{ padding: '6px 12px', fontSize: 12 }}
                          disabled={busy === setting.key}
                          onClick={() => void save(setting.key)}
                        >
                          Save
                        </button>
                        {saved === setting.key && <span className="muted" style={{ fontSize: 11 }}>Saved</span>}
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
