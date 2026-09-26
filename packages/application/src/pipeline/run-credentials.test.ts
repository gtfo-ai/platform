/**
 * `runCredentialWrites` — the run's git credential through `IntegrationActionExecutor` (WP-76,
 * TD-028's WP-76 amendment, criterion (2)): one `integration_actions` row per mint and per revoke,
 * keyed by the git binding, shadow mode honoured — **asserted by counting the rows** the real
 * executor wrote, not by reading the wiring.
 *
 * The provider is a hand-written port with counters rather than `FakeGitProvider`: this ring may not
 * import `@platform/integrations`, and what is under test is the door, not the provider.
 */
import type { Id, TaskMode } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { noSecretsRedactor } from '../integrations/redaction.js';
import type { IntegrationRef } from '../ports/integrations/common.js';
import type {
  CredentialScope,
  GitProviderPort,
  MintedCredential,
} from '../ports/integrations/git-provider.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import { type PipelineIntegrations, runCredentialWrites } from './integrations.js';

const GIT_REF: IntegrationRef = {
  integrationId: '00000000-0000-4000-8000-00000000a001',
  provider: 'fake-git',
  type: 'git',
  host: null,
};
const IDS = {
  runId: '00000000-0000-4000-8000-00000000c001' as Id,
  taskId: '00000000-0000-4000-8000-00000000c002' as Id,
  projectId: '00000000-0000-4000-8000-00000000c003' as Id,
};
const TOKEN = 'fake_run_credential_0123456789';

const harness = (
  options: { minting?: boolean; value?: string; scopeOverride?: CredentialScope } = {},
) => {
  const minted: { scope: CredentialScope; branchPatterns: readonly string[] | undefined }[] = [];
  const revoked: MintedCredential[] = [];
  const port = {
    capabilities: () => ({ credentialMinting: options.minting ?? true }),
    mintCredential: async (request: {
      scope: CredentialScope;
      branchPatterns?: readonly string[];
    }): Promise<MintedCredential> => {
      minted.push({ scope: request.scope, branchPatterns: request.branchPatterns });
      return {
        username: 'oauth2',
        value: options.value ?? TOKEN,
        scope: options.scopeOverride ?? request.scope,
        branchPatterns: request.branchPatterns ?? [],
        expiresAt: '2026-06-03T00:00:00.000Z',
        revokeId: 'acme/api#17',
      };
    },
    revokeCredential: async (credential: MintedCredential) => {
      revoked.push(credential);
    },
  } as unknown as GitProviderPort;
  const auditLog = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog,
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: fixedClock('2026-06-01T09:00:00.000Z', 1000),
  });
  const integrations: PipelineIntegrations = {
    executor,
    git: { port, ref: GIT_REF, project: 'acme/api', redactor: noSecretsRedactor() },
    taskManagement: null,
    communication: null,
  };
  return { integrations, auditLog, minted, revoked };
};

const request = (mode: TaskMode, scope: CredentialScope) => ({
  ...IDS,
  mode,
  scope,
  branchPatterns: ['agentic/*'],
  ttlSeconds: 86_400,
});

