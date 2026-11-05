/**
 * The small component set every screen is built from — the API every screen imports, now drawn in
 * TD-033's visual language.
 *
 * Until TD-033 these were hand-written on plain elements because Base UI had only a release
 * candidate (Q46). It is at 1.9 now and TD-033 adopted it for the five behaviours that need real
 * APG work (menu, dialog, tooltip, popover, tabs); those and the rest of the primitive kit live
 * one per file beside this one (`button.tsx`, `status.tsx`, `action-menu.tsx`, …). This module keeps
 * the names the screens already use and re-implements them on that kit, so no screen import broke:
 * `Button` maps its old `ghost` tone onto `invisible`, `Card` is GitHub's Box, `EmptyState` is a
 * `Blankslate`, `ErrorNotice` a danger `Flash` and `Metric`'s definition a `Tooltip`.
 *
 * Everything that displays text a human did not write goes through `untrusted.tsx`, never through
 * these.
 */
import type { InputHTMLAttributes, ReactElement, ReactNode, Ref } from 'react';
import { useId } from 'react';
import { PlatformUpdatedError } from '../api/http.js';
import { Blankslate } from './blankslate.js';
import {
  Button as PrimitiveButton,
  type ButtonProps as PrimitiveButtonProps,
  type ButtonTone as PrimitiveButtonTone,
} from './button.js';
import { cx, FOCUS_RING } from './cx.js';
import { Flash } from './flash.js';
import { Tooltip } from './tooltip.js';
import { UntrustedText } from './untrusted.js';

export { cx } from './cx.js';

// ── Button ───────────────────────────────────────────────────────────────────

/** `ghost` is the pre-TD-033 name of `invisible`, kept so no call site had to change. */
export type ButtonTone = PrimitiveButtonTone | 'ghost';

export interface ButtonProps extends Omit<PrimitiveButtonProps, 'tone'> {
  readonly tone?: ButtonTone;
}

export const Button = ({ tone = 'default', ...rest }: ButtonProps): ReactElement => (
  <PrimitiveButton tone={tone === 'ghost' ? 'invisible' : tone} {...rest} />
);

// ── Surfaces ─────────────────────────────────────────────────────────────────

/**
 * GitHub's Box: a quiet border, 6 px radius (`rounded-lg`, which `styles.css` sets to Primer's 6 px),
 * the page's own ground. `header` is the subtle row on
 * top (a title, counts, actions); without it the box is the plain bordered card every screen used.
 */
export const Card = ({
  children,
  className,
  header,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly header?: ReactNode;
}): ReactElement =>
  header === undefined ? (
    <div className={cx('rounded-lg border border-line bg-default p-4', className)}>{children}</div>
  ) : (
    <div className="overflow-hidden rounded-lg border border-line bg-default">
      <div className="flex min-h-11 items-center gap-3 border-b border-line bg-subtle px-4 py-2 text-sm font-semibold">
        {header}
      </div>
      <div className={cx('p-4', className)}>{children}</div>
    </div>
  );

export const SectionHeading = ({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}): ReactElement => (
  <div className="flex items-center justify-between gap-4 pb-2">
    <h2 className="text-base font-semibold text-fg">{children}</h2>
    {actions}
  </div>
);

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** A Primer Label: an outlined pill whose word carries the meaning, the tint only reinforces it. */
const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line text-fg-muted',
  accent: 'border-link/50 text-link',
  success: 'border-success/50 bg-success-bg text-success',
  warning: 'border-attention/50 bg-attention-bg text-attention',
  danger: 'border-danger/50 bg-danger-bg text-danger',
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
      'inline-flex items-center rounded-full border px-2 py-px text-xs leading-[1.125rem] font-medium whitespace-nowrap',
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
  /** The input's ref (React 19 passes it as a prop; it reaches the `<input>` with the rest). */
  readonly ref?: Ref<HTMLInputElement>;
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
        className={cx(
          'h-8 rounded-md border border-line-input bg-inset px-3 text-sm text-fg placeholder:text-fg-subtle',
          FOCUS_RING,
        )}
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
}): ReactElement =>
  action === undefined ? (
    <Blankslate informational title={title} hint={hint} />
  ) : (
    <Blankslate title={title} hint={hint} action={action} />
  );

