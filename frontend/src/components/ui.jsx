import { Check } from '@phosphor-icons/react';

const cx = (...parts) => parts.filter(Boolean).join(' ');

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-on-accent hover:brightness-110',
  secondary: 'bg-surface-2 text-fg border border-line hover:border-fg/30',
  ghost: 'text-muted hover:text-fg hover:bg-surface-2',
  inverse: 'bg-fg text-canvas hover:opacity-90',
};

const BUTTON_BASE =
  'inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-sm font-medium transition duration-200 active:translate-y-px active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40';

// Exposed so links (react-router) can look exactly like buttons.
export const buttonClass = (variant = 'primary', extra) => cx(BUTTON_BASE, BUTTON_VARIANTS[variant], extra);

export function Button({ variant = 'primary', icon: Icon, className, children, ...props }) {
  return (
    <button type="button" {...props} className={buttonClass(variant, className)}>
      {Icon && <Icon size={18} weight="regular" aria-hidden />}
      {children}
    </button>
  );
}

// A row-sized toggle. The whole row is the switch, so the hit area is generous.
export function Switch({ checked, onChange, label, hint }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 rounded-2xl px-1 py-1 text-left"
    >
      <span>
        <span className="block text-sm text-fg">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <span
        className={cx(
          'relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-200',
          checked ? 'border-accent bg-accent' : 'border-line bg-surface-2'
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-fg transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]',
            checked && 'translate-x-5'
          )}
        />
      </span>
    </button>
  );
}

// A pill-shaped single-choice toggle, e.g. Food / Hardware.
export function Segmented({ value, onChange, options, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-1 rounded-full border border-line bg-surface-2 p-1"
    >
      {options.map(({ id, label: text, icon: Icon }) => {
        const on = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(id)}
            className={cx(
              'inline-flex h-9 items-center gap-2 rounded-full px-4 text-sm font-medium transition duration-200 active:scale-[0.98]',
              on ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg'
            )}
          >
            {Icon && <Icon size={16} weight="regular" aria-hidden />}
            {text}
          </button>
        );
      })}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  'h-11 w-full rounded-full border border-line bg-surface-2 px-4 text-sm text-fg placeholder:text-muted/80 disabled:opacity-60';

export function Chip({ className, children, ...props }) {
  return (
    <span
      {...props}
      className={cx(
        'inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-3 text-sm text-fg',
        className
      )}
    >
      {children}
    </span>
  );
}

export function Skeleton({ className }) {
  return <div className={cx('animate-pulse rounded-xl bg-surface-2 motion-reduce:animate-none', className)} />;
}

export function Panel({ className, children, ...props }) {
  return (
    <div {...props} className={cx('rounded-panel border border-line bg-surface', className)}>
      {children}
    </div>
  );
}

export { cx, Check };
