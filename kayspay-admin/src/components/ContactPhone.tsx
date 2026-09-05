import { useState } from 'react';
import { formatPhoneForAdmin, phoneForCalling } from '../lib/phone';

export default function ContactPhone({ phone }: { phone: string | null }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  if (!phone) return <span className="muted">No phone number provided</span>;

  const callable = phoneForCalling(phone);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(callable);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };

  return (
    <div>
      <div>{formatPhoneForAdmin(phone)}</div>
      <div className="row" style={{ gap: 6, marginTop: 6 }}>
        <button className="secondary" type="button" onClick={() => { window.location.href = `tel:${callable}`; }}>
          Call user
        </button>
        <button className="secondary" type="button" onClick={() => void copy()}>
          {copyStatus === 'copied' ? 'Copied' : 'Copy number'}
        </button>
      </div>
      {copyStatus === 'failed' && <div className="error-text" style={{ marginTop: 4 }}>Could not copy the number.</div>}
    </div>
  );
}
