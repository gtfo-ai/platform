/**
 * The **core** of `scripts/worker-compose-check.mjs` (S-22.14, backlog 761): the product image's own
 * `startRuntime()` — every table, job, route, the worker protocol and the pipeline exactly as `main.ts`
 * composes them — with **one** seam replaced, the one the e2e tier replaces too: the provider
 * registry. Its git and tracker are the in-memory fakes of `@platform/integrations`, so a pipeline can
 * run to Ready in Docker without a GitLab or a Jira; the repositories the runs clone and push are
 * **real** (the check's HTTP and SSH stand-ins on the worker's run network).
 *
 * Mounted read-only at `/app/apps/server/worker-check/` and started as the `app` service's command
 * (`node --import ./scripts/ts-source-resolver.mjs apps/server/worker-check/core-entry.mjs`), so its
 * bare `@platform/*` imports resolve through `apps/server`'s own `node_modules` and its relative ones
 * reach the image's sources. It is **never** part of an image: the check mounts it.
 *
 * ## What it seeds (after `startRuntime`, so the bootstrap administrator exists)
 *
 *  - one organisation (if none), and two projects, each with its own `fake-git` integration:
 *    - `wcc-token` — `https://wcc-git/acme/api.git`, a **static run token** (`run_credential: static`,
 *      `remote_run_credential: allow`), the token the HTTP stand-in grants push to (`WCC_RUN_TOKEN`);
 *    - `wcc-deploy` — `https://git.example.test/acme/dk.git`, a **deploy key** (`run_credential:
 *      deploy_key`, `allow`), whose SSH route this registration points at the SSH stand-in
 *      (`ssh://git@wcc-ssh:443/`) with the stand-in's own host key, read per call from
 *      `/check/known_hosts` (the check writes it once the stand-in is up);
 *  - one `fake-task-management` integration bound to both, holding tickets `API-1` and `DK-1`;
 *  - the administrator a `member` of both, and both projects `workers_only` (no server claimant).
 *
 * Every merge request the fake git opens gets one changed file and a **successful** pipeline on its
 * head (what the e2e harness's `mirrorSeededCi` does), so the CI gate passes as it would on a green MR.
 *
 * ## Its control port (127.0.0.1:9099 inside the container, never published)
 *
 *  - `POST /start/<API-1|DK-1>` appends the ticket's `ticket.matched` — the event a tracker's webhook
 *    or poll appends — through the production event store;
 *  - `GET /state` answers the tasks, their runs and offers, as JSON.
 *
 * Every value here is obviously fake (BD-002); the deploy key is the check's throwaway one, passed
 * base64-encoded in `WCC_DEPLOY_PRIVATE_KEY_B64` (one `.env` line) and sealed with the instance's
 * own `APP_SECRET_KEY` like any secret.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import process from 'node:process';
import { domainEventSchemasByType } from '@platform/contracts';
import { taskBranchName } from '@platform/domain';
import { eventing as eventingAdapters, secrets as secretAdapters } from '@platform/infrastructure';
import {
  createFakeGitProvider,
  createFakeTaskManagement,
  createIntegrationRegistry,
  FAKE_GIT_RUN_CREDENTIAL,
  fakeGitRegistration,
  fakeTaskManagementRegistration,
} from '@platform/integrations';
import closeWithGrace from 'close-with-grace';
import { startRuntime } from '../src/runtime.js';

const env = (name) => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`worker-check core: ${name} is not set`);
  }
  return value;
};

const GIT_API_TOKEN = 'FAKE-wcc-git-api-token-0001';
const TRACKER_TOKEN = 'FAKE-wcc-tracker-token-0001';
const RUN_TOKEN = env('WCC_RUN_TOKEN');
const DEPLOY_PRIVATE_KEY = Buffer.from(env('WCC_DEPLOY_PRIVATE_KEY_B64'), 'base64').toString(
  'utf8',
);
const DEPLOY_PUBLIC_KEY = env('WCC_DEPLOY_PUBLIC_KEY');
const SSH_HOST = 'wcc-ssh';

const PROJECTS = {
  'API-1': {
    key: 'wcc-token',
    path: 'acme/api',
    repoUrl: 'https://wcc-git/acme/api.git',
    gitIntegrationId: randomUUID(),
  },
  'DK-1': {
    key: 'wcc-deploy',
    path: 'acme/dk',
    repoUrl: 'https://git.example.test/acme/dk.git',
    gitIntegrationId: randomUUID(),
  },
};
const TRACKER_INTEGRATION_ID = randomUUID();

/** A fake git per project, each opening merge requests that are green on their head. */
const greenOnOpen = (git, path) =>
  new Proxy(git, {
    get: (target, key, receiver) =>
      key === 'openMergeRequest'
        ? async (input) => {
            const opened = await target.openMergeRequest(input);
            target.setDiff({
              project: path,
              iid: opened.ref.iid,
              files: [{ path: 'src/totals.ts', diff: '@@ -1 +1 @@\n-a\n+b' }],
            });
            target.setPipeline({
              project: path,
              headSha: opened.head_sha,
              status: 'success',
              jobs: [{ name: 'test:unit', status: 'success' }],
            });
            return opened;
          }
        : Reflect.get(target, key, receiver),
  });
