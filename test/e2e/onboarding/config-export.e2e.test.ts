/**
 * **WP-63 criterion 5: export, edit the file, re-read — and the effective configuration moves.**
 *
 * Everything here is a real `apps/server` instance: the routes, the RBAC guard, the audit rows, the
 * platform's own bare mirror of a **real git repository on disk** (TD-026, `file://`), the YAML
 * codec, the `project_repository_config` table and the effective-configuration merge. The one
 * double is the git provider the export commits through (`fake-git`), because a merge request is a
 * provider object — so "the merge request was merged, with an edit" is played by this file
 * committing the exported bytes, edited, onto the fixture repository's default branch, which is
 * exactly what a reviewer merging it with a suggestion would leave behind.
 *
 * What each step proves:
 *
 *  1. The settings (written through `PUT …/config`) are the only layer until the repository is
 *     read: `sources` answers `project`, and the reading is `unread`, then `absent`.
 *  2. The export is a branch and a merge request, never the default branch (Q94 (b)); it needs an
 *     `Idempotency-Key`, leaves one `human_actions` row, and a replay sends nothing again. The file
 *     it proposes reads back as the settings document.
 *  3. After the edited file lands on the default branch and is re-read, the repository **wins**
 *     where it states an operational key, the settings still answer where it is silent (Q94 (a),
 *     criterion 3 against a real reading), and — review round 1's ruling — what the file tightens
 *     takes effect while what it would loosen does not, and is reported in `not_applied`.
 *  4. A file that fails the schema is a **named refusal** naming the key path (criterion 4) — the
 *     effective configuration is refused rather than served without the layer.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  agenticConfigSchema,
  type EffectiveConfigResponse,
  type ExportProjectConfigResponse,
  type RefreshProjectConfigResponse,
} from '@platform/contracts';
import { config as configAdapters } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_EMAIL, BOOTSTRAP_PASSWORD, Client } from '../support/instance.js';
import { type PipelineE2E, startPipeline } from '../support/pipeline.js';
import { TICKETS } from '../support/scenarios.js';

const execFileAsync = promisify(execFile);

let harness: PipelineE2E | undefined;
let workspace: string;
let mirrorRoot: string;
let repo: string;

const git = async (args: readonly string[]): Promise<string> => {
  const { stdout } = await execFileAsync('git', [...args], { maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
};

const commitAll = async (message: string): Promise<string> => {
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
    message,
  ]);
  return git(['-C', repo, 'rev-parse', 'HEAD']);
};

beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'wp63-config-'));
  mirrorRoot = path.join(workspace, 'mirrors');
  repo = path.join(workspace, 'fixture-repo');
  await mkdir(mirrorRoot, { recursive: true });
  await mkdir(path.join(repo, '.agentic/knowledge'), { recursive: true });
  await git(['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(repo, 'README.md'), '# fixture repository\n');
  await writeFile(
    path.join(repo, '.agentic/knowledge/index.md'),
    '---\nid: index\ntitle: Index\ntype: reference\nkind: technical\nscope: project\n---\n\nOne page.\n',
  );
  await commitAll('the fixture repository');
}, 120_000);

afterAll(async () => {
  await harness?.stop();
  harness = undefined;
  await rm(workspace, { recursive: true, force: true });
});

const signIn = async (baseUrl: string): Promise<Client> => {
  const client = new Client(baseUrl);
  const response = await client.post('/api/auth/sign-in/email', {
    email: BOOTSTRAP_EMAIL,
    password: BOOTSTRAP_PASSWORD,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return client;
};

const send = async <T>(
  client: Client,
  target: string,
  body: unknown,
  options: { readonly method?: 'POST' | 'PUT'; readonly key?: string } = {},
): Promise<{ status: number; body: T }> =>
  client.json<T>(target, {
    method: options.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
    body: JSON.stringify(body),
  });

/** The settings the operator writes in the UI — which the repository will later disagree with. */
const SETTINGS = {
  version: 1,
  stages: { refinement: { model: 'claude-opus-5', budget_usd: 2 } },
  features: { digest: { at: '08:00' } },
  commands: { allow: ['npm test'] },
} as const;

