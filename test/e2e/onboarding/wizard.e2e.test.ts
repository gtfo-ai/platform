/**
 * **WP-21's headline criterion: the onboarding wizard completes on a fixture repository, and a
 * readiness report is produced.**
 *
 * Nothing here seeds a project. Every step is an HTTP request to a real `apps/server` instance,
 * signed in as the bootstrap administrator, and everything behind it is production code: the
 * routes, the RBAC guard, the audit rows, the pipeline store, pg-boss, the stage executor, the
 * planner, the **real** `createClaudeRunner` over a scripted CLI, the `onboarding.discovery` job,
 * the readiness store and the proposal queue. The two doubles are the two technical/10 names for
 * this tier: the model (a scripted CLI process) and the providers (through the registry).
 *
 * ## What each step proves, and what it cannot
 *
 * **Step 1** creates the project and binds the integrations, and the proof that the binding is
 * *real* is the last case in this file: a signed webhook delivery reaches `ticket.matched` and a
 * task appears on the project the wizard created. That is the assertion the harness cannot fake —
 * the ingress resolves the binding from the rows `PUT …/bindings` wrote.
 *
 * The integration **rows** are seeded rather than created through `POST /api/integrations`, and the
 * reason is not convenience: `POST /api/integrations` refuses a provider `SHIPPED_PROVIDERS` does
 * not name, and the fake providers are deliberately not in that catalogue — it is the list an
 * operator may configure. So the create is exercised against a **shipped** provider (Sentry, whose
 * credential is a token and which needs no network to be created), and the pipeline's two bindings
 * are fakes the wizard's own `PUT …/bindings` attaches.
 *
 * **Step 2** runs the Discovery agent. The assertion that it was *given the repository* is on the
 * bytes the CLI received (standing rule 82: `FakeClaudeRunner` picks its scenario from `spec.stage`
 * and never reads a prompt, so this file runs the real runner over a scripted process instead).
 *
 * **Steps 3–5**: the business interview (WP-64) is driven end to end by
 * `readiness-loop.e2e.test.ts`, which also merges its pages and a task and watches the readiness
 * re-check notice; the commit step is the knowledge proposal queue, whose rows this file asserts.
 *
 * ## The fixture repository
 *
 * A **real git repository on disk**, cloned into the platform's own bare mirror by WP-18a's
 * indexer, so the knowledge the discovery run's prompt is built from comes from a tree rather than
 * from a seeded table — which is what makes the R12 (knowledge completeness) half of the readiness
 * evaluation a measurement.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DiscoveryDraftData,
  EffectiveConfigResponse,
  ReadinessResponse,
} from '@platform/contracts';
import { FAKE_TASK_MANAGEMENT_PROVIDER_ID, type SentryFetch } from '@platform/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchGitEnv } from '../../../scripts/git-scratch-env.mjs';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import {
  GIT_INTEGRATION_ID,
  type PipelineE2E,
  startPipeline,
  TICKETS_INTEGRATION_ID,
} from '../support/pipeline.js';
import { TICKETS } from '../support/scenarios.js';

const execFileAsync = promisify(execFile);

/** Obviously fake (BD-002), planted in the drafted page so the redaction assertion has a target. */
const PLANTED_REPO_SECRET = 'glpat-FAKE-wp21-drafted-page-credential-0';

/** What the scripted discovery CLI answers with — a `DiscoveryDraft` for the fixture repository. */
const DISCOVERY_DRAFT: DiscoveryDraftData = {
  documents: [
    {
      path: 'technical/overview.md',
      title: 'How the fixture API is laid out',
      confidence: 'medium',
      // The planted credential is inside the page the agent drafted, which is the ordinary way a
      // repository's secret reaches a stored row.
      markdown: `# Overview\n\nOne service, one database.\n\nCI token: ${PLANTED_REPO_SECRET}\n`,
    },
    {
      path: 'technical/how-to-run.md',
      title: 'How to run it',
      confidence: 'high',
      markdown: '# How to run\n\n`npm test` runs the suite.\n',
    },
  ],
  // `verified: false` on both: this scripted draft reports commands it *read* and did not run, and
  // the prompt asks exactly that of a command it did not run — the evidence names the file. (Since
  // WP-54 a discovery run *can* run them; `verified: true` is for one it ran, with the exit status.)
  commands: [
    {
      purpose: 'test',
      command: 'npm test',
      verified: false,
      evidence: 'package.json scripts.test',
    },
    { purpose: 'lint', command: 'npm run lint', verified: false, evidence: 'package.json' },
  ],
  linked_documents: [{ path: 'README.md', reason: 'the project documents itself here' }],
  questions: [{ id: 'q1', text: 'Is the legacy/ folder still maintained?', blocking: false }],
  /**
   * This scripted draft answers R1, R2 and R6 from files. Since WP-54 the shipped prompt asks for them
   * to be **run** (`criteria.ts` carries the argument) and the role's shell can; what this e2e holds
   * is the platform's handling of a draft, not the model's diligence, so the scripted answer is
   * unchanged.
   */
  readiness: [
    { id: 'R1', passed: true, evidence: '.github/workflows/ci.yml runs `npm test` on main' },
    { id: 'R2', passed: true, evidence: 'the CI job sets timeout-minutes: 10' },
    { id: 'R3', passed: true, evidence: '.github/workflows/ci.yml triggers on pull_request' },
    { id: 'R5', passed: false, evidence: 'no lint job in the CI configuration' },
    // Ignored on the way in: the platform answers R9 from the git provider (see the assertion).
    { id: 'R9', passed: true, evidence: 'the repository looks protected to me' },
  ],
};

