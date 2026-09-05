import { FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../AuthContext';
import { supabase } from '../lib/supabase';

interface TotpSetup {
  factorId: string;
  qrCode: string;
  secret: string;
}

export default function MfaPage() {
  const { nextLevel, refreshAssurance } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const prepare = async () => {
      setError(null);
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (!active) return;
      if (factorsError) {
        setError('Could not load your authentication factors. Please sign out and try again.');
        setLoading(false);
        return;
      }

      const verified = factors.totp.find((factor) => factor.status === 'verified');
      if (verified) {
        setFactorId(verified.id);
        setLoading(false);
        return;
      }

      const { data: enrolled, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'KaysPay Admin',
      });
      if (!active) return;
      if (enrollError || !enrolled) {
        setError('Could not start authenticator setup. Please sign out and try again.');
        setLoading(false);
        return;
      }

      setFactorId(enrolled.id);
      setSetup({
        factorId: enrolled.id,
        qrCode: enrolled.totp.qr_code,
        secret: enrolled.totp.secret,
      });
      setLoading(false);
    };

    void prepare();
    return () => { active = false; };
  }, []);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (!factorId || !/^\d{6}$/.test(code)) {
      setError('Enter the six-digit code from your authenticator app.');
      return;
    }

    setSubmitting(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code,
    });
    if (verifyError) {
      setError('That code is invalid or expired. Wait for a new code and try again.');
      setSubmitting(false);
      return;
    }

    await supabase.auth.refreshSession();
    await refreshAssurance();
    setSubmitting(false);
  };

  return (
    <div className="login-shell">
      <div className="login-card mfa-card">
        <h1>Secure your admin account</h1>
        <p className="muted">
          {setup
            ? 'Scan this code with an authenticator app. MFA is mandatory for KaysPay administrators.'
            : 'Enter the current code from your authenticator app to continue.'}
        </p>

        {loading ? <p className="muted">Preparing secure sign-in…</p> : (
          <>
            {setup && (
              <div className="mfa-setup">
                <img src={setup.qrCode} alt="KaysPay Admin authenticator QR code" />
                <p className="muted">Unable to scan? Enter this setup key manually:</p>
                <code>{setup.secret}</code>
              </div>
            )}

            <form onSubmit={verify}>
              <div className="field">
                <label>Six-digit authentication code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus={!setup}
                />
              </div>
              {error && <div className="error-text" role="alert">{error}</div>}
              <button className="primary" type="submit" disabled={submitting || !factorId} style={{ width: '100%' }}>
                {submitting ? 'Verifying…' : setup ? 'Finish secure setup' : 'Verify and continue'}
              </button>
            </form>
          </>
        )}

        {!loading && nextLevel === null && !error && (
          <p className="error-text">Authentication assurance could not be determined.</p>
        )}
        <button className="secondary mfa-signout" type="button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </div>
    </div>
  );
}