describe('the configuration export and the repository layer', () => {
  it('exports the settings, reads the edited file back, and moves the effective configuration', async () => {
    const pipeline = await startPipeline({
      label: 'config-export',
      scenarios: () => ({}),
      tickets: TICKETS,
      // `repositoryPathOf` strips the scheme and the leading slashes off `projects.repo_url`, so
      // this is the path the export's commit and merge request address the fake provider by.
      gitProjects: [repo.replace(/^\/+/, '')],
      env: { APP_KNOWLEDGE_MIRROR_ROOT: mirrorRoot },
    });
    harness = pipeline;
    // The seeded project points at the fixture repository on disk, which the mirror clones.
    await pipeline.query('update projects set repo_url = $1 where id = $2', [
      `file://${repo}`,
      pipeline.projectId,
    ]);
    const projectId = pipeline.projectId;
    const client = await signIn(pipeline.instance.baseUrl);

    // ── 0. WP-91: unread keys are reported at the write, and `pipeline.wip` is read and bounded ──
    const unreadKeys = await send<{ hash: string; not_applied: { key: string; reason: string }[] }>(
      client,
      `/api/projects/${projectId}/config`,
      {
        config: {
          version: 1,
          pipeline: {
            template_overrides: {
              feature: { enabled: false, stages: { business_review: { enabled: false } } },
            },
            wip: { max_parallel_tasks: 3 },
          },
        },
      },
      { method: 'PUT' },
    );
    expect(unreadKeys.status, JSON.stringify(unreadKeys.body)).toBe(200);
    // Both levels the ruling names — the template-level `enabled` (backlog 220) and a stage's.
    expect(unreadKeys.body.not_applied.map((item) => item.key).sort()).toEqual([
      'pipeline.template_overrides.feature.enabled',
      'pipeline.template_overrides.feature.stages.business_review.enabled',
    ]);
    const reported = await client.json<EffectiveConfigResponse>(
      `/api/projects/${projectId}/config`,
    );
    expect(reported.body.not_applied.map((item) => item.key).sort()).toEqual([
      'pipeline.template_overrides.feature.enabled',
      'pipeline.template_overrides.feature.stages.business_review.enabled',
    ]);
    expect(reported.body.effective.pipeline?.wip).toEqual({
      max_parallel_tasks: 3,
      max_tasks_in_pipeline: 5,
    });
    expect(reported.body.sources['pipeline.wip.max_parallel_tasks']).toBe('project');
    // The organisation's maximum, written by SQL on this build (WP-93 owns its surface): it
    // bounds the stored value at the next read and refuses a write above it.
    await pipeline.query(
      `update organizations set settings = settings || '{"pipeline":{"wip":{"max_parallel_tasks":2}}}'::jsonb
        where id = (select org_id from projects where id = $1)`,
      [projectId],
    );
    const bounded = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    expect(bounded.body.effective.pipeline?.wip?.max_parallel_tasks).toBe(2);
    expect(bounded.body.sources['pipeline.wip.max_parallel_tasks']).toBe('org');
    expect(bounded.body.not_applied.map((item) => item.key)).toContain(
      'pipeline.wip.max_parallel_tasks',
    );
    const above = await send<{ error: { code: string; message: string } }>(
      client,
      `/api/projects/${projectId}/config`,
      { config: { version: 1, pipeline: { wip: { max_parallel_tasks: 4 } } } },
      { method: 'PUT' },
    );
    expect(above.status).toBe(409);
    expect(above.body.error.code).toBe('wip_above_organisation');
    await pipeline.query(
      `update organizations set settings = settings - 'pipeline'
        where id = (select org_id from projects where id = $1)`,
      [projectId],
    );

    // ── 1. the settings are the only layer until the repository is read ─────
    const written = await send<{ hash: string }>(
      client,
      `/api/projects/${projectId}/config`,
      { config: SETTINGS },
      { method: 'PUT' },
    );
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    const unread = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    expect(unread.status).toBe(200);
    expect(unread.body.repository.status).toBe('unread');
    expect(unread.body.sources['stages.refinement.model']).toBe('project');

    const absent = await send<RefreshProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/refresh`,
      {},
    );
    expect(absent.status, JSON.stringify(absent.body)).toBe(200);
    expect(absent.body.repository.status).toBe('absent');
    expect(absent.body.repository.commit_sha).toBe(await git(['-C', repo, 'rev-parse', 'HEAD']));

    // ── 2. the export: a branch and a merge request, keyed, audited, replayable ──
    const unkeyed = await send<{ error: { code: string } }>(
      client,
      `/api/projects/${projectId}/config/export`,
      {},
    );
    expect(unkeyed.status).toBe(400);
    expect(unkeyed.body.error.code).toBe('idempotency_key_required');

    const exported = await send<ExportProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/export`,
      { base_hash: written.body.hash },
      { key: 'wp63-export-1' },
    );
    expect(exported.status, JSON.stringify(exported.body)).toBe(200);
    expect(exported.body.status).toBe('exported');
    expect(exported.body.performed).toBe(true);
    expect(exported.body.branch).toMatch(/^agentic\/config\/[0-9a-f]{12}-[0-9a-f]{12}$/);
    expect(exported.body.merge_request_url).not.toBeNull();
    expect(exported.body.paths).toEqual(['.agentic/config.yml', 'CLAUDE.md']);

    const commit = pipeline.git.commits.at(-1);
    expect(commit?.branch).toBe(exported.body.branch);
    // Q94 (b): nothing was committed onto the default branch.
    expect(pipeline.git.commits.some((entry) => entry.branch === 'main')).toBe(false);
    const file = commit?.files.find((entry) => entry.path === '.agentic/config.yml');
    const pointer = commit?.files.find((entry) => entry.path === 'CLAUDE.md');
    expect(pointer?.content).toContain('.agentic/knowledge/index.md');
    const proposed = configAdapters.yamlConfigCodec.parse(file?.content ?? '');
    expect(proposed.ok && agenticConfigSchema.parse(proposed.value)).toEqual(SETTINGS);

    const replay = await send<ExportProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/export`,
      { base_hash: written.body.hash },
      { key: 'wp63-export-1' },
    );
    expect(replay.body).toMatchObject({ performed: false, branch: exported.body.branch });
    expect(
      pipeline.git.commits.filter((entry) => entry.branch === exported.body.branch),
    ).toHaveLength(1);
    expect(
      await pipeline.query(
        "select count(*)::int as count from human_actions where action = 'project.config.export'",
      ),
    ).toEqual([{ count: 1 }]);

    // ── 2b. WP-91 (backlog 225): a second press — a new key — with the first still open ──
    // It answers that merge request instead of opening a second one; the provider is asked (a
    // read), nothing is committed or opened, and the settings page's read lists it after a reload.
    const openMergeRequests = async (): Promise<number> =>
      (
        await pipeline.query<{ count: number }>(
          "select count(*)::int as count from integration_actions where action = 'open_merge_request' and project_id = $1",
          [projectId],
        )
      )[0]?.count ?? -1;
    expect(await openMergeRequests()).toBe(1);
    const again = await send<ExportProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/export`,
      { base_hash: written.body.hash },
      { key: 'wp91-export-2' },
    );
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({
      status: 'open',
      performed: false,
      branch: exported.body.branch,
      merge_request_url: exported.body.merge_request_url,
      commit_sha: null,
    });
    expect(again.body.notes[0]).toMatch(/already proposes this configuration/);
    expect(await openMergeRequests()).toBe(1);
    expect(pipeline.git.commits).toHaveLength(1);
    const listed = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    expect(listed.body.last_export).toMatchObject({
      status: 'open',
      merge_request_url: exported.body.merge_request_url,
    });

    // The other direction: once that merge request is closed, a third press opens a new one.
    const iid = Number(exported.body.merge_request_url?.split('/').at(-1));
    await pipeline.git.closeMergeRequest({
      iid,
      url: exported.body.merge_request_url ?? '',
      project_path: repo.replace(/^\/+/, ''),
    });
    const third = await send<ExportProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/export`,
      { base_hash: written.body.hash },
      { key: 'wp91-export-3' },
    );
    expect(third.status, JSON.stringify(third.body)).toBe(200);
    expect(third.body.status).toBe('exported');
    expect(third.body.merge_request_url).not.toBe(exported.body.merge_request_url);
    expect(await openMergeRequests()).toBe(2);

    // ── 3. the reviewer merges it with an edit; the platform re-reads the default branch ──
    // The model changed in review, the budget removed (so the settings answer it again), a
    // command added, and a dial position the file may state and the platform does not apply.
    const edited = {
      version: 1,
      stages: { refinement: { model: 'claude-sonnet-5' } },
      features: { digest: { at: '09:30' } },
      // Review round 1's ruling: the file may tighten (a block, a protected path), never loosen
      // (a re-granted command, an emptied protected-path list, the dial and its overrides).
      commands: { allow: ['npm test', 'make test'], block: ['make deploy*'] },
      policies: {
        autonomy: 'autonomous',
        probation_tasks: 0,
        protected_paths: ['infra/**'],
      },
    };
    await mkdir(path.join(repo, '.agentic'), { recursive: true });
    await writeFile(
      path.join(repo, '.agentic/config.yml'),
      configAdapters.yamlConfigCodec.stringify(edited, ['edited in review']),
    );
    await writeFile(path.join(repo, 'CLAUDE.md'), pointer?.content ?? '');
    const mergedHead = await commitAll('Merge the configuration export, edited');

    const valid = await send<RefreshProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/refresh`,
      {},
    );
    expect(valid.status, JSON.stringify(valid.body)).toBe(200);
    expect(valid.body.repository).toMatchObject({ status: 'valid', commit_sha: mergedHead });

    const moved = await client.json<EffectiveConfigResponse>(`/api/projects/${projectId}/config`);
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // The repository wins where it states a key…
    expect(moved.body.effective.stages?.refinement?.model).toBe('claude-sonnet-5');
    expect(moved.body.sources['stages.refinement.model']).toBe('repo');
    // …where it tightens: an added block and an added protected path take effect…
    expect(moved.body.effective.commands?.block).toContain('make deploy*');
    expect(moved.body.sources['commands.block']).toBe('repo');
    expect(moved.body.effective.policies?.protected_paths).toEqual(
      expect.arrayContaining(['infra/**', '.agentic/**', 'tests/**']),
    );
    // …and where it would loosen, nothing moves and the reading says so.
    expect(moved.body.effective.commands?.allow).not.toContain('make test');
    expect(moved.body.ignored_allow_commands).toContain('make test');
    expect(moved.body.effective.features?.digest?.at).toBe('08:00');
    expect(moved.body.effective.policies?.probation_tasks).toBe(5);
    expect(moved.body.effective.policies?.autonomy).not.toBe('autonomous');
    expect(moved.body.repository.not_applied.map((item) => item.key).sort()).toEqual([
      'features',
      'policies.autonomy',
      'policies.probation_tasks',
      'policies.protected_paths',
    ]);
    // The settings answer where the file is silent, and the settings layer itself is untouched.
    expect(moved.body.effective.stages?.refinement?.budget_usd).toBe(2);
    expect(moved.body.sources['stages.refinement.budget_usd']).toBe('project');
    expect(moved.body.config).toEqual(SETTINGS);

    // ── 4. a file that fails the schema is a named refusal ──────────────────
    await writeFile(
      path.join(repo, '.agentic/config.yml'),
      'version: 1\nstages:\n  refinement:\n    max_turns: many\n',
    );
    await commitAll('a configuration that does not parse');
    const invalid = await send<RefreshProjectConfigResponse>(
      client,
      `/api/projects/${projectId}/config/refresh`,
      {},
    );
    expect(invalid.status).toBe(200);
    expect(invalid.body.repository.status).toBe('invalid');
    expect(invalid.body.repository.detail).toContain('stages.refinement.max_turns');

    const refused = await client.json<{ error: { code: string; message: string } }>(
      `/api/projects/${projectId}/config`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('invalid_repository_config');
    expect(refused.body.error.message).toContain('stages.refinement.max_turns');
    expect(
      await pipeline.query<{ status: string }>(
        'select status from project_repository_config where project_id = $1',
        [projectId],
      ),
    ).toEqual([{ status: 'invalid' }]);
  }, 180_000);
});
