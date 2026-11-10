/**
 * **The sentence for each error code the server raises, with its next step** (S-25.18) — the table
 * `errorSentence` (`./read-error.ts`) reads, in a module of its own so that it is **not** in TD-013's
 * initial graph: `ui/kit.tsx`'s `ErrorNotice` is on every screen's first paint, and these sentences
 * are needed only once something has failed. `./read-error.ts` loads this module with `import()` and
 * says the error by its status until it has arrived (review of #123: +5.5 kB gz, measured).
 *
 * Every code the server raises has an entry, and every entry is a code the server raises (or the
 * client's own): `./error-code-census.test.ts` reads the server's sources and holds this table to
 * them in both directions. Where the server's `details` name the specifics (which projects use an
 * integration, the organisation's maximum, the state a task is in, the request id of a failure), the
 * sentence says them.
 */
import {
  APPROVAL_STATUS_LABEL,
  configFieldLabel,
  QUESTION_STATUS_LABEL,
  RUN_STATUS_LABEL,
  stageLabel,
  TASK_STATE_LABEL,
  wordInSentence,
} from '../ui/humanize.js';
import { LINK_REFUSAL_WORDS } from '../ui/humanize-accounts.js';
import { AUTONOMY_LEVEL_LABEL } from '../ui/words/settings.js';
import { fieldNames, invalidSettingsSentence, TRANSITION_UNKNOWN } from './error-words.js';
import { type ApiError, PLATFORM_UPDATED_MESSAGE } from './http.js';

// ── Reading `details` ────────────────────────────────────────────────────────

/** The first `details` entry at `path`, or `undefined`. */
const detailOf = (error: ApiError, path: string): string | undefined =>
  error.details.find((detail) => detail.path === path)?.message;

/** Every `details` entry at `path`, in order. */
const detailsOf = (error: ApiError, path: string): string[] =>
  error.details.filter((detail) => detail.path === path).map((detail) => detail.message);

/** "A", "A and B", "A, B and C". */
const listWords = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * A dollar figure a `details` entry carries, as the screens print one — rounded **up** to the cent
 * for a minimum (`'up'`), so "at least $50.99" is never a hair below what the server admits.
 */
const dollarsOf = (value: string | undefined, rounding: 'up' | 'near'): string | null => {
  const usd = value === undefined ? Number.NaN : Number(value);
  if (!Number.isFinite(usd)) return null;
  const cents =
    rounding === 'up' ? Math.ceil(Number((usd * 100).toFixed(6)) - 1e-9) : Math.round(usd * 100);
  return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(cents / 100);
};

/** An instant as the screens print one ("9 Nov 2026, 14:05"), or the text itself if it is none. */
const instantWords = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? iso
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(at);
};

/** An autonomy position as the dial names it; one this build has no word for is title-cased. */
const autonomyWord = (level: string): string =>
  Object.hasOwn(AUTONOMY_LEVEL_LABEL, level)
    ? AUTONOMY_LEVEL_LABEL[level as keyof typeof AUTONOMY_LEVEL_LABEL]
    : `${level.charAt(0).toUpperCase()}${level.slice(1)}`;

// ── A move the state machine does not have (`illegal_transition`) ───────────

/** What the refused command would have done, as "…so it cannot be ___". Keyed by audit action. */
const COMMAND_PARTICIPLE: Readonly<Record<string, string>> = {
  'task.pause': 'paused',
  'task.resume': 'resumed',
  'task.cancel': 'cancelled',
  'task.retry_stage': 'retried',
  'task.return_to_stage': 'sent back to an earlier step',
  'task.rework': 'sent back for rework',
  'task.feedback': 'given feedback',
  'task.question.answer': 'answered',
  'task.approval.decide': 'decided',
  'task.take_over': 'handed to you to work on',
  'task.hand_back': 'given back to the agent',
  'task.owner.take': 'given a new owner',
  'task.breakdown.decide': 'split as proposed',
  'budget.write': 'given a new cap',
  'run.retry': 're-run',
  'run.cancel': 'cancelled',
  'run.steer': 'sent a message',
};

