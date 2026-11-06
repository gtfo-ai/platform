/**
 * CheckboxList (S-25.10): **a multiple choice is a list of checkboxes, never a native
 * multi-select.** A `<select multiple>` asks for Cmd/Ctrl-click to add a second value and loses the
 * first on a plain click — the owner met it as *Returned* on the ticket lifecycle. A checkbox is
 * one press per value with the keyboard's own Space, and every value's state is visible at once.
 *
 * - A `<fieldset>` whose `<legend>` is the group's name (a screen reader announces "Returned,
 *   group"), one labelled native checkbox per option, and the count ("2 selected") as a polite live
 *   region the group is described by.
 * - **`max` is enforced at the press**: checking one more than `max` is refused — the box stays
 *   unchecked, `onChange` is not called — and the message says how many may be chosen and what to
 *   do. The boxes are never `disabled` at the limit, because a disabled box leaves the tab order and
 *   a keyboard user would not learn why it was skipped. A `value` already longer than `max` (a
 *   stored list) is shown as it is, with the same message, and a press that clears one is allowed.
 * - The order sent is the options' order, as a native multi-select's `selectedOptions` was; a value
 *   the options do not list is kept, in front, so the list never drops what it cannot show (the
 *   caller says so in words if it matters).
 * - `invalid` marks every box `aria-invalid` (a `group` may not carry the attribute; a `checkbox`
 *   may) and draws the danger edge.
 *
 * The box is drawn as a `Select` is — the card ground (`bg-default`) inside the input edge — and the
 * checkboxes take the brand accent from `styles.css` (`accent-color`).
 */
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { cx } from './cx.js';

export interface CheckboxListOption {
  readonly value: string;
  /** Plain text: a caller with provider text sanitises it first, as for an `<option>`. */
  readonly label: string;
}

export interface CheckboxListProps {
  readonly legend: string;
  readonly options: readonly CheckboxListOption[];
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  /** At most this many may be checked; one more press is refused with a message. */
  readonly max?: number;
  /** A sentence under the list. */
  readonly hint?: ReactNode;
  readonly invalid?: boolean;
  readonly className?: string;
  /** Anything that follows the list inside the group (a refusal's sentences). */
  readonly children?: ReactNode;
  /** Passed to the fieldset, so a caller can find the group (`data-lifecycle-slot`). */
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}

/** `value` with `option` checked or cleared, in the options' order, unknown values kept in front. */
export const toggledValue = (
  options: readonly CheckboxListOption[],
  value: readonly string[],
  option: string,
  checked: boolean,
): string[] => {
  const listed = new Set(options.map((entry) => entry.value));
  const next = new Set(value);
  if (checked) {
    next.add(option);
  } else {
    next.delete(option);
  }
  return [
    ...value.filter((entry) => !listed.has(entry) && next.has(entry)),
    ...options.map((entry) => entry.value).filter((entry) => next.has(entry)),
  ];
};

export const CheckboxList = ({
  legend,
  options,
  value,
  onChange,
  max,
  hint,
  invalid = false,
  className,
  children,
  data,
}: CheckboxListProps): ReactElement => {
  const id = useId();
  const [refused, setRefused] = useState(false);
  const checked = new Set(value);
  const over = max !== undefined && value.length > max;
  const countId = `${id}-count`;
  const hintId = `${id}-hint`;
  const describedBy = [countId, hint === undefined ? null : hintId].filter(Boolean).join(' ');
  return (
    <fieldset
      {...data}
      aria-describedby={describedBy}
      className={cx('flex min-w-0 flex-col gap-1', className)}
    >
      <legend className="text-sm font-medium">{legend}</legend>
      <div
        className={cx(
          'flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-md border bg-default px-2 py-1.5',
          invalid ? 'border-danger' : 'border-line-input',
        )}
      >
        {options.map((option) => (
          <label
            key={option.value}
            className="flex items-center gap-2 rounded-sm px-1 py-0.5 text-sm hover:bg-subtle"
          >
            <input
              type="checkbox"
              value={option.value}
              checked={checked.has(option.value)}
              {...(invalid ? { 'aria-invalid': true } : {})}
              onChange={(event) => {
                const press = event.target.checked;
                if (press && max !== undefined && value.length >= max) {
                  setRefused(true);
                  return;
                }
                setRefused(false);
                onChange(toggledValue(options, value, option.value, press));
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
      <p id={countId} aria-live="polite" className="text-xs text-fg-muted" data-checkbox-count="">
        {value.length} selected{max === undefined ? '' : ` of at most ${max}`}
      </p>
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-fg-muted">
          {hint}
        </p>
      )}
      {refused || over ? (
        <p role="alert" className="text-xs text-danger">
          {`At most ${max} can be selected. Clear one to select another.`}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
};
