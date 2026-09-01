import { useHidden, HIDDEN_MASK } from '../lib/hidden';

interface Props {
  /** Unique per stat card — used as the localStorage key, so each figure
   * remembers its own hidden state independently of the others. */
  id: string;
  value: string;
  label: string;
  tone?: 'accent' | 'dark';
}

export default function HideableStat({ id, value, label, tone }: Props) {
  const [hidden, toggle] = useHidden(`stat:${id}`);
  return (
    <div className={tone ? `stat ${tone}` : 'stat'}>
      <div className="row between" style={{ gap: 8 }}>
        <div className="value">{hidden ? HIDDEN_MASK : value}</div>
        <button
          type="button"
          onClick={toggle}
          aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
          title={hidden ? 'Show' : 'Hide'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 2,
            lineHeight: 1,
            fontSize: 14,
            opacity: 0.55,
          }}
        >
          {hidden ? '🙈' : '👁️'}
        </button>
      </div>
      <div className="label">{label}</div>
    </div>
  );
}
