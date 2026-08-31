import type { CSSProperties, ReactNode } from "react";

type Journey = { label: string; screen: ReactNode };

const journeys: readonly Journey[] = [
  { label: "Login", screen: <>
    <div className="demo-heading"><span className="demo-kicker">Welcome back</span><h3>Sign in to KaysPay</h3><p>Enter your Nigerian phone number to continue.</p></div>
    <div className="demo-field"><span className="field-label">Phone number</span><div className="phone-entry"><span>🇳🇬</span><strong>+234</strong><span>803 456 7821</span></div></div>
    <button className="demo-button" type="button" tabIndex={-1}>Continue securely</button><div className="demo-trust"><span>⌁</span> Protected sign in</div>
  </> },
  { label: "Buy airtime", screen: <>
    <div className="demo-topline"><span className="demo-back">‹</span><strong>Buy airtime</strong><span className="demo-help">?</span></div>
    <div className="demo-balance"><span>Wallet balance</span><strong>₦24,850.00</strong></div>
    <div className="demo-field"><span className="field-label">Mobile network</span><div className="demo-select"><span className="network-mark">MTN</span><strong>MTN Nigeria</strong><span>⌄</span></div></div>
    <div className="demo-field"><span className="field-label">Phone number</span><div className="demo-input">0803 456 7821</div></div>
    <div className="demo-field"><span className="field-label">Amount</span><div className="demo-input amount">₦1,000</div></div>
    <button className="demo-button" type="button" tabIndex={-1}>Continue to pay</button>
  </> },
  { label: "Buy crypto", screen: <>
    <div className="demo-topline"><span className="demo-back">‹</span><strong>Buy crypto</strong><span className="demo-help">?</span></div>
    <div className="crypto-tabs"><span>Buy</span><span>Sell</span></div>
    <div className="demo-field"><span className="field-label">Select asset</span><div className="demo-select"><span className="coin-mark">₮</span><span><strong>Tether</strong><small>USDT</small></span><span>⌄</span></div></div>
    <div className="demo-field crypto-amount"><span className="field-label">You pay</span><div><strong>₦5,000</strong><span>NGN</span></div></div>
    <div className="receive-row"><span>You receive</span><strong>≈ 3.51 USDT</strong></div>
    <button className="demo-button" type="button" tabIndex={-1}>Review purchase</button><div className="demo-trust"><span>✓</span> Quote shown before confirmation</div>
  </> },
  { label: "Successful", screen: <div className="success-screen">
    <div className="success-rings"><span>✓</span></div><span className="demo-kicker">Payment confirmed</span><h3>Transaction successful</h3><p>Your crypto purchase has been completed.</p>
    <div className="success-receipt"><span>Amount paid<strong>₦5,000</strong></span><span>Asset received<strong>3.51 USDT</strong></span><span>Status<strong className="status-success">Successful</strong></span></div>
    <button className="demo-button" type="button" tabIndex={-1}>Done</button>
  </div> },
] as const;

export default function AppJourneyPhone() {
  return <div className="journey-showcase" role="img" aria-label="Animated KaysPay demonstration showing secure login, an airtime purchase, a crypto purchase and a successful transaction">
    <div className="journey-glow" aria-hidden="true" />
    <div className="phone-shell">
      <span className="phone-side-button phone-side-button-one" aria-hidden="true"/><span className="phone-side-button phone-side-button-two" aria-hidden="true"/>
      <div className="phone-screen">
        <div className="phone-status"><span>9:41</span><span className="camera-dot"/><span>◒ ▰</span></div>
        <div className="phone-brand"><img src="/images/icon.png" alt=""/><strong>KaysPay</strong><span>⌁</span></div>
        <div className="journey-stage" aria-hidden="true">
          {journeys.map((journey,index)=><article className="journey-frame" style={{"--journey-index":index} as CSSProperties} key={journey.label}>{journey.screen}</article>)}
          <span className="tap-pulse"/>
        </div>
        <div className="phone-home-indicator" aria-hidden="true"/>
      </div>
    </div>
    <div className="journey-steps" aria-hidden="true">{journeys.map((journey,index)=><div className="journey-step" style={{"--journey-index":index} as CSSProperties} key={journey.label}><span>{index + 1}</span><strong>{journey.label}</strong></div>)}</div>
    <div className="journey-caption"><span className="live-dot"/>KaysPay in action</div>
  </div>;
}
