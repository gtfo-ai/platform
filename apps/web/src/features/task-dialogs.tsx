/**
 * The task page's dialogs (S-23.9b, research/19 § 3.9 and § 5.2 "Task").
 *
 * Every command of the header's `···` menu that takes fields or cannot be undone opens one of these,
 * carrying the fields the page's inline forms had **under the same accessible names** — *Stage*,
 * *Reason*, *Rework instructions*, *Why you are taking it over*, *New cap (USD)*, *Resume at*, *What
 * you did* — so a person, and a test, finds the same control one step further in. A dialog is only
 * ever a human's own action, opened by them; nothing an agent does opens one.
 *
 * **Retry, return-to-stage and rework** share one form state, held by the page
 * ({@link useStageCommandForm}) rather than by a dialog, because a dialog's content unmounts when it
 * closes and two things must outlive it: the stage a person picked (retry, then rework, address the
 * same stage) and an untick of *Attach the gate's last failure*, which is remembered for the gate
 * attempt it was made on and offered ticked again for a later one (WP-152 round 1).
 *
 * The stage list comes from the task's **own** history rather than from the pipeline template: a
 * task that has entered no stage yet is offered none of the three (the menu leaves them out). Each
 * command's required fields are the published ones — `retryStageRequestSchema` takes an optional
 * reason, `returnToStageRequestSchema` requires one, `reworkRequestSchema` requires instructions —
 * so each submit button is disabled until its own contract is satisfiable. A dialog closes when its
 * command was **accepted**; a refusal stays in the dialog, beside the fields that caused it.
 */
import type {
  ApprovalRecord,
  RetryStageResponse,
  TakenOver,
  TaskDetailResponse,
} from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import type { useTakeOverCommands, useTaskCommands } from '../app/queries.js';
import { Dialog } from '../ui/dialog.js';
import { APPROVAL_KIND_LABEL } from '../ui/humanize.js';
import { Button, ErrorNotice, Field, formatUsd } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';
import { HandBackForm, TakeOverForm } from './take-over.js';

/** Which dialog is open — one at a time, held by the page so the callout and the menu share it. */
export type TaskDialog =
  | 'retry'
  | 'return'
  | 'rework'
  | 'cancel'
  | 'take_over'
  | 'hand_back'
  | 'raise_budget'
  | 'approve';

type TaskCommands = ReturnType<typeof useTaskCommands>;
type TakeOverCommands = ReturnType<typeof useTakeOverCommands>;
type GateFeedback = TaskDetailResponse['gate_feedback'];

/**
 * The attached excerpt's size, in the box's own words (WP-152): the characters the run will be given,
 * and — when the gate cut a longer log to fit (WP-81) — how long it was before.
 */
export const gateFeedbackLength = (feedback: NonNullable<GateFeedback>): string =>
  feedback.original_chars === null
    ? `${feedback.chars.toLocaleString('en')} characters`
    : `${feedback.chars.toLocaleString('en')} characters, cut from ${feedback.original_chars.toLocaleString('en')}`;

/**
 * What a retry did, in one sentence (PROGRESS backlog 494).
 *
 * The control used to say nothing on success, which is half of how *"retry během běžícího pokusu
 * se tiše přeskočí"* went unnoticed: the server answered 200 and the screen looked the same. Now
 * the answer names the attempt it entered and, when a run of the stage was still in flight, that
 * the run is being stopped first — the new attempt starts once it has ended.
 */
export const retryOutcomeText = (answer: RetryStageResponse): string => {
  const stage = answer.current_stage ?? 'the stage';
  if (answer.attempt === null) {
    return 'Nothing was re-entered here: the platform re-checks the branch head and re-enters the gate it needs.';
  }
  const queued = `Attempt ${answer.attempt} of ${stage} is queued.`;
  if (answer.stopped_run === null) {
    return queued;
  }
  return answer.stopped_run.command_id === null
    ? `${queued} The run that was still in flight had no live process, so its record was ended.`
    : `${queued} The run still in flight is being stopped; the new attempt starts once it has ended.`;
};

/** The three stage commands' shared fields (see the module note for why the page holds them). */
export const useStageCommandForm = (
  stages: readonly { readonly stage: string }[],
  gateFeedback: GateFeedback,
) => {
  const options = [...new Set(stages.map((entry) => entry.stage))];
  const [stage, setStage] = useState(options[0] ?? '');
  const [reason, setReason] = useState('');
  const [instructions, setInstructions] = useState('');
  // Ticked by default, as the server's own default is (WP-152 ruling (b)) — and ticked again for
  // every new escalation (round 1): an untick is remembered for the gate attempt it was made on, so
  // a later escalation, a different attempt, offers the box ticked rather than inheriting it.
  const feedbackKey =
    gateFeedback === null ? null : `${gateFeedback.stage}#${gateFeedback.attempt}`;
  const [untickedFor, setUntickedFor] = useState<string | null>(null);
  const attachGateFeedback = feedbackKey === null || untickedFor !== feedbackKey;
  return {
    options,
    selected: options.includes(stage) ? stage : (options[0] ?? ''),
    setStage,
    reason,
    setReason,
    instructions,
    setInstructions,
    gateFeedback,
    attachGateFeedback,
    setAttachGateFeedback: (checked: boolean) => {
      setUntickedFor(checked ? null : feedbackKey);
    },
    // Sent only when the box was offered, so a task with nothing to attach sends nothing either.
    attach: gateFeedback === null ? {} : { attachGateFeedback },
  };
};

