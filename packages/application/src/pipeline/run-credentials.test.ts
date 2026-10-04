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
import { IntegrationError, type IntegrationRef } from '../ports/integrations/common.js';
import type {
  CredentialRevocationAddress,
  CredentialScope,
  GitProviderPort,
  MintedRunCredential,
} from '../ports/integrations/git-provider.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import {
  type CredentialMintingHints,
  type MintingIntegration,
  type MintingIntegrationLiveness,
  mintingIntegrationOf,
  type PipelineIntegrations,
  type RecoverableRunCredential,
  RunCredentialMintRetiredError,
  runCredentialRevocations,
  runCredentialWrites,
  type StaticRunCredential,
  StaticRunCredentialRefusedError,
} from './integrations.js';

/** The minting integration is live: the mint's post-record check passes (WP-114, backlog 386). */
const LIVE: MintingIntegrationLiveness = { isRetired: async () => false };

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
/** The shape the harness's provider declares for {@link TOKEN} (WP-80). */
const TOKEN_SHAPE = {
  prefix: 'fake_run_credential_',
  charset: 'alnum',
  length: TOKEN.length,
} as const;

/** A provider's words for the two mint refusals (WP-107) — this harness's, not any real provider's. */
const HINTS: CredentialMintingHints = {
  enable: 'fake-git: turn minting on for the account',
  shape: 'fake-git: declare the prefix your instance uses',
  static: 'fake-git: declare a dedicated run token',
};

/** The revocation door, built from the binding that minted — what teardown and recovery use (WP-80). */
const revocationsOf = (integrations: PipelineIntegrations) =>
  runCredentialRevocations(mintingIntegrationOf(integrations) as MintingIntegration);

