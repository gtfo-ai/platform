import { describe, expect, it } from 'vitest';
import type * as z from 'zod';
import { apiErrorSchema } from './api.js';
import { runCredentialIssues, type WorkspaceSpec } from './run-spec.js';
import {
  ACCEPTED_WORKER_PROTOCOLS,
  isAcceptedWorkerProtocol,
  parseWorkerProtocolHeader,
  runPackageSchema,
  WORKER_PACKAGE_MAX_BYTES,
  WORKER_PATHS,
  WORKER_PROTOCOL_HEADER,
  WORKER_PROTOCOL_LOCAL_UI,
  WORKER_PROTOCOL_VERSION,
  WORKER_USER_CODE_ALPHABET,
  workerApprovalRequestSchema,
  workerApprovalResponseSchema,
  workerClaimRequestSchema,
  workerDeviceRequestSchema,
  workerDeviceResponseSchema,
  workerDeviceTokenErrorSchema,
  workerDeviceTokenRequestSchema,
  workerDeviceTokenResponseSchema,
  workerFinishRequestSchema,
  workerFinishResponseSchema,
  workerHandshakeRequestSchema,
  workerHandshakeResponseSchema,
  workerHeartbeatRequestSchema,
  workerHeartbeatResponseSchema,
  workerLateCostRequestSchema,
  workerLateCostResponseSchema,
  workerLeaseLostBodySchema,
  workerPauseRequestSchema,
  workerReleaseResponseSchema,
  workerRunReleaseRequestSchema,
  workerSessionRequestSchema,
  workerSpawnRequestSchema,
  workerSpawnResponseSchema,
  workerSshSignRequestSchema,
  workerSshSignResponseSchema,
  workerToolCallRequestSchema,
  workerToolCallResponseSchema,
  workerTranscriptRequestSchema,
  workerTranscriptResponseSchema,
  workerUpdateReportRequestSchema,
  workerUpgradeRequiredBodySchema,
} from './worker.js';

/**
 * WP-273: the worker protocol's constants, the run package (TD-031 decision 4) and every DTO of
 * TD-031 decision 9 — each strict, and the package refusing every secret it must not carry. All
 * values are obviously fake.
 */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const TASK_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const RUN_TOKEN = `FAKE_run_token_${'0'.repeat(28)}`;
const PASSWORD = 'fake_run_credential_push_0001';
const DIGESTS = {
  platform: DIGEST,
  platform_launcher: DIGEST,
  platform_runtime: DIGEST_B,
  platform_egress: DIGEST_B,
};

const REPO = {
  url: 'https://git.example.com/acme/api.git',
  defaultBranch: 'main',
  checkoutBranch: null,
  checkoutCommit: null,
  cacheKey: 'acme-api',
} as const;

const workspace = (overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  runId: RUN_ID,
  projectId: PROJECT_ID,
  repo: REPO,
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 512, tmpfsMb: 256, stopGraceSeconds: 10 },
  egress: { hosts: ['api.anthropic.com', 'git.example.com'], connectPorts: [443] },
  runtime: 'runc',
  readOnly: false,
  skills: ['kb'],
  protectedPaths: ['infra/**'],
  env: { CI: 'true' },
  keepUntil: '2026-11-07T00:00:00.000Z',
  runletProtocol: 3,
  ...overrides,
});

const SSH = {
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE',
  httpsPrefix: 'https://git.example.com/',
  sshPrefix: 'ssh://git@altssh.example.com:443/',
  connectHost: 'altssh.example.com',
  connectPort: 443,
  hostKeyAlias: 'git.example.com',
  knownHosts: ['git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKE'],
};

/** A writing spec whose git goes over SSH with a deploy key's route (TD-028 decision 13b). */
const sshWorkspace = (ssh: typeof SSH = SSH): WorkspaceSpec =>
  workspace({
    repo: { ...REPO, ssh },
    egress: { hosts: ['git.example.com', 'altssh.example.com'], connectPorts: [443] },
  });