export type StageCommandForm = ReturnType<typeof useStageCommandForm>;

const INPUT = 'rounded-md border border-line bg-inset px-2 py-1 text-sm';

const StagePicker = ({ form }: { readonly form: StageCommandForm }): ReactElement => (
  // The label beside the select rather than around it, so its name is "Stage" and not the options.
  <div className="flex items-center gap-2 text-xs text-fg-muted">
    <label htmlFor="stage-command">Stage</label>
    <select
      id="stage-command"
      value={form.selected}
      onChange={(event) => {
        form.setStage(event.target.value);
      }}
      className={`${INPUT} text-fg`}
    >
      {form.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  </div>
);

/*
 * WP-152 (PROGRESS backlog 491): out of an escalation at a gate, a return or a rework carries the
 * gate's last failure — on a CI gate, the failing jobs' log excerpts — beside the person's note,
 * unless they untick it. The excerpt is provider output and is never rendered here: the box says
 * how long it is, which is what a person deciding to send it needs.
 */
const GateFeedbackBox = ({ form }: { readonly form: StageCommandForm }): ReactElement | null =>
  form.gateFeedback === null ? null : (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={form.attachGateFeedback}
        onChange={(event) => {
          form.setAttachGateFeedback(event.target.checked);
        }}
      />
      <span>
        Attach the gate’s last failure from <UntrustedText value={form.gateFeedback.stage} /> (
        {gateFeedbackLength(form.gateFeedback)}) to a return or a rework
      </span>
    </label>
  );

const StageRefused = (): ReactElement => <ErrorNotice title="That stage command was refused." />;

const Submit = ({
  label,
  disabled,
  tone = 'primary',
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly tone?: 'primary' | 'danger';
}): ReactElement => (
  <div className="flex justify-end">
    <Button type="submit" tone={tone} disabled={disabled}>
      {label}
    </Button>
  </div>
);

/**
 * **Raise this task's cap** (WP-131 review round 1) — offered on a task its own budget paused, the
 * one way out of that pause: the cap is raised through `POST /api/tasks/:id/budget`, then the task is
 * resumed through the existing resume command. Only a figure above the cap in force is offered; the
 * server refuses the rest (409 `budget_not_raised`) and nothing here lowers a cap.
 */
const RaiseTaskCap = ({
  capUsd,
  commands,
  onDone,
}: {
  readonly capUsd: number;
  readonly commands: TaskCommands;
  readonly onDone: () => void;
}): ReactElement => {
  const [value, setValue] = useState<number | null>(null);
  const valid = value !== null && Number.isFinite(value) && value > capUsd;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted">
        {`This task's cap is ${formatUsd(capUsd)}. Raise it and the task resumes at the stage it stopped at; a run nobody measured stays held at its cap and is never counted as spent.`}
      </p>
      <Field
        label="New cap (USD)"
        hint={`Above ${formatUsd(capUsd)}.`}
        type="number"
        min={capUsd}
        step="any"
        value={value ?? ''}
        onChange={(event) => {
          const parsed = Number.parseFloat(event.target.value);
          setValue(Number.isFinite(parsed) ? parsed : null);
        }}
      />
      <div className="flex justify-end">
        <Button
          tone="primary"
          disabled={!valid || commands.raiseBudget.isPending}
          onClick={() => {
            if (valid) {
              commands.raiseBudget.mutate(value, { onSuccess: onDone });
            }
          }}
        >
          Raise this task's cap
        </Button>
      </div>
      {commands.raiseBudget.isError ? <ErrorNotice title="The cap was not raised." /> : null}
    </div>
  );
};

