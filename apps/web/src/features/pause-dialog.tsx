/**
 * **Pause, with an optional why** (S-25.23, BACKLOG 1375) — the one dialog the task header's and the
 * board card's *Pause* open. It asks *Why are you pausing it? — optional*, and what the person types
 * is the reason the pause command records (redacted by the command, TD-012), which the paused notice
 * (`./task-callout.tsx`, S-25.20) then shows as *Why: …*. Blank sends **no** reason: the buttons
 * used to send the fixed *paused from the UI*, which is no reason a person gave and which the notice
 * still leaves out for a task paused before this dialog existed.
 *
 * It is not a confirmation of something destructive — a pause is undone by *Resume* — so its act is
 * the plain primary *Pause*, not `ConfirmDialog`'s danger button. A refusal stays in the dialog with
 * the server's reason; the dialog closes when the caller says the command was accepted.
 */
import { MAX_TASK_PAUSE_REASON_CHARS } from '@platform/contracts';
import { type ReactElement, useId, useState } from 'react';
import { Dialog } from '../ui/dialog.js';
import { Button, ErrorNotice } from '../ui/kit.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';

/** The field's label, which is also its accessible name. */
export const PAUSE_REASON_LABEL = 'Why are you pausing it? — optional';

/** The reason the command is sent: the typed words, or `null` for none (blank sends nothing). */
export const pauseReasonOf = (typed: string): string | null =>
  typed.trim() === '' ? null : typed.trim();

export const PauseDialog = ({
  ticketKey,
  pending,
  error,
  onClose,
  onPause,
}: {
  /** The ticket key, for the title; `null` says *this task*. */
  readonly ticketKey: string | null;
  readonly pending: boolean;
  /** The last refusal, shown with its reason; `null` while there is none. */
  readonly error: unknown;
  readonly onClose: () => void;
  readonly onPause: (reason: string | null) => void;
}): ReactElement => {
  const [text, setText] = useState('');
  const fieldId = useId();
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      title={ticketKey === null ? 'Pause this task' : `Pause ${sanitiseUntrusted(ticketKey)}`}
      description="Nothing more runs until it is resumed; it then goes on at the stage it stopped at, with no round used. A run already in flight finishes and is recorded."
      footer={
        <>
          <Button onClick={onClose}>Keep it running</Button>
          <Button
            tone="primary"
            disabled={pending}
            data-pause-act=""
            onClick={() => {
              onPause(pauseReasonOf(text));
            }}
          >
            Pause
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-sm font-medium">
            {PAUSE_REASON_LABEL}
          </label>
          <textarea
            id={fieldId}
            value={text}
            rows={3}
            maxLength={MAX_TASK_PAUSE_REASON_CHARS}
            onChange={(event) => {
              setText(event.target.value);
            }}
            placeholder="Shown on the task while it is paused"
            className="rounded-md border border-line-input bg-inset px-2 py-1 text-sm text-fg placeholder:text-fg-subtle"
          />
        </div>
        {error === null || error === undefined ? null : (
          <ErrorNotice title="The task was not paused." error={error} />
        )}
      </div>
    </Dialog>
  );
};