const runSpec = () => ({
  runId: RUN_ID,
  taskId: TASK_ID,
  projectId: PROJECT_ID,
  stage: 'implementation',
  role: 'developer',
  mode: 'normal',
  attempt: 1,
  model: 'claude-opus-5',
  effort: 'high',
  providerMode: 'local',
  promptVersion: 'developer@3+skills@none',
  systemPromptAppend: 'You are the developer agent.',
  userPrompt: 'Fix the flaky login test.',
  workspacePath: '/work/repo',
  checkoutRef: null,
  checkoutCommit: null,
  unfinishedWorkBranch: null,
  contextPack: [],
  limits: {
    maxTurns: 60,
    maxBudgetUsd: 10,
    stallTimeoutMs: 300_000,
    wallClockMs: 3_600_000,
    toolOutputMaxChars: 10_000,
    questionTimeoutMs: 86_400_000,
  },
  tools: ['Read', 'Bash'],
  disallowedTools: [],
  platformTools: ['report_progress'],
  commandPolicy: { allow: [], ask: [], block: [], unattended: 'deny' },
  protectedPaths: ['infra/**'],
  plannedProtectedPaths: [],
  existingProtectedPaths: { state: 'unlisted', reason: 'planned before the workspace' },
  agents: {},
  mcpServers: {},
  skills: ['agentic:kb'],
  artifactType: null,
  env: { PATH: '/usr/bin' } as Record<string, string>,
  secretEnvNames: [] as string[],
  claudeCodePath: null,
  resumeSessionId: null,
});

const runPackage = () => ({
  runId: RUN_ID,
  epoch: 1,
  runToken: RUN_TOKEN,
  run: runSpec(),
  workspace: workspace(),
  credential: {
    host: 'git.example.com',
    username: 'oauth2',
    password: PASSWORD,
    scope: 'push',
    expiresAt: '2026-11-04T18:00:00.000Z',
    source: 'minted',
  },
  skills: {
    digest: 'skills@0123456789abcdef',
    files: { kb: { 'SKILL.md': '# kb\n' } },
    versions: { kb: '2' },
  },
  images: { run: DIGEST_B, egress: DIGEST_B },
  limits: { leaseTtlMs: 600_000 },
});

