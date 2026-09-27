/**
 * Take over and hand back — product/19 §19 on the task and run screens (WP-44, PROGRESS backlog 70
 * and 68).
 *
 * WP-27 built both routes and published everything a screen needed: `takeOverResponseSchema` carries
 * the branch, the session, the resume lines and what became of the workspace, and
 * `taskDetailResponseSchema.taken_over` carries the take-over in force. Until this file nothing
 * called either route, so the product's answer to *"the agent is stuck, let me finish it"* was an
 * HTTP request an operator wrote by hand. This is the screen half.
 *
 * ## What it renders
 *
 * - **Before a take-over**: one form — an optional reason and the optional tarball — and, once the
 *   command answers, **the four fields the response carries**, as the response said them: the
 *   branch, the session `claude --resume` continues (or that there was none), the resume lines, and
 *   the workspace's fate in its own tense (`requested` is "being committed and pushed as the run
 *   winds down", never "done").
 * - **While a take-over is in force** (`taken_over`, which since WP-44 follows the workpad's rule and
 *   survives an escalation): the same lines, the two downloads a person takes to their own machine,
 *   and the hand-back control. Its stage picker is `hand_back_stages` — the task's **compiled**
 *   pipeline, enabled stages only, computed by the server exactly as the hand-back route checks it
 *   — so it offers nothing the route would refuse with `409 stage_not_in_template`.
 *
 * ## What it does not do
 *
 * It does not decide who may press the buttons: take-over and hand-back are `member` and the server
 * answers 403 to anybody less, which the error line says. And it does not know *which* run a
 * take-over interrupted — the event does not record one — so the downloads name the newest run
 * that had started by the take-over's instant, which is the run the take-over stopped whenever
 * there was one. A take-over with no live run exported nothing, and the tarball link then answers
 * 404 with a sentence saying so.
 *
 * Every string a provider or a person chose — the branch, the session, the ticket in a resume line —
 * is rendered as text (BD-022). The two downloads are same-origin paths composed here and rendered
 * through `ui/untrusted.tsx`'s `DownloadLink`, the one module that may write a URL attribute.
 */
import type { RunRecord, TakenOver, TakeOverResponse, TaskState } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import { exportDownloadPath, transcriptDownloadPath } from '../api/endpoints.js';
import { useTakeOverCommands } from '../app/queries.js';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  formatDateTime,
  SectionHeading,
} from '../ui/kit.js';
import { CodeText, DownloadLink, UntrustedText } from '../ui/untrusted.js';

/** States in which there is nothing left to take over. */
const FINISHED: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'cancelled']);

/**
 * The run a take-over interrupted, as far as the record allows: the newest run of the task that
 * had **started** by the take-over's instant. `null` for a take-over before any run started.
 */
export const interruptedRunOf = (
  runs: readonly Pick<RunRecord, 'id' | 'started_at'>[],
  at: string,
): string | null => {
  const atMs = Date.parse(at);
  let best: { readonly id: string; readonly started: number } | null = null;
  for (const run of runs) {
    if (run.started_at === null || run.started_at === undefined) {
      continue;
    }
    const started = Date.parse(run.started_at);
    if (started <= atMs && (best === null || started > best.started)) {
      best = { id: run.id, started };
    }
  }
  return best?.id ?? null;
};

/** `workspace_export`, said in the tense the route means it (standing rule 18). */
export const workspaceExportText = (value: TakeOverResponse['workspace_export']): string =>
  value === 'requested'
    ? 'A run was in flight: its workspace is being committed as a work-in-progress hand-over commit, pushed to the branch and — if you asked — archived, as the run winds down. It is requested, not finished.'
    : 'No run was in flight in the process that answered, so nothing was exported: the branch holds whatever the last run pushed.';

