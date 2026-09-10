/**
 * The small component set every screen is built from.
 *
 * Hand-written on plain elements rather than vendored from shadcn/ui: TD-013 names shadcn on Base
 * UI, and Base UI's only published version today is `1.0.0-rc.0`. Taking a release candidate as
 * the foundation of every screen is a dependency decision with a blast radius, and it is not one a
 * foundation work package should make quietly — so the primitives here are deliberately thin
 * (a class name and the right element), the APG behaviours they need are native, and swapping any
 * one of them for its Base UI equivalent is a change inside this file. Recorded as follow-up and
 * as Q46.
 *
 * Everything that displays text a human did not write goes through `untrusted.tsx`, never through
 * these.
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import { UntrustedText } from './untrusted.js';

export const cx = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter((part) => typeof part === 'string' && part !== '').join(' ');

// ── Button ───────────────────────────────────────────────────────────────────

export type ButtonTone = 'default' | 'primary' | 'danger' | 'ghost';

const BUTTON_TONES: Record<ButtonTone, string> = {
  default: 'bg-surface text-fg border-line hover:bg-surface-muted',
  primary: 'bg-accent text-accent-fg border-transparent hover:opacity-90',
  danger: 'bg-danger text-white border-transparent hover:opacity-90',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-surface-muted',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone;
}

export const Button = ({ tone = 'default', className, ...rest }: ButtonProps): ReactElement => (
  <button
    // An explicit `type` on every button: the default inside a form is `submit`, which is how a
    // "cancel" button comes to submit the form it sits in.
    type="button"
    className={cx(
      'inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      'disabled:cursor-not-allowed disabled:opacity-50',
      BUTTON_TONES[tone],
      className,
    )}
    {...rest}
  />
);

// ── Surfaces ─────────────────────────────────────────────────────────────────

export const Card = ({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): ReactElement => (
  <div className={cx('rounded-lg border border-line bg-surface p-4', className)}>{children}</div>
);

export const SectionHeading = ({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}): ReactElement => (
  <div className="flex items-baseline justify-between gap-4 pb-3">
    <h2 className="text-sm font-semibold tracking-wide text-fg-muted uppercase">{children}</h2>
    {actions}
  </div>
);

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-muted text-fg-muted',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/20 text-warning',
  danger: 'bg-danger/15 text-danger',
};

export const Badge = ({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone;
}): ReactElement => (
  <span
    className={cx(
      'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
      BADGE_TONES[tone],
    )}
  >
    {children}
  </span>
);

// ── Form fields ──────────────────────────────────────────────────────────────

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly hint?: string;
}

export const Field = ({ label, hint, id, ...rest }: FieldProps): ReactElement => {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={inputId}
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        {...(hint === undefined ? {} : { 'aria-describedby': hintId })}
        {...rest}
      />
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
    </div>
  );
};

// ── States ───────────────────────────────────────────────────────────────────

/**
 * product/10: "Empty states teach." An empty board explains how tasks get picked up; an empty
 * inbox says what will appear there. Every one of these takes a `hint`, and none of them is a
 * shrug.
 */
export const EmptyState = ({
  title,
  hint,
  action,
}: {
  readonly title: string;
  readonly hint: string;
  readonly action?: ReactNode;
}): ReactElement => (
  <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-line p-6">
    <p className="text-sm font-medium">{title}</p>
    <p className="max-w-prose text-sm text-fg-muted">{hint}</p>
    {action}
  </div>
);

export const Loading = ({ label }: { readonly label: string }): ReactElement => (
  <p role="status" aria-live="polite" className="p-4 text-sm text-fg-muted">
    {label}
  </p>
);

/**
 * A failure, shown as text.
 *
 * The message comes from the server (`ApiError.message`), and a 400's `details` can quote a value
 * the caller sent, so both halves go through `UntrustedText` like anything else the platform did
 * not author. `role="alert"` announces it once, which is what a screen reader user needs from a
 * failure that appears without them doing anything.
 */
export const ErrorNotice = ({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail?: string;
}): ReactElement => (
  <div role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm">
    <p className="font-medium">
      <UntrustedText value={title} />
    </p>
    {detail === undefined ? null : (
      <p className="pt-1 text-fg-muted">
        <UntrustedText value={detail} />
      </p>
    )}
  </div>
);

// ── Metric ───────────────────────────────────────────────────────────────────

/**
 * product/10: "Every number shown has a tooltip with its definition."
 *
 * The definition is attached with `aria-describedby` as well as `title`, so it reaches a screen
 * reader and a keyboard user rather than only a mouse.
 */
export const Metric = ({
  label,
  value,
  definition,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly definition: string;
}): ReactElement => {
  const id = useId();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-fg-muted" title={definition} aria-describedby={id}>
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span id={id} hidden>
        {definition}
      </span>
    </div>
  );
};

// ── Formatting (Intl only; English-only strings, technical/09) ───────────────

export const formatUsd = (value: number): string =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(value);

export const formatInteger = (value: number): string => new Intl.NumberFormat('en').format(value);

export const formatDateTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
};

/** Elapsed time as a compact human string. `now` is a parameter: a component must not read a clock. */
export const formatElapsed = (fromIso: string | null | undefined, nowMs: number): string => {
  if (fromIso === null || fromIso === undefined) {
    return '—';
  }
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) {
    return '—';
  }
  const seconds = Math.max(0, Math.round((nowMs - from) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};
