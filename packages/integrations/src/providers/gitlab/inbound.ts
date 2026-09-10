/**
 * GitLab deliveries → catalogue events (technical/02, BD-022).
 *
 * Everything in a delivery is untrusted data: a merge-request description, a review comment and a
 * branch name are all attacker-writable in a fork workflow, and none of them is ever anything but
 * a payload field here. What *is* trusted is the identity, and only because the delivery was
 * verified first and the identity is then resolved against the platform's own user table
 * (`InboundContext.resolveUser`), never taken from the text.
 *
 * A delivery that produces no event says why. Four reasons exist and this normaliser uses three of
 * them deliberately:
 *  - `unsupported_event` — a kind or an action with no catalogue equivalent (an approval, a push
 *    to a feature branch, a pipeline that has not finished, a system note);
 *  - `not_for_this_project` — the binding names a project and the payload is about another one;
 *  - `malformed_payload` — the body failed its schema, or it is a merge-request note whose thread
 *    cannot be identified.
 */
import type {
  ExternalIdentity,
  GitProviderInboundEvent,
  IgnoredDelivery,
  InboundContext,
  NormalisedDelivery,
  NormalisedEvent,
  WebhookDelivery,
} from '@platform/application';
import type { Actor } from '@platform/contracts';
import { GITLAB_PROVIDER_ID } from './http.js';
import {
  pipelineStatusOrNull,
  terminalCiStatus,
  toIsoDateTime,
  toIsoDateTimeOrNull,
} from './mapping.js';
import {
  gitlabHookSchema,
  type MergeRequestHook,
  type NoteHook,
  type PipelineHook,
  type PushHook,
} from './webhook-payloads.js';

/** What the normaliser needs from the client: the one lookup a note delivery cannot avoid. */
export interface InboundDeps {
  /**
   * The discussion containing `noteId`, or `null` when none does.
   *
   * The published "Comment on a merge request" payload carries no `discussion_id`, and
   * `mr.review.comment` requires a `thread_id` that WP-15 will reply to. So the thread is looked
   * up from the discussions API, where `notes[].id` and `notes[].resolved` both live.
   */
  findThreadForNote(
    project: string,
    iid: number,
    noteId: number,
  ): Promise<{ readonly id: string; readonly resolved: boolean } | null>;
  /** `path_with_namespace` this binding serves, or `null` when it serves any. */
  readonly project: string | null;
}

const ignored = (
  reason: IgnoredDelivery['reason'],
  detail: string,
): NormalisedDelivery<GitProviderInboundEvent> => ({
  events: [],
  ignored: [{ reason, detail }],
});

const identityOf = (user: {
  id: number;
  name?: string | null;
  username?: string | null;
  email?: string | null;
}): ExternalIdentity => ({
  provider: GITLAB_PROVIDER_ID,
  external_id: String(user.id),
  email: user.email?.includes('@') === true ? user.email : null,
  display_name: user.name ?? user.username ?? null,
  verified: false,
});

/** The MR web URL, taking the fragment off a note URL (`…/merge_requests/1#note_1244`). */
const withoutFragment = (url: string): string => {
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
};

const projectPathOf = (
  hook: { project?: { path_with_namespace?: string | null } | null },
  fallback: string | null,
): string | null => hook.project?.path_with_namespace ?? fallback;

/**
 * GitLab's merge-request actions mapped onto the catalogue
 * (<https://docs.gitlab.com/user/project/integrations/webhook_events/>, "Merge request events").
 *
 * `approval`, `unapproval`, `approved` and `unapproved` have no catalogue event: technical/02 has
 * no approval event for a git provider, and folding them into `mr.updated` would put four
 * pipeline wake-ups where nothing about the merge request changed.
 */
const MR_ACTIONS: Readonly<Record<string, 'mr.opened' | 'mr.updated' | 'mr.merged' | 'mr.closed'>> =
  {
    open: 'mr.opened',
    reopen: 'mr.opened',
    update: 'mr.updated',
    merge: 'mr.merged',
    close: 'mr.closed',
  };

