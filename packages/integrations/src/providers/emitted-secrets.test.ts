/**
 * **Every string the Jira and GitLab adapters emit, walked rather than listed, with the binding's
 * own credential planted in all of them** — the follow-up to WP-11, standing rules 31 and 35
 * (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * WP-11 made `ProviderCreateInput.redactor` **required** to close standing rule 31 ("an optional
 * security dependency is an absent one"). Merging Slack proved that was not enough: a required
 * field is checked where the object is *built*, not where it is *read*, so four test call sites
 * turned the build green while the adapter redacted nothing. That is standing rule 35, and a
 * reviewer then found the same shape twice more, on `main`, with working exploits:
 *
 *  - **gitlab** used the redactor it was handed but composed **no** `bindingSecretRedactor`, so
 *    its own `PRIVATE-TOKEN` was not in the set being redacted. Built through
 *    `gitlabProviderRegistration.create` with `noSecretsRedactor()`, `getJobLog` returned
 *    `PRIVATE-TOKEN: glpat-PLANTED-…` verbatim.
 *  - **jira** applied its redactor to `HealthProbe.detail` **only**. Ticket and comment text
 *    reached the caller unredacted, and the executor does not compensate: `action-executor.ts`
 *    redacts the audit **row**, not the value it hands back.
 *
 * Neither adapter's own review saw it, because each reviewed a call site that *did* redact. The
 * enumeration is therefore executed rather than written down (standing rules 30 and 33), and it is
 * the redaction dual of `emitted-bounds.test.ts`: that file walks what the observability adapters
 * emit and fails on any string past the largest named cap; this one walks what the tracker and the
 * git provider emit and fails on any string carrying a credential.
 *
 * ## The instrument, and why each part of it is load-bearing
 *
 *  1. **Through the real registration.** `create` is the only production path, and it is what the
 *     four green test call sites of rule 35 were not.
 *  2. **`noSecretsRedactor()` as the caller's redactor**, so the caller is *disarmed*: anything
 *     redacted below can only have been redacted by the adapter's own composed redactor. With a
 *     correctly-built caller redactor in place, every assertion here would pass whichever layer
 *     fired and neither would be proved (standing rule 9).
 *  3. **The credential planted in every string the provider can produce**, including record keys,
 *     because a key is emitted text too, and including the failure branches: WP-07's review found
 *     redaction present on a success path and missing on the failure path three times in one file.
 *  4. **Each answer walked to its leaves and asserted by path**, so a failure names the field, and
 *     the serialised whole asserted as well, so a leaf the walk cannot reach still fails.
 *  5. **A positive assertion that the plant arrived**: every method is asserted to carry the
 *     placeholder somewhere. Without it a harness that never reached the provider — a typo in a
 *     scripted path, a method that threw early — would pass by emitting nothing at all (standing
 *     rules 4, 10 and 42).
 *
 * ## What it cannot cover, stated rather than implied
 *
 *  - **A secret the platform never told the adapter about.** `SecretRedactor` is TD-012 step 1,
 *    exact match over injected values; a credential belonging to somebody else, or one an operator
 *    typed into a ticket that this binding does not hold, is step 2's job (the gitleaks rule
 *    subset) and does not exist yet.
 *  - **A secret cut into fragments by the provider itself.** Redaction happens before every cap
 *    this ring applies, which is what `http.ts` and `client.ts` assert; a provider that returned
 *    half a token in one field and half in another is not matchable by construction.
 *  - **Bounds.** A redacted string can still be a 2 MB one; that is `emitted-bounds.test.ts`, and
 *    these two adapters are deliberately **not** in it — see `docs/OPEN-QUESTIONS.md` Q54, and
 *    `unbounded-emission.test.ts`, which measures what one call of each hands over.
 *  - **Where the value goes next.** What `IntegrationActionExecutor` writes to
 *    `integration_actions`, and what WP-15 appends to `events.payload`, have their own redaction
 *    obligations; this file bounds what the adapters hand over.
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type IntegrationError,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type GitLabProvider, gitlabProviderRegistration } from './gitlab/index.js';
import { createJiraCloudRegistration } from './jira-cloud/registration.js';
import { signWebhookBody } from './jira-cloud/webhook.js';

const NOW = '2026-06-01T10:30:00.000Z' as const;

/**
 * The three GitLab credentials and the two Jira ones, in the obviously-fake shape the repository
 * requires (BD-002) and long enough to clear `MIN_SECRET_LENGTH`.
 */
const GITLAB_TOKEN = 'glpat-FAKE-PLANTED-binding-token-0123456789';
const GITLAB_WEBHOOK_SECRET = 'FAKE-PLANTED-gitlab-webhook-secret-token-01';
const GITLAB_SIGNING_TOKEN = 'whsec_FAKE-PLANTED-gitlab-signing-token-0123';
const JIRA_TOKEN = 'FAKE-PLANTED-jira-api-token-0123456789';
const JIRA_WEBHOOK_SECRET = 'FAKE-PLANTED-jira-webhook-secret-0123456789';
const JIRA_EMAIL = 'agentic-bot@example.test';