/** The branch, the session and the resume lines — the same shape whichever surface answered. */
const ResumeLines = ({
  branch,
  sessionId,
  commands,
}: {
  readonly branch: string;
  readonly sessionId: string | null;
  readonly commands: readonly string[];
}): ReactElement => (
  <div className="flex flex-col gap-1 text-xs">
    <p>
      Branch: <UntrustedText className="font-mono" value={branch} />
    </p>
    <p>
      Session:{' '}
      {sessionId === null ? (
        <span className="text-fg-muted">
          none — the interrupted run had no session, so there is nothing for claude --resume to
          continue
        </span>
      ) : (
        <UntrustedText className="font-mono" value={sessionId} />
      )}
    </p>
    <CodeText value={commands.join('\n')} />
  </div>
);

/**
 * Which run's files the panel offers (WP-73, PROGRESS backlog 203): the run `task.taken_over`
 * recorded when it did, and only for an event from before WP-73 the inference
 * {@link interruptedRunOf} — which then says it is one, because on a take-over with no live run it
 * names an earlier, finished run the take-over never interrupted.
 */
export const takeOverRunOf = (
  takenOver: Pick<TakenOver, 'at' | 'run_id' | 'run_recorded'>,
  runs: readonly Pick<RunRecord, 'id' | 'started_at'>[],
): { readonly runId: string | null; readonly inferred: boolean } =>
  takenOver.run_recorded
    ? { runId: takenOver.run_id, inferred: false }
    : { runId: interruptedRunOf(runs, takenOver.at), inferred: true };