const harness = (
  options: {
    minting?: boolean;
    value?: string;
    scopeOverride?: CredentialScope;
    /** What every `revokeCredential` throws, when set (WP-77). */
    revokeError?: Error;
    /** The shape the provider declares, when not {@link TOKEN_SHAPE} (WP-80). */
    shape?: MintedRunCredential['shape'];
    /** The registration's words for the mint refusals (WP-107); absent is none declared. */
    hints?: CredentialMintingHints;
  } = {},
) => {
  const minted: { scope: CredentialScope; branchPatterns: readonly string[] | undefined }[] = [];
  /** Exactly what the provider was handed — the address, and nothing else since WP-77. */
  const revoked: CredentialRevocationAddress[] = [];
  const port = {
    capabilities: () => ({ credentialMinting: options.minting ?? true }),
    mintCredential: async (request: {
      scope: CredentialScope;
      branchPatterns?: readonly string[];
    }): Promise<MintedRunCredential> => {
      minted.push({ scope: request.scope, branchPatterns: request.branchPatterns });
      return {
        username: 'oauth2',
        value: options.value ?? TOKEN,
        scope: options.scopeOverride ?? request.scope,
        branchPatterns: request.branchPatterns ?? [],
        expiresAt: '2026-06-03T00:00:00.000Z',
        revokeId: 'acme/api#17',
        shape: options.shape ?? TOKEN_SHAPE,
      };
    },
    revokeCredential: async (address: CredentialRevocationAddress) => {
      if (options.revokeError !== undefined) {
        throw options.revokeError;
      }
      revoked.push(address);
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
    git: {
      port,
      ref: GIT_REF,
      project: 'acme/api',
      redactor: noSecretsRedactor(),
      ...(options.hints === undefined ? {} : { mintingHints: options.hints }),
    },
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
  defaultBranch: 'main',
});

/**
 * WP-114, PROGRESS backlog 386: an integration retired while a mint's provider call was open. The
 * post-record check sees it, and the token is revoked through the adapter that minted it — the one
 * that still holds the account's credential — before the run can use it.
 */
describe('a mint whose integration was retired while its call was open (backlog 386)', () => {
  it('revokes the token in hand and refuses the run start by name', async () => {
    const { integrations, auditLog, revoked } = harness();
    const asked: Id[] = [];
    const error = await runCredentialWrites(integrations, {
      isRetired: async (integrationId) => {
        asked.push(integrationId);
        // Read after the record: the mint's own audit row is already written.
        expect(auditLog.entries.map((entry) => entry.action)).toEqual(['mint_credential']);
        return true;
      },
    })
      .mint(request('normal', 'push'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunCredentialMintRetiredError);
    expect((error as Error).message).toMatch(
      /was retired while run .* was being minted, .*; it was revoked$/,
    );
    expect((error as Error).message).not.toContain(TOKEN);
    expect(asked).toEqual([GIT_REF.integrationId]);
    expect(revoked).toHaveLength(1);
    expect(auditLog.entries.map((entry) => [entry.action, entry.status])).toEqual([
      ['mint_credential', 'ok'],
      ['revoke_credential', 'ok'],
    ]);
  });

  it('names a revocation that fails, and the token never reaches the caller', async () => {
    const { integrations } = harness({ revokeError: new Error(`provider down, quoted ${TOKEN}`) });
    const error = await runCredentialWrites(integrations, { isRetired: async () => true })
      .mint(request('normal', 'push'))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RunCredentialMintRetiredError);
    expect((error as Error).message).toMatch(/its revocation failed .* delete it at the provider$/);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe('runCredentialWrites (WP-76)', () => {
  it('writes one audit row per mint and one per revoke, keyed by the git binding', async () => {
    const { integrations, auditLog, minted, revoked } = harness();
    const writes = runCredentialWrites(integrations, LIVE);

    const answer = await writes.mint(request('normal', 'push'));
    expect(answer.kind).toBe('minted');
    if (answer.kind !== 'minted') return;
    await revocationsOf(integrations).revoke(answer.handle, { ...IDS, mode: 'normal' });

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
    await runCredentialWrites(integrations, LIVE).mint(request('normal', 'push'));

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
    await runCredentialWrites(integrations, LIVE).mint(request('normal', 'read'));

    expect(minted).toEqual([{ scope: 'read', branchPatterns: undefined }]);
  });

  it('performs a read-scoped mint and revoke for a shadow task (Q98 (a)), audited as performed', async () => {
    const { integrations, auditLog, revoked } = harness();
    const writes = runCredentialWrites(integrations, LIVE);
    const answer = await writes.mint(request('shadow', 'read'));
    expect(answer.kind).toBe('minted');
    if (answer.kind !== 'minted') return;
    await revocationsOf(integrations).revoke(answer.handle, { ...IDS, mode: 'shadow' });

    expect(auditLog.entries.map((entry) => [entry.action, entry.status])).toEqual([
      ['mint_credential', 'ok'],
      ['revoke_credential', 'ok'],
    ]);
    expect(auditLog.entries[0]?.payload).toMatchObject({ task_mode: 'shadow' });
    expect(revoked).toHaveLength(1);
  });

  it('gives a shadow task no push credential: would_have, nothing minted, answered unavailable', async () => {
    const { integrations, auditLog, minted } = harness();
    const answer = await runCredentialWrites(integrations, LIVE).mint(request('shadow', 'push'));

    expect(answer).toMatchObject({ kind: 'unavailable' });
    expect(minted).toEqual([]);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['would_have']);
  });

  it('answers unavailable, naming the setting, for a binding that cannot mint — and calls nobody', async () => {
    const { integrations, auditLog, minted } = harness({ minting: false, hints: HINTS });
    const answer = await runCredentialWrites(integrations, LIVE).mint(request('normal', 'push'));

    expect(answer.kind).toBe('unavailable');
    expect(answer.kind === 'unavailable' ? answer.reason : '').toContain(`(${HINTS.enable})`);
    expect(minted).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  /**
   * WP-107 (PROGRESS backlog 278): both mint refusals carry the **provider's** sentence from its
   * registration, verbatim, and this ring adds no provider's name of its own — with no hint declared
   * the refusal says what happened and names no setting. The GitLab sentences themselves are pinned
   * where they are declared (`providers/gitlab/provider.test.ts`).
   */
  it('renders the provider’s hints in both mint refusals, and names no provider without them', async () => {
    const off = await runCredentialWrites(
      harness({ minting: false, hints: HINTS }).integrations,
      LIVE,
    ).mint(request('normal', 'push'));
    expect(off).toEqual({
      kind: 'unavailable',
      // WP-137 (TD-028 decision 13 item 6): the binding, **both** settings, and the API token never sent.
      reason:
        `the git binding ${GIT_REF.integrationId} (fake-git) cannot give run ${IDS.runId} a credential: ` +
        `minting is off (${HINTS.enable}) and no static run credential is configured ` +
        `(${HINTS.static}). The binding’s own token is never sent instead (TD-028 decisions 6 and 13)`,
    });
    const bare = await runCredentialWrites(harness({ minting: false }).integrations, LIVE).mint(
      request('normal', 'push'),
    );
    expect(bare.kind === 'unavailable' ? bare.reason : '').toContain(
      'minting is off and no static run credential is configured. The binding',
    );

    const misshapen = { prefix: 'glpat-', charset: 'token_dotted' as const, length: TOKEN.length };
    const refused = await runCredentialWrites(
      harness({ shape: misshapen, hints: HINTS }).integrations,
      LIVE,
    )
      .mint(request('normal', 'push'))
      .then(
        () => '',
        (error: unknown) => (error as Error).message,
      );
    expect(refused).toContain(
      `its value does not have the shape the provider declared (prefix "glpat-", token_dotted ` +
        `characters, ${TOKEN.length} long), so no process but this one could redact it ` +
        `(TD-012, WP-80) — ${HINTS.shape}; it was revoked`,
    );
    const unhinted = await runCredentialWrites(harness({ shape: misshapen }).integrations, LIVE)
      .mint(request('normal', 'push'))
      .then(
        () => '',
        (error: unknown) => (error as Error).message,
      );
    expect(unhinted).toContain('could redact it (TD-012, WP-80); it was revoked');
    // No provider's setting is spelled by this ring: neither GitLab's key appears without a hint.
    for (const reason of [bare.kind === 'unavailable' ? bare.reason : '', unhinted]) {
      expect(reason).not.toMatch(/GitLab|token_prefix|mint_credentials/);
    }
  });

  it('answers unavailable for a project with no git binding', async () => {
    const { integrations } = harness();
    const answer = await runCredentialWrites({ ...integrations, git: null }, LIVE).mint(
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
        runCredentialWrites(integrations, LIVE).mint(request('normal', 'read')),
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
    const refusal = await runCredentialWrites(failing, LIVE)
      .mint(request('normal', 'read'))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(refusal?.message).toMatch(
      /revocation failed.*live until the recovery pass revokes it .* or it expires at 2026-06-03/,
    );
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
    await expect(
      runCredentialWrites(integrations, LIVE).mint(request('shadow', 'read')),
    ).rejects.toThrow(/asked for read, got push; it was revoked/);
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
      integrationId: GIT_REF.integrationId,
    };
    await revocationsOf(integrations).revoke(push, { ...IDS, mode: 'shadow' });
    expect(revoked).toHaveLength(1);
  });

  /**
   * The guard after the revoke call, held on its own: with every revoke declaring the carve-out no
   * shipped executor answers `would_have` here any more, so without this case deleting the guard
   * left every test green (the orchestrator's canary after review round 2). A revoke the executor
   * did not perform must never read as done — the token is live until the recovery pass revokes it
   * (WP-77) or it expires.
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
      integrationId: GIT_REF.integrationId,
    };
    await expect(
      revocationsOf(suppressing).revoke(push, { ...IDS, mode: 'normal' }),
    ).rejects.toThrow(
      /was not revoked \(the executor answered would_have\); it is live until the recovery pass revokes it .* or it expires at 2026-06-03/,
    );
    expect(revoked).toHaveLength(0);
  });

  /**
   * WP-73b, PROGRESS backlog 156 half 2, and structural since WP-80 (TD-028 decision 10): the
   * revocation is built from the minting integration, and one built from any other — git
   * integration B for a credential A minted — is refused before the executor, so no row names B.
   */
  it('refuses a revocation built from an integration that did not mint the credential', async () => {
    const { integrations, auditLog, revoked } = harness();
    const answer = await runCredentialWrites(integrations, LIVE).mint(request('normal', 'push'));
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    expect(answer.handle.integrationId).toBe(GIT_REF.integrationId);
    const other = mintingIntegrationOf(integrations) as MintingIntegration;
    const stranger: MintingIntegration = {
      ...other,
      ref: { ...GIT_REF, integrationId: '00000000-0000-4000-8000-00000000a0b2' as Id },
    };

    await expect(
      runCredentialRevocations(stranger).revoke(answer.handle, { ...IDS, mode: 'normal' }),
    ).rejects.toThrow(/minted through the git integration .*a001.*built from .*a0b2.*backlog 156/);
    // Refused before the executor: nothing reached a provider, and no row names integration B.
    expect(revoked).toEqual([]);
    expect(auditLog.entriesFor('revoke_credential')).toEqual([]);
  });

  /**
   * WP-80 (TD-012's M5 amendment): the mint's audit entry carries the value's non-secret shape, so
   * the audit adapter writes it in the row's transaction; and it carries nothing of the value.
   */
  it('carries the minted value’s shape on the mint’s audit entry, and never the value', async () => {
    const { integrations, auditLog } = harness();
    await runCredentialWrites(integrations, LIVE).mint(request('normal', 'push'));

    const entry = auditLog.entriesFor('mint_credential')[0];
    expect(entry?.credentialShape).toEqual({
      shape: TOKEN_SHAPE,
      expiresAt: '2026-06-03T00:00:00.000Z',
    });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  /**
   * WP-80: a value that does not have the shape it came with could be redacted by no process but
   * its minter, so it is refused like a value too short to redact — and revoked first.
   */
  it('refuses, and revokes, a value that does not have the shape the provider declared', async () => {
    const { integrations, auditLog, revoked } = harness({
      shape: { prefix: 'glpat-', charset: 'token_dotted', length: TOKEN.length },
      hints: HINTS,
    });
    await expect(
      runCredentialWrites(integrations, LIVE).mint(request('normal', 'push')),
    ).rejects.toThrow(
      /does not have the shape the provider declared \(prefix "glpat-".*declare the prefix.*it was revoked/,
    );
    expect(revoked).toHaveLength(1);
    expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['ok']);
  });

  it('refuses to mint or revoke inside an open transaction', async () => {
    const { integrations, minted, revoked } = harness();
    const writes = runCredentialWrites(integrations, LIVE);
    await expect(
      withOpenTransaction(async () => writes.mint(request('normal', 'push'))),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    const answer = await writes.mint(request('normal', 'push'));
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    await expect(
      withOpenTransaction(async () =>
        revocationsOf(integrations).revoke(answer.handle, { ...IDS, mode: 'normal' }),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(minted).toHaveLength(1);
    expect(revoked).toHaveLength(0);
  });
});

/**
 * The recovery revoke (WP-77, PROGRESS backlog 155) — by address, through the executor, bounded by
 * its own audit row. The address is what the mint's audit row recorded; nothing here holds a value.
 */
describe('runCredentialRevocations().recover (WP-77)', () => {
  const stranded = (over: Partial<RecoverableRunCredential> = {}): RecoverableRunCredential => ({
    ...IDS,
    mode: 'normal',
    integrationId: GIT_REF.integrationId as Id,
    revokeId: 'acme/api#17',
    scope: 'push',
    expiresAt: '2026-06-03T00:00:00.000Z',
    ...over,
  });

  it('hands the provider the address and nothing else, and records the attempt as the recovery’s', async () => {
    const { integrations, auditLog, revoked } = harness();

    expect(await revocationsOf(integrations).recover(stranded())).toBe('revoked');

    // Standing rule 18: the provider was given `{ revokeId }` — no value, invented or otherwise.
    expect(revoked).toEqual([{ revokeId: 'acme/api#17' }]);
    const rows = auditLog.entriesFor('revoke_credential');
    expect(rows.map((row) => row.status)).toEqual(['ok']);
    expect(rows[0]?.integrationId).toBe(GIT_REF.integrationId);
    expect(rows[0]?.taskId).toBe(IDS.taskId);
    // `origin` is the bound the finding query reads; `revoked: true` is the only "done".
    expect(rows[0]?.payload).toEqual({
      scope: 'push',
      revoke_id: 'acme/api#17',
      run_id: IDS.runId,
      task_mode: 'normal',
      origin: 'recovery',
    });
    expect(rows[0]?.result).toEqual({
      revoked: true,
      confirmation: 'revoked',
      revoke_id: 'acme/api#17',
    });
  });

  it('records not_found as unconfirmed — revoked: false — and never as a revocation', async () => {
    const { integrations, auditLog } = harness({
      revokeError: new IntegrationError('not_found', 'fake-git', 'no such access token'),
    });

    expect(await revocationsOf(integrations).recover(stranded())).toBe('unconfirmed');

    const rows = auditLog.entriesFor('revoke_credential');
    expect(rows.map((row) => row.status)).toEqual(['ok']);
    expect(rows[0]?.result).toEqual({
      revoked: false,
      confirmation: 'unconfirmed',
      revoke_id: 'acme/api#17',
    });
    expect(rows[0]?.payload).toMatchObject({ origin: 'recovery' });
  });

  it('throws for any other failure, after the executor recorded it as failed with the marker', async () => {
    const { integrations, auditLog } = harness({
      revokeError: new IntegrationError('forbidden', 'fake-git', 'the binding lost access'),
    });

    await expect(revocationsOf(integrations).recover(stranded())).rejects.toThrow(
      /the binding lost access/,
    );
    const rows = auditLog.entriesFor('revoke_credential');
    expect(rows.map((row) => row.status)).toEqual(['failed']);
    // A failed attempt still spends the address's one attempt: the marker is on the payload.
    expect(rows[0]?.payload).toMatchObject({ origin: 'recovery' });
  });

  it('performs a shadow task’s recovery revoke under the carve-out its mint used (Q98 (a))', async () => {
    const { integrations, auditLog, revoked } = harness();

    expect(
      await revocationsOf(integrations).recover(stranded({ mode: 'shadow', scope: 'read' })),
    ).toBe('revoked');

    expect(revoked).toHaveLength(1);
    expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['ok']);
    expect(auditLog.entries[0]?.payload).toMatchObject({ task_mode: 'shadow', scope: 'read' });
  });

  it('treats a recovery the executor answered would_have as a failure of this row', async () => {
    const { integrations, revoked } = harness();
    const real = integrations.executor;
    const suppressing = {
      ...integrations,
      executor: {
        execute: async () =>
          ({ status: 'would_have', result: null }) as unknown as Awaited<
            ReturnType<typeof real.execute>
          >,
      } as typeof real,
    };

    await expect(
      revocationsOf(suppressing).recover(stranded({ mode: 'shadow', scope: 'read' })),
    ).rejects.toThrow(/not revoked by the recovery pass \(the executor answered would_have\)/);
    expect(revoked).toEqual([]);
  });

  it('refuses an address minted through an integration other than the one it is built from', async () => {
    const { integrations, auditLog, revoked } = harness();

    await expect(
      revocationsOf(integrations).recover(
        stranded({ integrationId: '00000000-0000-4000-8000-00000000a0ff' as Id }),
      ),
    ).rejects.toThrow(/never sent to an integration that did not mint it.*lives until 2026-06-03/);
    // Refused before the executor: nothing sent, and no row claims an attempt.
    expect(revoked).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it('refuses to revoke inside an open transaction', async () => {
    const { integrations, revoked } = harness();
    await expect(
      withOpenTransaction(async () => revocationsOf(integrations).recover(stranded())),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(revoked).toEqual([]);
  });

  it('hands the teardown revoke’s provider the address alone as well', async () => {
    const { integrations, revoked } = harness();
    const answer = await runCredentialWrites(integrations, LIVE).mint(request('normal', 'push'));
    if (answer.kind !== 'minted') throw new Error('expected a credential');

    await revocationsOf(integrations).revoke(answer.handle, { ...IDS, mode: 'normal' });

    expect(revoked).toEqual([{ revokeId: 'acme/api#17' }]);
  });
});

/**
 * WP-137 — TD-028 decision 13: a static run credential, handed where a minted one would be, with no
 * provider call and no audit row, never to a shadow task, and refused by name when it is broken.
 */
describe('a static run credential (WP-137, TD-028 decision 13)', () => {
  const STATIC_TOKEN = 'glpat-FAKE-static-run-token-not-real-0001';
  const NOW = '2026-10-03T12:00:00.000Z';
  const AT_NOW: MintingIntegrationLiveness = { isRetired: async () => false, now: () => NOW };
  const fixed = (overrides: Partial<StaticRunCredential> = {}): StaticRunCredential => ({
    owner: 'dedicated_user',
    username: 'agentic-runner',
    value: STATIC_TOKEN,
    expiresAt: '2026-12-01T00:00:00.000Z',
    declaredExpiry: '2026-12-01',
    sameAsApiToken: false,
    refusal: null,
    ...overrides,
  });
  const staticHarness = (credential: StaticRunCredential, minting = false) => {
    const built = harness({ minting, hints: HINTS });
    const git = built.integrations.git as NonNullable<PipelineIntegrations['git']>;
    return {
      ...built,
      integrations: { ...built.integrations, git: { ...git, staticRunCredential: credential } },
    };
  };

  it('hands a writing run the static token as push, with the declared expiry, and calls no provider', async () => {
    const { integrations, auditLog, minted } = staticHarness(fixed());
    const answer = await runCredentialWrites(integrations, AT_NOW).mint(request('normal', 'push'));
    expect(answer).toEqual({
      kind: 'static',
      credential: {
        username: 'agentic-runner',
        value: STATIC_TOKEN,
        scope: 'push',
        expiresAt: '2026-12-01T00:00:00.000Z',
      },
      ref: GIT_REF,
    });
    expect(minted).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it('hands a read-only run the same push-capable token: it cannot be narrowed (decision 13 item 5)', async () => {
    const { integrations } = staticHarness(fixed());
    const answer = await runCredentialWrites(integrations, AT_NOW).mint(request('normal', 'read'));
    expect(answer.kind === 'static' ? answer.credential.scope : answer.kind).toBe('push');
  });

  it('gives a shadow task no credential at all, never the static one (decision 13 item 4)', async () => {
    const { integrations, auditLog, minted } = staticHarness(fixed(), true);
    const answer = await runCredentialWrites(integrations, AT_NOW).mint(request('shadow', 'read'));
    expect(answer.kind).toBe('unavailable');
    expect(JSON.stringify(answer)).not.toContain(STATIC_TOKEN);
    expect(answer.kind === 'unavailable' ? answer.reason : '').toMatch(
      /shadow task is never given the static run credential/,
    );
    expect(minted).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it.each([
    ['no run token', { value: '' }, /holds no run token/],
    ['the API token in its place', { sameAsApiToken: true }, /own API token/],
    [
      'minting also on',
      { refusal: '`run_credential: static` and `mint_credentials: true`' },
      /mint_credentials: true/,
    ],
    [
      'an expiry passed',
      { expiresAt: '2026-10-01T00:00:00.000Z', declaredExpiry: '2026-10-01' },
      /expired on 2026-10-01/,
    ],
    ['an expiry that is no date', { expiresAt: null }, /no declared expiry/],
  ])(
    'refuses %s by name, before anything is sent, and never names the value',
    async (_case, overrides, reason) => {
      const { integrations, auditLog, minted } = staticHarness(fixed(overrides));
      const error = await runCredentialWrites(integrations, AT_NOW)
        .mint(request('normal', 'push'))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(StaticRunCredentialRefusedError);
      expect((error as Error).message).toMatch(reason);
      expect((error as Error).message).toContain(GIT_REF.integrationId);
      expect((error as Error).message).not.toContain(STATIC_TOKEN);
      expect(minted).toEqual([]);
      expect(auditLog.entries).toEqual([]);
    },
  );

  it('refuses rather than skipping the expiry check when no clock was composed', async () => {
    const { integrations } = staticHarness(fixed());
    await expect(
      runCredentialWrites(integrations, LIVE).mint(request('normal', 'push')),
    ).rejects.toThrow(/no clock was composed/);
  });
});

/**
 * WP-141 — TD-028 decision 13a item 2: an **operator's own** run token is handed to a run only while
 * the project's default branch is protected with push **No one** and force push off, read with the API
 * token through the executor before **each** run — so protection loosened after the probe refuses the
 * next run by name, before anything is created. A dedicated user's token is not read (decision 13
 * unchanged).
 */
describe('an operator’s own run token (WP-141, TD-028 decision 13a)', () => {
  const OPERATOR_TOKEN = 'glpat-FAKE-operator-run-token-not-real-01';
  const NOW = '2026-10-04T12:00:00.000Z';
  const AT_NOW: MintingIntegrationLiveness = { isRetired: async () => false, now: () => NOW };
  const NO_ONE = {
    protected: true,
    nobodyPushes: true,
    forcePushAllowed: false,
    pushers: ['No one'],
  };
  const operatorHarness = (
    rules: readonly (typeof NO_ONE)[],
    owner: 'operator' | 'dedicated_user' = 'operator',
  ) => {
    const built = harness({ minting: false, hints: HINTS });
    const git = built.integrations.git as NonNullable<PipelineIntegrations['git']>;
    const read: string[] = [];
    let call = 0;
    const port = Object.assign(Object.create(git.port) as GitProviderPort, {
      branchPushProtection: async (project: string, branch: string) => {
        read.push(`${project}@${branch}`);
        const rule = rules[Math.min(call, rules.length - 1)] as typeof NO_ONE;
        call += 1;
        return rule;
      },
    });
    const credential: StaticRunCredential = {
      owner,
      username: 'acme-owner',
      value: OPERATOR_TOKEN,
      expiresAt: '2026-12-01T00:00:00.000Z',
      declaredExpiry: '2026-12-01',
      sameAsApiToken: false,
      refusal: null,
    };
    return {
      ...built,
      read,
      integrations: {
        ...built.integrations,
        git: { ...git, port, staticRunCredential: credential },
      } satisfies PipelineIntegrations,
    };
  };

  it('hands it behind a No-one default branch, read once per run with the API token, audited', async () => {
    const { integrations, auditLog, read } = operatorHarness([NO_ONE]);
    const writes = runCredentialWrites(integrations, AT_NOW);
    const answer = await writes.mint({ ...request('normal', 'push'), defaultBranch: 'develop' });
    expect(answer.kind).toBe('static');
    expect(read).toEqual(['acme/api@develop']);
    const [row] = auditLog.entriesFor('check_default_branch_protection');
    expect(row?.payload).toMatchObject({ project: 'acme/api', branch: 'develop' });
    expect(JSON.stringify(auditLog.entries)).not.toContain(OPERATOR_TOKEN);
  });

  /** Criterion (3): the probe passed, then the operator loosened the rule; the next run is refused. */
  it('refuses the next run by name once the protection is loosened after a run was given it', async () => {
    const loosened = {
      protected: true,
      nobodyPushes: false,
      forcePushAllowed: false,
      pushers: ['Maintainers'],
    };
    const { integrations, read, minted } = operatorHarness([NO_ONE, loosened]);
    const writes = runCredentialWrites(integrations, AT_NOW);
    expect((await writes.mint(request('normal', 'push'))).kind).toBe('static');
    const error = await writes.mint(request('normal', 'read')).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StaticRunCredentialRefusedError);
    expect((error as Error).message).toMatch(
      /default branch main of acme\/api lets Maintainers push.*protect main with push "No one" and force push off/,
    );
    expect((error as Error).message).not.toContain(OPERATOR_TOKEN);
    expect(read).toEqual(['acme/api@main', 'acme/api@main']);
    expect(minted).toEqual([]);
  });

  it.each([
    [
      'unprotected',
      { protected: false, nobodyPushes: false, forcePushAllowed: true, pushers: [] },
      /is not protected/,
    ],
    ['force push on', { ...NO_ONE, forcePushAllowed: true }, /allows force push/],
  ])('refuses a default branch that is %s', async (_case, rule, words) => {
    const { integrations } = operatorHarness([rule]);
    await expect(
      runCredentialWrites(integrations, AT_NOW).mint(request('normal', 'push')),
    ).rejects.toThrow(words);
  });

  it('refuses rather than reading no branch, and asks nothing for a shadow task', async () => {
    const { integrations, read } = operatorHarness([NO_ONE]);
    await expect(
      runCredentialWrites(integrations, AT_NOW).mint({
        ...request('normal', 'push'),
        defaultBranch: ' ',
      }),
    ).rejects.toThrow(/no default branch was given/);
    const shadow = await runCredentialWrites(integrations, AT_NOW).mint(request('shadow', 'read'));
    expect(shadow.kind).toBe('unavailable');
    expect(read).toEqual([]);
  });

  it('reads no protection for a dedicated user’s token (decision 13 unchanged)', async () => {
    const { integrations, read, auditLog } = operatorHarness([NO_ONE], 'dedicated_user');
    expect(
      (await runCredentialWrites(integrations, AT_NOW).mint(request('normal', 'push'))).kind,
    ).toBe('static');
    expect(read).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it('reads the protection outside any transaction', async () => {
    const { integrations } = operatorHarness([NO_ONE]);
    await expect(
      withOpenTransaction(() =>
        runCredentialWrites(integrations, AT_NOW).mint(request('normal', 'push')),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
  });
});