describe('runCredentialWrites (WP-76)', () => {
  it('writes one audit row per mint and one per revoke, keyed by the git binding', async () => {
    const { integrations, auditLog, minted, revoked } = harness();
    const writes = runCredentialWrites(integrations);

    const answer = await writes.mint(request('normal', 'push'));
    expect(answer.kind).toBe('minted');
    if (answer.kind !== 'minted') return;
    await writes.revoke(answer.credential, { ...IDS, mode: 'normal' });

    expect(auditLog.entriesFor('mint_credential')).toHaveLength(1);
    expect(auditLog.entriesFor('revoke_credential')).toHaveLength(1);
    expect(auditLog.entries.map((entry) => entry.integrationId)).toEqual([
      GIT_REF.integrationId,
      GIT_REF.integrationId,
    ]);
    expect(minted).toEqual([{ scope: 'push', branchPatterns: ['agentic/*'] }]);
    expect(revoked).toHaveLength(1);
  });

  it('records the revocation address and never the value', async () => {
    const { integrations, auditLog } = harness();
    await runCredentialWrites(integrations).mint(request('normal', 'push'));

    const row = auditLog.entriesFor('mint_credential')[0];
    expect(row?.result).toEqual({
      scope: 'push',
      expires_at: '2026-06-03T00:00:00.000Z',
      revoke_id: 'acme/api#17',
    });
    expect(row?.payload).toMatchObject({ run_id: IDS.runId, task_mode: 'normal' });
    expect(JSON.stringify(auditLog.entries)).not.toContain(TOKEN);
  });

  it('asks for a read credential with no branch patterns, and the read scope reaches the provider', async () => {
    const { integrations, minted } = harness();
    await runCredentialWrites(integrations).mint(request('normal', 'read'));

    expect(minted).toEqual([{ scope: 'read', branchPatterns: undefined }]);
  });

  it('performs a read-scoped mint and revoke for a shadow task (Q98 (a)), audited as performed', async () => {
    const { integrations, auditLog, revoked } = harness();
    const writes = runCredentialWrites(integrations);
    const answer = await writes.mint(request('shadow', 'read'));
    expect(answer.kind).toBe('minted');
    if (answer.kind !== 'minted') return;
    await writes.revoke(answer.credential, { ...IDS, mode: 'shadow' });

    expect(auditLog.entries.map((entry) => [entry.action, entry.status])).toEqual([
      ['mint_credential', 'ok'],
      ['revoke_credential', 'ok'],
    ]);
    expect(auditLog.entries[0]?.payload).toMatchObject({ task_mode: 'shadow' });
    expect(revoked).toHaveLength(1);
  });

  it('gives a shadow task no push credential: would_have, nothing minted, answered unavailable', async () => {
    const { integrations, auditLog, minted } = harness();
    const answer = await runCredentialWrites(integrations).mint(request('shadow', 'push'));

    expect(answer).toMatchObject({ kind: 'unavailable' });
    expect(minted).toEqual([]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['would_have']);
  });

  it('answers unavailable, naming the setting, for a binding that cannot mint — and calls nobody', async () => {
    const { integrations, auditLog, minted } = harness({ minting: false });
    const answer = await runCredentialWrites(integrations).mint(request('normal', 'push'));

    expect(answer.kind).toBe('unavailable');
    expect(answer.kind === 'unavailable' ? answer.reason : '').toMatch(/mint_credentials: true/);
    expect(minted).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it('answers unavailable for a project with no git binding', async () => {
    const { integrations } = harness();
    const answer = await runCredentialWrites({ ...integrations, git: null }).mint(
      request('normal', 'push'),
    );
    expect(answer.kind).toBe('unavailable');
  });

  /**
   * Review round 1: the provider has already created the token when these refusals happen, so each
   * one revokes it — exactly once, through the executor — before the refusal leaves.
   */
  it.each([
    ['an empty value', { value: '' }],
    ['a value too short to redact', { value: 'short' }],
    ['a scope the provider changed', { scopeOverride: 'push' as const }],
  ])(
    'refuses %s rather than using it, and revokes it first (standing rule 18)',
    async (_case, over) => {
      const { integrations, auditLog, revoked } = harness(over);
      await expect(
        runCredentialWrites(integrations).mint(request('normal', 'read')),
      ).rejects.toThrow(/will not use.*it was revoked/);
      expect(revoked).toHaveLength(1);
      expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['ok']);
    },
  );

  it('names a revocation that failed in the refusal, rather than hiding the live token', async () => {
    const { integrations } = harness({ scopeOverride: 'push' });
    const git = integrations.git;
    if (git === null) throw new Error('expected a binding');
    const failing = {
      ...integrations,
      git: {
        ...git,
        port: {
          ...git.port,
          capabilities: git.port.capabilities,
          mintCredential: git.port.mintCredential,
          revokeCredential: async () => {
            throw new Error(`the provider is down and quoted ${TOKEN}`);
          },
        } as unknown as typeof git.port,
      },
    };
    const refusal = await runCredentialWrites(failing)
      .mint(request('normal', 'read'))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(refusal?.message).toMatch(/revocation failed.*live until 2026-06-03/);
    // Neither the binding's scope nor any registry holds the value on this path, so the refusal
    // redacts the provider's words against it itself (review round 2).
    expect(refusal?.message).not.toContain(TOKEN);
    expect(refusal?.message).toContain('[REDACTED:integration:refused_run_credential]');
  });

  /**
   * Review round 2, measured: a **shadow** task asks `read`, the provider answers `push`. The mint
   * ran under the carve-out; the revoke of a `push` token used to declare none, so the shadow guard
   * answered `would_have`, nothing reached the provider, and the refusal said "it was revoked".
   */
  it('revokes, at the provider, a push token a shadow task was handed, and says so honestly', async () => {
    const { integrations, auditLog, revoked } = harness({ scopeOverride: 'push' });
    await expect(runCredentialWrites(integrations).mint(request('shadow', 'read'))).rejects.toThrow(
      /asked for read, got push; it was revoked/,
    );
    expect(revoked).toHaveLength(1);
    expect(auditLog.entries.map((row) => [row.action, row.status])).toEqual([
      ['mint_credential', 'ok'],
      ['revoke_credential', 'ok'],
    ]);
  });

  it('performs a shadow task’s revoke of a push credential it holds', async () => {
    const { integrations, revoked } = harness();
    const push = {
      username: 'oauth2',
      value: TOKEN,
      scope: 'push' as const,
      branchPatterns: ['agentic/*'],
      expiresAt: '2026-06-03T00:00:00.000Z',
      revokeId: 'acme/api#17',
    };
    await runCredentialWrites(integrations).revoke(push, { ...IDS, mode: 'shadow' });
    expect(revoked).toHaveLength(1);
  });

  /**
   * The guard after the revoke call, held on its own: with every revoke declaring the carve-out no
   * shipped executor answers `would_have` here any more, so without this case deleting the guard
   * left every test green (the orchestrator's canary after review round 2). A revoke the executor
   * did not perform must never read as done — the token is live until it expires.
   */
  it('treats a revoke the executor did not perform as a failure naming the expiry, never as done', async () => {
    const { integrations, revoked } = harness();
    const real = integrations.executor;
    const suppressing = {
      ...integrations,
      executor: {
        execute: async (req: Parameters<typeof real.execute>[0]) =>
          req.action === 'revoke_credential'
            ? ({ status: 'would_have', result: false } as unknown as Awaited<
                ReturnType<typeof real.execute>
              >)
            : real.execute(req),
      } as typeof real,
    };
    const push = {
      username: 'oauth2',
      value: TOKEN,
      scope: 'push' as const,
      branchPatterns: ['agentic/*'],
      expiresAt: '2026-06-03T00:00:00.000Z',
      revokeId: 'acme/api#17',
    };
    await expect(
      runCredentialWrites(suppressing).revoke(push, { ...IDS, mode: 'normal' }),
    ).rejects.toThrow(
      /was not revoked \(the executor answered would_have\); it is live until 2026-06-03/,
    );
    expect(revoked).toHaveLength(0);
  });

  it('refuses to mint or revoke inside an open transaction', async () => {
    const { integrations, minted, revoked } = harness();
    const writes = runCredentialWrites(integrations);
    await expect(
      withOpenTransaction(async () => writes.mint(request('normal', 'push'))),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    const answer = await writes.mint(request('normal', 'push'));
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    await expect(
      withOpenTransaction(async () => writes.revoke(answer.credential, { ...IDS, mode: 'normal' })),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(minted).toHaveLength(1);
    expect(revoked).toHaveLength(0);
  });
});