/** `Basic base64(email:token)` without its scheme — a credential the token is not a substring of. */
const JIRA_BASIC = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`, 'utf8').toString('base64');

// ── The walk ─────────────────────────────────────────────────────────────────

interface EmittedString {
  readonly path: string;
  readonly text: string;
}

/**
 * Every string in an emitted value, with the path it sits at — **keys included**, because a record
 * key is provider text the platform stores and renders (the lesson `emitted-bounds.test.ts` learned
 * from a 2 MB tag *name*).
 */
const walkStrings = (value: unknown, path = '$'): EmittedString[] => {
  if (typeof value === 'string') {
    return [{ path, text: value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => walkStrings(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [
      { path: `${path}.<key ${key}>`, text: key },
      ...walkStrings(item, `${path}.${key}`),
    ]);
  }
  return [];
};

/** Everything pino would print out of an error: message, own keys, and the whole cause chain. */
const serialiseLikePino = (error: unknown): string => {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    parts.push(String(record.message ?? ''), String(record.stack ?? ''));
    for (const key of Object.keys(record)) {
      if (key !== 'cause') {
        try {
          parts.push(JSON.stringify(record[key]) ?? '');
        } catch {
          parts.push(String(record[key]));
        }
      }
    }
    current = record.cause;
  }
  return parts.join('\n');
};

/**
 * The assertions every emitted value gets, named so a failure says which field and which secret.
 *
 * `expect(paths).toEqual([])` rather than `expect(text).not.toContain(secret)` because the failure
 * message then *lists the leaking fields* instead of naming one.
 */
const assertNoSecret = (
  label: string,
  value: unknown,
  secrets: Readonly<Record<string, string>>,
): void => {
  const strings = walkStrings(value);
  const serialised = JSON.stringify(value) ?? '';
  for (const [name, secret] of Object.entries(secrets)) {
    expect(
      strings.filter((entry) => entry.text.includes(secret)).map((entry) => entry.path),
      `${label}: no emitted string may carry ${name}`,
    ).toEqual([]);
    // **Parameterised over the provider's own secret**, which it was not until review round 2: the
    // prefix was hard-coded to `GITLAB_TOKEN.slice(0, 24)`, so every run of this helper over a
    // *Jira* answer asserted a GitLab constant and could not fail (standing rule 10). A prefix
    // rather than the whole value, because the failure it is here to catch is a **cut** — a cap
    // applied before redaction leaves the leading bytes and nothing else would see them.
    expect(
      serialised,
      `${label}: nor may the serialised whole carry a fragment of ${name} — an audit row and a context pack are exactly this string`,
    ).not.toContain(secret.slice(0, Math.min(24, secret.length)));
  }
};

/**
 * **The emission surface, asked of the port object rather than remembered** (standing rules 7 and
 * 37).
 *
 * Review round 1 walked eighteen GitLab answers and eleven Jira ones and called the enumeration
 * complete; a reviewer counting the *members* found five that no scenario drove — `cloneUrl`,
 * `revokeCredential`, `isBranchProtected`, `inbound.verify` and `inbound.deliveryKey` on GitLab,
 * `linkMergeRequest` on Jira — and one of them, `deliveryKey`, turned out to copy a **header
 * value** into a stored string with no redactor anywhere on the path. A list of what was walked is
 * not a list of what is emitted, which is rule 37 in the redaction register instead of the cap one.
 *
 * So the list is derived from the object: every own key of the port, with `inbound` expanded to its
 * own members. A method added to a provider fails this test until somebody drives it and decides
 * what it may emit. It can only make the build red — it holds no allow-list (rule 7's corollary).
 */
const surfaceOf = (port: object): string[] =>
  Object.keys(port)
    .flatMap((name) =>
      name === 'inbound'
        ? Object.keys((port as { inbound: object }).inbound).map((inner) => `inbound.${inner}`)
        : [name],
    )
    .sort();

/** The plant arrived: a method whose harness never reached the provider emits nothing to redact. */
const assertRedactionHappened = (label: string, value: unknown): void => {
  const marked = walkStrings(value).filter((entry) =>
    entry.text.includes('[REDACTED:integration:'),
  );
  expect(
    marked.length,
    `${label}: the planted credential must actually have reached an emitted field`,
  ).toBeGreaterThan(0);
};

// ── GitLab ───────────────────────────────────────────────────────────────────

const HOST = 'https://gitlab.example.test';
const PROJECT = 'acme/api';
const P = 'acme%2Fapi';
const SHA = '1111111111111111111111111111111111111111';
const DISCUSSION = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';

/** Planted everywhere GitLab's user shape has a string. */
const gitlabUser = (id: number) => ({
  id,
  username: `bot-${GITLAB_TOKEN}`,
  name: `Agentic ${GITLAB_TOKEN}`,
  // **Not** planted, and the reason is worth recording: `ExternalIdentity.email` is
  // `z.email()`, and a placeholder contains `[`, `]` and `:`, so a credential arriving in an
  // email field makes the *redacted* response fail its own schema — `invalid_response` rather
  // than a leak. That is the fail-closed direction and it is left as it is, but it means this
  // walk cannot carry a plant through that field.
  email: 'dana@example.test',
  web_url: `${HOST}/u/${GITLAB_TOKEN}`,
});

const gitlabMr = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 155016007,
  iid: 7,
  project_id: 1,
  title: `Draft: fix ${GITLAB_TOKEN}`,
  description: `PRIVATE-TOKEN: ${GITLAB_TOKEN}\nand the hook secret ${GITLAB_WEBHOOK_SECRET}`,
  state: 'opened',
  draft: true,
  source_branch: `agentic/${GITLAB_TOKEN}`,
  target_branch: 'main',
  sha: SHA,
  merge_status: 'can_be_merged',
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  labels: [`needs-${GITLAB_TOKEN}`],
  author: gitlabUser(4242),
  reviewers: [gitlabUser(4243)],
  merged_at: null,
  web_url: `${HOST}/acme/api/-/merge_requests/7#${GITLAB_TOKEN}`,
  diff_refs: {
    base_sha: '2222222222222222222222222222222222222222',
    head_sha: SHA,
    start_sha: '2222222222222222222222222222222222222222',
  },
  ...overrides,
});