/** The two files a take-over hands a person (WP-44, Q93). */
export const TakeOverDownloads = ({
  runId,
  inferred,
}: {
  readonly runId: string | null;
  readonly inferred: boolean;
}): ReactElement =>
  runId === null ? (
    <p className="text-xs text-fg-muted">
      {inferred
        ? 'No run had started when the task was taken over, so there is no transcript or workspace to download — the branch is where the work is.'
        : 'No run was live when the task was taken over, so nothing was exported and there is no transcript or workspace to download — the branch is where the work is.'}
    </p>
  ) : (
    <div className="flex flex-col gap-1 text-xs">
      {inferred ? (
        <p className="text-fg-muted">
          This take-over was recorded before the platform stored which run it interrupted, so the
          run below is inferred — the newest run that had started by then — and may be one that had
          already finished.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <DownloadLink
          path={transcriptDownloadPath(runId)}
          label="Download the transcript (JSONL)"
          className="text-accent underline"
        />
        <DownloadLink
          path={exportDownloadPath(runId)}
          label="Download the workspace tarball"
          className="text-accent underline"
        />
      </div>
      <p className="text-fg-muted">
        The transcript is rendered from the run’s stored messages each time, so it lasts as long as
        the transcript does. The tarball exists only when the take-over asked for one, and is kept
        for fourteen days — the taken-over workspace’s own retention.
      </p>
    </div>
  );

const HandBack = ({
  taskId,
  takenOver,
  commands,
}: {
  readonly taskId: string;
  readonly takenOver: TakenOver;
  readonly commands: ReturnType<typeof useTakeOverCommands>;
}): ReactElement => {
  const options = takenOver.hand_back_stages;
  const [stage, setStage] = useState(
    options.includes(takenOver.stage) ? takenOver.stage : (options[0] ?? ''),
  );
  const [summary, setSummary] = useState('');
  if (options.length === 0) {
    return (
      <EmptyState
        title="No stage to hand back to"
        hint="This task’s pipeline cannot be read on this build, so there is no stage the hand-back would accept. Cancel the task, or ask an operator."
      />
    );
  }
  const selected = options.includes(stage) ? stage : (options[0] ?? '');
  return (
    <form
      className="flex flex-col gap-2"
      aria-label={`Hand task ${taskId} back`}
      onSubmit={(event) => {
        event.preventDefault();
        commands.handBack.mutate({ stage: selected, summary: summary.trim() });
      }}
    >
      <label className="flex items-center gap-2 text-xs text-fg-muted" htmlFor="hand-back-stage">
        Resume at
        <select
          id="hand-back-stage"
          value={selected}
          onChange={(event) => {
            setStage(event.target.value);
          }}
          className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <textarea
        aria-label="What you did"
        value={summary}
        onChange={(event) => {
          setSummary(event.target.value);
        }}
        placeholder="What you did on the branch — it goes onto the ticket’s workpad"
        className="min-h-16 rounded-md border border-line bg-surface px-2 py-1 text-sm"
      />
      <div>
        <Button
          type="submit"
          tone="primary"
          disabled={commands.handBack.isPending || summary.trim() === ''}
        >
          Hand back
        </Button>
      </div>
      {commands.handBack.isError ? (
        <ErrorNotice title="The hand-back was refused." detail={String(commands.handBack.error)} />
      ) : null}
    </form>
  );
};

/**
 * The control, for the task screen and the run screen alike — one component, so the two surfaces
 * cannot drift into two answers.
 */
export const TakeOverPanel = ({
  taskId,
  state,
  takenOver,
  runs,
}: {
  readonly taskId: string;
  readonly state: TaskState;
  readonly takenOver: TakenOver | null;
  readonly runs: readonly Pick<RunRecord, 'id' | 'started_at'>[];
}): ReactElement | null => {
  const commands = useTakeOverCommands(taskId);
  const [reason, setReason] = useState('');
  const [tarball, setTarball] = useState(false);
  const answered = commands.takeOver.data;

  if (takenOver !== null) {
    return (
      <div>
        <SectionHeading>Taken over by a human</SectionHeading>
        <Card className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
            <Badge tone="warning">taken over</Badge>
            <span>at {formatDateTime(takenOver.at)}</span>
            <span>
              from <UntrustedText value={takenOver.stage} />
            </span>
            {state === 'needs_human' ? <Badge tone="danger">escalated — still held</Badge> : null}
          </div>
          <ResumeLines
            branch={takenOver.branch}
            sessionId={takenOver.session_id}
            commands={takenOver.resume_commands}
          />
          {answered === undefined ? null : (
            <p className="text-xs text-fg-muted">
              {workspaceExportText(answered.workspace_export)}
            </p>
          )}
          <TakeOverDownloads {...takeOverRunOf(takenOver, runs)} />
          <HandBack taskId={taskId} takenOver={takenOver} commands={commands} />
        </Card>
      </div>
    );
  }

  if (FINISHED.has(state)) {
    return null;
  }

  return (
    <div>
      <SectionHeading>Take over</SectionHeading>
      <Card className="flex flex-col gap-2">
        <p className="text-xs text-fg-muted">
          Pauses the pipeline, stops a run in flight gracefully and hands you the branch to finish
          on your own machine. Hand it back at any stage when you are done.
        </p>
        <form
          className="flex flex-col gap-2"
          aria-label={`Take task ${taskId} over`}
          onSubmit={(event) => {
            event.preventDefault();
            commands.takeOver.mutate({ tarball, reason: reason.trim() });
          }}
        >
          <input
            aria-label="Why you are taking it over"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            placeholder="Why (optional, recorded in the audit)"
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={tarball}
              onChange={(event) => {
                setTarball(event.target.checked);
              }}
            />
            Also archive the workspace (without .git and node_modules) for download
          </label>
          <div>
            <Button type="submit" tone="danger" disabled={commands.takeOver.isPending}>
              Take over
            </Button>
          </div>
        </form>
        {commands.takeOver.isError ? (
          <ErrorNotice
            title="The take-over was refused."
            detail={String(commands.takeOver.error)}
          />
        ) : null}
        {answered === undefined ? null : (
          <div className="flex flex-col gap-2">
            <ResumeLines
              branch={answered.branch}
              sessionId={answered.session_id}
              commands={answered.resume_commands}
            />
            <p className="text-xs text-fg-muted">
              {workspaceExportText(answered.workspace_export)}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
};