export const Loading = ({ label }: { readonly label: string }): ReactElement => (
  <p role="status" aria-live="polite" className="py-3 text-sm text-fg-muted">
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
 *
 * **A screen passes the error itself** (`error`), and its text is the detail unless `detail` says
 * otherwise. **A read refused because the server was upgraded under this tab renders nothing here**
 * (WP-154 (d), PROGRESS backlog 487): the shell's banner already says it once for the whole page, so
 * the screen shows no schema error and no second copy of the reload instruction per section. That
 * is decided **by the error's type** — `error instanceof PlatformUpdatedError`, which only the API
 * client throws after `/api/version` named a different build — and never by its text (WP-167
 * ruling (b), backlog 524): until WP-167 the notice was hidden when its title or detail *contained*
 * the platform sentence, so an `ApiError` whose server-written message carried those words hid
 * itself. A screen that passes no `error` is never hidden; `apps/web/src/error-notice-census.test.ts`
 * refuses `String(…)` in a `title` or `detail` attribute, the spelling that used to stand in for it.
 */
export const ErrorNotice = ({
  title,
  detail,
  error,
}: {
  readonly title: string;
  readonly detail?: string;
  /** The failure itself: its text is the default detail, and its type decides whether to hide. */
  readonly error?: unknown;
}): ReactElement | null => {
  if (error instanceof PlatformUpdatedError) {
    return null;
  }
  const text = detail ?? (error === undefined ? undefined : String(error));
  return (
    <Flash tone="danger" live="alert" title={<UntrustedText value={title} />}>
      {text === undefined ? undefined : (
        <p>
          <UntrustedText value={text} />
        </p>
      )}
    </Flash>
  );
};

// ── Metric ───────────────────────────────────────────────────────────────────

/**
 * product/10: "Every number shown has a tooltip with its definition."
 *
 * The label is the trigger of a Base UI `Tooltip` (TD-033 § 5), so the definition opens on hover
 * **and on keyboard focus** — the old `title=` reached neither a keyboard nor a touch screen. It is
 * also attached with `aria-describedby` to a hidden node, because Base UI does not tie a tooltip to
 * its trigger for assistive tech, and a definition a screen reader cannot reach is not a definition.
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
      <Tooltip content={definition}>
        {/* A focusable span, not a button: the label opens a definition, it performs nothing. */}
        <span
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a tooltip trigger must be reachable by Tab, or the definition is mouse-only.
          tabIndex={0}
          aria-describedby={id}
          className={cx(
            'w-fit rounded-sm text-xs text-fg-muted underline decoration-fg-subtle decoration-dotted underline-offset-4 hover:text-fg',
            FOCUS_RING,
          )}
        >
          {label}
        </span>
      </Tooltip>
      <span className="text-xl font-semibold tabular-nums">{value}</span>
      <span id={id} hidden>
        {definition}
      </span>
    </div>
  );
};

// ── Formatting (Intl only; English-only strings, technical/09) ───────────────

export const formatUsd = (value: number): string =>
  new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(value);

/** What a screen prints for a run nobody measured (`RunRecord.cost` is `null`, WP-119). */
export const NOT_MEASURED = 'not measured';

/**
 * A run's cost, or {@link NOT_MEASURED} when nothing measured it — never `$0.00`, which reads as a
 * free run (standing rule 16). `estimate` appends `est.` to a figure the price list produced.
 */
export const formatRunCost = (
  cost: { readonly usd: number; readonly is_estimate: boolean } | null,
  options: { readonly estimate?: boolean } = {},
): string => {
  if (cost === null) {
    return NOT_MEASURED;
  }
  const figure = formatUsd(cost.usd);
  return options.estimate === true && cost.is_estimate ? `${figure} est.` : figure;
};

export const formatInteger = (value: number): string => new Intl.NumberFormat('en').format(value);

export const formatDateTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
};

/**
 * Human minutes as `"2 h 15 m"` — product/19 §16's unit, product/09:29's *"shown next to"* (WP-29).
 *
 * Minutes rather than a duration between two instants, because that is what `human_time_entries`
 * stores: the caps and the excluded gaps have already been applied, so there is no interval left to
 * derive. Below an hour it prints minutes alone, and a measured zero prints `"0 m"` rather than an
 * em dash — a review window the platform measured at zero length is a different fact from a task
 * nobody has touched, and the caller decides which it is showing.
 */
export const formatMinutes = (value: number): string => {
  const total = Math.max(0, Math.round(value));
  const hours = Math.floor(total / 60);
  return hours === 0 ? `${total} m` : `${hours} h ${total % 60} m`;
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