const gitlabDiscussion = () => ({
  id: DISCUSSION,
  notes: [
    {
      id: 900,
      body: `please rotate ${GITLAB_TOKEN}`,
      author: gitlabUser(4244),
      created_at: NOW,
      system: false,
      resolvable: true,
      resolved: false,
      position: { new_path: `src/${GITLAB_TOKEN}.ts`, new_line: 12 },
    },
  ],
});

/** `METHOD /path` without the query string; the scripted body is returned as JSON or as text. */
type Script = Record<string, { status?: number; body?: unknown; text?: string }>;

const gitlabScript = (): Script => ({
  'GET /version': { body: { version: `18.1.1 ${GITLAB_TOKEN}`, enterprise: true } },
  [`GET /projects/${P}`]: {
    body: {
      id: 1,
      path_with_namespace: PROJECT,
      // **Not** planted: this value is fed straight back into the next request's URL, so a
      // credential here would be redacted and then *addressed* — the adapter would ask GitLab for
      // `branches/[REDACTED:…]` and get a 404. Fail-closed, and left as it is, but it means the
      // plant for `getDefaultBranchHead` has to sit on the branch's own `name` instead.
      default_branch: 'main',
      web_url: `${HOST}/acme/api`,
    },
  },
  [`GET /projects/${P}/repository/branches/main`]: {
    body: {
      name: `main-${GITLAB_TOKEN}`,
      protected: true,
      commit: { id: SHA, title: `chore ${GITLAB_TOKEN}` },
    },
  },
  [`GET /projects/${P}/protected_branches/main`]: {
    body: {
      name: `main-${GITLAB_TOKEN}`,
      allow_force_push: false,
      code_owner_approval_required: true,
      push_access_levels: [{ access_level: 30, access_level_description: GITLAB_TOKEN }],
      merge_access_levels: [{ access_level: 40 }],
    },
  },
  [`POST /projects/${P}/repository/commits`]: {
    status: 201,
    body: {
      id: SHA,
      short_id: SHA.slice(0, 8),
      // Planted: a commit's own message comes back from the provider, and the platform puts it in
      // an audit payload and a log line.
      title: `docs(knowledge) ${GITLAB_TOKEN}`,
      message: `docs(knowledge) ${GITLAB_TOKEN}`,
      web_url: `${HOST}/acme/api/-/commit/${SHA}`,
    },
  },
  [`POST /projects/${P}/merge_requests`]: { status: 201, body: gitlabMr() },
  [`PUT /projects/${P}/merge_requests/7`]: { body: gitlabMr() },
  [`GET /projects/${P}/merge_requests/7`]: { body: gitlabMr() },
  [`GET /projects/${P}/merge_requests`]: {
    body: [gitlabMr({ merged_at: NOW, state: 'merged' })],
  },
  [`GET /projects/${P}/merge_requests/7/discussions`]: { body: [gitlabDiscussion()] },
  [`GET /projects/${P}/merge_requests/7/discussions/${DISCUSSION}`]: { body: gitlabDiscussion() },
  [`POST /projects/${P}/merge_requests/7/discussions`]: { status: 201, body: gitlabDiscussion() },
  [`POST /projects/${P}/merge_requests/7/discussions/${DISCUSSION}/notes`]: {
    status: 201,
    body: {
      id: 901,
      body: `ok ${GITLAB_TOKEN}`,
      author: gitlabUser(4245),
      created_at: NOW,
      system: false,
    },
  },
  [`PUT /projects/${P}/merge_requests/7/discussions/${DISCUSSION}`]: { body: gitlabDiscussion() },
  [`GET /projects/${P}/pipelines`]: { body: [{ id: 900, sha: SHA, status: 'success' }] },
  [`GET /projects/${P}/pipelines/900`]: {
    body: {
      id: 900,
      sha: SHA,
      status: 'success',
      web_url: `${HOST}/acme/api/-/pipelines/900?trace=${encodeURIComponent(GITLAB_TOKEN)}`,
      finished_at: NOW,
    },
  },
  [`GET /projects/${P}/pipelines/900/jobs`]: {
    body: [{ id: 9002, name: `build ${GITLAB_TOKEN}`, status: 'success', allow_failure: false }],
  },
  [`GET /projects/${P}/jobs/9002/trace`]: {
    text: `$ echo pushing\nremote: https://oauth2:${GITLAB_TOKEN}@gitlab.example.test/acme/api\nfatal\n`,
  },
  [`GET /projects/${P}/repository/files/CODEOWNERS/raw`]: {
    // Both halves of a rule are provider text: the pattern is kept verbatim, and the owner list is
    // matched by shape — so the placeholder survives in the pattern and the owner match stops at
    // the `[`, which is why the plant is on both.
    text: `src/${GITLAB_TOKEN}/ @team-${GITLAB_TOKEN}\n`,
  },
  [`DELETE /projects/${P}/access_tokens/55`]: { status: 204 },
  [`POST /projects/${P}/access_tokens`]: {
    status: 201,
    body: {
      id: 55,
      name: `agentic-push ${GITLAB_TOKEN}`,
      scopes: ['write_repository'],
      expires_at: '2026-06-03',
      token: MINTED,
    },
  },
});

/** The credential the adapter *mints* is not the binding's, and must survive intact. */
const MINTED = 'glpat-FAKE-minted-workspace-token-987654321';