let harness: PipelineE2E | undefined;
let workspace: string;
let mirrorRoot: string;

const git = async (args: readonly string[]): Promise<string> => {
  // WP-162: every repository this file builds is under `workspace`; no inherited `GIT_*`.
  const { stdout } = await execFileAsync('git', [...args], {
    env: scratchGitEnv(workspace),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
};

/** A real repository with a knowledge vault in it, for the index the discovery prompt reads. */
const seedFixtureRepository = async (): Promise<string> => {
  const repo = path.join(workspace, 'fixture-repo');
  await mkdir(path.join(repo, '.agentic/knowledge/technical'), { recursive: true });
  await git(['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# fixture repository\n');
  await writeFile(
    path.join(repo, '.agentic/knowledge/index.md'),
    '---\nid: index\ntitle: Index\ntype: reference\nkind: technical\nscope: project\n---\n\nOne page.\n',
  );
  await git(['-C', repo, 'add', '-A']);
  await git([
    '-C',
    repo,
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'the fixture repository',
  ]);
  return repo;
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wp21-wizard-'));
  mirrorRoot = path.join(workspace, 'mirrors');
  await mkdir(mirrorRoot, { recursive: true });
}, 120_000);

afterAll(async () => {
  await harness?.stop();
  harness = undefined;
  await rm(workspace, { recursive: true, force: true });
});

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post<{ user?: { id: string } }>('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const command = async <T>(
  client: Client,
  path_: string,
  body: unknown,
  options: { readonly method?: 'POST' | 'PUT' | 'PATCH'; readonly idempotencyKey?: string } = {},
): Promise<{ status: number; body: T }> =>
  client.json<T>(path_, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    body: JSON.stringify(body),
  });

describe('the onboarding wizard', () => {
  it('completes on a fixture repository and produces a readiness report', async () => {
    const repo = await seedFixtureRepository();
    const sentryRequests: { url: string; authorization: string | undefined }[] = [];
    const sentryTransport: SentryFetch = async (url, init) => {
      sentryRequests.push({
        url,
        authorization: init.headers.authorization ?? init.headers.Authorization,
      });
      // `GET /api/0/organizations/<slug>/` — the probe's one call (`sentry/client.ts`).
      return new Response(JSON.stringify({ slug: 'acme', name: 'ACME' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const pipeline = await startPipeline({
      label: 'wizard',
      seedProject: false,
      // `repositoryPathOf` strips the scheme and the leading slashes off `projects.repo_url`, so
      // this is the path every git read the pipeline makes will address the fake provider by.
      gitProjects: [repo.replace(/^\/+/, '')],
      tickets: TICKETS,
      agent: 'real-over-fake-cli',
      // One scenario, for the one stage the discovery template has.
      scenarios: () => ({ discovery: { structuredOutput: DISCOVERY_DRAFT } }),
      env: {
        APP_KNOWLEDGE_MIRROR_ROOT: mirrorRoot,
        // The operator-declared allow-list (`APP_INTEGRATION_SECRET_ENV`): without it
        // `POST /api/integrations` refuses every `secret_refs` name, which is the shipped default
        // and is asserted below before the permitted name is used.
        APP_INTEGRATION_SECRET_ENV: 'WP21_SENTRY_TOKEN',
        // The second operator-declared list (`APP_INTEGRATION_HOSTS`, WP-51): without it
        // `POST /api/integrations` refuses every host, which is the shipped default and is
        // asserted below before the declared one is used. The fake providers the pipeline runs on
        // publish no host at all, so this list governs the Sentry row and WP-100's refused-config
        // bodies, whose hosts are declared so the refusal under test is the schema's.
        APP_INTEGRATION_HOSTS: 'sentry.example.test,slack.example.test,gitlab.example.test',
      },
      // WP-100 (backlog 328, criterion 3): the **production** Sentry registration over a recording
      // transport, so the integration the wizard creates is loaded and probed by production code
      // and the far side of the HTTP call is the only double.
      sentry: { fetch: sentryTransport },
    });
    harness = pipeline;
    const client = await signIn(pipeline.instance.baseUrl);

    // ── Step 1: connect ─────────────────────────────────────────────────────

    // The `Idempotency-Key` is required on a POST that creates (technical/08 § Principles), and a
    // header that is optional is a header production omits — so the refusal is asserted first.
    const unkeyed = await command(client, '/api/projects', {
      key: 'acme_api',
      name: 'ACME API',
      repo_url: `file://${repo}`,
    });
    expect(unkeyed.status).toBe(400);
    expect((unkeyed.body as { error: { code: string } }).error.code).toBe(
      'idempotency_key_required',
    );

    const created = await command<{ id: string; key: string; readiness_level: number }>(
      client,
      '/api/projects',
      { key: 'acme_api', name: 'ACME API', repo_url: `file://${repo}` },
      { idempotencyKey: 'wizard-step-1' },
    );
    expect(created.status).toBe(201);
    const projectId = created.body.id;
    // Level 0 at creation — the "before" of the transition this file exists to show.
    expect(created.body.readiness_level).toBe(0);

    // A retry under the same key answers with the same project and creates no second one.
    const retried = await command<{ id: string }>(
      client,
      '/api/projects',
      { key: 'acme_api', name: 'ACME API', repo_url: `file://${repo}` },
      { idempotencyKey: 'wizard-step-1' },
    );
    expect(retried.status).toBe(200);
    expect(retried.body.id).toBe(projectId);
    expect(await pipeline.query('select count(*)::int as count from projects')).toEqual([
      { count: 1 },
    ]);

    // …and a **different** request under the same key is refused rather than replayed. A unique key
    // alone cannot see this — `name` is not part of any index — which is why the digest exists.
    const reused = await command<{ error: { code: string } }>(
      client,
      '/api/projects',
      { key: 'acme_api', name: 'Renamed', repo_url: `file://${repo}` },
      { idempotencyKey: 'wizard-step-1' },
    );
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reused');

    // An integration created through the wizard's own command, against a **shipped** provider.
    // Sentry's credential is a token and creating it needs no network; the value is read from this
    // process's environment by name, so nothing typed into a browser is ever a credential.
    process.env.WP21_SENTRY_TOKEN = 'FAKE-sentry-token-not-a-real-secret-00';

    /**
     * **A name the operator has not declared is refused**, and the platform's own variables are the
     * reason the allow-list exists: the instance really does hold `APP_SECRET_KEY` and
     * `DATABASE_URL`, so without this a caller with `integration.write` could have the platform
     * seal its envelope key into a row and a provider built with a caller-chosen `base_url` would
     * be handed it. Asserted here rather than only in the unit tier because the instance is the
     * thing that has those variables.
     */
    for (const forbidden of ['APP_SECRET_KEY', 'DATABASE_URL']) {
      const refused = await command<{ error: { code: string; message: string } }>(
        client,
        '/api/integrations',
        {
          type: 'errors',
          provider: 'sentry',
          name: `acme sentry ${forbidden}`,
          config: { organization: 'acme', base_url: 'https://sentry.example.test' },
          secret_refs: { auth_token: forbidden },
        },
        { idempotencyKey: `wizard-forbidden-${forbidden}` },
      );
      expect(refused.status, forbidden).toBe(403);
      expect(refused.body.error.code).toBe('secret_name_not_permitted');
      // The refusal names the setting, never the value it did not read.
      expect(refused.body.error.message).toContain('APP_INTEGRATION_SECRET_ENV');
      expect(JSON.stringify(refused.body)).not.toContain('e2e-test-secret-key');
    }

    /**
     * **A credential in `config` is refused**, which is what makes "no credential crosses this API"
     * a property rather than a sentence: `secret_refs` was checked and `config` was not, so a
     * caller could store a plaintext token in a column nothing rotates.
     */
    const inConfig = await command<{ error: { code: string; message: string } }>(
      client,
      '/api/integrations',
      {
        type: 'errors',
        provider: 'sentry',
        name: 'acme sentry plaintext',
        config: { organization: 'acme', auth_token: 'FAKE-plaintext-token-not-a-real-secret' },
        secret_refs: {},
      },
      { idempotencyKey: 'wizard-credential-in-config' },
    );
    expect(inConfig.status).toBe(400);
    expect(inConfig.body.error.code).toBe('credential_in_config');
    expect(inConfig.body.error.message).not.toContain('FAKE-plaintext-token');
    expect(
      await pipeline.query(
        "select count(*)::int as count from integrations where name like '%plaintext%'",
      ),
    ).toEqual([{ count: 0 }]);

    /**
     * **A host the operator has not declared is refused**, at the HTTP boundary and from a body
     * this test writes rather than a typed request (WP-51, PROGRESS backlog 48).
     *
     * The adjacent host is the case that matters (standing rule 43): `evil.example.com` would be
     * refused by a substring check too, while `sentry.example.test.evil.test` and
     * `evil-sentry.example.test` are refused only by exact matching. Asserted **here**, on a real
     * instance, because the row this would create is the one whose credential the probe then sends.
     */
    for (const host of [
      'sentry.example.test.evil.test',
      'evil-sentry.example.test',
      'evil.example.com',
    ]) {
      const refusedHost = await command<{ error: { code: string; message: string } }>(
        client,
        '/api/integrations',
        {
          type: 'errors',
          provider: 'sentry',
          name: `acme sentry ${host}`,
          config: { organization: 'acme', base_url: `https://${host}` },
          secret_refs: { auth_token: 'WP21_SENTRY_TOKEN' },
        },
        { idempotencyKey: `wizard-forbidden-host-${host}` },
      );
      expect(refusedHost.status, host).toBe(403);
      expect(refusedHost.body.error.code).toBe('integration_host_not_permitted');
      // The refusal names the host **and** the setting: an operator who is told "not permitted"
      // without being told which variable declares it has been told nothing.
      expect(refusedHost.body.error.message).toContain(host);
      expect(refusedHost.body.error.message).toContain('APP_INTEGRATION_HOSTS');
    }
    // Nothing was stored: the refusal is a countable effect, not a status code (rule 79).
    expect(
      await pipeline.query(
        "select count(*)::int as count from integrations where name like '%evil%'",
      ),
    ).toEqual([{ count: 0 }]);

    const integration = await command<{ id: string; provider: string }>(
      client,
      '/api/integrations',
      {
        type: 'errors',
        provider: 'sentry',
        name: 'acme sentry',
        config: { organization: 'acme', base_url: 'https://sentry.example.test' },
        secret_refs: { auth_token: 'WP21_SENTRY_TOKEN' },
      },
      { idempotencyKey: 'wizard-step-1-sentry' },
    );
    expect(integration.status).toBe(201);
    expect(integration.body.provider).toBe('sentry');
    // Nothing the command answered with, and nothing it audited, is the credential.
    expect(JSON.stringify(integration.body)).not.toContain('FAKE-sentry-token');
    const audited = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'integration.create'",
    );
    expect(JSON.stringify(audited)).not.toContain('FAKE-sentry-token');
    expect(audited[0]?.params.secret_fields).toEqual(['auth_token']);

    /**
     * **WP-100, criterion 3: the integration the wizard created loads.** Until WP-100 this row
     * sent British `organisation`, the create stored it, and nothing here probed it — so the test
     * passed over a row every binding load would refuse (PROGRESS backlog 328). *Test connection*
     * builds the production Sentry adapter from the row and the sealed credential and reaches the
     * transport with the bearer the route was given.
     */
    const sentryProbe = await command<{ ok: boolean; checks: { detail: string }[] }>(
      client,
      `/api/integrations/${integration.body.id}/test`,
      {},
    );
    expect(sentryProbe.status, JSON.stringify(sentryProbe.body)).toBe(200);
    expect(sentryProbe.body.ok, JSON.stringify(sentryProbe.body)).toBe(true);
    expect(
      sentryRequests.filter(
        (each) => each.url === 'https://sentry.example.test/api/0/organizations/acme/',
      ),
    ).toEqual([
      {
        url: 'https://sentry.example.test/api/0/organizations/acme/',
        authorization: 'Bearer FAKE-sentry-token-not-a-real-secret-00',
      },
    ]);

    /**
     * **WP-100, criterion 1 over HTTP: a config the provider's schema refuses is 400 naming the key
     * path, and no row is written — for each of the five shipped providers.** Each body clears the
     * host check (a declared host where the provider defaults one), so the refusal under test is
     * the schema's, not the allow-list's.
     */
    const refusedBodies: readonly {
      type: string;
      provider: string;
      config: Record<string, unknown>;
      paths: string[];
    }[] = [
      { type: 'git', provider: 'gitlab', config: {}, paths: ['base_url'] },
      // The operator guide's old example (backlog 328): `host` for `base_url`.
      {
        type: 'git',
        provider: 'gitlab',
        config: { host: 'https://gitlab.example.test' },
        paths: ['base_url', 'host'],
      },
      {
        type: 'task_management',
        provider: 'jira-cloud',
        config: {},
        paths: ['site_url', 'user_email'],
      },
      { type: 'logs', provider: 'loki', config: {}, paths: ['base_url'] },
      {
        type: 'errors',
        provider: 'sentry',
        config: { organisation: 'acme', base_url: 'https://sentry.example.test' },
        paths: ['organisation', 'organization'],
      },
      {
        type: 'communication',
        provider: 'slack',
        config: { base_url: 'https://slack.example.test' },
        paths: ['channel'],
      },
    ];
    for (const [index, body] of refusedBodies.entries()) {
      const refusedConfig = await command<{
        error: { code: string; message: string; details?: { path: string }[] };
      }>(
        client,
        '/api/integrations',
        { ...body, paths: undefined, name: `refused config ${index}`, secret_refs: {} },
        { idempotencyKey: `wizard-refused-config-${index}` },
      );
      expect(`${body.provider} ${refusedConfig.status} ${refusedConfig.body.error.code}`).toBe(
        `${body.provider} 400 invalid_integration_config`,
      );
      expect(refusedConfig.body.error.details?.map((detail) => detail.path).sort()).toEqual(
        body.paths,
      );
      for (const path of body.paths) {
        expect(refusedConfig.body.error.message).toContain(path);
      }
    }
    expect(
      await pipeline.query(
        "select count(*)::int as count from integrations where name like 'refused config %'",
      ),
    ).toEqual([{ count: 0 }]);

    /**
     * **WP-100, criterion 4: a stored row that no longer parses — written before the create parsed
     * it — answers a named refusal at read, with the `PATCH` that repairs it, never a 500.** The
     * row is the wizard's own old body, written the way every pre-WP-100 create wrote it; it shares
     * the created row's sealed credential so that, once repaired, the probe can prove it loads.
     */
    const legacy = await pipeline.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config, secret_ids)
       select org_id, type, provider, 'acme sentry (pre-WP-100)',
              '{"organisation":"acme","base_url":"https://sentry.example.test"}'::jsonb, secret_ids
         from integrations where id = $1
       returning id::text as id`,
      [integration.body.id],
    );
    const legacyId = legacy[0]?.id as string;
    const listed = await client.json<{
      items: {
        id: string;
        config_refusal: { code: string; message: string; paths: string[] } | null;
      }[];
    }>('/api/integrations');
    expect(listed.status).toBe(200);
    const refusal = listed.body.items.find((item) => item.id === legacyId)?.config_refusal;
    expect(refusal?.code).toBe('invalid_integration_config');
    expect(refusal?.paths.sort()).toEqual(['organisation', 'organization']);
    expect(refusal?.message).toContain(`PATCH /api/integrations/${legacyId}`);
    // The row that parses carries none — the other direction (standing rule 42).
    expect(listed.body.items.find((item) => item.id === integration.body.id)?.config_refusal).toBe(
      null,
    );
    const refusedProbe = await command<{ error: { code: string; message: string } }>(
      client,
      `/api/integrations/${legacyId}/test`,
      {},
    );
    expect(`${refusedProbe.status} ${refusedProbe.body.error.code}`).toBe(
      '409 invalid_integration_config',
    );
    expect(refusedProbe.body.error.message).toContain(`PATCH /api/integrations/${legacyId}`);

    // The PATCH runs the create's checks over the merged document: a host outside the list and a
    // value the schema refuses are both refused, and neither writes.
    const patchHost = await command<{ error: { code: string } }>(
      client,
      `/api/integrations/${legacyId}`,
      { config: { base_url: 'https://evil.example.com' } },
      { method: 'PATCH' },
    );
    expect(`${patchHost.status} ${patchHost.body.error.code}`).toBe(
      '403 integration_host_not_permitted',
    );
    const patchSlug = await command<{ error: { code: string; details?: { path: string }[] } }>(
      client,
      `/api/integrations/${legacyId}`,
      { config: { organization: 'Not A Slug' }, remove: ['organisation'] },
      { method: 'PATCH' },
    );
    expect(`${patchSlug.status} ${patchSlug.body.error.code}`).toBe(
      '400 invalid_integration_config',
    );
    expect(patchSlug.body.error.details?.map((detail) => detail.path)).toEqual(['organization']);
    const patchCredential = await command<{ error: { code: string } }>(
      client,
      `/api/integrations/${legacyId}`,
      { config: { auth_token: 'FAKE-plaintext-token-not-a-real-secret' } },
      { method: 'PATCH' },
    );
    expect(`${patchCredential.status} ${patchCredential.body.error.code}`).toBe(
      '400 credential_in_config',
    );
    expect(
      await pipeline.query<{ config: Record<string, unknown> }>(
        'select config from integrations where id = $1',
        [legacyId],
      ),
    ).toEqual([{ config: { organisation: 'acme', base_url: 'https://sentry.example.test' } }]);

    const repaired = await command<{
      config: Record<string, unknown>;
      config_refusal: unknown;
      health: { status: string };
    }>(
      client,
      `/api/integrations/${legacyId}`,
      { config: { organization: 'acme' }, remove: ['organisation'] },
      { method: 'PATCH' },
    );
    expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
    expect(repaired.body.config).toEqual({
      base_url: 'https://sentry.example.test',
      organization: 'acme',
    });
    expect(repaired.body.config_refusal).toBe(null);
    expect(repaired.body.health.status).toBe('unknown');
    const repairedProbe = await command<{ ok: boolean }>(
      client,
      `/api/integrations/${legacyId}/test`,
      {},
    );
    expect(repairedProbe.status, JSON.stringify(repairedProbe.body)).toBe(200);
    expect(repairedProbe.body.ok).toBe(true);
    // One audit row for the one accepted PATCH, naming the keys it changed and never a value.
    const configWrites = await pipeline.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'integration.config.write'",
    );
    expect(configWrites).toEqual([
      {
        params: {
          integration_id: legacyId,
          changed_keys: ['organisation', 'organization'],
        },
      },
    ]);

    // The two fake-provider rows the pipeline needs, **without** their bindings: the wizard's own
    // command is what attaches them, which is the part under test.
    await pipeline.seedIntegrations(projectId as never);
    expect(await pipeline.query('select count(*)::int as count from bindings')).toEqual([
      { count: 0 },
    ]);

    // "The platform validates access" — the provider's own read-only probe, through the registry
    // this instance composed.
    const probe = await command<{ ok: boolean; checks: { detail: string }[] }>(
      client,
      `/api/integrations/${GIT_INTEGRATION_ID}/test`,
      {},
    );
    expect(probe.status).toBe(200);
    expect(probe.body.ok).toBe(true);
    // …and the verdict reached `integrations.health`, the column `GET /api/integrations` publishes
    // and that nothing wrote before this endpoint existed.
    const health = await client.json<{ items: { id: string; health: { status: string } }[] }>(
      '/api/integrations',
    );
    expect(health.body.items.find((item) => item.id === GIT_INTEGRATION_ID)?.health.status).toBe(
      'ok',
    );

    /**
     * **WP-100 review round 1, backlog 330: no credential in a binding, in either direction.** A
     * `PUT …/bindings` whose overlay carries Sentry's `auth_token` is refused by the key's name and
     * writes nothing; a binding row stored before that refusal (inserted the way `psql` or a
     * pre-WP-100 `PUT` wrote it) is served by `GET …/bindings` without the token and with the key
     * beside it — the canary that the read strips a field rather than publishing nothing.
     */
    const BINDING_TOKEN = 'sntrys_FAKE-wizard-binding-token-000001';
    const credentialOverlay = await command<{ error: { code: string; message: string } }>(
      client,
      `/api/projects/${projectId}/bindings`,
      {
        items: [{ integration_id: integration.body.id, config: { auth_token: BINDING_TOKEN } }],
      },
      { method: 'PUT' },
    );
    expect(`${credentialOverlay.status} ${credentialOverlay.body.error.code}`).toBe(
      '400 credential_in_config',
    );
    expect(JSON.stringify(credentialOverlay.body)).not.toContain(BINDING_TOKEN);
    expect(await pipeline.query('select count(*)::int as count from bindings')).toEqual([
      { count: 0 },
    ]);
    await pipeline.query(
      'insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)',
      [
        projectId,
        integration.body.id,
        JSON.stringify({ auth_token: BINDING_TOKEN, max_issues: 5 }),
      ],
    );
    const servedBindings = await client.json<{ items: { config: Record<string, unknown> }[] }>(
      `/api/projects/${projectId}/bindings`,
    );
    expect(servedBindings.status).toBe(200);
    expect(JSON.stringify(servedBindings.body)).not.toContain(BINDING_TOKEN);
    expect(servedBindings.body.items.map((item) => item.config)).toEqual([{ max_issues: 5 }]);

    const bound = await command<{ items: { provider: string }[] }>(
      client,
      `/api/projects/${projectId}/bindings`,
      {
        items: [{ integration_id: GIT_INTEGRATION_ID }, { integration_id: TICKETS_INTEGRATION_ID }],
      },
      { method: 'PUT' },
    );
    expect(bound.status).toBe(200);
    // The PUT's own answer is the second read of the set: the seeded row is replaced, no token.
    expect(JSON.stringify(bound.body)).not.toContain(BINDING_TOKEN);
    expect(bound.body.items.map((item) => item.provider).sort()).toEqual([
      'fake-git',
      'fake-task-management',
    ]);

    // ── Step 2: technical discovery ─────────────────────────────────────────

    // Before the run: the readiness endpoint refuses by name, with the row count.
    const before = await client.json<{ error: { code: string; message: string } }>(
      `/api/projects/${projectId}/readiness`,
    );
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe('readiness_not_evaluated');
    expect(before.body.error.message).toContain('0 readiness_evaluations rows');

    const discovery = await command<{ task_id: string; started: boolean }>(
      client,
      `/api/projects/${projectId}/discovery`,
      {},
      { idempotencyKey: 'wizard-step-2' },
    );
    expect(discovery.status).toBe(202);
    expect(discovery.body.started).toBe(true);

    // A second call spends no second budget.
    const again = await command<{ task_id: string; started: boolean }>(
      client,
      `/api/projects/${projectId}/discovery`,
      {},
      { idempotencyKey: 'wizard-step-2' },
    );
    expect(again.status).toBe(200);
    expect(again.body.started).toBe(false);
    expect(again.body.task_id).toBe(discovery.body.task_id);

    await pipeline.settle('the discovery task to finish', (task) => task.state === 'done');

    /**
     * **The run was given the repository, asserted on the bytes the CLI received** (rule 82).
     *
     * The prompt the SDK wrote to the scripted process is the only artefact that can falsify
     * "discovery was told which project it is inspecting"; the spec is checked only for the things
     * the CLI cannot show (the role and the artifact type).
     */
    const run = pipeline.agentRuns.find((entry) => entry.stage === 'discovery');
    expect(run, 'the discovery stage ran').toBeDefined();
    expect(run?.spec.role).toBe('discovery');
    expect(run?.spec.artifactType).toBe('DiscoveryDraft');
    /**
     * The role's least privilege, both halves (BD-021).
     *
     * `Bash` is there because product/17 R1/R2/R6 are detected by *executing* the project's own
     * commands and R1 is a level-1 requirement (`TOOLS_BY_ROLE`'s docblock carries the argument),
     * and what bounds it is BD-025's command policy, which reaches the run on the same spec. What is
     * **not** there is any way to keep what the shell produced: no `Write`, no `Edit`, and no
     * mutating platform tool.
     */
    // `Skill` since WP-83 (PROGRESS backlog 149): it loads `agentic:kb` and keeps nothing.
    expect(run?.spec.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash', 'Skill']);
    expect(run?.spec.tools).not.toContain('Write');
    expect(run?.spec.platformTools).not.toContain('open_mr');
    // The policy that bounds the shell, as the platform ships it since WP-54 (Q69 (ii)): the read
    // verbs **and** the project's declared test command, so R1 can be run rather than read — and
    // no git write. Asserted in both directions so neither half can be read as the other.
    expect(run?.spec.commandPolicy.allow).toContain('git log');
    expect(run?.spec.commandPolicy.allow).toContain('npm test');
    expect(run?.spec.commandPolicy.allow).not.toContain('git commit *');
    expect(run?.spec.commandPolicy.allow).not.toContain('git push origin agentic/*');
    // Everything the SDK wrote to the process, as one string — the shape `agent-run.e2e.test.ts`
    // uses, because `cli.stdin` is the parsed frames rather than the bytes.
    const written = JSON.stringify(run?.cli.stdin ?? []);
    expect(written).toContain('onboarding-discovery');
    expect(written).toContain(projectId);

    /**
     * **Charged to the project's budget like any other run** (WP-19).
     *
     * One entry **per model** rather than one per run: the scripted CLI reports the run's own model
     * and a sub-agent's, which is what the ledger's per-model split exists for. So the assertion is
     * on the set of models and on the total, not on a row count — a count would have to be edited
     * every time the fixture's model list changed, and would say nothing about the money.
     */
    /**
     * **The wait this read never had** — standing rule 87, fixed as a pre-review round of WP-52
     * (the defect is not that row's; see its notes).
     *
     * `settle(… task.state === 'done')` above binds the **task aggregate's** state. The ledger is a
     * handler on `run.finished` at TD-005 priority 10 writing `cost_entries` in its **own
     * transaction** (WP-19), so it commits after the task is already `done` — the assertion bound a
     * row written by a later, separate dispatch than the wait's condition. Green at low load, red
     * at high: it failed once at a one-minute load of about 12, on a second pass over a tree the
     * first pass had passed.
     *
     * The answer is rule 87's own: bind the **assertion's own row**, not widen `settle` to mean
     * everything — other cases depend on `settle` meaning what it says. The predicate counts the
     * exact rows the block below reads, so it is false until they exist rather than until something
     * adjacent does.
     */
    await pipeline.waitFor('the discovery run’s ledger rows', async () => {
      // Scoped by **task** as well as stage: one discovery run exists today, so `stage` alone is
      // exact — but exact-by-fixture decays the moment a second one does, and the predicate is
      // meant to be exact by construction.
      const rows = await pipeline.query<{ count: number }>(
        `select count(*)::int as count from cost_entries
          where stage = 'discovery' and task_id = $1`,
        [discovery.body.task_id],
      );
      return (rows[0]?.count ?? 0) > 0;
    });

    const cost = await pipeline.costRows();
    const charged = cost.entries.filter((entry) => entry.stage === 'discovery');
    expect(charged.length).toBeGreaterThan(0);
    expect(new Set(charged.map((entry) => entry.model)).size).toBe(charged.length);
    expect(charged.every((entry) => entry.run_id !== null && !entry.is_estimate)).toBe(true);
    expect(charged.reduce((total, entry) => total + entry.usd, 0)).toBeGreaterThan(0);

    /**
     * The file's other three post-`settle` reads, swept with rule 87's two questions — *is the row
     * written before or after the thing waited on, and was the predicate already true?* — because
     * one instance is never one instance (standing rule 49):
     *
     *  - **this one, `run_messages`**: the transcript sink appends each entry *during* the run, so
     *    every row exists before `run.finished`, let alone before the task reaches `done`. Written
     *    **before** the wait's condition; safe, and no wait is owed;
     *  - **`proposals()` below**: written by the `onboarding.discovery` job — but in the **same
     *    transaction** as the `readiness_evaluations` row (`onboarding/record.ts`), and the
     *    `waitFor('the readiness evaluation', …)` between here and there binds that row. Covered by
     *    an existing wait rather than by luck, which is why it is stated here and not fixed;
     *  - **the `human_actions` query**: written synchronously by the HTTP commands this test itself
     *    awaited. Written before, asserted after; safe.
     *
     * So exactly one read was unbound, and it is the one above.
     */
    const transcript = await pipeline.transcript();
    expect(transcript.length).toBeGreaterThan(0);
    expect(JSON.stringify(transcript)).not.toContain('FAKE-anthropic-key');

    // ── The readiness report ────────────────────────────────────────────────

    await pipeline.waitFor('the readiness evaluation', async () => {
      const rows = await pipeline.query<{ count: number }>(
        'select count(*)::int as count from readiness_evaluations',
      );
      return (rows[0]?.count ?? 0) > 0;
    });

    const readiness = await client.json<ReadinessResponse>(`/api/projects/${projectId}/readiness`);
    expect(readiness.status).toBe(200);
    expect(readiness.body.source).toBe('discovery');
    expect(readiness.body.criteria).toHaveLength(14);
    const byId = new Map(readiness.body.criteria.map((entry) => [entry.id, entry]));
    expect(byId.get('R1')?.passed).toBe(true);
    expect(byId.get('R1')?.evidence).toBe('.github/workflows/ci.yml runs `npm test` on main');
    expect(byId.get('R5')?.passed).toBe(false);
    // The agent claimed R9; the platform answered it from the git provider, which reports the
    // fixture's default branch as protected — so the *evidence* is the platform's sentence and not
    // the model's, which is the assertion that fails if the claim were ever merged in.
    expect(byId.get('R9')?.detected_by).toBe('platform');
    expect(byId.get('R9')?.evidence).not.toContain('looks protected to me');
    // R1 and R3 both pass, so the ladder is at level 1 — and R5 fails, so it is not level 2.
    expect(readiness.body.level).toBe(1);
    expect(readiness.body.next_improvements.map((entry) => entry.id)).toContain('R5');

    /**
     * **The transition, which is the criterion**: a project created at level 0 leaves it through
     * the shipped commands — create, bind, run discovery — and nothing else. `readiness_level` is
     * the projection the board badge reads, written with the row.
     */
    const projects = await client.json<{ items: { id: string; readiness_level: number }[] }>(
      '/api/projects',
    );
    expect(projects.body.items.find((item) => item.id === projectId)?.readiness_level).toBe(1);
    expect(created.body.readiness_level).toBe(0);

    // ── The drafted pages, as proposals ─────────────────────────────────────

    const proposals = await pipeline.proposals();
    expect(proposals.map((entry) => entry.target_path).sort()).toEqual([
      '.agentic/knowledge/technical/how-to-run.md',
      '.agentic/knowledge/technical/overview.md',
    ]);
    // product/06: nothing is committed without acceptance.
    expect(proposals.every((entry) => entry.status === 'queued')).toBe(true);
    expect(proposals.every((entry) => entry.applied_commit_sha === null)).toBe(true);
    // TD-012: the credential the drafted page carried is redacted before the row exists.
    const overview = proposals.find((entry) => entry.target_path.endsWith('overview.md'));
    expect(overview?.delta).not.toContain(PLANTED_REPO_SECRET);
    expect(overview?.delta).toContain('[REDACTED');
    // …and the page is still there, which a store that wrote nothing would also satisfy (rule 42).
    expect(overview?.delta).toContain('One service, one database.');

    // ── Step 4: operating mode ──────────────────────────────────────────────

    const config = await command<{ hash: string; autonomy_level: string }>(
      client,
      `/api/projects/${projectId}/config`,
      { config: { version: 1 }, autonomy_level: 'assist' },
      { method: 'PUT' },
    );
    expect(config.status).toBe(200);
    expect(config.body.autonomy_level).toBe('assist');

    const effective = await client.json<{ config: Record<string, unknown>; hash: string }>(
      `/api/projects/${projectId}/config`,
    );
    expect(effective.status).toBe(200);
    expect(effective.body.hash).toBe(config.body.hash);
    expect((effective.body.config as { policies?: { autonomy?: string } }).policies?.autonomy).toBe(
      'assist',
    );
    // A dial that disagrees with the document is refused rather than silently resolved.
    const disagreeing = await command(
      client,
      `/api/projects/${projectId}/config`,
      { config: { version: 1, policies: { autonomy: 'autonomous' } }, autonomy_level: 'observe' },
      { method: 'PUT' },
    );
    expect(disagreeing.status).toBe(400);

    // ── Step 4's risk classes, on the published document (WP-45) ───────────

    /**
     * Criterion 1, asserted on what the server **publishes** rather than on a docblock: `payments`
     * is offered with both of product/19 §14's requirements and the checklist it needs is named, by
     * the classes that select it, as not yet defined here.
     */
    const offered = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    const proposal = offered.body.risk_class_proposal;
    expect(proposal.classes.payments?.require).toEqual(['plan_approval', 'checklist:payments']);
    expect(proposal.classes.public_api?.require).toEqual(['checklist:public_api']);
    expect(
      proposal.checklists.map((entry) => [entry.name, entry.required_by, entry.defined]),
    ).toEqual([
      ['payments', ['payments'], false],
      ['public_api', ['public_api'], false],
    ]);
    // Criterion 2: accepting the classes without the lists is refused at the configuration write,
    // with the key path and the value — and writes no audit row, because nothing was done.
    const bare = await command<{ error: { details?: { path: string; message: string }[] } }>(
      client,
      `/api/projects/${projectId}/config`,
      { config: { version: 1, policies: { autonomy: 'assist', risk_classes: proposal.classes } } },
      { method: 'PUT' },
    );
    expect(bare.status).toBe(400);
    const refused = bare.body.error.details ?? [];
    expect(refused.map((issue) => issue.path).sort()).toEqual([
      '/config/policies/risk_classes/payments/require/1',
      '/config/policies/risk_classes/public_api/require/0',
    ]);
    expect(refused.map((issue) => issue.message).join(' ')).toContain('"checklist:payments"');
    // …and with the operator's own items, the same classes are accepted and the offer says so.
    const accepted = await command<{ hash: string }>(
      client,
      `/api/projects/${projectId}/config`,
      {
        config: {
          version: 1,
          policies: {
            autonomy: 'assist',
            risk_classes: proposal.classes,
            review_checklists: {
              payments: ['Amounts are integer minor units'],
              public_api: ['No field is removed from a published response'],
            },
          },
        },
      },
      { method: 'PUT' },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const reread = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    expect(reread.body.risk_class_proposal.checklists.every((entry) => entry.defined)).toBe(true);

    // Every command the wizard ran is audited (technical/08 § "Rate limits and safety").
    const actions = await pipeline.query<{ action: string }>(
      'select action from human_actions order by created_at',
    );
    // A refused command writes no row: an audit of actions that did not happen is not an audit.
    expect(actions.map((entry) => entry.action)).toEqual([
      'project.create',
      'integration.create',
      // WP-100: the Sentry row's probe, the pre-WP-100 row's repair and its probe; the refused
      // creates, the refused probe and the three refused PATCHes left no row.
      'integration.test',
      'integration.config.write',
      'integration.test',
      'integration.test',
      'project.bindings.write',
      'project.discovery.start',
      'project.config.write',
      // WP-45: the accepted risk classes and their checklists; the refused write left no row.
      'project.config.write',
    ]);

    // ── The wizard produced a working project ───────────────────────────────

    /**
     * The only assertion that cannot be satisfied by a seeded row: a **signed webhook delivery**
     * to this instance resolves the binding `PUT …/bindings` wrote, normalises to `ticket.matched`
     * and starts a task on the project the wizard created.
     */
    const delivery = pipeline.tickets.emitTicketMatched({
      ticketKey: 'ACME-1',
      rule: 'label:agentic',
    });
    const response = await fetch(
      `${pipeline.instance.baseUrl}/webhooks/${FAKE_TASK_MANAGEMENT_PROVIDER_ID}/${TICKETS_INTEGRATION_ID}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...delivery.headers },
        body: delivery.body,
      },
    );
    expect(response.status).toBe(202);

    await pipeline.waitFor('the ticket to start a task on the wizard’s project', async () => {
      const rows = await pipeline.query<{ count: number }>(
        "select count(*)::int as count from tasks where project_id = $1 and ticket_key = 'ACME-1'",
        [projectId],
      );
      return (rows[0]?.count ?? 0) > 0;
    });
  }, 300_000);
});