const normaliseMergeRequest = (
  hook: MergeRequestHook,
  context: InboundContext,
  actor: Actor,
  project: string,
): NormalisedDelivery<GitProviderInboundEvent> => {
  const attributes = hook.object_attributes;
  const action = attributes.action ?? '';
  const type = MR_ACTIONS[action];
  if (type === undefined) {
    return ignored('unsupported_event', `merge request action ${JSON.stringify(action)}`);
  }
  const headSha = attributes.last_commit?.id ?? null;
  if (headSha === null) {
    return ignored('malformed_payload', 'merge request delivery carries no last_commit.id');
  }
  const url = attributes.url ?? null;
  if (url === null) {
    return ignored('malformed_payload', 'merge request delivery carries no url');
  }

  const payload = {
    project_id: context.projectId,
    task_id: null,
    mr: {
      provider: GITLAB_PROVIDER_ID,
      project_path: project,
      iid: attributes.iid,
      url,
      branch: attributes.source_branch ?? null,
      head_sha: headSha,
    },
    draft: attributes.draft ?? attributes.work_in_progress ?? false,
    head_sha: headSha,
    // GitLab's REST merge request publishes `changes_count` (a file count, and the string "1000+"
    // above 1000) and no insertion/deletion counts, so there is nothing honest to put here. See
    // `provider.ts`'s divergence register.
    diff_stats: null,
  };

  if (type === 'mr.merged') {
    const event: NormalisedEvent<'mr.merged'> = {
      type,
      payload: { ...payload, merge_commit_sha: attributes.merge_commit_sha ?? null },
      actor,
    };
    return { events: [event], ignored: [] };
  }
  const event = { type, payload, actor } as NormalisedEvent<
    'mr.opened' | 'mr.updated' | 'mr.closed'
  >;
  return { events: [event], ignored: [] };
};

const normaliseNote = async (
  hook: NoteHook,
  context: InboundContext,
  actor: Actor,
  project: string,
  deps: InboundDeps,
): Promise<NormalisedDelivery<GitProviderInboundEvent>> => {
  const attributes = hook.object_attributes;
  if (attributes.noteable_type !== 'MergeRequest') {
    return ignored('unsupported_event', `note on ${JSON.stringify(attributes.noteable_type)}`);
  }
  if (attributes.system === true) {
    return ignored('unsupported_event', 'system note');
  }
  const iid = hook.merge_request?.iid;
  if (iid === undefined) {
    return ignored('malformed_payload', 'note delivery carries no merge_request.iid');
  }
  const url = attributes.url ?? null;
  if (url === null) {
    return ignored('malformed_payload', 'note delivery carries no url');
  }

  const thread = await deps.findThreadForNote(project, iid, attributes.id);
  if (thread === null) {
    return ignored(
      'malformed_payload',
      `note ${attributes.id} belongs to no discussion of ${project}!${iid}`,
    );
  }

  const base = identityOf(hook.user);
  const author: ExternalIdentity = { ...base, verified: context.resolveUser(base) !== null };
  const event: NormalisedEvent<'mr.review.comment'> = {
    type: 'mr.review.comment',
    payload: {
      project_id: context.projectId,
      task_id: null,
      mr: {
        provider: GITLAB_PROVIDER_ID,
        project_path: project,
        iid,
        url: withoutFragment(url),
        branch: hook.merge_request?.source_branch ?? null,
        head_sha: hook.merge_request?.last_commit?.id ?? null,
      },
      thread_id: thread.id,
      author,
      text: attributes.note,
      resolved: thread.resolved,
    },
    actor: { ...actor, identity: author } as Actor,
  };
  return { events: [event], ignored: [] };
};

