/**
 * Run detail — the "click and watch" requirement (product/10 § "Run detail").
 *
 * Header metrics, then four tabs: the live transcript, the exact prompt that produced it, the
 * context pack that went into it, and — since WP-112 — the settings it was planned with
 * (`features/run-settings.tsx`), whose hash the header compares with the task's previous run.
 *
 * **The commands technical/09's screens table gives this screen are all here**: steer (accepted,
 * then applied or refused by the process holding the run — the list under the transcript says
 * which, WP-85), cancel,
 * retry with model/effort (`POST /api/runs/:id/retry`, which creates a *new* run rather than
 * changing this one), feedback — and, since WP-44, **take over and hand back** for the run's task
 * (`features/take-over.tsx`, the same component the task screen renders) and the **transcript
 * download** for this run. This note used to say the take-over was absent for want of a place to
 * render the branch and the resume lines; that place is the panel below the header.
 *
 * This route is **lazily loaded** (`routes/tree.tsx`): the transcript renderer is the largest
 * component in the app and TD-013's budget is about the *initial* bundle. A user on the board has
 * not paid for it.
 */

import type { ContextPackRecord } from '@platform/contracts';
import { type ReactElement, useState, useSyncExternalStore } from 'react';
import { transcriptDownloadPath } from '../api/endpoints.js';
import {
  useRun,
  useRunCommandLog,
  useRunCommands,
  useRunContextPack,
  useRunMessages,
  useRunPrompt,
  useRunSettings,
  useTask,
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
  formatRunCost,
  Loading,
  Metric,
  SectionHeading,
} from '../ui/kit.js';
import { CodeText, DownloadLink, UntrustedText } from '../ui/untrusted.js';
import { FeedbackForm } from './feedback.js';
import { RunCommandLog } from './run-command-log.js';
import { RunNotStartedPanel } from './run-not-started.js';
import { RunSettingsLine, RunSettingsPanel } from './run-settings.js';
import { TakeOverPanel } from './take-over.js';

type Tab = 'transcript' | 'prompt' | 'context' | 'settings';

/**
 * The documents a run was **shown**: tier 0 and the tier-1 entries recorded `validated: true`
 * (WP-44, PROGRESS backlog 168).
 *
 * A tier-1 entry recorded `validated: false` was dropped by the assembler before the count and the
 * budget — its `paths:` glob resolved to nothing at the indexed commit — so it was never in the
 * prompt. The stored `total_tokens` excludes it and the statistics' `kb_usage` admits only
 * `validated` rows; this is the same rule, spelled once for the screen (standing rule 41). The
 * unvalidated entries stay in the list, marked, because they are the audit technical/07 step 3
 * promises.
 */
export const admittedDocuments = (pack: ContextPackRecord): number =>
  pack.tier0.length + pack.tier1.filter((entry) => entry.validated).length;

/**
 * Why tier 1 has no text-matched document, in words — or what the text step did (WP-44, PROGRESS
 * backlog 172). `null` for a pack recorded before the step was (migration 0047).
 */
export const textSearchText = (pack: ContextPackRecord): string | null => {
  const search = pack.text_search;
  if (search === null || search === undefined) {
    return null;
  }
  const kept = search.kept_terms.join(', ');
  const dropped = search.dropped_terms.join(', ');
  const omitted =
    search.omitted_terms === 0
      ? ''
      : ` ${search.omitted_terms} term${search.omitted_terms === 1 ? ' is' : 's are'} not shown (redacted or too long).`;
  const statistics =
    search.floor === 'no_statistics'
      ? ' The index carries no word statistics yet, so no word was dropped as too common.'
      : '';
  switch (search.outcome) {
    case 'not_searched':
      return 'No text search ran: this project has no knowledge index yet, so only the path rules could match.';
    case 'no_terms':
      return `No text search ran: the task text had no keyword to search for.${omitted}`;
    case 'all_uninformative':
      return `Every keyword was dropped as too common in this project to mean anything: ${dropped}.${omitted}`;
    case 'no_match':
      return `Searched for ${kept}${dropped === '' ? '' : ` (dropped as too common: ${dropped})`} and nothing matched.${statistics}${omitted}`;
    default:
      return `Searched for ${kept}${dropped === '' ? '' : ` (dropped as too common: ${dropped})`}: ${search.matched_documents} document${search.matched_documents === 1 ? '' : 's'} matched.${statistics}${omitted}`;
  }
};

/**
 * The run page's tabs, in order. `docs/user-guide.md` § 5 names each one in bold and says how many
 * there are; `user-guide-census.test.ts` holds the two together (WP-129).
 */
export const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'transcript', label: 'Transcript' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'context', label: 'Context pack' },
  { id: 'settings', label: 'Settings' },
];

