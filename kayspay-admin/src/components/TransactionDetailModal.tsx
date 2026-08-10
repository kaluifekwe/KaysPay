import { useEffect, useState } from 'react';
import { callAdmin, AdminApiError } from '../lib/adminApi';
import { isRefundable, formatNaira, serviceLabelForType, TxRow } from '../lib/transactions';
import { useAuth } from '../AuthContext';

interface UserDetail {
  full_name: string | null;
  phone: string | null;
  email: string | null;
  wallet_balance_kobo: number | null;
  kyc_status: string;
  transaction_count: number;
  created_at: string;
}

export default function TransactionDetailModal({
  transaction,
  onClose,
  onRefunded,
}: {
  transaction: TxRow;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const { role } = useAuth();
  const [user, setUser] = useState<UserDetail | null>(null);
  const [userError, setUserError] = useState<string | null>(null);

  const [refundOpen, setRefundOpen] = useState(false);
  const [refundReason, setRefundReason] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundDone, setRefundDone] = useState(false);
  const hasConfirmedRefund = refundDone || !!transaction.service_refunds?.length || transaction.status === 'refunded';

  useEffect(() => {
    callAdmin<{ user: UserDetail }>('admin-user-lookup', { query: { user_id: transaction.user_id } })
      .then((r) => setUser(r.user))
      .catch((e) => setUserError(e instanceof AdminApiError ? e.message : 'Could not load user details'));
  }, [transaction.user_id]);

  const submitRefund = async () => {
    setRefundError(null);
    if (refundReason.trim().length < 5) {
      setRefundError('Enter a reason of at least 5 characters');
      return;
    }
    setRefundBusy(true);
    try {
      await callAdmin('admin-refund', {
        method: 'POST',
        body: { transaction_id: transaction.id, reason: refundReason.trim() },
      });
      setRefundDone(true);
      onRefunded();
    } catch (e) {
      setRefundError(e instanceof AdminApiError ? e.message : 'Refund failed');
    } finally {
      setRefundBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Transaction detail</h3>
          <button className="secondary" onClick={onClose}>Close</button>
        </div>

        <div className="card">
          <h4 style={{ marginTop: 0 }}>Transaction</h4>
          <table>
            <tbody>
              <tr><td className="muted">Service</td><td>{serviceLabelForType(transaction.type)} <span className="muted">({transaction.type})</span></td></tr>
              <tr><td className="muted">Amount paid</td><td><strong>{formatNaira(transaction.amount_ngn)}</strong></td></tr>
              <tr><td className="muted">Status</td><td><span className={`badge ${hasConfirmedRefund ? 'refunded' : transaction.status}`}>{hasConfirmedRefund ? 'refunded' : transaction.status}</span></td></tr>
              <tr><td className="muted">Recipient</td><td>{transaction.recipient_phone || '—'}{transaction.network ? ` (${transaction.network})` : ''}</td></tr>
              <tr><td className="muted">Order reference</td><td>{transaction.vtu_order_id || '—'}</td></tr>
              <tr><td className="muted">Created</td><td>{new Date(transaction.created_at).toLocaleString('en-GB')}</td></tr>
              <tr><td className="muted">Completed</td><td>{transaction.completed_at ? new Date(transaction.completed_at).toLocaleString('en-GB') : '—'}</td></tr>
              {transaction.service_refunds?.[0] && (
                <>
                  <tr><td className="muted">Wallet refund</td><td><strong>Confirmed</strong></td></tr>
                  <tr><td className="muted">Refund reason</td><td>{transaction.service_refunds[0].reason}</td></tr>
                  <tr><td className="muted">Refund source</td><td>{transaction.service_refunds[0].origin}</td></tr>
                  <tr><td className="muted">Refunded</td><td>{new Date(transaction.service_refunds[0].created_at).toLocaleString('en-GB')}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h4 style={{ marginTop: 0 }}>Who made this transaction</h4>
          {userError && <div className="error-text">{userError}</div>}
          {!user && !userError && <p className="muted">Loading…</p>}
          {user && (
            <table>
              <tbody>
                <tr><td className="muted">Name</td><td>{user.full_name || '—'}</td></tr>
                <tr><td className="muted">Phone</td><td>{user.phone || '—'}</td></tr>
                <tr><td className="muted">Email</td><td>{user.email || '—'}</td></tr>
                <tr><td className="muted">Wallet balance</td><td>{formatNaira(user.wallet_balance_kobo ?? 0)}</td></tr>
                <tr><td className="muted">KYC status</td><td><span className={`badge ${user.kyc_status === 'verified' ? 'enabled' : 'pending'}`}>{user.kyc_status}</span></td></tr>
                <tr><td className="muted">Total transactions</td><td>{user.transaction_count}</td></tr>
                <tr><td className="muted">Joined</td><td>{new Date(user.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td></tr>
              </tbody>
            </table>
          )}
        </div>

        {role === 'super_admin' && (
          <div className="card">
            <h4 style={{ marginTop: 0 }}>Refund</h4>
            {hasConfirmedRefund ? (
              <p className="muted">Refunded {formatNaira(transaction.amount_ngn)} back to this user's wallet.</p>
            ) : !isRefundable(transaction) ? (
              <p className="muted">This transaction isn't eligible for a refund from the admin panel.</p>
            ) : !refundOpen ? (
              <button className="secondary" onClick={() => setRefundOpen(true)}>Refund this transaction</button>
            ) : (
              <div>
                <p className="muted">
                  This refunds exactly what was paid — <strong>{formatNaira(transaction.amount_ngn)}</strong> — back
                  to the user's wallet. It's not possible to refund a different amount.
                </p>
                <div className="field">
                  <label>Reason (required)</label>
                  <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} autoFocus />
                </div>
                {refundError && <div className="error-text">{refundError}</div>}
                <div className="row" style={{ gap: 8 }}>
                  <button className="danger" disabled={refundBusy} onClick={submitRefund}>
                    {refundBusy ? 'Refunding…' : `Confirm refund of ${formatNaira(transaction.amount_ngn)}`}
                  </button>
                  <button className="secondary" disabled={refundBusy} onClick={() => setRefundOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
