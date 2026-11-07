/**
 * ConfirmDialog — the one shape a destructive action asks with (S-23.23, the UX audit's item 8;
 * research/19 § 3.9): a title naming the act, **one consequence sentence** saying what happens and
 * whether it can be undone, an optional reason field, and two buttons — *Keep* (default, focused
 * last so Escape and a stray Enter do nothing destructive) and the act itself, in `danger`.
 *
 * It is `Dialog` underneath, so it is modal, focus-trapped, dismissed by Escape and the close
 * button, and returns focus to what opened it. A refusal stays **in** the dialog, beside the field
 * that caused it, with the server's reason (`error`); the dialog closes only when the caller says
 * the command was accepted (`onOpenChange(false)` from its own `onSuccess`).
 *
 * The reason a person types is recorded with the decision (approval rejects, knowledge rejects,
 * breakdown rejects) — it is theirs, sent as typed, and `required` disables the act until it is not
 * blank, the way the commands' published schemas require it.
 */
import { type ReactElement, type ReactNode, useId, useState } from 'react';
import { Button } from './button.js';
import { Dialog } from './dialog.js';
import { ErrorNotice } from './kit.js';

export interface ConfirmReason {
  /** The field's visible label, which is also its accessible name. */
  readonly label: string;
  readonly placeholder?: string;
  /** Whether the act needs a non-blank reason (the command's own contract). */
  readonly required?: boolean;
  /** The command's own bound on the reason, so the field cannot send what it would refuse. */
  readonly maxLength?: number;
}

export const ConfirmDialog = ({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel,
  keepLabel = 'Keep it',
  reason,
  pending = false,
  error,
  errorTitle = 'That was refused.',
  errorDetail,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The act, as a question: "Reject this plan?". */
  readonly title: string;
  /**
   * One sentence: what happens, and whether it can be undone. A node when part of it is somebody
   * else's text, rendered through `UntrustedText` (S-26.8b's tracker assignee).
   */
  readonly consequence: ReactNode;
  /** The act's own verb: "Reject", "Replace the classes". */
  readonly confirmLabel: string;
  readonly keepLabel?: string;
  readonly reason?: ConfirmReason;
  readonly pending?: boolean;
  /** The last refusal, shown with its reason; `undefined` or `null` while there is none. */
  readonly error?: unknown;
  readonly errorTitle?: string;
  /** The refusal in the screen's own words, when it has them; else `errorSentence`'s. */
  readonly errorDetail?: string | undefined;
  /** The typed reason, trimmed (empty when there is no field or nothing was typed). */
  readonly onConfirm: (reason: string) => void;
}): ReactElement => {
  const [text, setText] = useState('');
  const fieldId = useId();
  const trimmed = text.trim();
  const blocked = pending || (reason?.required === true && trimmed === '');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setText('');
        }
        onOpenChange(next);
      }}
      title={title}
      description={consequence}
      footer={
        <>
          <Button
            onClick={() => {
              setText('');
              onOpenChange(false);
            }}
          >
            {keepLabel}
          </Button>
          <Button
            tone="danger"
            disabled={blocked}
            data-confirm-act=""
            onClick={() => {
              onConfirm(trimmed);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {reason === undefined && (error === undefined || error === null) ? undefined : (
        <div className="flex flex-col gap-2">
          {reason === undefined ? null : (
            <div className="flex flex-col gap-1">
              <label htmlFor={fieldId} className="text-sm font-medium">
                {reason.label}
              </label>
              <textarea
                id={fieldId}
                value={text}
                rows={3}
                onChange={(event) => {
                  setText(event.target.value);
                }}
                {...(reason.placeholder === undefined ? {} : { placeholder: reason.placeholder })}
                {...(reason.maxLength === undefined ? {} : { maxLength: reason.maxLength })}
                className="rounded-md border border-line-input bg-inset px-2 py-1 text-sm text-fg placeholder:text-fg-subtle"
              />
            </div>
          )}
          {error === undefined || error === null ? null : (
            <ErrorNotice
              title={errorTitle}
              error={error}
              {...(errorDetail === undefined ? {} : { detail: errorDetail })}
            />
          )}
        </div>
      )}
    </Dialog>
  );
};
