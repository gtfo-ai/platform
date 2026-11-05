/**
 * CopyField: a value to paste somewhere else — a webhook URL, a branch, a resume command
 * (Primer's ClipboardCopy).
 *
 * A read-only text field (so the value can still be selected by hand when the clipboard is refused)
 * and a copy button named after the field. The outcome is announced through a polite status, and a
 * refusal says what to do instead of failing silently. The value is shown as a field's value — text,
 * never markup — so an untrusted one is safe here.
 */
import { CheckIcon } from '@primer/octicons-react/CheckIcon';
import { CopyIcon } from '@primer/octicons-react/CopyIcon';
import { type ReactElement, useId, useState } from 'react';
import { IconButton } from './button.js';
import { cx, FOCUS_RING } from './cx.js';

type Outcome = 'idle' | 'copied' | 'failed';

const defaultWriteText = async (text: string): Promise<void> => {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) {
    throw new Error('the clipboard is not available here');
  }
  await clipboard.writeText(text);
};

export const CopyField = ({
  label,
  value,
  writeText = defaultWriteText,
  className,
}: {
  readonly label: string;
  readonly value: string;
  /** The clipboard; injectable so a test can refuse it. */
  readonly writeText?: (text: string) => Promise<void>;
  readonly className?: string;
}): ReactElement => {
  const id = useId();
  const [outcome, setOutcome] = useState<Outcome>('idle');
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-stretch gap-1">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(event) => {
            event.currentTarget.select();
          }}
          className={cx(
            'min-w-0 flex-1 rounded-md border border-line-input bg-inset px-3 py-1.5 font-mono text-xs text-fg',
            FOCUS_RING,
          )}
        />
        <IconButton
          aria-label={`Copy ${label}`}
          tone="default"
          icon={outcome === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
          onClick={() => {
            writeText(value).then(
              () => {
                setOutcome('copied');
              },
              () => {
                setOutcome('failed');
              },
            );
          }}
        />
      </div>
      <span role="status" aria-live="polite" className="text-xs text-fg-muted">
        {outcome === 'copied' ? 'Copied.' : null}
        {outcome === 'failed' ? 'Could not copy — select the text and copy it by hand.' : null}
      </span>
    </div>
  );
};
