/**
 * The *Start a ticket* dialog's **Ticket key** field with suggestions from the project's tracker
 * (`GET /api/projects/:id/ticket-search`).
 *
 * The WAI-ARIA combobox pattern, as the command palette builds it: the field keeps the focus
 * (`role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`,
 * `aria-activedescendant`) and the options are chosen through it.
 *
 *  - Typing asks for suggestions **250 ms** after the last keystroke, from
 *    {@link TICKET_SEARCH_MIN_CHARS} characters; a superseded request is aborted, a repeat is served
 *    from the cache, nothing is retried.
 *  - ↓/↑ move through the list (and open it again); **Enter picks only an active option** — with
 *    none active it submits the form exactly as before, so typing a full key and pressing Enter or
 *    *Start* still starts it. Picking fills the key and closes the list; it never starts anything.
 *  - **Escape closes the list first**: with the list open the field stops the key's propagation, so
 *    the dialog (Base UI listens on the document, in the bubble phase) does not see it — the first
 *    Escape closes the list and the second the dialog.
 *  - A tracker that cannot be searched (no binding, a provider with no search, a failure or a
 *    timeout) is one quiet line under the field; the field is the plain key field it was.
 *
 * Every text an option shows — the key, the summary, the status — is the tracker's, untrusted
 * (BD-022), and rendered through `UntrustedText`.
 */
import type { TicketSearchItem } from '@platform/contracts';
import {
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useState,
} from 'react';
import { TICKET_SEARCH_MIN_CHARS, useTicketSearch } from '../app/queries.js';
import { cx } from '../ui/cx.js';
import { Badge, Field } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** How long after the last keystroke the field asks for suggestions. */
export const TICKET_SEARCH_DEBOUNCE_MS = 250;

/** `value`, once it has stopped changing for `delayMs`. */
const useDebounced = (value: string, delayMs: number): string => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
};

/** Words for a suggestion's status: the tracker's name and whether a start would start work. */
export const startableWords = (item: Pick<TicketSearchItem, 'startable'>): string =>
  item.startable ? 'can start' : 'will not start from this status';

export interface TicketKeyFieldProps {
  readonly projectId: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly hint: string;
  readonly placeholder: string;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}

export const TicketKeyField = ({
  projectId,
  value,
  onChange,
  label,
  hint,
  placeholder,
  inputRef,
}: TicketKeyFieldProps): ReactElement => {
  const listId = useId();
  const optionId = (index: number): string => `${listId}-option-${String(index)}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const query = useDebounced(value, TICKET_SEARCH_DEBOUNCE_MS);
  const search = useTicketSearch(projectId, query);
  const settled = query.trim() === value.trim();
  const items: readonly TicketSearchItem[] =
    settled && search.isSuccess && [...value.trim()].length >= TICKET_SEARCH_MIN_CHARS
      ? search.data.items
      : [];
  const expanded = open && items.length > 0;
  const activeIndex = expanded && active < items.length ? active : -1;

  const close = (): void => {
    setOpen(false);
    setActive(-1);
  };

  const pick = (item: TicketSearchItem): void => {
    onChange(item.ref.key);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      if (!expanded) {
        setOpen(true);
        setActive(event.key === 'ArrowDown' ? 0 : items.length - 1);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + items.length) % items.length);
    } else if (event.key === 'Enter') {
      const item = activeIndex >= 0 ? items[activeIndex] : undefined;
      if (item !== undefined) {
        event.preventDefault();
        pick(item);
      }
      // No active option: the form submits the typed key, as it always did.
    } else if (event.key === 'Escape' && expanded) {
      // The list closes and the dialog stays open: the dialog never sees this Escape.
      event.stopPropagation();
      close();
    }
  };

  const unavailable =
    search.isError && settled && [...value.trim()].length >= TICKET_SEARCH_MIN_CHARS;
  const searching = search.isFetching || !settled;

  return (
    <div className="flex flex-col gap-1">
      <Field
        {...(inputRef === undefined ? {} : { ref: inputRef })}
        label={label}
        hint={hint}
        placeholder={placeholder}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        {...(activeIndex >= 0 ? { 'aria-activedescendant': optionId(activeIndex) } : {})}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
      />
      <p role="status" className="sr-only">
        {expanded
          ? `${String(items.length)} ${items.length === 1 ? 'suggestion' : 'suggestions'}. Use the arrow keys to choose one.`
          : ''}
      </p>
      {unavailable ? (
        <p className="text-xs text-fg-muted" data-ticket-search="unavailable">
          No suggestions from the tracker right now — type the full key.
        </p>
      ) : null}
      <div
        id={listId}
        role="listbox"
        aria-label="Suggested tickets"
        hidden={!expanded}
        className="flex max-h-64 flex-col overflow-y-auto rounded-md border border-line bg-default py-1"
      >
        {expanded
          ? items.map((item, index) => (
              // Chosen through the field (`aria-activedescendant`), so no option takes the focus;
              // `onMouseDown` keeps it in the field so the blur does not close the list first.
              // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard half is the field's onKeyDown.
              <div
                key={item.ref.key}
                id={optionId(index)}
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                data-ticket-option={item.ref.key}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== activeIndex) {
                    setActive(index);
                  }
                }}
                onClick={() => pick(item)}
                className={cx(
                  'flex cursor-pointer items-baseline gap-2 px-2 py-1.5 text-sm',
                  index === activeIndex ? 'bg-subtle' : null,
                )}
              >
                <span className="shrink-0 font-mono text-xs font-semibold">
                  <UntrustedText value={item.ref.key} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <UntrustedText value={item.title} />
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge tone={item.startable ? 'success' : 'neutral'}>
                    <UntrustedText value={item.status} />
                  </Badge>
                  <span className="sr-only">{`, ${startableWords(item)}`}</span>
                  {item.startable ? null : (
                    <span aria-hidden="true" className="text-xs text-fg-muted">
                      won’t start
                    </span>
                  )}
                </span>
              </div>
            ))
          : null}
      </div>
      {searching && !expanded && [...value.trim()].length >= TICKET_SEARCH_MIN_CHARS ? (
        <span className="sr-only">Searching the tracker…</span>
      ) : null}
    </div>
  );
};