const gits = Object.fromEntries(
  Object.values(PROJECTS).map((project) => [
    project.path,
    greenOnOpen(
      createFakeGitProvider({
        integrationId: project.gitIntegrationId,
        clockStart: new Date().toISOString(),
        projects: [{ path: project.path, defaultBranch: 'main' }],
      }),
      project.path,
    ),
  ]),
);
const tickets = createFakeTaskManagement({
  integrationId: TRACKER_INTEGRATION_ID,
  tickets: [
    {
      key: 'API-1',
      title: 'Show the totals in the invoice footer',
      issueType: 'Story',
      description: 'The footer sums the visible rows rather than all of them.',
    },
    {
      key: 'DK-1',
      title: 'Show the totals in the invoice footer',
      issueType: 'Story',
      description: 'The footer sums the visible rows rather than all of them.',
    },
  ],
});

/** The deploy key's SSH route: the stand-in, pinned to its own host key (read per call). */
const runCredential = {
  ...FAKE_GIT_RUN_CREDENTIAL,
  deployKey: {
    ...FAKE_GIT_RUN_CREDENTIAL.deployKey,
    sshRoute: () => ({
      httpsPrefix: 'https://git.example.test/',
      sshPrefix: `ssh://git@${SSH_HOST}:443/`,
      connectHost: SSH_HOST,
      connectPort: 443,
      hostKeyAlias: SSH_HOST,
      knownHosts: readFileSync('/check/known_hosts', 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    }),
  },
};
const gitRegistrationFor = (path) =>
  fakeGitRegistration({ port: gits[path], token: GIT_API_TOKEN, runCredentials: true });
const gitRegistration = {
  ...gitRegistrationFor(PROJECTS['API-1'].path),
  staticRunCredential: runCredential,
  // One provider id, two ports: the binding's own `project` says which.
  create: (input) => gitRegistrationFor(input.config.project).create(input),
};

const runtime = await startRuntime({
  pipeline: {
    registry: () =>
      createIntegrationRegistry([
        gitRegistration,
        fakeTaskManagementRegistration({ port: tickets, token: TRACKER_TOKEN }),
      ]),
  },
});
const logger = runtime.logger;
const pool = runtime.pool;
const key = secretAdapters.deriveSecretKey(env('APP_SECRET_KEY'));

const seal = async (field, value) => {
  const secretId = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    secretId,
    secretAdapters.sealSecret(key, secretAdapters.secretDocument(field, value), secretId),
    key.keyId,
  ]);
  return secretId;
};

const seed = async () => {
  const admin = (
    await pool.query('select id from users where email = $1', [env('APP_BOOTSTRAP_ADMIN_EMAIL')])
  ).rows[0]?.id;
  if (admin === undefined)
    throw new Error('worker-check core: the bootstrap administrator is missing');
  const orgId =
    (await pool.query('select id from organizations order by created_at limit 1')).rows[0]?.id ??
    (await pool.query("insert into organizations (name) values ('worker-check') returning id"))
      .rows[0].id;
  const trackerSecret = await seal('token', TRACKER_TOKEN);
  await pool.query(
    `insert into integrations (id, org_id, type, provider, name, config, secret_ids)
     values ($1, $2, 'task_management', 'fake-task-management', 'wcc tickets', '{}'::jsonb, $3::uuid[])`,
    [TRACKER_INTEGRATION_ID, orgId, [trackerSecret]],
  );
  const expires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  for (const [ticket, project] of Object.entries(PROJECTS)) {
    const projectId = (
      await pool.query(
        `insert into projects (org_id, key, name, repo_url, config, default_branch)
         values ($1, $2, $3, $4, '{}'::jsonb, 'main') returning id`,
        [orgId, project.key, project.key, project.repoUrl],
      )
    ).rows[0].id;
    project.id = projectId;
    const deployKey = ticket === 'DK-1';
    const secretIds = [
      await seal('token', GIT_API_TOKEN),
      deployKey
        ? await seal('run_ssh_private_key', DEPLOY_PRIVATE_KEY)
        : await seal('run_token', RUN_TOKEN),
    ];
    const config = deployKey
      ? {
          project: project.path,
          run_credential: 'deploy_key',
          run_ssh_public_key: DEPLOY_PUBLIC_KEY,
          remote_run_credential: 'allow',
        }
      : {
          project: project.path,
          run_credential: 'static',
          run_token_owner: 'operator',
          run_token_username: 'agentic-runner',
          run_token_expires_at: expires,
          remote_run_credential: 'allow',
        };
    await pool.query(
      `insert into integrations (id, org_id, type, provider, name, config, secret_ids)
       values ($1, $2, 'git', 'fake-git', $3, $4::jsonb, $5::uuid[])`,
      [
        project.gitIntegrationId,
        orgId,
        `wcc git ${project.key}`,
        JSON.stringify(config),
        secretIds,
      ],
    );
    for (const integrationId of [project.gitIntegrationId, TRACKER_INTEGRATION_ID]) {
      await pool.query(
        "insert into bindings (project_id, integration_id, config) values ($1, $2, '{}'::jsonb)",
        [projectId, integrationId],
      );
    }
    await pool.query(
      `insert into project_members (project_id, user_id, role) values ($1, $2, 'member')
       on conflict do nothing`,
      [projectId, admin],
    );
    await pool.query(
      `insert into project_execution_settings (project_id, mode, prefer) values ($1, 'workers_only', 'workers')`,
      [projectId],
    );
  }
  logger.info({ projects: Object.keys(PROJECTS) }, 'worker-check core: seeded');
};
await seed();