/** The messages a refused package carries. */
const refusals = (value: unknown): string[] => {
  const parsed = runPackageSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('protocol versions (TD-032 decision 7)', () => {
  it('ships N = 2, accepting [N-1, N] without a 0 (WP-292 bumped it)', () => {
    expect(WORKER_PROTOCOL_VERSION).toBe(2);
    expect(ACCEPTED_WORKER_PROTOCOLS).toEqual([1, 2]);
    // The local UI's verbs and keys are protocol 2's: the version that introduced them is N.
    expect(WORKER_PROTOCOL_LOCAL_UI).toBe(2);
    expect(ACCEPTED_WORKER_PROTOCOLS).toContain(WORKER_PROTOCOL_VERSION);
    for (const version of ACCEPTED_WORKER_PROTOCOLS) {
      expect([WORKER_PROTOCOL_VERSION - 1, WORKER_PROTOCOL_VERSION]).toContain(version);
      expect(version).toBeGreaterThan(0);
    }
  });

  it('accepts exactly the listed versions', () => {
    expect(isAcceptedWorkerProtocol(1)).toBe(true);
    expect(isAcceptedWorkerProtocol(2)).toBe(true);
    expect(isAcceptedWorkerProtocol(0)).toBe(false);
    expect(isAcceptedWorkerProtocol(3)).toBe(false);
  });

  it('reads the X-Worker-Protocol header strictly; anything else is no protocol (426)', () => {
    expect(WORKER_PROTOCOL_HEADER).toBe('x-worker-protocol');
    expect(parseWorkerProtocolHeader('1')).toBe(1);
    expect(parseWorkerProtocolHeader('12')).toBe(12);
    for (const bad of ['0', '01', ' 1', '1 ', '+1', '-1', '1.0', 'one', '', '1234567890']) {
      expect(parseWorkerProtocolHeader(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(parseWorkerProtocolHeader(undefined)).toBeNull();
    expect(parseWorkerProtocolHeader(['1', '1'])).toBeNull();
  });

  it('names every verb of TD-031 decision 9 once', () => {
    const paths = Object.values(WORKER_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    // WP-281: the spawn marker joined TD-031 §9's seventeen (its 2026-11-04 amendment §4).
    // WP-292: the local UI's two verbs (TD-031's worker-UI amendment §4).
    expect(paths).toHaveLength(20);
    expect(paths).toContain('runs/:id/spawn');
    expect(paths).toContain('manual-pause');
    expect(paths).toContain('runs/:id/cancel');
  });
});

describe('runPackageSchema (TD-031 decision 4)', () => {
  it('admits a package the core would send', () => {
    expect(refusals(runPackage())).toEqual([]);
  });

  it('admits the display block (protocol 2), strictly and bounded (WP-292)', () => {
    const display = { projectKey: 'ACME', ticketKey: 'ACME-12', title: 'Fix the login' };
    expect(refusals({ ...runPackage(), display })).toEqual([]);
    expect(refusals({ ...runPackage(), display: { ...display, title: null } })).toEqual([]);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), display: { ...display, x: 1 } }).success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({
        ...runPackage(),
        display: { ...display, title: 'x'.repeat(501) },
      }).success,
    ).toBe(false);
  });

  it('is strict at every level: an unknown key is refused', () => {
    expect(runPackageSchema.safeParse({ ...runPackage(), extra: 1 }).success).toBe(false);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), limits: { leaseTtlMs: 600_000, more: 1 } })
        .success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), run: { ...runSpec(), apiKey: 'x' } }).success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), images: { run: DIGEST, egress: DIGEST, x: 1 } })
        .success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), workspace: { ...workspace(), extra: 1 } })
        .success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({
        ...runPackage(),
        credential: { ...runPackage().credential, extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({
        ...runPackage(),
        skills: { ...runPackage().skills, extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('refuses any MCP server configuration: it is opaque and may carry a credential', () => {
    const pkg = runPackage();
    const withMcp = {
      ...pkg,
      run: {
        ...pkg.run,
        mcpServers: { tracker: { headers: { Authorization: `Bearer ${RUN_TOKEN}` } } },
      },
    };
    expect(refusals(withMcp)).toEqual([
      'a run package carries no MCP server configuration: it is opaque and may hold a credential (TD-031 §4)',
    ]);
  });

  it('refuses a credential in the repository URL, and admits an SSH user', () => {
    const withUrl = (url: string) => ({
      ...runPackage(),
      workspace: workspace({ repo: { ...REPO, url } }),
    });
    const message = 'a run package carries no credential in the repository URL (TD-031 §4)';
    expect(
      refusals(withUrl('https://oauth2:secret-value@gitlab.example.test/group/repo.git')),
    ).toEqual([message]);
    expect(refusals(withUrl('https://someone@gitlab.example.test/group/repo.git'))).toEqual([
      message,
    ]);
    expect(refusals(withUrl('ssh://git:pw@gitlab.example.test/group/repo.git'))).toEqual([message]);
    expect(refusals(withUrl('ssh://git@gitlab.example.test/group/repo.git'))).toEqual([]);
    expect(refusals(withUrl('git@gitlab.example.test:group/repo.git'))).toEqual([]);
    expect(refusals(withUrl('https://gitlab.example.test/group/repo.git'))).toEqual([]);
  });

  it('refuses the run credential in either environment — the launcher’s credential-in-env rule', () => {
    const inRun = runPackage();
    inRun.run.env = { PATH: '/usr/bin', GIT_PASSWORD: `prefix-${PASSWORD}` };
    expect(refusals(inRun)).toEqual([
      'the credential appears in the package’s environment, which the agent can read',
    ]);
    const inWorkspace = runPackage();
    inWorkspace.workspace = workspace({ env: { TOKEN: PASSWORD } });
    expect(refusals(inWorkspace)).toEqual([
      'the credential appears in the package’s environment, which the agent can read',
    ]);
  });

  it('refuses the run token, a model credential and a credential-shaped value in an environment', () => {
    const token = runPackage();
    token.run.env = { PATH: '/usr/bin', X: RUN_TOKEN };
    expect(refusals(token)).toEqual([
      'the run token appears in the package’s environment; it never enters the container (TD-031 §7)',
    ]);
    const model = runPackage();
    model.run.env = { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'placeholder' };
    expect(refusals(model)).toEqual([
      'the core never puts a model credential in a package (TD-031 §4)',
    ]);
    const shaped = runPackage();
    shaped.workspace = workspace({ env: { SOMETHING: 'sk-ant-oat01-FAKE-FAKE-FAKE' } });
    expect(refusals(shaped)).toEqual(['a package environment value looks like a credential']);
    const worker = runPackage();
    worker.run.env = { PATH: '/usr/bin', W: 'wkr_fake' };
    expect(refusals(worker)).toEqual(['a package environment value looks like a credential']);
  });

  it('refuses a RunSpec that names a secret environment variable: the package carries no secret value', () => {
    const named = runPackage();
    named.run.secretEnvNames = ['GITLAB_TOKEN'];
    expect(refusals(named)).toEqual([
      'a run package carries no secret value, so it names no secret environment variable (TD-031 §4)',
    ]);
  });

  it('never carries a deploy key: the core signs for an SSH run (TD-031 decision 5)', () => {
    const ssh = sshWorkspace();
    const keyed = {
      ...runPackage(),
      workspace: ssh,
      credential: { ...runPackage().credential, username: 'git', source: 'deploy_key' },
    };
    expect(refusals(keyed)).toEqual([
      'a deploy key never leaves the core: a run package carries none, and the worker forwards ssh.sign to the core (TD-031 decision 5)',
    ]);
    expect(refusals({ ...runPackage(), workspace: ssh })).toEqual([
      'a spec whose git goes over SSH carries no credential in a run package: the core signs for it (TD-031 decision 5)',
    ]);
    expect(refusals({ ...runPackage(), workspace: ssh, credential: null })).toEqual([]);
    const port22 = sshWorkspace({ ...SSH, connectPort: 22 });
    expect(refusals({ ...runPackage(), workspace: port22, credential: null })).toEqual([
      'the SSH route’s port must be one the sidecar admits for CONNECT, and never 22 (TD-028 decision 13b item 4)',
    ]);
  });

  it('applies the launcher’s other credential rules unchanged', () => {
    expect(refusals({ ...runPackage(), credential: null })).toEqual([
      'a spec that writes must carry a run credential; a binding that cannot mint refuses the run before it is created',
    ]);
    expect(
      refusals({
        ...runPackage(),
        credential: { ...runPackage().credential, host: 'elsewhere.example.com' },
      }),
    ).toEqual(['the credential names a host that is not one of the spec’s egress hosts']);
    expect(refusals({ ...runPackage(), workspace: workspace({ readOnly: true }) })).toHaveLength(1);
    expect(refusals({ ...runPackage(), workspace: workspace({ repo: null }) })).toEqual([
      'a spec with no repository carries no credential: nothing will fetch or push',
    ]);
  });

  it('refuses a package whose parts name another run or project, or other skills', () => {
    expect(refusals({ ...runPackage(), runId: OTHER_ID })).toEqual([
      'the package, its RunSpec and its WorkspaceSpec name one run',
    ]);
    expect(refusals({ ...runPackage(), workspace: workspace({ projectId: OTHER_ID }) })).toEqual([
      'the RunSpec and the WorkspaceSpec name one project',
    ]);
    expect(
      refusals({
        ...runPackage(),
        skills: {
          digest: 'skills@0123456789abcdef',
          files: { other: { 'SKILL.md': '' } },
          versions: { other: '1' },
        },
      }),
    ).toEqual([
      'the skills carried are exactly the skills the WorkspaceSpec names',
      'a version is carried for exactly the skills the WorkspaceSpec names',
    ]);
  });

  it('refuses a skill with no version, a file the digest does not cover, and a misused skills@none (WP-279)', () => {
    const base = runPackage().skills;
    expect(refusals({ ...runPackage(), skills: { ...base, versions: {} } })).toEqual([
      'a version is carried for exactly the skills the WorkspaceSpec names',
    ]);
    expect(
      refusals({
        ...runPackage(),
        skills: { ...base, files: { kb: { 'SKILL.md': '# kb\n', 'extra.md': 'unverified' } } },
      }),
    ).toEqual([
      "skill kb carries SKILL.md and nothing else: the set's digest covers no other file (WP-279)",
    ]);
    expect(refusals({ ...runPackage(), skills: { ...base, digest: 'skills@none' } })).toEqual([
      'skills@none is the digest of the empty set, and only of it',
    ]);
  });

  it('refuses a skill file path that escapes its directory, and a digest of another shape', () => {
    for (const path of ['../SKILL.md', '/abs', 'a/./b', 'a//b']) {
      const pkg = {
        ...runPackage(),
        skills: { digest: 'skills@none', files: { kb: { [path]: '' } }, versions: { kb: '1' } },
      };
      expect(runPackageSchema.safeParse(pkg).success, path).toBe(false);
    }
    expect(
      runPackageSchema.safeParse({
        ...runPackage(),
        skills: { digest: 'sha256:abc', files: { kb: {} }, versions: { kb: '1' } },
      }).success,
    ).toBe(false);
    expect(
      runPackageSchema.safeParse({ ...runPackage(), images: { run: 'latest', egress: DIGEST } })
        .success,
    ).toBe(false);
  });

  it(`refuses a package past ${WORKER_PACKAGE_MAX_BYTES} bytes rather than truncating it`, () => {
    const chunk = 'x'.repeat(200 * 1024);
    const names = Array.from({ length: 22 }, (_, index) => `part-${index}`);
    const big = {
      ...runPackage(),
      workspace: workspace({ skills: names }),
      skills: {
        digest: 'skills@0123456789abcdef',
        files: Object.fromEntries(names.map((name) => [name, { 'SKILL.md': chunk }])),
        versions: Object.fromEntries(names.map((name) => [name, '1'])),
      },
    };
    expect(refusals(big)).toEqual([
      `a run package is at most ${WORKER_PACKAGE_MAX_BYTES} bytes of JSON; it is refused, not truncated (TD-031 §4)`,
    ]);
  });
});

describe('runCredentialIssues — the launcher’s carriage', () => {
  it('keeps a deploy key and its SSH route together when the key travels', () => {
    const ssh = sshWorkspace();
    expect(runCredentialIssues(ssh, null, 'carried')).toEqual([
      'a spec whose git goes over SSH carries its deploy key (TD-028 decision 13b)',
      'a spec that writes must carry a run credential; a binding that cannot mint refuses the run before it is created',
    ]);
    const credential = {
      host: 'git.example.com',
      username: 'git',
      password: 'FAKE-PRIVATE-KEY',
      scope: 'push',
      expiresAt: '2026-11-04T18:00:00.000Z',
      source: 'deploy_key',
    } as const;
    expect(runCredentialIssues(ssh, credential, 'carried')).toEqual([]);
    expect(runCredentialIssues(workspace(), credential, 'carried')).toEqual([
      'a deploy-key credential and the spec’s repo.ssh route travel together: one without the other is an SSH run with no key or a key with no route (TD-028 decision 13b)',
    ]);
  });

  /**
   * TD-031's 2026-11-04 amendment (backlog 693): the worker's launcher holds no key. The table is the
   * three carriages over the four shapes that differ — an SSH spec with no credential, with a deploy
   * key, with another credential, and an HTTPS spec with a token.
   */
  it('relayed: an SSH spec carries nothing, a deploy key is refused, HTTPS is carried’s rule', () => {
    const ssh = sshWorkspace();
    const deployKey = {
      host: 'git.example.com',
      username: 'git',
      password: 'FAKE-PRIVATE-KEY',
      scope: 'push',
      expiresAt: '2026-11-04T18:00:00.000Z',
      source: 'deploy_key',
    } as const;
    const token = {
      ...deployKey,
      username: 'oauth2',
      password: PASSWORD,
      source: 'static',
    } as const;
    expect(runCredentialIssues(ssh, null, 'relayed')).toEqual([]);
    expect(runCredentialIssues(ssh, deployKey, 'relayed')).toEqual([
      'a deploy key never reaches a worker’s launcher: its helpers sign through the run’s helper agent socket (TD-031’s 2026-11-04 amendment)',
    ]);
    expect(runCredentialIssues(ssh, token, 'relayed')).toEqual([
      'a spec whose git goes over SSH carries no credential to a worker’s launcher: the core signs for it (TD-031’s 2026-11-04 amendment)',
    ]);
    for (const spec of [workspace(), workspace({ readOnly: true }), workspace({ repo: null })]) {
      for (const credential of [null, token, deployKey]) {
        const carried = runCredentialIssues(spec, credential, 'carried');
        const relayed = runCredentialIssues(spec, credential, 'relayed');
        if (credential?.source === 'deploy_key' && spec.repo !== null) {
          expect(relayed).toHaveLength(1);
        } else {
          expect(relayed).toEqual(carried);
        }
      }
    }
    // The route is still checked with no credential to carry it.
    const port22 = workspace({
      repo: { ...REPO, ssh: { ...SSH, connectPort: 22 } },
      egress: { hosts: ['git.example.com', 'altssh.example.com'], connectPorts: [443] },
    });
    expect(runCredentialIssues(port22, null, 'relayed')).toEqual([
      'the SSH route’s port must be one the sidecar admits for CONNECT, and never 22 (TD-028 decision 13b item 4)',
    ]);
  });
});

/** Each DTO, a body it admits — every one strict, so the same body with one more key is refused. */
const DTO_SAMPLES: ReadonlyArray<readonly [string, z.ZodType, Record<string, unknown>]> = [
  ['device request', workerDeviceRequestSchema, {}],
  [
    'device response',
    workerDeviceResponseSchema,
    {
      device_code: RUN_TOKEN,
      user_code: 'BCDF-GHJK',
      verification_uri: 'https://core.example.com/workers/approve',
      interval: 5,
      expires_in: 600,
    },
  ],
  ['device token request', workerDeviceTokenRequestSchema, { device_code: RUN_TOKEN }],
  [
    'device token response',
    workerDeviceTokenResponseSchema,
    { worker_id: OTHER_ID, credential: `wkr_${'a'.repeat(26)}_${'F'.repeat(43)}` },
  ],
  ['device token error', workerDeviceTokenErrorSchema, { error: 'slow_down' }],
  [
    'handshake request',
    workerHandshakeRequestSchema,
    { image_digests: [DIGEST], commit: 'abc1234' },
  ],
  [
    'handshake response',
    workerHandshakeResponseSchema,
    {
      protocol: { current: 1, accepted: [1] },
      digests: DIGESTS,
      compose_bundle_digest: 'c'.repeat(64),
      worker: {
        id: OTHER_ID,
        name: 'laptop',
        concurrency: 1,
        paused_until: null,
        paused_reason: null,
      },
      server_time: '2026-11-04T12:00:00.000Z',
    },
  ],
  ['claim request', workerClaimRequestSchema, { free_slots: 1, image_digests: [], paused: false }],
  [
    'heartbeat request',
    workerHeartbeatRequestSchema,
    {
      epoch: 2,
      acks: [
        { command_id: OTHER_ID, outcome: 'applied' },
        { command_id: TASK_ID, outcome: 'refused', refused_reason: 'delivery_failed' },
      ],
    },
  ],
  [
    'heartbeat response',
    workerHeartbeatResponseSchema,
    {
      lease_expires_at: '2026-11-04T12:10:00.000Z',
      commands: [{ id: OTHER_ID, kind: 'steer', payload: { message: 'look at the tests' } }],
      approvals: [{ approval_id: TASK_ID, decision: 'allow', reason: 'ok', question_id: null }],
    },
  ],
  [
    'transcript request',
    workerTranscriptRequestSchema,
    { epoch: 1, entries: [{ seq: 0, event: { kind: 'anything' } }] },
  ],
  ['transcript response', workerTranscriptResponseSchema, { stored: 1, refused_seqs: [] }],
  [
    'tool call request',
    workerToolCallRequestSchema,
    { epoch: 1, tool_use_id: 'toolu_FAKE', input: { query: 'login' } },
  ],
  ['tool call response', workerToolCallResponseSchema, { result: 'recorded', is_error: false }],
  [
    'approval request',
    workerApprovalRequestSchema,
    {
      epoch: 1,
      tool_use_id: 'toolu_FAKE',
      tool_name: 'Bash',
      detail: 'pnpm test',
      input: { command: 'pnpm test' },
      reason: 'ask list',
    },
  ],
  ['approval response', workerApprovalResponseSchema, { approval_id: OTHER_ID }],
  [
    'session request',
    workerSessionRequestSchema,
    { epoch: 1, session_id: 'session-fake', from_line: 0, lines: ['{}'] },
  ],
  [
    'ssh-sign request',
    workerSshSignRequestSchema,
    { epoch: 1, key_blob: 'AAAA', data: 'AAAA', flags: 0 },
  ],
  ['ssh-sign response', workerSshSignResponseSchema, { signature: null }],
  [
    'run release request',
    workerRunReleaseRequestSchema,
    { epoch: 1, reason: 'usage_limited', resets_at: '2026-11-04T13:00:00.000Z' },
  ],
  [
    'finish request',
    workerFinishRequestSchema,
    {
      epoch: 1,
      stop_reason: null,
      outcome: {
        kind: 'ran',
        status: 'failed',
        terminal_reason: 'rate_limited',
        session_id: null,
        num_turns: 3,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        model_usage: [],
        cost: null,
        wall_ms: 1_000,
        structured_output: null,
        error: 'usage limit',
        redaction_count: 0,
      },
    },
  ],
  [
    'finish request (not started)',
    workerFinishRequestSchema,
    {
      epoch: 1,
      stop_reason: 'shutdown',
      outcome: {
        kind: 'not_started',
        failure: 'the workspace could not be created',
        detail: null,
        detail_truncated: false,
        transient: true,
        spawn_requested: false,
      },
    },
  ],
  [
    'finish response',
    workerFinishResponseSchema,
    {
      outcome: 'already_settled',
      ending: { status: 'completed', terminal_reason: 'success', epoch: 2 },
    },
  ],
  ['spawn request', workerSpawnRequestSchema, { epoch: 2 }],
  ['spawn response', workerSpawnResponseSchema, { started_at: '2026-11-04T09:00:00.000Z' }],
  ['late cost response', workerLateCostResponseSchema, { recorded: false }],
  [
    'late cost request',
    workerLateCostRequestSchema,
    {
      epoch: 1,
      session_id: null,
      num_turns: 4,
      wall_ms: 2_000,
      cost: { usd: 0.12, is_estimate: false },
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      model_usage: [],
    },
  ],
  [
    'pause request',
    workerPauseRequestSchema,
    { until: '2026-11-04T13:00:00.000Z', reason: 'usage_limited' },
  ],
  [
    'release response',
    workerReleaseResponseSchema,
    { protocol: { current: 1, accepted: [1] }, digests: DIGESTS },
  ],
  [
    'update report',
    workerUpdateReportRequestSchema,
    { from: DIGESTS, to: DIGESTS, result: 'rolled_back', detail: null },
  ],
  [
    '426 upgrade_required',
    workerUpgradeRequiredBodySchema,
    {
      error: { code: 'upgrade_required', message: 'this core serves protocol 1' },
      accepted: [1],
      compose_url: 'https://core.example.com/api/worker/v1/compose.yml',
      digests: DIGESTS,
    },
  ],
  [
    '426 upgrade_required, digests unresolved (WP-281)',
    workerUpgradeRequiredBodySchema,
    {
      error: { code: 'upgrade_required', message: 'this core serves protocol 1' },
      accepted: [1],
      compose_url: 'https://core.example.com/api/worker/v1/compose.yml',
      digests: null,
    },
  ],
  [
    '409 lease_lost',
    workerLeaseLostBodySchema,
    { error: { code: 'lease_lost', message: 'the run’s epoch moved on' } },
  ],
];

describe('the worker DTOs (TD-031 decision 9)', () => {
  it.each(DTO_SAMPLES)('%s: admits its body and refuses an unknown key', (_name, schema, body) => {
    expect(schema.safeParse(body).error?.issues ?? []).toEqual([]);
    expect(schema.safeParse({ ...body, unknown_key: true }).success).toBe(false);
  });

  it('keeps the 409 body inside the API error envelope, and the 426 body its superset', () => {
    const lost = { error: { code: 'lease_lost', message: 'stale epoch' } };
    expect(apiErrorSchema.safeParse(lost).success).toBe(true);
    expect(
      workerLeaseLostBodySchema.safeParse({ error: { code: 'conflict', message: 'x' } }).success,
    ).toBe(false);
    expect(
      workerUpgradeRequiredBodySchema.safeParse({
        error: { code: 'lease_lost', message: 'x' },
        accepted: [1],
        compose_url: 'https://core.example.com/c.yml',
        digests: DIGESTS,
      }).success,
    ).toBe(false);
  });

  it('refuses a finish whose stop reason is outside the closed vocabulary, and a not_started report with a run’s fields (WP-281)', () => {
    const notStarted = {
      kind: 'not_started',
      failure: 'the workspace could not be created',
      detail: null,
      detail_truncated: false,
      transient: false,
      spawn_requested: false,
    };
    expect(
      workerFinishRequestSchema.safeParse({ epoch: 1, stop_reason: null, outcome: notStarted })
        .success,
    ).toBe(true);
    expect(
      workerFinishRequestSchema.safeParse({ epoch: 1, stop_reason: 'bored', outcome: notStarted })
        .success,
    ).toBe(false);
    expect(
      workerFinishRequestSchema.safeParse({
        epoch: 1,
        stop_reason: null,
        outcome: { ...notStarted, num_turns: 3 },
      }).success,
    ).toBe(false);
    // The epoch is the only fence field a body names: the owner is the authenticated worker.
    expect(
      workerFinishRequestSchema.safeParse({
        epoch: 1,
        owner: 'worker:someone-else',
        stop_reason: null,
        outcome: notStarted,
      }).success,
    ).toBe(false);
  });

  it('refuses resets_at on a release that is not for a usage limit, and an unknown reason', () => {
    expect(
      workerRunReleaseRequestSchema.safeParse({
        epoch: 1,
        reason: 'shutdown',
        resets_at: '2026-11-04T13:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      workerRunReleaseRequestSchema.safeParse({ epoch: 1, reason: 'usage_limited' }).success,
    ).toBe(true);
    expect(workerRunReleaseRequestSchema.safeParse({ epoch: 1, reason: 'bored' }).success).toBe(
      false,
    );
  });

  it('holds the user code to XXXX-XXXX over twenty consonants, and the worker credential to its prefix', () => {
    expect(WORKER_USER_CODE_ALPHABET).toHaveLength(20);
    expect(new Set(WORKER_USER_CODE_ALPHABET).size).toBe(20);
    expect(WORKER_USER_CODE_ALPHABET).not.toMatch(/[AEIOUY0-9]/);
    const device = DTO_SAMPLES[1]?.[2] ?? {};
    for (const code of ['BCDFGHJK', 'bcdf-ghjk', 'ABCD-FGHJ', 'BCDF-GHJ']) {
      expect(
        workerDeviceResponseSchema.safeParse({ ...device, user_code: code }).success,
        code,
      ).toBe(false);
    }
    expect(
      workerDeviceTokenResponseSchema.safeParse({ worker_id: OTHER_ID, credential: 'glpat-FAKE' })
        .success,
    ).toBe(false);
  });

  it('refuses an epoch of 0 — never claimed — on every run-scoped body', () => {
    expect(workerHeartbeatRequestSchema.safeParse({ epoch: 0, acks: [] }).success).toBe(false);
    expect(workerRunReleaseRequestSchema.safeParse({ epoch: 0, reason: 'shutdown' }).success).toBe(
      false,
    );
  });
});