export const RunDetailScreen = ({ runId }: { readonly runId: string }): ReactElement => {
  useTopics([`run:${runId}`]);
  const { transcripts, now } = useServices();
  const run = useRun(runId);
  const messages = useRunMessages(runId);
  const commands = useRunCommands(runId);
  const commandLog = useRunCommandLog(runId);
  const [tab, setTab] = useState<Tab>('transcript');
  const [steer, setSteer] = useState('');
  const [retryModel, setRetryModel] = useState('');
  const [retryEffort, setRetryEffort] = useState<'low' | 'medium' | 'high' | ''>('');

  // The run's task, for the take-over control: `taken_over` lives on the task, not on a run.
  const task = useTask(run.data?.task_id ?? '', run.data !== undefined);
  const prompt = useRunPrompt(runId, tab === 'prompt');
  const contextPack = useRunContextPack(runId, tab === 'context');
  const settings = useRunSettings(runId, tab === 'settings');

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
            value={formatRunCost(record.cost, { estimate: true })}
            definition="Provider-reported cost of this run. Estimated from the price list in local provider mode (BD-011). Not measured when the run ended with no figure from the provider, which is not the same as free."
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
        {/* WP-112: the hash is on the record, so whether the settings moved between this run and
            the task's previous one is answered here, before anybody opens the Settings tab. */}
        <div className="pt-3">
          <RunSettingsLine run={record} runs={task.data?.runs} />
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <DownloadLink
          path={transcriptDownloadPath(record.id)}
          label="Download this run’s transcript (JSONL)"
          className="text-accent underline"
        />
      </div>

      {task.data === undefined ? null : (
        <TakeOverPanel
          taskId={task.data.task.id}
          state={task.data.task.state}
          takenOver={task.data.taken_over}
          runs={task.data.runs}
        />
      )}

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

      {commands.cancel.isError ? <ErrorNotice title="That cancel was refused." /> : null}
      {commands.cancel.isSuccess ? (
        <p className="text-xs text-fg-muted">
          {commands.cancel.data.command_id === null
            ? 'No process was running this session, so the run was ended here.'
            : 'Cancel accepted — the process running the agent stops the session and ends the run with what it cost; the commands below say when it was applied.'}
        </p>
      ) : null}
      {commands.retry.isError ? <ErrorNotice title="That retry was refused." /> : null}
      {commands.retry.isSuccess ? (
        <p className="text-xs text-fg-muted">
          A new run was requested; it appears in the task's run list.
        </p>
      ) : null}

      {/* Backlog 453: a run whose workspace never started has no transcript to show, and an empty
          one read as "nothing happened yet". The reason is shown in its place. */}
      {tab === 'transcript' && record.start_failure !== null ? (
        <RunNotStartedPanel failure={record.start_failure} />
      ) : null}

      {tab === 'transcript' && record.start_failure === null ? (
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
            <ErrorNotice title="That steer was not accepted: the run may have ended, or you sent one within the last five seconds (the limit is one message per five seconds)." />
          ) : null}
          {commands.steer.isSuccess ? (
            <p className="text-xs text-fg-muted">
              Accepted. The agent runs in another process, which applies the message — whether it
              did is shown under “Commands sent to this run”.
            </p>
          ) : null}
          {commandLog.isError ? (
            <ErrorNotice
              title="What became of the commands sent to this run could not be loaded."
              detail={String(commandLog.error)}
            />
          ) : null}
          <RunCommandLog commands={commandLog.data?.items ?? []} />
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
              {prompt.data.prompts_withheld === null ? null : (
                // WP-121 (PROGRESS backlog 363): why the project's prompt files are not below.
                <ErrorNotice
                  title="The project’s prompt files were withheld from this prompt."
                  detail={[
                    prompt.data.prompts_withheld.reason,
                    ...prompt.data.prompts_withheld.integrations.map(
                      (entry) => `${entry.integration}: ${entry.reason}`,
                    ),
                  ].join(' — ')}
                />
              )}
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
                  value={formatInteger(admittedDocuments(contextPack.data))}
                  definition="Knowledge-base documents this run was shown: the unconditional tier 0 and the tier-1 documents that were admitted. A tier-1 page whose paths: rule matched nothing in the repository is listed below as not admitted and is not counted."
                />
              </div>
              {textSearchText(contextPack.data) === null ? (
                <p className="pb-2 text-xs text-fg-muted">
                  This run’s pack was recorded before the text search’s outcome was.
                </p>
              ) : (
                <p className="pb-2 text-xs text-fg-muted">
                  {/* The terms are words of the ticket: somebody else's text (BD-022). */}
                  <UntrustedText value={textSearchText(contextPack.data) ?? ''} />
                </p>
              )}
              <ul className="flex flex-col gap-1 text-xs">
                {contextPack.data.tier0.map((entry) => (
                  <li key={entry.path} className="flex gap-2 font-mono">
                    <UntrustedText value={entry.path} />
                    <span className="ml-auto text-fg-muted">{formatInteger(entry.tokens)}</span>
                  </li>
                ))}
                {contextPack.data.tier1.map((entry) => (
                  <li key={entry.path} className="flex gap-2 font-mono">
                    <UntrustedText value={entry.path} />
                    {entry.validated ? null : (
                      <span data-not-admitted="true">
                        <Badge tone="warning">
                          not admitted — its paths: did not resolve at the indexed commit
                        </Badge>
                      </span>
                    )}
                    <span className="ml-auto text-fg-muted">{formatInteger(entry.tokens)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : null}

      {tab === 'settings' ? <RunSettingsPanel query={settings} /> : null}

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
