/**
 * Run detail — the "click and watch" requirement (product/10 § "Run detail").
 *
 * Header metrics, then three tabs: the live transcript, the exact prompt that produced it, and the
 * context pack that went into it.
 *
 * **The commands technical/09's screens table gives this screen are all here**: steer, cancel,
 * retry with model/effort (`POST /api/runs/:id/retry`, which creates a *new* run rather than
 * changing this one) and feedback. **Take-over is not**, and that is the declaration rather than
 * an oversight: product/10 defines it as "pause pipeline, get branch + resume command, export
 * workspace", and no published response carries the branch, the command or the export, so WP-27
 * owns it — see the same list in `task-detail.tsx`.
 *
 * This route is **lazily loaded** (`routes/tree.tsx`): the transcript renderer is the largest
 * component in the app and TD-013's budget is about the *initial* bundle. A user on the board has
 * not paid for it.
 */
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import {
  useRun,
  useRunCommands,
  useRunContextPack,
  useRunMessages,
  useRunPrompt,
} from '../app/queries.js';
import { useServices } from '../app/services.js';
import { useTopics } from '../realtime/provider.js';
import { TranscriptView } from '../transcript/view.js';
import {
  Badge,
  Button,
  Card,
  ErrorNotice,
  formatElapsed,
  formatInteger,
  formatUsd,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { CodeText, UntrustedText } from '../ui/untrusted.js';
import { FeedbackForm } from './feedback.js';

type Tab = 'transcript' | 'prompt' | 'context';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'context', label: 'Context pack' },
];