interface AggregateWords {
  readonly subject: string;
  /** The state, as the middle of "This task is ___". */
  readonly state: Readonly<Record<string, string>>;
  /** What the person does next, from that state. */
  readonly next: Readonly<Record<string, string>>;
  readonly otherwise: string;
}

const inSentence = (labels: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(labels).map(([key, word]) => [key, wordInSentence(word)]));

const TASK_WORDS: AggregateWords = {
  subject: 'This task',
  state: {
    ...inSentence(TASK_STATE_LABEL),
    // "is needs you" and "is retrospective" do not read; the words are the same facts.
    needs_human: 'waiting for you',
    retro: 'in its retrospective',
  },
  next: {
    queued: 'wait for it to start',
    active: 'wait for its current step to finish, or pause it first',
    returned: 'wait for it to start the step it was sent back to',
    waiting_answers: 'answer its open questions first',
    waiting_approval: 'approve or reject its pending approval first',
    paused: 'resume it first',
    needs_human: 'open it and choose one of the ways on that it offers',
    ready_for_merge: 'merge its merge request, or send it back',
    merged: 'only its retrospective is left to run',
    retro: 'wait for its retrospective to finish',
    done: 'it has finished, so nothing changes it any more',
    cancelled: 'it was cancelled, so nothing changes it any more',
  },
  otherwise: 'open it to see where it stands and what it needs',
};

const RUN_WORDS: AggregateWords = {
  subject: 'This run',
  state: inSentence(RUN_STATUS_LABEL),
  next: {
    created: 'wait for it to start, or cancel it',
    starting: 'wait for it to start, or cancel it',
    running: 'wait for it to end, or cancel it',
  },
  otherwise: 'it has ended; re-run it from the task page if it is still needed',
};

const QUESTION_WORDS: AggregateWords = {
  subject: 'This question',
  state: inSentence(QUESTION_STATUS_LABEL),
  next: { open: 'answer it first' },
  otherwise: 'it is already settled; reload the page to see how',
};

const APPROVAL_WORDS: AggregateWords = {
  subject: 'This approval',
  state: inSentence(APPROVAL_STATUS_LABEL),
  next: { pending: 'approve or reject it first' },
  otherwise: 'it is already decided; reload the page to see the decision',
};

const AGGREGATE_WORDS: Readonly<Record<string, AggregateWords>> = {
  task: TASK_WORDS,
  run: RUN_WORDS,
  question: QUESTION_WORDS,
  approval: APPROVAL_WORDS,
};

/**
 * The subject of a task's refusal: its ticket key when the server named it (`details.ticket_key`,
 * S-25.23) — *AUT-6639 is paused …* — else *This task*. The key is the tracker's text and the
 * sentence is rendered as a text node like every other (BD-022).
 */
const subjectOf = (error: ApiError, aggregate: string, words: AggregateWords): string => {
  const key = detailOf(error, 'ticket_key')?.trim() ?? '';
  return aggregate === 'task' && key !== '' ? key : words.subject;
};

/**
 * "AUT-6639 is paused, so it cannot be retried — resume it first." From the refusal's `details`
 * (`aggregate`, `from`, `command` — S-25.18 — and `ticket_key`, S-25.23), in the screens' own state
 * words; a state or an aggregate this build has no word for is never printed raw, it drops to
 * {@link TRANSITION_UNKNOWN}.
 */
const transitionSentence = (error: ApiError): string => {
  const aggregate = (detailOf(error, 'aggregate') ?? '').toLowerCase();
  const words = Object.hasOwn(AGGREGATE_WORDS, aggregate) ? AGGREGATE_WORDS[aggregate] : undefined;
  const from = detailOf(error, 'from') ?? '';
  if (words === undefined || !Object.hasOwn(words.state, from)) {
    return TRANSITION_UNKNOWN;
  }
  const subject = subjectOf(error, aggregate, words);
  // A command whose target is the state the task is already in (a pause of a paused task).
  if (detailOf(error, 'to') === from) {
    return `${subject} is already ${words.state[from]}.`;
  }
  const command = detailOf(error, 'command');
  const done =
    command !== undefined && Object.hasOwn(COMMAND_PARTICIPLE, command)
      ? `it cannot be ${COMMAND_PARTICIPLE[command]}`
      : 'this cannot be done to it';
  const next = Object.hasOwn(words.next, from) ? words.next[from] : words.otherwise;
  return `${subject} is ${words.state[from]}, so ${done} — ${next}.`;
};