const stubFetch = (script: Script, calls: { method: string; path: string; body: string }[]) => {
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/v4', '').replace('/rest/api/3', '');
    const body = request.method === 'GET' ? '' : await request.clone().text();
    calls.push({ method: request.method, path, body });
    const scripted = script[`${request.method} ${path}`];
    if (scripted === undefined) {
      return new Response(JSON.stringify({ message: 'not scripted' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const status = scripted.status ?? 200;
    return new Response(
      // 204 is a null-body status: undici refuses to construct a `Response` with both.
      status === 204 ? null : (scripted.text ?? JSON.stringify(scripted.body ?? {})),
      {
        status,
        headers: {
          'content-type': scripted.text === undefined ? 'application/json' : 'text/plain',
        },
      },
    );
  });
};

const GITLAB_SECRETS = {
  'the binding token': GITLAB_TOKEN,
  'the webhook secret token': GITLAB_WEBHOOK_SECRET,
  'the webhook signing token': GITLAB_SIGNING_TOKEN,
};

/**
 * Scenario → the **port member** it drives.
 *
 * Two things are derived from this one object and neither is a second list: the `it.each` that
 * asserts each answer, and the enumeration that holds the set of members against
 * `surfaceOf(port)`. Two scenarios may name one member (`inbound.normalise` is driven on both its
 * branches); no member may go unnamed.
 */
const GITLAB_SCENARIOS: Readonly<Record<string, string>> = {
  ref: 'ref',
  capabilities: 'capabilities',
  test_connection: 'testConnection',
  clone_url: 'cloneUrl',
  mint_credential: 'mintCredential',
  revoke_credential: 'revokeCredential',
  commit_files: 'commitFiles',
  open_merge_request: 'openMergeRequest',
  update_merge_request: 'updateMergeRequest',
  get_merge_request: 'getMergeRequest',
  list_discussions: 'listDiscussions',
  reply_to_discussion: 'replyToDiscussion',
  resolve_discussion: 'resolveDiscussion',
  create_discussion: 'createDiscussion',
  get_pipeline_status: 'getPipelineStatus',
  get_job_log: 'getJobLog',
  get_default_branch_head: 'getDefaultBranchHead',
  read_codeowners: 'readCodeowners',
  list_merged_merge_requests: 'listMergedMergeRequests',
  is_branch_protected: 'isBranchProtected',
  branch_protection: 'branchProtection',
  instance_version: 'instanceVersion',
  verify_delivery: 'inbound.verify',
  delivery_key: 'inbound.deliveryKey',
  normalise_delivery: 'inbound.normalise',
  ignored_delivery: 'inbound.normalise',
};

describe('gitlab emits no string carrying its own credentials (rules 31, 35)', () => {
  const emitted: Record<string, unknown> = {};
  const calls: { method: string; path: string; body: string }[] = [];
  let surface: string[] = [];

  beforeAll(async () => {
    stubFetch(gitlabScript(), calls);
    // The real registration, and a caller redactor that knows **nothing** — so every placeholder
    // below can only have been written by the adapter's own composed redactor.
    const port = gitlabProviderRegistration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a9',
      config: { base_url: HOST, project: PROJECT, mint_credentials: true, request_timeout_ms: 0 },
      secrets: {
        token: GITLAB_TOKEN,
        webhook_secret_token: GITLAB_WEBHOOK_SECRET,
        webhook_signing_token: GITLAB_SIGNING_TOKEN,
      },
      redactor: noSecretsRedactor(),
    });

    const ref = {
      provider: 'gitlab',
      project_path: PROJECT,
      iid: 7,
      url: `${HOST}/acme/api/-/merge_requests/7`,
      branch: null,
      head_sha: null,
    } as const;

    surface = surfaceOf(port);
    emitted.ref = port.ref;
    emitted.capabilities = port.capabilities();
    emitted.test_connection = await port.testConnection();
    emitted.commit_files = await port.commitFiles({
      project: PROJECT,
      branch: 'agentic/knowledge/2026-09-12-abcdef01',
      start_branch: 'main',
      // The platform's own emission again: a knowledge page a model wrote may repeat anything it
      // was shown, and the message and the content both travel to the provider and back.
      message: `docs(knowledge): apply 1 proposal\n\nseen: ${GITLAB_TOKEN}\n`,
      author_name: 'Agentic',
      author_email: 'agentic@platform.invalid',
      actions: [
        {
          action: 'create',
          path: '.agentic/knowledge/lessons/L-1.md',
          content: `the token was ${GITLAB_TOKEN}`,
        },
      ],
    });
    emitted.open_merge_request = await port.openMergeRequest({
      project: PROJECT,
      branch: 'agentic/task-1',
      target: 'main',
      title: 'fix the totals',
      // The platform's own emission: an agent that pasted its remote into a description publishes
      // the credential to every human on the merge request.
      description: `debug output: PRIVATE-TOKEN ${GITLAB_TOKEN}`,
      draft: true,
      labels: ['agentic'],
      reviewers: [],
      remove_source_branch: true,
    });
    emitted.update_merge_request = await port.updateMergeRequest(ref, {
      description: `still ${GITLAB_TOKEN}`,
    });
    emitted.get_merge_request = await port.getMergeRequest(ref);
    emitted.list_discussions = await port.listDiscussions(ref);
    emitted.reply_to_discussion = await port.replyToDiscussion(
      ref,
      DISCUSSION,
      `rotating ${GITLAB_TOKEN}`,
    );
    emitted.resolve_discussion = await port.resolveDiscussion(ref, DISCUSSION);
    emitted.create_discussion = await port.createDiscussion(ref, {
      path: 'src/app.ts',
      line: 12,
      markdown: `found ${GITLAB_TOKEN}`,
    });
    emitted.get_pipeline_status = await port.getPipelineStatus(PROJECT, SHA);
    emitted.get_job_log = await port.getJobLog(PROJECT, '9002');
    emitted.get_default_branch_head = await port.getDefaultBranchHead(PROJECT);
    emitted.read_codeowners = await port.readCodeowners(PROJECT, 'main');
    emitted.list_merged_merge_requests = await port.listMergedMergeRequests(
      PROJECT,
      '2026-01-01T00:00:00.000Z',
      5,
    );
    // `create` is typed as the *type port*, which is the whole of BD-017 — so GitLab's own two
    // extras are reached through the same instance, narrowed back. They emit provider text
    // (`branchProtection.name`, `instanceVersion.version`) and belong in the walk.
    const gitlab = port as GitLabProvider;
    emitted.branch_protection = await gitlab.branchProtection(PROJECT, 'main');
    emitted.instance_version = await gitlab.instanceVersion();
    emitted.mint_credential = await port.mintCredential({
      project: PROJECT,
      scope: 'push',
      ttlSeconds: 3600,
    });
    // `cloneUrl` before the revocation, because a revoked handle is refused: it is the one method
    // whose product **is** a credential, so it is asserted separately below.
    emitted.clone_url = port.cloneUrl(
      PROJECT,
      emitted.mint_credential as Parameters<typeof port.cloneUrl>[1],
    );
    emitted.revoke_credential = await port.revokeCredential(
      emitted.mint_credential as Parameters<typeof port.revokeCredential>[0],
    );
    emitted.is_branch_protected = await (port as GitLabProvider).isBranchProtected(PROJECT, 'main');
    // **The header plant.** `X-Gitlab-Token` *is* the webhook secret — this is what a real
    // delivery carries — and `verify` and `deliveryKey` are the two members that read a header.
    // Round 1 walked neither, and `deliveryKey` copied a delivery's own text into a stored string
    // with nothing redacting it.
    const keyableDelivery = {
      headers: {
        'x-gitlab-event': 'Merge Request Hook',
        'x-gitlab-token': GITLAB_WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        object_kind: 'merge_request',
        object_attributes: { id: 155016007, updated_at: `2026-06-01T09:00:00.000Z` },
      }),
    };
    emitted.verify_delivery = port.inbound.verify(keyableDelivery);
    emitted.delivery_key = port.inbound.deliveryKey({
      headers: keyableDelivery.headers,
      body: JSON.stringify({
        object_kind: 'push',
        ref: `refs/heads/agentic/${GITLAB_TOKEN}`,
        after: SHA,
      }),
    });
    emitted.normalise_delivery = await port.inbound.normalise(
      {
        headers: {
          'x-gitlab-event': 'Merge Request Hook',
          'x-gitlab-token': GITLAB_WEBHOOK_SECRET,
        },
        body: JSON.stringify({
          object_kind: 'merge_request',
          project: {
            id: 1,
            name: 'api',
            web_url: `${HOST}/acme/api`,
            path_with_namespace: PROJECT,
            default_branch: 'main',
          },
          user: gitlabUser(4242),
          object_attributes: {
            id: 155016007,
            iid: 7,
            title: `Draft: ${GITLAB_TOKEN}`,
            description: `hook secret ${GITLAB_WEBHOOK_SECRET}`,
            state: 'opened',
            action: 'open',
            // The payload of `mr.opened` carries the ref, not the prose: `title` and `description`
            // are dropped by the normaliser, so the plant that has to survive into
            // `events.payload` is the one on the branch name.
            source_branch: `agentic/${GITLAB_TOKEN}`,
            target_branch: 'main',
            url: `${HOST}/acme/api/-/merge_requests/7`,
            last_commit: { id: SHA },
          },
          labels: [],
        }),
      },
      {
        integrationId: '00000000-0000-4000-8000-0000000000a9',
        projectId: '00000000-0000-4000-8000-0000000000b9',
        resolveUser: () => null,
      },
    );
    // The ignored branch, whose `detail` quotes provider text **and cuts it to 32 characters** —
    // the case that proves redaction precedes the cut rather than following it.
    emitted.ignored_delivery = await port.inbound.normalise(
      { headers: {}, body: JSON.stringify({ object_kind: `wiki_${GITLAB_SIGNING_TOKEN}` }) },
      {
        integrationId: '00000000-0000-4000-8000-0000000000a9',
        projectId: '00000000-0000-4000-8000-0000000000b9',
        resolveUser: () => null,
      },
    );
  });

  it('drove every member of the port, and the list is the port’s own', () => {
    expect(
      [...new Set(Object.values(GITLAB_SCENARIOS))].sort(),
      'a member with no scenario is a member nothing asserts anything about',
    ).toEqual(surface);
    expect(
      Object.keys(emitted).sort(),
      'and every scenario ran: a name here with no answer is a call that threw or was dropped',
    ).toEqual(Object.keys(GITLAB_SCENARIOS).sort());
    expect(calls.length, 'the harness reached the provider').toBeGreaterThan(15);
  });

  it.each(Object.keys(GITLAB_SCENARIOS))(
    '%s emits no field carrying a binding credential',
    (method) => {
      assertNoSecret(method, emitted[method], GITLAB_SECRETS);
    },
  );

  it.each([
    'test_connection',
    'open_merge_request',
    'get_merge_request',
    'list_discussions',
    'get_pipeline_status',
    'get_job_log',
    'get_default_branch_head',
    'read_codeowners',
    'normalise_delivery',
    'ignored_delivery',
    'delivery_key',
  ])('%s actually carried the plant, so the assertion is not vacuous', (method) => {
    assertRedactionHappened(method, emitted[method]);
  });

  /**
   * `verify` emits a boolean, so the walk over it is vacuous by construction — what it can prove
   * is that the harness fed the real thing. The delivery carries `X-Gitlab-Token: <the binding's
   * webhook secret>`, which is what GitLab actually sends, so a `true` here says the plant is the
   * binding's own credential arriving on a header (standing rule 4: show the harness can reach the
   * accepted state before believing anything it says about the rejected one).
   */
  it('verified a delivery whose header carries the binding’s own webhook secret', () => {
    expect(emitted.verify_delivery, 'the plant is a real, accepted delivery').toBe(true);
  });

  it('redacts the request document too, which is what an MR description publishes', () => {
    const posted = calls.filter((call) => call.body !== '');
    expect(posted.length, 'the harness posted something').toBeGreaterThan(3);
    for (const call of posted) {
      expect(call.body, `${call.method} ${call.path}`).not.toContain(GITLAB_TOKEN);
    }
    expect(
      posted.some((call) => call.body.includes('[REDACTED:integration:gitlab_token]')),
      'and the placeholder proves the plant reached a request body',
    ).toBe(true);
  });

  /**
   * The one string that must **not** be redacted: the credential this adapter minted itself.
   *
   * A transport pass over every response document could just as easily eat the value the port
   * exists to hand out, and a workspace that clones with `[REDACTED:…]` fails far from here.
   */
  it('hands back the credential it minted, intact, and a clone URL that still works', () => {
    const minted = emitted.mint_credential as { value: string; revokeId: string | null };
    expect(minted.value, 'the minted token is the product, not a leak').toBe(MINTED);
    expect(minted.revokeId).toBe(`${PROJECT}#55`);
    // `cloneUrl` is the second half of the same argument, and it is the reason the *minted*
    // credential is deliberately absent from the binding redactor (`provider.ts`): a redacted
    // clone URL is a workspace that cannot clone, failing a long way from here.
    expect(
      emitted.clone_url,
      'the URL percent-encodes the token, which is what git needs',
    ).toContain(encodeURIComponent(MINTED));
  });

  it('keeps the credentials out of a failure branch as well', async () => {
    const failing = gitlabProviderRegistration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a9',
      config: { base_url: HOST, project: PROJECT, request_timeout_ms: 0 },
      secrets: { token: GITLAB_TOKEN, webhook_secret_token: GITLAB_WEBHOOK_SECRET },
      redactor: noSecretsRedactor(),
    });
    const errors: unknown[] = [];
    const script: Script = {
      // A provider that quotes the request back at us, on the branch that builds a message.
      'GET /version': {
        status: 401,
        body: { message: `401 Unauthorized for ${GITLAB_TOKEN}`, request: { token: GITLAB_TOKEN } },
      },
      [`GET /projects/${P}/jobs/9002/trace`]: { status: 404, body: { message: GITLAB_TOKEN } },
    };
    stubFetch(script, []);
    for (const call of [
      () => failing.testConnection(),
      () => failing.getJobLog(PROJECT, '9002'),
      () =>
        failing.getMergeRequest({
          provider: 'gitlab',
          project_path: PROJECT,
          iid: 7,
          url: `${HOST}/acme/api/-/merge_requests/7`,
        }),
      // The refusal `revokeCredential` owes divergence 6: a handle this provider did **not** mint,
      // whose address it therefore names in the message. The address comes out of the caller's
      // `revokeId`, so it is caller text (BD-022) on a path that never crosses `http.ts`.
      () =>
        failing.revokeCredential({
          username: 'oauth2',
          value: 'glpat-FAKE-someone-elses-token-000000000',
          scope: 'push',
          branchPatterns: [],
          expiresAt: '2026-06-03T23:59:59.000Z',
          revokeId: `acme/${GITLAB_TOKEN}#7`,
        }),
    ]) {
      try {
        await call();
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors.length, 'all four failed, which is what this test needs').toBe(4);
    for (const error of errors) {
      const serialised = serialiseLikePino(error);
      for (const [name, secret] of Object.entries(GITLAB_SECRETS)) {
        expect(serialised, `a failure branch must not carry ${name}`).not.toContain(secret);
      }
      expect((error as IntegrationError).code).toBeTruthy();
    }
  });
});