const normalisePipeline = (
  hook: PipelineHook,
  context: InboundContext,
  actor: Actor,
  project: string,
): NormalisedDelivery<GitProviderInboundEvent> => {
  const attributes = hook.object_attributes;
  const mapped = pipelineStatusOrNull(attributes.status);
  if (mapped === null) {
    // A status this adapter has never heard of. GitLab adds them, and the port documents no
    // `@throws` here: throwing would turn a vendor's new pipeline state into a delivery that can
    // never be normalised and therefore a job that fails for ever. `MR_ACTIONS` already ignores an
    // action it does not handle; an unknown status is the same shape (WP-09 review round 1).
    return ignored(
      'unsupported_event',
      `unknown pipeline status ${JSON.stringify(attributes.status.slice(0, 32))}`,
    );
  }
  const status = terminalCiStatus(mapped);
  if (status === null) {
    // A pipeline hook fires on every status change; `ci.pipeline.finished` means finished.
    return ignored('unsupported_event', `pipeline status ${JSON.stringify(attributes.status)}`);
  }
  const failedJobs = (hook.builds ?? [])
    .filter((build) => build.status === 'failed' && build.allow_failure !== true)
    .map((build) => ({ name: build.name, log_ref: String(build.id) }));

  const event: NormalisedEvent<'ci.pipeline.finished'> = {
    type: 'ci.pipeline.finished',
    payload: {
      project_id: context.projectId,
      task_id: null,
      mr:
        hook.merge_request == null || hook.merge_request.url == null
          ? null
          : {
              provider: GITLAB_PROVIDER_ID,
              project_path: project,
              iid: hook.merge_request.iid,
              url: hook.merge_request.url,
              branch: hook.merge_request.source_branch ?? null,
              head_sha: attributes.sha,
            },
      head_sha: attributes.sha,
      status,
      failed_jobs: failedJobs,
      // The documented Pipeline Hook `builds[]` carries no `coverage`, and neither does
      // `object_attributes`. `getPipelineStatus` is the read that has it.
      coverage_pct: null,
    },
    actor,
  };
  return { events: [event], ignored: [] };
};

const HANDLED_KINDS: ReadonlySet<string> = new Set(['merge_request', 'note', 'pipeline', 'push']);

const ZERO_SHA = /^0{40,64}$/;

const normalisePush = (
  hook: PushHook,
  context: InboundContext,
  actor: Actor,
): NormalisedDelivery<GitProviderInboundEvent> => {
  const defaultBranch = hook.project?.default_branch ?? null;
  if (defaultBranch === null) {
    return ignored('malformed_payload', 'push delivery carries no project.default_branch');
  }
  if (hook.ref !== `refs/heads/${defaultBranch}`) {
    return ignored('unsupported_event', `push to ${hook.ref}, not the default branch`);
  }
  if (ZERO_SHA.test(hook.after)) {
    return ignored('unsupported_event', 'branch deletion');
  }
  const event: NormalisedEvent<'default_branch.moved'> = {
    type: 'default_branch.moved',
    payload: {
      project_id: context.projectId,
      branch: defaultBranch,
      new_head: hook.after,
    },
    actor,
  };
  return { events: [event], ignored: [] };
};

export const normaliseGitLabDelivery = async (
  delivery: WebhookDelivery,
  context: InboundContext,
  deps: InboundDeps,
): Promise<NormalisedDelivery<GitProviderInboundEvent>> => {
  let body: unknown;
  try {
    body = JSON.parse(delivery.body) as unknown;
  } catch {
    return ignored('malformed_payload', 'delivery body is not JSON');
  }
  // An `object_kind` this provider does not handle is `unsupported_event`, not a malformed one:
  // GitLab sends wiki, release, deployment and member hooks from the same endpoint, and calling
  // them malformed would make a real defect indistinguishable from a subscription nobody wanted.
  const kind = (body as { object_kind?: unknown })?.object_kind;
  if (typeof kind !== 'string') {
    return ignored('malformed_payload', 'delivery carries no object_kind');
  }
  if (!HANDLED_KINDS.has(kind)) {
    return ignored('unsupported_event', `object_kind ${JSON.stringify(kind.slice(0, 32))}`);
  }

  const parsed = gitlabHookSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return ignored(
      'malformed_payload',
      issue === undefined
        ? 'delivery did not match any known GitLab hook'
        : `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
  }
  const hook = parsed.data;

  const project = projectPathOf(hook, deps.project);
  if (project === null) {
    return ignored('malformed_payload', 'delivery carries no project.path_with_namespace');
  }
  if (deps.project !== null && project !== deps.project) {
    return ignored('not_for_this_project', `delivery is about ${project}`);
  }

  const actor: Actor = {
    kind: 'integration',
    integration_id: context.integrationId,
    provider: GITLAB_PROVIDER_ID,
  };

  switch (hook.object_kind) {
    case 'merge_request':
      return normaliseMergeRequest(hook, context, actor, project);
    case 'note':
      return normaliseNote(hook, context, actor, project, deps);
    case 'pipeline':
      return normalisePipeline(hook, context, actor, project);
    case 'push':
      return normalisePush(hook, context, actor);
    default:
      return ignored('unsupported_event', 'unknown object_kind');
  }
};

/** Re-exported so the provider can stamp a note's `created_at` when it needs one. */
export { toIsoDateTime, toIsoDateTimeOrNull };