export const RunDetailScreen = ({ runId }: { readonly runId: string }): ReactElement => {
  useTopics([`run:${runId}`]);
  const { transcripts, now } = useServices();
  const run = useRun(runId);
  const messages = useRunMessages(runId);
  const commands = useRunCommands(runId);
  const [tab, setTab] = useState<Tab>('transcript');
  const [steer, setSteer] = useState('');
  const [retryModel, setRetryModel] = useState('');
  const [retryEffort, setRetryEffort] = useState<'low' | 'medium' | 'high' | ''>('');

  const prompt = useRunPrompt(runId, tab === 'prompt');
  const contextPack = useRunContextPack(runId, tab === 'context');

  // The store is the source of truth for the transcript; `useRunMessages` only feeds it.
  const snapshot = useSyncExternalStore(
    (listener) => transcripts.subscribe(runId, listener),
    () => transcripts.snapshot(runId),
    () => transcripts.snapshot(runId),
  );

  if (run.isPending) {
    return <Loading label="Loading run…" />;
  }
  if (run.isError) {
    return <ErrorNotice title="Run could not be loaded." detail={String(run.error)} />;
  }

  const record = run.data;
  const nowMs = now();

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <h1 className="text-lg font-semibold">
            {record.stage} · {record.role}
          </h1>
          <Badge
            tone={
              record.status === 'running'
                ? 'accent'
                : record.status === 'completed'
                  ? 'success'
                  : record.status === 'failed' || record.status === 'budget_exceeded'
                    ? 'danger'
                    : 'neutral'
            }
          >
            {record.status}
          </Badge>
          <Badge>{record.mode}</Badge>
          <span className="font-mono text-xs text-fg-muted">
            <UntrustedText value={record.model} />
          </span>
          <Badge>{record.effort}</Badge>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <Metric
            label="Cost"
            value={`${formatUsd(record.cost.usd)}${record.cost.is_estimate ? ' est.' : ''}`}
            definition="Provider-reported cost of this run. Estimated from the price list in local provider mode (BD-011)."
          />
          <Metric
            label="Turns"
            value={formatInteger(record.num_turns)}
            definition="Assistant turns the SDK reported for this run."
          />
          <Metric
            label="Input tokens"
            value={formatInteger(record.usage.input_tokens)}
            definition="Uncached input tokens billed for this run."
          />
          <Metric
            label="Cache read"
            value={formatInteger(record.usage.cache_read_tokens)}
            definition="Tokens served from the prompt cache; billed at a lower rate."
          />
          <Metric
            label="Elapsed"
            value={formatElapsed(record.started_at, nowMs)}
            definition="Wall-clock time since the run started."
          />
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="Run views" className="flex gap-1">
          {TABS.map((item) => (
            <Button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              tone={tab === item.id ? 'primary' : 'default'}
              onClick={() => {
                setTab(item.id);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Retry creates a new run with an overridden model or effort (technical/08
              `POST /api/runs/:id/retry`); empty fields mean "as before", which is why neither is
              defaulted here to this run's own values. */}
          <input
            aria-label="Retry with model"
            value={retryModel}
            onChange={(event) => {
              setRetryModel(event.target.value);
            }}
            placeholder={`Model (default ${record.model})`}
            className="w-56 rounded-md border border-line bg-surface px-2 py-1 text-sm"
          />
          <select
            aria-label="Retry with effort"
            value={retryEffort}
            onChange={(event) => {
              setRetryEffort(event.target.value as 'low' | 'medium' | 'high' | '');
            }}
            className="rounded-md border border-line bg-surface px-2 py-1 text-sm text-fg"
          >
            <option value="">{`Effort (${record.effort})`}</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
          <Button
            disabled={commands.retry.isPending}
            onClick={() => {
              commands.retry.mutate({
                taskId: record.task_id,
                ...(retryModel.trim() === '' ? {} : { model: retryModel.trim() }),
                ...(retryEffort === '' ? {} : { effort: retryEffort }),
              });
            }}
          >
            Retry run
          </Button>
          <Button
            tone="danger"
            disabled={commands.cancel.isPending || record.status !== 'running'}
            onClick={() => {
              commands.cancel.mutate('cancelled from the UI');
            }}
          >
            Cancel run
          </Button>
        </div>
      </div>

      {commands.retry.isError ? <ErrorNotice title="That retry was refused." /> : null}
      {commands.retry.isSuccess ? (
        <p className="text-xs text-fg-muted">
          A new run was requested; it appears in the task's run list.
        </p>
      ) : null}

      {tab === 'transcript' ? (
        <div className="flex min-h-0 flex-col gap-3">
          {messages.isError ? (
            <ErrorNotice
              title="The transcript page could not be loaded."
              detail="Live frames still arrive on the stream; what happened before this screen opened is missing."
            />
          ) : null}
          <TranscriptView blocks={snapshot.blocks} />
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commands.steer.mutate(steer, {
                onSuccess: () => {
                  setSteer('');
                },
              });
            }}
          >
            <input
              aria-label="Steer the agent"
              value={steer}
              onChange={(event) => {
                setSteer(event.target.value);
              }}
              placeholder="Send a message to the running agent…"
              className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-sm"
            />
            <Button
              type="submit"
              tone="primary"
              disabled={commands.steer.isPending || steer.trim() === ''}
            >
              Steer
            </Button>
          </form>
          {commands.steer.isError ? (
            <ErrorNotice title="That steer was refused (rate limit is one message per five seconds)." />
          ) : null}
        </div>
      ) : null}

      {tab === 'prompt' ? (
        <div className="flex flex-col gap-3">
          <SectionHeading>Prompt snapshot</SectionHeading>
          {prompt.isPending ? <Loading label="Loading prompt…" /> : null}
          {prompt.isError ? (
            <ErrorNotice title="The prompt could not be loaded." detail={String(prompt.error)} />
          ) : null}
          {prompt.data === undefined ? null : (
            <>
              <p className="font-mono text-xs text-fg-muted">
                <UntrustedText value={prompt.data.prompt_version} />
              </p>
              <CodeText value={prompt.data.system_prompt} />
              <CodeText value={prompt.data.user_prompt} />
            </>
          )}
        </div>
      ) : null}

      {tab === 'context' ? (
        <div className="flex flex-col gap-3">
          <SectionHeading>Context pack</SectionHeading>
          {contextPack.isPending ? <Loading label="Loading context pack…" /> : null}
          {contextPack.isError ? (
            <ErrorNotice
              title="The context pack could not be loaded."
              detail={String(contextPack.error)}
            />
          ) : null}
          {contextPack.data === undefined ? null : (
            <Card>
              <div className="grid grid-cols-3 gap-4 pb-3">
                <Metric
                  label="Budget"
                  value={formatInteger(contextPack.data.budget_tokens)}
                  definition="Token budget the context assembler was allowed to spend."
                />
                <Metric
                  label="Used"
                  value={formatInteger(contextPack.data.total_tokens)}
                  definition="Tokens the assembled pack actually cost."
                />
                <Metric
                  label="Documents"
                  value={formatInteger(
                    contextPack.data.tier0.length + contextPack.data.tier1.length,
                  )}
                  definition="Knowledge-base documents included in this run's context."
                />
              </div>
              <ul className="flex flex-col gap-1 text-xs">
                {[...contextPack.data.tier0, ...contextPack.data.tier1].map((entry) => (
                  <li key={entry.path} className="flex gap-2 font-mono">
                    <UntrustedText value={entry.path} />
                    <span className="ml-auto text-fg-muted">{formatInteger(entry.tokens)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : null}

      <FeedbackForm
        heading={`Feedback on the ${record.stage} stage`}
        hint="Scoped to the stage rather than to this attempt: a run is one attempt, and the retrospective reads the stage (product/10)."
        pending={commands.feedback.isPending}
        failed={commands.feedback.isError}
        accepted={commands.feedback.isSuccess}
        onSubmit={(input) => {
          commands.feedback.mutate({ taskId: record.task_id, stage: record.stage, ...input });
        }}
      />
    </div>
  );
};
