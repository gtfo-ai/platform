/**
 * Select (S-25.10, TD-033 decisions 2 and 5): **the native `<select>`, drawn in the brand.**
 *
 * The owner, on project Settings → Ticket lifecycle: "the selectboxes use the native `<select>`
 * without proper styling". The element stays the browser's — its keyboard, its screen-reader
 * semantics (role `combobox`, the options' names), the picker a phone opens and the type-to-find
 * are all native — and only its box is ours:
 *
 * - `appearance-none` removes the operating system's arrow and bevel, so the field takes the card
 *   ground (`bg-default`), the input edge (`border-line-input`, held to 3:1 by `contrast.test.ts`
 *   and `form-edge-census.test.ts`), the 6 px radius and the one `FOCUS_RING`;
 * - the arrow is an Octicon (`ChevronDownIcon`, already in `ui/` for the NavList, so it costs the
 *   worker entry nothing) placed over the right padding with `pointer-events: none`, so a press on
 *   it is a press on the select;
 * - **no `style=` and no CSS `background-image` data URI** — the production policy is
 *   `style-src 'self'` and `img-src 'self'` (`apps/server/src/web/csp.ts`), and the chevron as an
 *   element needs neither.
 *
 * Not Base UI's Select (decided in the slice's brief): its popup would be a positioned listbox in
 * the initial graph (BACKLOG 1240), and a phone's own picker is better than any we could draw.
 *
 * `className` is the **wrapper's** — width and alignment (`max-w-56`, `self-start`, `w-full`) —
 * because the wrapper is what a layout places; the field fills it. `multiple` is not offered: a
 * native multi-select needs Cmd/Ctrl-click, so a multiple choice is a `CheckboxList`
 * (`checkbox-list.tsx`). `invalid` draws the danger edge and sets `aria-invalid`, and sets nothing
 * when false, so "not refused" is the attribute's absence rather than `aria-invalid="false"`.
 *
 * `apps/web/src/select-census.test.ts` refuses a raw `<select>` anywhere in `apps/web/src` outside
 * this file (the worker's local page, `worker/`, is its own session's).
 */
import { ChevronDownIcon } from '@primer/octicons-react/ChevronDownIcon';
import type { ReactElement, Ref, SelectHTMLAttributes } from 'react';
import { cx, FOCUS_RING } from './cx.js';

export type SelectSize = 'sm' | 'md';

const SIZES: Record<SelectSize, string> = {
  sm: 'h-7 text-sm',
  md: 'h-8 text-sm',
};

/** The field's own classes, exported for the census and the test (the one place they are written). */
export const SELECT_FIELD = cx(
  'w-full min-w-0 appearance-none rounded-md border bg-default py-0 pr-8 pl-2 text-fg',
  'disabled:cursor-not-allowed',
  FOCUS_RING,
);

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> {
  /** `sm` for a toolbar's filter (the board's), `md` for a form's field. */
  readonly controlSize?: SelectSize;
  /** A refused value: the danger edge and `aria-invalid="true"`. */
  readonly invalid?: boolean;
  /** React 19 passes a ref as a prop; it reaches the `<select>`. */
  readonly ref?: Ref<HTMLSelectElement>;
}

export const Select = ({
  controlSize = 'md',
  invalid = false,
  className,
  children,
  ...rest
}: SelectProps): ReactElement => (
  <span data-select="" className={cx('relative inline-flex has-[:disabled]:opacity-50', className)}>
    <select
      {...rest}
      {...(invalid ? { 'aria-invalid': true } : {})}
      className={cx(
        SELECT_FIELD,
        SIZES[controlSize],
        invalid ? 'border-danger' : 'border-line-input',
      )}
    >
      {children}
    </select>
    <span
      aria-hidden="true"
      data-select-chevron=""
      className="pointer-events-none absolute inset-y-0 right-2 inline-flex items-center text-fg-muted"
    >
      <ChevronDownIcon size={16} />
    </span>
  </span>
);