// ── A policy that refused (`policy_violation`) ───────────────────────────────

const POLICY_SENTENCE: Readonly<Record<string, string>> = {
  'budget.exhausted':
    'A budget has run out, so this cannot start. Raise the budget under Budgets, or wait for its period to begin again.',
  'budget.limit': 'A budget limit cannot be below zero. Enter zero or more.',
  'budget.spend': 'A cost cannot be below zero. Enter zero or more.',
  'pipeline.template':
    'The project’s pipeline template is refused, so this cannot go on. Correct the template in the project’s settings, then try again.',
  'command.policy':
    'The project’s command rules do not allow this command. Change the rules under Rules & limits if it should be allowed.',
};

/** Names the policy from `details.policy` (S-25.18); one this table lacks is named by its words. */
const policySentence = (error: ApiError): string => {
  const policy = detailOf(error, 'policy');
  if (policy === undefined) {
    return 'A project rule does not allow this. Check the project’s Rules & limits.';
  }
  if (Object.hasOwn(POLICY_SENTENCE, policy)) {
    return POLICY_SENTENCE[policy] as string;
  }
  const name = policy.split('.').map(configFieldLabel).join(' › ');
  return `A project rule (${name}) does not allow this. Check the project’s Rules & limits.`;
};

// ── The sentences ────────────────────────────────────────────────────────────

/** A sentence, or a function of the error that builds one from its `details`. */
export type CodeSentence = string | ((error: ApiError) => string);

/** One sentence for the codes a process with no workers composed answers with. */
const NEEDS_WORKERS = (what: string): string =>
  `This server cannot ${what} right now. Ask an administrator to check that the platform’s workers are running.`;

const LIVE_UPDATES = 'Live updates could not be connected. Reload the page to connect them again.';

const WIP_LIMIT_WORDS: Readonly<Record<string, string>> = {
  max_parallel_tasks: 'parallel tasks',
  max_tasks_in_pipeline: 'tasks in the pipeline',
  max_tasks_per_owner: 'tasks in flight per person',
};

/**
 * Every code the server answers a screen with, said plainly with what to do next — keyed by the
 * server's `error.code`. `api/error-code-census.test.ts` holds this table to the server's sources
 * in both directions; the codes it exempts (the remote worker's protocol, which no screen calls)
 * are listed there with the reason.
 */