// ── Jira Cloud ───────────────────────────────────────────────────────────────

const SITE = 'https://acme-example.atlassian.net';
const KEY = 'ACME-1';

const jiraUser = () => ({
  accountId: '557058:00000000-0000-4000-8000-00000000d0c1',
  displayName: `Dana ${JIRA_TOKEN}`,
  emailAddress: `${JIRA_TOKEN}@example.test`,
});

const adf = (text: string) => ({
  type: 'doc',
  version: 1,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const jiraIssue = () => ({
  id: '10001',
  key: KEY,
  fields: {
    summary: `Fix the totals ${JIRA_TOKEN}`,
    description: adf(`the api token is ${JIRA_TOKEN} and the hook secret ${JIRA_WEBHOOK_SECRET}`),
    issuetype: { name: `Bug ${JIRA_TOKEN}` },
    status: { name: `In Progress ${JIRA_TOKEN}` },
    priority: { name: `High ${JIRA_TOKEN}` },
    labels: [`agentic-${JIRA_TOKEN}`],
    updated: '2026-06-01T09:00:00.000+0000',
    assignee: jiraUser(),
    reporter: jiraUser(),
    issuelinks: [],
  },
});

const jiraComment = () => ({
  id: '20001',
  author: jiraUser(),
  body: adf(`rotate ${JIRA_TOKEN} please, and ${JIRA_BASIC} too`),
  created: '2026-06-01T09:10:00.000+0000',
  updated: '2026-06-01T09:10:00.000+0000',
});

const jiraScript = (): Script => ({
  'GET /myself': { body: jiraUser() },
  [`GET /issue/${KEY}`]: { body: jiraIssue() },
  [`GET /issue/${KEY}/comment`]: { body: { comments: [jiraComment()], total: 1 } },
  [`GET /issue/${KEY}/remotelink`]: {
    body: [
      {
        id: 1,
        object: { url: `${SITE}/browse/${KEY}`, title: `link ${JIRA_TOKEN}` },
      },
    ],
  },
  'GET /search/jql': { body: { issues: [jiraIssue()], total: 1, isLast: true } },
  [`GET /issue/${KEY}/transitions`]: {
    body: { transitions: [{ id: '31', name: `Done ${JIRA_TOKEN}`, to: { name: 'Done' } }] },
  },
  [`POST /issue/${KEY}/transitions`]: { status: 204, body: {} },
  [`POST /issue/${KEY}/comment`]: { status: 201, body: jiraComment() },
  [`PUT /issue/${KEY}/comment/20001`]: { body: jiraComment() },
  [`PUT /issue/${KEY}`]: { status: 204, body: {} },
  [`POST /issue/${KEY}/remotelink`]: { status: 201, body: { id: 1 } },
  'POST /issue': {
    status: 201,
    body: { id: '10002', key: 'ACME-2', self: `${SITE}/rest/api/3/issue/10002` },
  },
  'GET /user/search': { body: [jiraUser()] },
});

const JIRA_SECRETS = {
  'the api token': JIRA_TOKEN,
  'the Basic authorization value': JIRA_BASIC,
  'the webhook secret': JIRA_WEBHOOK_SECRET,
};

/** Scenario → port member, as for GitLab. `surfaceOf` holds the values to the object's own keys. */
const JIRA_SCENARIOS: Readonly<Record<string, string>> = {
  ref: 'ref',
  capabilities: 'capabilities',
  test_connection: 'testConnection',
  read_ticket: 'readTicket',
  match_tickets: 'matchTickets',
  transition: 'transition',
  upsert_workpad: 'upsertWorkpad',
  add_comment: 'addComment',
  set_labels: 'setLabels',
  link_merge_request: 'linkMergeRequest',
  create_ticket: 'createTicket',
  resolve_identity: 'resolveIdentity',
  verify_delivery: 'inbound.verify',
  delivery_key: 'inbound.deliveryKey',
  normalise_delivery: 'inbound.normalise',
  ignored_delivery: 'inbound.normalise',
};

describe('jira emits no string carrying its own credentials (rules 31, 35)', () => {
  const emitted: Record<string, unknown> = {};
  const calls: { method: string; path: string; body: string }[] = [];
  let surface: string[] = [];

  beforeAll(async () => {
    stubFetch(jiraScript(), calls);
    const clock = fixedClock(NOW, 0);
    const registration = createJiraCloudRegistration({
      executor: createIntegrationActionExecutor({
        auditLog: createMemoryAuditLog(),
        // The executor is disarmed too: nothing below may be discharged by the layer outside the
        // adapter, which is the layer that does not cover a returned value anyway.
        redactor: noSecretsRedactor(),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock,
        rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
      }),
      clock,
      actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
    });
    const port = registration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a8',
      config: {
        site_url: SITE,
        user_email: JIRA_EMAIL,
        project_keys: ['ACME'],
        pickup_label: 'agentic',
      },
      secrets: { api_token: JIRA_TOKEN, webhook_secret: JIRA_WEBHOOK_SECRET },
      redactor: noSecretsRedactor(),
    });

    const ref = { provider: 'jira-cloud', key: KEY, url: `${SITE}/browse/${KEY}` } as const;

    surface = surfaceOf(port);
    emitted.ref = port.ref;
    emitted.capabilities = port.capabilities();
    emitted.test_connection = await port.testConnection();
    emitted.read_ticket = await port.readTicket(ref);
    emitted.match_tickets = await port.matchTickets({ kind: 'label', label: 'agentic' });
    // The target is the platform's own status mapping, not provider text, so it is not planted:
    // the *response* it is matched against is (`Done ${JIRA_TOKEN}` as the transition name).
    emitted.transition = await port.transition(ref, 'Done');
    emitted.add_comment = await port.addComment(ref, `the token is ${JIRA_TOKEN}`);
    emitted.upsert_workpad = await port.upsertWorkpad(ref, 'workpad', `plan: ${JIRA_TOKEN}`);
    emitted.set_labels = await port.setLabels(ref, [`added-${JIRA_TOKEN}`], []);
    emitted.create_ticket = await port.createTicket({
      project_key: 'ACME',
      issue_type: 'Task',
      title: 'follow-up',
      description: `context: ${JIRA_TOKEN}`,
      labels: [],
    });
    emitted.resolve_identity = await port.resolveIdentity({ email: 'dana@example.test' });
    emitted.link_merge_request = await port.linkMergeRequest(
      ref,
      // The MR url is the platform's own text, and it is published to the ticket as a remote link.
      `${HOST}/acme/api/-/merge_requests/7?trace=${JIRA_TOKEN}`,
    );
    // The two members that read a **header**, neither of which round 1 drove. `deliveryKey` copies
    // the identifier header into a string the platform stores; a header is emitted text.
    const signedBody = JSON.stringify({
      timestamp: Date.parse(NOW),
      webhookEvent: 'jira:issue_updated',
      issue: jiraIssue(),
    });
    emitted.verify_delivery = port.inbound.verify({
      headers: { 'x-hub-signature': signWebhookBody(JIRA_WEBHOOK_SECRET, signedBody) },
      body: signedBody,
    });
    emitted.delivery_key = port.inbound.deliveryKey({
      headers: { 'x-atlassian-webhook-identifier': `delivery-${JIRA_TOKEN}` },
      body: signedBody,
    });
    emitted.normalise_delivery = await port.inbound.normalise(
      {
        headers: {},
        body: JSON.stringify({
          timestamp: Date.parse(NOW),
          webhookEvent: 'comment_created',
          user: jiraUser(),
          issue: jiraIssue(),
          comment: jiraComment(),
        }),
      },
      {
        integrationId: '00000000-0000-4000-8000-0000000000a8',
        projectId: '00000000-0000-4000-8000-0000000000b8',
        resolveUser: () => null,
      },
    );
    emitted.ignored_delivery = await port.inbound.normalise(
      {
        headers: {},
        body: JSON.stringify({
          timestamp: Date.parse(NOW),
          webhookEvent: `jira:unknown_${JIRA_WEBHOOK_SECRET}`,
          issue: jiraIssue(),
        }),
      },
      {
        integrationId: '00000000-0000-4000-8000-0000000000a8',
        projectId: '00000000-0000-4000-8000-0000000000b8',
        resolveUser: () => null,
      },
    );
  });

  it('drove every member of the port, and the list is the port’s own', () => {
    expect(
      [...new Set(Object.values(JIRA_SCENARIOS))].sort(),
      'a member with no scenario is a member nothing asserts anything about',
    ).toEqual(surface);
    expect(
      Object.keys(emitted).sort(),
      'and every scenario ran: a name here with no answer is a call that threw or was dropped',
    ).toEqual(Object.keys(JIRA_SCENARIOS).sort());
    expect(calls.length, 'the harness reached the provider').toBeGreaterThan(8);
  });

  it.each(Object.keys(JIRA_SCENARIOS))(
    '%s emits no field carrying a binding credential',
    (method) => {
      assertNoSecret(method, emitted[method], JIRA_SECRETS);
    },
  );

  it.each([
    'test_connection',
    'read_ticket',
    'match_tickets',
    'normalise_delivery',
    'delivery_key',
  ])('%s actually carried the plant, so the assertion is not vacuous', (method) => {
    assertRedactionHappened(method, emitted[method]);
  });

  it('verified a delivery signed with the binding’s own webhook secret', () => {
    expect(emitted.verify_delivery, 'the plant is a real, accepted delivery').toBe(true);
  });

  it('redacts the request document too, which is what a ticket comment publishes', () => {
    const posted = calls.filter((call) => call.body !== '');
    expect(posted.length, 'the harness posted something').toBeGreaterThan(3);
    for (const call of posted) {
      expect(call.body, `${call.method} ${call.path}`).not.toContain(JIRA_TOKEN);
    }
    expect(
      posted.some((call) => call.body.includes('[REDACTED:integration:jira_api_token]')),
      'and the placeholder proves the plant reached a request body',
    ).toBe(true);
  });

  it('keeps the credentials out of a failure branch as well', async () => {
    const clock = fixedClock(NOW, 0);
    const registration = createJiraCloudRegistration({
      executor: createIntegrationActionExecutor({
        auditLog: createMemoryAuditLog(),
        redactor: noSecretsRedactor(),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock,
        rateLimits: () => ({ capacity: 100, refillPerSecond: 100, maxConcurrent: 8 }),
      }),
      clock,
      actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
    });
    const port = registration.create({
      integrationId: '00000000-0000-4000-8000-0000000000a8',
      config: { site_url: SITE, user_email: JIRA_EMAIL, project_keys: ['ACME'] },
      secrets: { api_token: JIRA_TOKEN, webhook_secret: JIRA_WEBHOOK_SECRET },
      redactor: noSecretsRedactor(),
    });
    stubFetch(
      {
        'GET /myself': {
          status: 401,
          body: { errorMessages: [`Basic auth failed for ${JIRA_BASIC} (${JIRA_TOKEN})`] },
        },
        [`GET /issue/${KEY}`]: {
          status: 403,
          body: { errorMessages: [`token ${JIRA_TOKEN} may not read ${KEY}`], errors: {} },
        },
        // The reviewer's exploit: the credential in an `errors` **key**. `redactJson` walks values
        // and leaves keys alone (`redaction.ts` says why), and `detailOf` interpolates every entry
        // of this object into the message — which is how the transport's "every string is redacted
        // here" claim was false for a document nobody had sent it.
        [`POST /issue/${KEY}/comment`]: {
          status: 400,
          body: { errors: { [JIRA_TOKEN]: 'is not a valid field' } },
        },
      },
      [],
    );

    // A probe reports rather than throws, so its failure branch is an emitted value.
    const probe = await port.testConnection();
    expect(probe.ok).toBe(false);
    assertNoSecret('test_connection (failure branch)', probe, JIRA_SECRETS);
    assertRedactionHappened('test_connection (failure branch)', probe);

    let caught: unknown;
    try {
      await port.readTicket({ provider: 'jira-cloud', key: KEY, url: `${SITE}/browse/${KEY}` });
    } catch (error) {
      caught = error;
    }
    const serialised = serialiseLikePino(caught);
    for (const [name, secret] of Object.entries(JIRA_SECRETS)) {
      expect(serialised, `a failure branch must not carry ${name}`).not.toContain(secret);
    }
    expect(serialised, 'and the plant reached the message').toContain('[REDACTED:integration:');

    let fromKey: unknown;
    try {
      await port.addComment(
        { provider: 'jira-cloud', key: KEY, url: `${SITE}/browse/${KEY}` },
        'a comment the field validation refuses',
      );
    } catch (error) {
      fromKey = error;
    }
    const fromKeySerialised = serialiseLikePino(fromKey);
    for (const [name, secret] of Object.entries(JIRA_SECRETS)) {
      expect(
        fromKeySerialised,
        `a provider-chosen **key** must not carry ${name} either`,
      ).not.toContain(secret);
    }
    expect(fromKeySerialised, 'and that plant reached the message too').toContain(
      '[REDACTED:integration:jira_api_token]: is not a valid field',
    );
  });
});

/** The stub is a global; a file that leaves one behind is a file that poisons its neighbours. */
afterAll(() => {
  vi.unstubAllGlobals();
});