const eventing = eventingAdapters.createEventing({
  pool,
  connectionString: env('DATABASE_URL'),
  config: { maxConcurrency: 1 },
});
const start = async (ticket) => {
  const project = PROJECTS[ticket];
  const event = domainEventSchemasByType['ticket.matched'].parse({
    id: randomUUID(),
    stream_type: 'project',
    stream_id: randomUUID(),
    stream_seq: 1,
    correlation_id: null,
    cause_event_id: null,
    actor: {
      kind: 'integration',
      integration_id: TRACKER_INTEGRATION_ID,
      provider: 'fake-task-management',
    },
    occurred_at: new Date().toISOString(),
    type: 'ticket.matched',
    payload: {
      project_id: project.id,
      ticket: {
        provider: 'fake-task-management',
        key: ticket,
        url: `https://tickets.example.test/browse/${ticket}`,
      },
      rule: 'label:agentic',
      priority: 'High',
      issue_type: 'Story',
      epic: null,
      links: [],
    },
  });
  await eventing.unitOfWork.transaction(async (scope) => scope.events.append([event]));
  return { branch: taskBranchName(ticket), project_id: project.id };
};

const state = async () => ({
  projects: Object.fromEntries(Object.entries(PROJECTS).map(([ticket, p]) => [ticket, p.id])),
  tasks: (
    await pool.query(
      `select t.id, t.ticket_key, t.state::text as state, t.current_stage, t.project_id
         from tasks t order by t.created_at`,
    )
  ).rows,
  runs: (
    await pool.query(
      `select r.id, r.task_id, o.stage, r.status::text as status, r.terminal_reason::text as reason,
              r.worker_id, o.claimant_kind::text as claimant_kind, o.lease_epoch, o.ssh_signatures
         from runs r left join run_offers o on o.run_id = r.id order by r.created_at`,
    )
  ).rows,
  // What the fake CLI said about its probe and its push (`fake-claude-stage.mjs`), per task.
  said: (
    await pool.query(
      `select r.task_id, m.search_text as text
         from run_messages m join runs r on r.id = m.run_id
        where m.kind = 'assistant'
          and (m.search_text like '%wcc-probe%' or m.search_text like '%fake-claude-stage pushed%')
        order by m.created_at`,
    )
  ).rows,
  // A failed run's own `result` entry — the fake CLI's words when it ended `error_during_execution`.
  failedResults: (
    await pool.query(
      `select r.task_id, o.stage, m.payload
         from run_messages m join runs r on r.id = m.run_id left join run_offers o on o.run_id = r.id
        where m.kind = 'result' and r.status <> 'completed'`,
    )
  ).rows,
  escalations: (
    await pool.query(
      `select type, payload from events where type in ('task.escalated', 'run.failed')
        order by position`,
    )
  ).rows,
});

const control = http.createServer((request, response) => {
  const answer = (status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const started = /^\/start\/(API-1|DK-1)$/.exec(request.url ?? '');
  const work =
    request.method === 'POST' && started !== null
      ? start(started[1])
      : request.method === 'GET' && request.url === '/state'
        ? state()
        : null;
  if (work === null) {
    answer(404, { error: 'not_found' });
    return;
  }
  work.then(
    (body) => answer(200, body),
    (error) => answer(500, { error: String(error) }),
  );
});
control.listen(9099, '127.0.0.1');

closeWithGrace({ delay: runtime.config.shutdownTimeoutMs }, async () => {
  control.close();
  await eventing.stop();
  await runtime.stop();
});
const address = await runtime.listen();
logger.info({ address }, 'worker-check core: listening');