export const CODE_SENTENCE: Readonly<Record<string, CodeSentence>> = {
  ...LINK_REFUSAL_WORDS,

  // Who may act.
  forbidden:
    'Your role does not allow this. Ask a maintainer or an administrator to do it, or to give you a role that can.',
  unauthenticated: 'You are signed out. Sign in again.',
  cross_site_request:
    'The server refused this because it did not come from this page. Reload the page and try again.',

  // A task, a run, a question or an approval refused the move.
  illegal_transition: transitionSentence,
  invariant_violation:
    'This cannot be done as things stand now. Open it to see where it stands and what it needs.',
  policy_violation: policySentence,
  task_conflict: 'The task changed while this was being done. Try again.',
  task_merged:
    'The task is already merged, so it cannot go back to work. Resume or retry its retrospective, or cancel it.',
  // S-27.1, BACKLOG 854: only the approval's own decision moves a task that waits for one.
  approval_pending:
    'This task is waiting for an approval. Approve or reject it to move the task on.',
  approval_subject_mismatch:
    'The plan you approved is not the plan this approval is about. Reload the page, read the plan it shows, then approve it.',
  approval_subject_superseded:
    'A newer plan replaced the one you approved. Read the newest plan, then approve or reject it.',
  approval_subject_unrecorded:
    'This approval does not record which plan it asks about, so it cannot be approved. Reject it to ask for a fresh plan.',
  stage_not_reached:
    'The task has not reached that step yet. Choose a step it has already been through.',
  stage_not_current:
    'The task has moved on from that step. Reload the page to see the step it is at now.',
  stage_not_in_template:
    'That step is not part of this task’s pipeline. Choose one of the steps it runs.',
  iteration_limit_reached:
    'That loop has used all the rounds it is allowed. Choose another way on: work on it yourself, send it to another step, or cancel the task.',
  run_not_live:
    'The run has already ended, so there is nothing to stop or message. Re-run it from the task page if it is still needed.',
  budget_not_raised: 'The new cap must be above the cap in force. Enter a higher figure.',
  // S-28.1 (M28 ruling 2): a raise the next run would still not fit under, with its arithmetic.
  budget_raise_insufficient: (error) => {
    const minimum = dollarsOf(detailOf(error, 'required_cap_usd'), 'up');
    const spent = dollarsOf(detailOf(error, 'spent_usd'), 'near');
    const reserve = dollarsOf(detailOf(error, 'reserve_usd'), 'near');
    const stage = detailOf(error, 'stage');
    if (minimum === null) {
      return 'That cap is still too low for the task’s next run to start. Enter a higher figure.';
    }
    const parts =
      spent !== null && reserve !== null
        ? `It has spent ${spent} and the next ${stage === undefined ? '' : `${stageLabel(stage)} `}run reserves up to ${reserve} (a ceiling, not spend). `
        : '';
    return `That cap is too low for the task to continue. ${parts}Enter at least ${minimum}.`;
  },
  not_paused_by_task_cap:
    'The task is not paused by its own cost cap, so there is no cap here to raise. If a project or organisation budget stopped it, raise that one under Budgets.',
  budget_override_unsupported:
    'A retry cannot raise the run’s budget. Retry without a new budget, or raise the task’s cap first.',
  no_gate_feedback: 'There is no check failure to attach. Clear the box and send it again.',
  model_not_listed: 'That model is not one this project may use. Choose a model from the list.',
  breakdown_refused:
    'This breakdown can no longer be decided: the task is not waiting on it, or the items you chose were already decided. Reload the page to see what is still waiting.',
  ask_already_recorded:
    'This question was already sent to the task. Reload the page to see it and its answer.',
  rate_limited:
    'You have sent this agent several messages in a short time. Wait a moment, then send it again.',
  // S-26.1's owner command (`POST /api/tasks/:id/owner`), said for S-26.8b's controls.
  owner_change_not_permitted:
    'Your role does not allow this change of owner. Reload to see who owns it now.',
  owner_not_project_member: 'That person is not a member of this project, so they cannot own it.',
  task_finished: 'The task has finished, so its owner no longer changes.',
  commands_unavailable: NEEDS_WORKERS('act on tasks'),

  // Records an older build did not write.
  not_found: 'It was not found. It may have been removed; go back and open it again from its list.',
  row_not_projectable:
    'Part of this record was stored in a form this version cannot show. An administrator can find which in the details below.',
  prompt_not_recorded:
    'This run was made before prompts were recorded, so there is no prompt to show. Newer runs show theirs.',
  context_pack_not_recorded:
    'This run was made before the knowledge it was given was recorded, so there is nothing to show. Newer runs show theirs.',
  settings_not_recorded:
    'This run was made before its settings were recorded, so there is nothing to show. Newer runs show theirs.',
  artifact_not_redacted:
    'This document was stored before secrets were hidden in documents, so it is not shown. The task’s newer documents are shown as usual.',

  // Downloads, knowledge, statistics and the background work.
  export_directory_not_configured:
    'Workspace downloads are not set up on this server. Ask an administrator to set the export folder; the branch is on the git host either way.',
  export_not_found:
    'There is no workspace download for this run: it was not saved, or it was removed after fourteen days. The branch is on the git host.',
  kb_health_not_reported:
    'There is no knowledge health report yet. The nightly check writes one; look again tomorrow.',
  knowledge_unavailable: NEEDS_WORKERS('read or decide knowledge proposals'),
  conflict: 'Someone else changed this at the same moment. Reload the page and try again.',
  stats_range_too_large: 'That period holds too much to add up at once. Choose a shorter period.',
  dead_letters_unavailable: NEEDS_WORKERS('read stuck events'),
  failed_jobs_unavailable: NEEDS_WORKERS('list failed background jobs'),
  event_already_dispatched:
    'That event was already handled, so there is nothing to try again. Reload the list.',
  event_not_dead_lettered:
    'That event is not stuck: the platform will deliver it by itself. Reload the list.',
  invalid_cursor:
    'The list changed while you were paging through it. Reload the page to start from the top.',

  // Workers and their machines, as the Workers screens see them.
  device_code_already_decided:
    'This code was already approved or denied. Ask the machine for a new code if it still needs one.',
  device_code_expired:
    'This code has expired. Ask the machine for a new code, then enter that one.',
  device_code_needs_confirmation:
    'This code is more than five minutes old. Approve it only if your own machine shows it right now, and confirm again.',
  device_code_not_found:
    'No machine is waiting with that code. Check the code your machine shows now and enter it again.',
  claim_policy_owner_only:
    'Only the person whose machine this is can change what it takes. Ask them to change it.',
  // S-28.6: a person's own limit above the organisation's `max_tasks_per_owner`.
  task_limit_above_maximum: (error) => {
    const maximum = detailOf(error, 'max_tasks_in_flight');
    return maximum === undefined
      ? 'That limit is above what the organisation allows. Choose a lower number, or ask an administrator to raise the organisation’s limit.'
      : `The organisation allows at most ${maximum} tasks in flight per person. Choose ${maximum} or fewer, or ask an administrator to raise the organisation’s limit.`;
  },
  claim_scope_empty:
    'Choose at least one project, or every project. To have the machine take nothing by itself, choose that option instead.',
  project_not_eligible:
    'You cannot take work from some of the projects you chose. Remove them, or ask a maintainer to make you a member there.',
  unknown_user: 'That person is not a user of this platform. Choose someone from the list.',

  // Retried requests.
  idempotency_key_required:
    'The page sent this without its retry key. Reload the page and try again.',
  idempotency_key_in_flight:
    'The same request is still being performed. Wait a moment, then check whether it was done.',
  idempotency_key_reused:
    'This was already sent with different details. Reload the page and try again.',
  // The client says its own sentence for this one (`ATTEMPT_UNKNOWN_MESSAGE`); this is the fallback.
  idempotency_attempt_unknown:
    'An earlier attempt never recorded whether it was done. Check whether it happened before you try again.',
  too_many_requests: 'Too many requests. Wait a moment and try again.',
  invalid_response: 'The server’s answer could not be read. Reload the page.',
  platform_updated: `${PLATFORM_UPDATED_MESSAGE.charAt(0).toUpperCase()}${PLATFORM_UPDATED_MESSAGE.slice(1)}.`,

  // Forms and settings.
  invalid_request: (error) => {
    const fields = fieldNames(error.details);
    return fields.length > 0
      ? `Some fields are invalid: ${fields.join(', ')}. Correct them and try again.`
      : 'The server did not accept this request. Check what you entered and try again.';
  },
  invalid_integration_config: (error) =>
    `${invalidSettingsSentence(error.details.map((detail) => detail.path))} Correct them and save again.`,
  invalid_binding_config: (error) =>
    `${invalidSettingsSentence(error.details.map((detail) => detail.path))} Correct them and save again.`,
  credential_in_config: (error) => {
    const names = fieldNames(error.details);
    return `${names.length === 0 ? 'A credential was' : `${listWords(names)} ${names.length === 1 ? 'is a credential and was' : 'are credentials and were'}`} entered among the settings. Remove it from there and give it as a credential instead.`;
  },
  run_credential_refused: (error) => {
    const names = fieldNames(error.details);
    return `The run credential is refused${names.length === 0 ? '' : `: ${names.join(', ')}`}. Correct it as the details below say, then save again.`;
  },
  static_run_credential_shared:
    'This integration gives its runs a fixed credential, so only one project may use it. Create a separate integration for the other project.',
  invalid_repository_config:
    'The repository’s settings file on the default branch does not parse, so no run of this project starts. Fix the file there; the details below say where.',
  invalid_stored_config:
    'This project’s saved settings hold keys this version does not accept. Correct the keys the details below name in the project’s settings, then try again.',
  invalid_organisation_config:
    'The organisation’s saved settings do not parse. An administrator corrects them under Settings.',
  project_config_refused:
    'This project’s saved settings do not parse, so its pipeline cannot be shown. Correct them in the project’s settings.',
  pipeline_not_compilable:
    'This version cannot build the project’s pipeline from its template. Correct the template in the project’s settings.',
  template_not_found:
    'The project has no pipeline template by that name. Choose one of its templates.',
  config_conflict:
    'The project’s settings changed since you opened them. Reload the page to see the new settings, then try again.',
  config_commands_unavailable:
    'This server cannot read the repository or reach the git host right now. Ask an administrator to check the platform’s integrations.',
  config_export_unavailable:
    'The settings could not be proposed to the repository just now. Check the git connection under Integrations, then try again.',
  nothing_to_export:
    'This project has no settings of its own to export yet. Save some settings first.',
  repository_unreadable:
    'The default branch could not be read, so the last reading stands. Check the git connection, then refresh again.',
  autonomy_above_organisation: (error) => {
    const maximum = detailOf(error, 'organisation_maximum');
    return maximum === undefined
      ? 'The organisation does not allow that much autonomy. Choose a lower position, or ask an administrator to raise the organisation’s maximum.'
      : `The organisation allows agents at most ${autonomyWord(maximum)}. Choose ${autonomyWord(maximum)} or lower, or ask an administrator to raise the organisation’s maximum.`;
  },
  wip_above_organisation: (error) => {
    const maximum = detailOf(error, 'organisation_maximum');
    const limit = detailOf(error, 'limit');
    const what =
      limit !== undefined && Object.hasOwn(WIP_LIMIT_WORDS, limit)
        ? WIP_LIMIT_WORDS[limit]
        : 'tasks';
    return maximum === undefined
      ? 'A task limit is above the organisation’s maximum. Lower it, or ask an administrator to raise the organisation’s limit.'
      : `The organisation allows at most ${maximum} ${what}, so this project cannot go above that. Choose ${maximum} or fewer, or ask an administrator to raise the organisation’s limit.`;
  },

  // Integrations.
  integration_bound: (error) => {
    const projects = detailsOf(error, 'projects');
    return projects.length === 0
      ? 'A project still uses this integration. Remove it from each project’s connections first, then retire it.'
      : `${listWords(projects)} still ${projects.length === 1 ? 'uses' : 'use'} this integration. Remove it from ${projects.length === 1 ? 'that project’s' : 'those projects’'} connections first, then retire it.`;
  },
  integration_is_organisation_default:
    'This is the organisation’s chat account for notifications. Choose another chat account under Settings, or clear that setting, then retire it.',
  integration_has_live_credential: (error) => {
    const count = Number(detailOf(error, 'live_credentials') ?? Number.NaN);
    const latest = detailOf(error, 'latest_expiry');
    const issued =
      Number.isInteger(count) && count > 0
        ? `It issued ${count} run credential${count === 1 ? '' : 's'} that ${count === 1 ? 'has' : 'have'} not expired or been revoked`
        : 'It issued run credentials that have not expired or been revoked';
    return `${issued}, and a revoke is sent through it. Retire it once ${count === 1 ? 'that one has' : 'they have'} expired${latest === undefined ? '' : ` (the last at ${instantWords(latest)})`}.`;
  },
  integration_host_not_permitted:
    'That address is on a host this instance does not allow. Use an allowed address, or ask an administrator to allow the host.',
  secret_name_not_permitted:
    'That environment variable is not one this instance allows. Choose an allowed one, or ask an administrator to allow it.',
  missing_secret:
    'An environment variable you named is not set on the server. Ask an administrator to set it, then try again.',
  integration_retired:
    'The integration is retired, so it cannot be changed. Create a new one instead.',
  integration_name_retired: 'A retired integration already has that name. Choose another.',
  provider_not_shipped:
    'This integration’s provider is not part of this version, so it cannot be changed here. Create one with a provider this version offers.',
  organisation_default_not_communication:
    'Notifications go only to a chat account of this organisation. Choose one of its chat accounts.',
  probe_busy:
    'The connection test is queued behind other calls to the same provider. It finishes by itself; look at the integration’s health again in a moment.',
  onboarding_unavailable: NEEDS_WORKERS('run discovery or test a connection'),

  // Discovery, the history, trial runs and starting a ticket.
  readiness_not_evaluated:
    'This project has no readiness evaluation yet. Run discovery on it; that is what records one.',
  discovery_unavailable:
    'This project’s settings define no discovery pipeline, so discovery cannot run. Restore the discovery template in its settings.',
  discovery_not_started:
    'This project has never run discovery. Start it from the setup wizard’s discovery step first.',
  rediscovery_attempts_spent:
    'Discovery was run again several times without recording an evaluation. Read those tasks to see why before running it again.',
  bootstrap_unavailable: NEEDS_WORKERS('mine the history'),
  bootstrap_feature_disabled:
    'Mining the history is off for this project. Turn it on in the project’s feature settings first.',
  bootstrap_no_git_binding:
    'This project has no git host connected, so there is no history to mine. Connect one first.',
  bootstrap_already_running:
    'The history of this project is already being mined. Wait for that to finish.',
  bootstrap_merge_requests_out_of_range:
    'That number of merge requests is outside the range allowed. Choose a number within it.',
  shadow_unavailable: NEEDS_WORKERS('start trial runs'),
  shadow_feature_disabled:
    'Trial runs are off for this project. Switch on Trial runs under the project’s Rules & limits first.',
  shadow_shadow_not_allowed:
    'This project’s How much agents do alone setting does not allow trial runs. Set it to Observe to run a trial.',
  shadow_no_templates:
    'This project’s settings define no ticket template, so there is no pipeline to try. Add one in its settings.',
  task_start_unavailable: NEEDS_WORKERS('read a ticket to start'),
  no_task_management_binding:
    'This project has no ticket tracker connected. Connect one in its connections first.',
  project_does_not_pick_up_tickets:
    'This project is set to Observe, so it starts no tickets. Move How much agents do alone past Observe to start one.',
  ticket_has_task: 'That ticket already has a task. Open it from the board.',
  ticket_not_found: 'The tracker has no ticket with that key. Check the key and try again.',
  ticket_outside_binding_scope:
    'That ticket is outside the tracker projects this connection reads. Use a ticket from one of them, or add its project to the connection.',
  ticket_status_not_startable:
    'That ticket is in a status this project does not start work from, or one that means it is finished. Move it to a status work starts from in the tracker, or change those statuses in the project’s tracker settings.',
  ticket_unreadable: 'The ticket tracker did not answer. Try again in a moment.',
  lifecycle_status_unknown:
    'The tracker has no status by some of the names you chose. Pick them from the tracker’s list.',
  lifecycle_statuses_unavailable:
    'The tracker’s statuses could not be read, so nothing was saved. Try again in a moment.',
  project_has_live_tasks:
    'The project has tasks still in progress. Wait for them to finish or cancel them first.',
  project_stream_contended:
    'Other changes to this project kept getting in first, and nothing was saved. Send it again.',

  // The live stream's own subscription.
  connection_id_in_use: LIVE_UPDATES,
  invalid_topics: LIVE_UPDATES,
  too_many_topics: LIVE_UPDATES,

  // The platform's own failure: the request id is what an administrator finds it by.
  internal_error: (error) => {
    const id = detailOf(error, 'request_id');
    return id === undefined
      ? 'The server failed while doing this. Try again in a moment; if it keeps failing, report it with the time it happened.'
      : `The server failed while doing this. Try again in a moment; if it keeps failing, quote request id ${id} when you report this.`;
  },
};

/** The sentence `error`'s code has here, or `undefined` for a code this table does not hold. */
export const codeSentence = (error: ApiError): string | undefined => {
  const said = Object.hasOwn(CODE_SENTENCE, error.code) ? CODE_SENTENCE[error.code] : undefined;
  return said === undefined ? undefined : typeof said === 'string' ? said : said(error);
};