/** Approve or reject the first pending approval, with an optional reason (the header's primary). */
const ApprovalDecision = ({
  approval,
  commands,
  onDone,
}: {
  readonly approval: ApprovalRecord;
  readonly commands: TaskCommands;
  readonly onDone: () => void;
}): ReactElement => {
  const [reason, setReason] = useState('');
  const decide = (decision: 'approve' | 'reject'): void => {
    commands.decide.mutate(
      {
        approvalId: approval.id,
        decision,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      },
      { onSuccess: onDone },
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <input
        aria-label="Decision reason (optional)"
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
        placeholder="Why (optional, recorded with the decision)"
        className={INPUT}
      />
      <div className="flex justify-end gap-2">
        <Button
          tone="danger"
          disabled={commands.decide.isPending}
          onClick={() => {
            decide('reject');
          }}
        >
          Reject
        </Button>
        <Button
          tone="primary"
          disabled={commands.decide.isPending}
          onClick={() => {
            decide('approve');
          }}
        >
          Approve
        </Button>
      </div>
      {commands.decide.isError ? <ErrorNotice title="That decision was refused." /> : null}
    </div>
  );
};

export const TaskDialogs = ({
  open,
  onOpenChange,
  taskId,
  capUsd,
  takenOver,
  merged,
  approval,
  form,
  commands,
  takeOverCommands,
}: {
  readonly open: TaskDialog | null;
  readonly onOpenChange: (dialog: TaskDialog | null) => void;
  readonly taskId: string;
  readonly capUsd: number;
  readonly takenOver: TakenOver | null;
  readonly merged: boolean;
  /** The pending approval the header's *Approve…* decides — the oldest one. */
  readonly approval: ApprovalRecord | null;
  readonly form: StageCommandForm;
  readonly commands: TaskCommands;
  readonly takeOverCommands: TakeOverCommands;
}): ReactElement => {
  const close = (): void => {
    onOpenChange(null);
  };
  const shown = (dialog: TaskDialog) => ({
    open: open === dialog,
    onOpenChange: (next: boolean) => {
      onOpenChange(next ? dialog : null);
    },
  });
  return (
    <>
      <Dialog
        {...shown('retry')}
        title="Retry a stage"
        description="Runs the stage again, optionally with a reason. It costs a run; a run of the stage still in flight is stopped first."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            commands.retryStage.mutate(
              {
                stage: form.selected,
                ...(form.reason.trim() === '' ? {} : { reason: form.reason }),
              },
              { onSuccess: close },
            );
          }}
        >
          <StagePicker form={form} />
          <input
            aria-label="Reason"
            value={form.reason}
            onChange={(event) => {
              form.setReason(event.target.value);
            }}
            placeholder="Reason (optional)"
            className={INPUT}
          />
          <Submit label="Retry stage" disabled={commands.retryStage.isPending} />
          {commands.retryStage.isError ? <StageRefused /> : null}
        </form>
      </Dialog>

      <Dialog
        {...shown('return')}
        title="Return to a stage"
        description="Sends the task back to a stage it has already run. The stage is given your reason; it costs an iteration of the loop."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            commands.returnToStage.mutate(
              { stage: form.selected, reason: form.reason, ...form.attach },
              {
                onSuccess: () => {
                  form.setReason('');
                  close();
                },
              },
            );
          }}
        >
          <StagePicker form={form} />
          <input
            aria-label="Reason"
            value={form.reason}
            onChange={(event) => {
              form.setReason(event.target.value);
            }}
            placeholder="Reason (required)"
            className={INPUT}
          />
          <GateFeedbackBox form={form} />
          <Submit
            label="Return to stage"
            disabled={commands.returnToStage.isPending || form.reason.trim() === ''}
          />
          {commands.returnToStage.isError ? <StageRefused /> : null}
        </form>
      </Dialog>

      <Dialog
        {...shown('rework')}
        title="Rework from a stage"
        description="Restarts the work from that stage with your instructions, on a new branch; the merge request you rejected is closed."
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            commands.rework.mutate(
              { stage: form.selected, instructions: form.instructions, ...form.attach },
              {
                onSuccess: () => {
                  form.setInstructions('');
                  close();
                },
              },
            );
          }}
        >
          <StagePicker form={form} />
          <input
            aria-label="Rework instructions"
            value={form.instructions}
            onChange={(event) => {
              form.setInstructions(event.target.value);
            }}
            placeholder="What should be reworked?"
            className={INPUT}
          />
          <GateFeedbackBox form={form} />
          <Submit
            label="Rework"
            disabled={commands.rework.isPending || form.instructions.trim() === ''}
          />
          {commands.rework.isError ? <StageRefused /> : null}
        </form>
      </Dialog>

      <Dialog
        {...shown('cancel')}
        title="Cancel this task?"
        description="The task ends and enters no further stage. It cannot be resumed."
        footer={
          <Button
            tone="danger"
            disabled={commands.cancel.isPending}
            onClick={() => {
              commands.cancel.mutate('cancelled from the UI', { onSuccess: close });
            }}
          >
            Cancel task
          </Button>
        }
      >
        {commands.cancel.isError ? <ErrorNotice title="That command was refused." /> : undefined}
      </Dialog>

      <Dialog {...shown('take_over')} title="Take over this task">
        <div className="flex flex-col gap-2">
          <TakeOverForm taskId={taskId} commands={takeOverCommands} onDone={close} />
        </div>
      </Dialog>

      {takenOver === null ? null : (
        <Dialog
          {...shown('hand_back')}
          title="Hand the task back"
          description="The pipeline resumes at the stage you choose, from what is on the branch."
        >
          <HandBackForm
            taskId={taskId}
            takenOver={takenOver}
            merged={merged}
            commands={takeOverCommands}
            onDone={close}
          />
        </Dialog>
      )}

      <Dialog {...shown('raise_budget')} title="Raise this task's cap">
        <RaiseTaskCap capUsd={capUsd} commands={commands} onDone={close} />
      </Dialog>

      {approval === null ? null : (
        <Dialog {...shown('approve')} title={APPROVAL_KIND_LABEL[approval.kind]}>
          <ApprovalDecision approval={approval} commands={commands} onDone={close} />
        </Dialog>
      )}
    </>
  );
};
