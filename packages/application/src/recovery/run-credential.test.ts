/**
 * The `revoke_run_credential` duty and the site's bounds (WP-77, PROGRESS backlog 155).
 *
 * The duty is asserted on what the **provider was asked** and on the audit rows the real executor
 * wrote (standing rule 1), with a hand-written port because this ring may not import
 * `@platform/integrations`. The SQL predicate — which terminal runs, which rows count as revoked —
 * is the integration tier's (`test/integration/recovery/run-credential-recovery.integration.test.ts`),
 * where the fake provider's `credentials[].revocations` is counted.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationActionExecutor } from '../integrations/action-executor.js';
import { allowAnyIntegrationHost } from '../integrations/egress.js';
import { noSecretsRedactor } from '../integrations/redaction.js';
import type {
  PipelineIntegrations,
  PipelineIntegrationsPort,
  RecoverableRunCredential,
} from '../pipeline/integrations.js';
import { RUN_CREDENTIAL_TTL_SECONDS } from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import { type PipelineOutboundOptions, pipelineOutboundHandler } from '../pipeline/outbound.js';
import { IntegrationError } from '../ports/integrations/common.js';
import type { CredentialRevocationAddress } from '../ports/integrations/git-provider.js';
import type { Logger } from '../ports/logger.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryAuditLog, createVirtualTimer } from '../testing/memory-integrations.js';
import {
  runCredentialRecoveryHorizonMs,
  runRunCredentialRevocation,
  type UnrevokedRunCredentialStore,
  unrevokedRunCredentialQuery,
} from './run-credential.js';

const GIT = '00000000-0000-4000-8000-00000000a001' as Id;
const RUN = '00000000-0000-4000-8000-00000000c001' as Id;
const TASK = '00000000-0000-4000-8000-00000000c002' as Id;
const PROJECT = '00000000-0000-4000-8000-00000000c003' as Id;
const NOW = '2026-09-15T12:00:00.000Z';

const STRANDED: RecoverableRunCredential = {
  runId: RUN,
  taskId: TASK,
  projectId: PROJECT,
  mode: 'normal',
  integrationId: GIT,
  revokeId: 'acme/api#58',
  scope: 'push',
  expiresAt: '2026-09-17T00:00:00.000Z',
};

const WAKE_UP: PipelineOutboundData = {
  duty: 'revoke_run_credential',
  project_id: PROJECT,
  task_id: TASK,
  run_id: RUN,
  revoke_id: 'acme/api#58',
  cause_event_id: RUN,
};

interface Line {
  readonly level: 'warn' | 'error';
  readonly message: string;
}

const harness = (
  options: {
    readonly revalidated?: RecoverableRunCredential | null;
    readonly revokeError?: Error;
    readonly forProjectError?: Error;
  } = {},
) => {
  const asked: CredentialRevocationAddress[] = [];
  const revalidations: unknown[] = [];
  const lines: Line[] = [];
  const auditLog = createMemoryAuditLog();
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog,
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: fixedClock(NOW, 1000),
  });
  const integrations: PipelineIntegrations = {
    executor,
    git: {
      port: {
        revokeCredential: async (address: CredentialRevocationAddress) => {
          if (options.revokeError !== undefined) throw options.revokeError;
          asked.push(address);
        },
      } as unknown as NonNullable<PipelineIntegrations['git']>['port'],
      ref: { integrationId: GIT, provider: 'fake-git', type: 'git', host: null },
      project: 'acme/api',
      redactor: noSecretsRedactor(),
    },
    taskManagement: null,
    communication: null,
  };
  const port: PipelineIntegrationsPort = {
    forProject: async () => {
      if (options.forProjectError !== undefined) throw options.forProjectError;
      return integrations;
    },
  } as unknown as PipelineIntegrationsPort;
  const store: UnrevokedRunCredentialStore = {
    unrevokedRunCredentials: async () => [],
    unrevokedRunCredential: async (_tx, input) => {
      revalidations.push(input);
      return options.revalidated === undefined ? STRANDED : options.revalidated;
    },
  };
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (_fields, message) => lines.push({ level: 'warn', message }),
    error: (_fields, message) => lines.push({ level: 'error', message }),
  };
  const base = {
    unitOfWork: new MemoryEventing(),
    integrations: port,
    clock: { now: () => NOW },
    logger,
  };
  return { asked, revalidations, lines, auditLog, store, base };
};

describe('the revoke_run_credential duty', () => {
  it('re-validates its one address, then revokes it by address through the executor', async () => {
    const { asked, revalidations, lines, auditLog, store, base } = harness();

    await runRunCredentialRevocation({ ...base, runCredentials: store }, WAKE_UP);

    expect(revalidations).toEqual([{ runId: RUN, revokeId: 'acme/api#58', now: NOW }]);
    expect(asked).toEqual([{ revokeId: 'acme/api#58' }]);
    expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['ok']);
    expect(lines).toEqual([
      { level: 'warn', message: expect.stringMatching(/revoked by the recovery pass/) },
    ]);
  });

  it('asks nobody when the address was revoked or attempted since the pass read it', async () => {
    const { asked, auditLog, lines, store, base } = harness({ revalidated: null });

    await runRunCredentialRevocation({ ...base, runCredentials: store }, WAKE_UP);

    // The duplicate wake-up of a pass that ran twice: nothing sent, nothing recorded.
    expect(asked).toEqual([]);
    expect(auditLog.entries).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('refuses by name, and asks nobody, when composed without the store to re-validate with', async () => {
    const { asked, auditLog, lines, base } = harness();

    await runRunCredentialRevocation(base, WAKE_UP);

    expect(asked).toEqual([]);
    expect(auditLog.entries).toEqual([]);
    expect(lines).toEqual([
      {
        level: 'error',
        message: expect.stringMatching(/composed without the run-credential store/),
      },
    ]);
  });

  it('logs an unconfirmed answer as an error and never as a revocation', async () => {
    const { lines, auditLog, store, base } = harness({
      revokeError: new IntegrationError('not_found', 'fake-git', 'no such token'),
    });

    await runRunCredentialRevocation({ ...base, runCredentials: store }, WAKE_UP);

    expect(auditLog.entriesFor('revoke_credential')[0]?.result).toMatchObject({ revoked: false });
    expect(lines).toEqual([
      {
        level: 'error',
        message: expect.stringMatching(/recorded as unconfirmed, never as revoked/),
      },
    ]);
  });

  it('does not throw for a revoke that failed — a retry would be a second attempt', async () => {
    const { lines, auditLog, store, base } = harness({ revokeError: new Error('gateway timeout') });

    await expect(
      runRunCredentialRevocation({ ...base, runCredentials: store }, WAKE_UP),
    ).resolves.toBeUndefined();

    expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['failed']);
    expect(lines).toEqual([
      { level: 'error', message: expect.stringMatching(/live until it expires/) },
    ]);
  });

  it('throws when the binding cannot be loaded — no row was written, so the retry is in bound', async () => {
    const { asked, auditLog, store, base } = harness({
      forProjectError: new Error('the binding could not be decrypted'),
    });

    await expect(
      runRunCredentialRevocation({ ...base, runCredentials: store }, WAKE_UP),
    ).rejects.toThrow(/could not be decrypted/);
    expect(asked).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });

  it('asks nobody for a wake-up that names no address', async () => {
    const { asked, lines, store, base } = harness();
    const { revoke_id: _dropped, ...noAddress } = WAKE_UP;

    await runRunCredentialRevocation(
      { ...base, runCredentials: store },
      noAddress as PipelineOutboundData,
    );

    expect(asked).toEqual([]);
    expect(lines.map((line) => line.level)).toEqual(['error']);
  });
});

describe('pipeline.outbound', () => {
  it('routes the revoke_run_credential duty to the recovery revoke', async () => {
    const { asked, store, base } = harness();
    const handler = pipelineOutboundHandler({
      ...base,
      runCredentials: store,
    } as unknown as PipelineOutboundOptions);

    await handler({
      id: 'job-1',
      queue: 'pipeline.outbound',
      data: WAKE_UP,
      signal: new AbortController().signal,
    });

    expect(asked).toEqual([{ revokeId: 'acme/api#58' }]);
  });
});

describe('the run-credential site’s bounds', () => {
  it('reaches back as far as a credential of this build can live: the TTL plus GitLab’s rounding', () => {
    // 24 h requested, granted to the next midnight UTC on or after it: up to 48 h.
    expect(runCredentialRecoveryHorizonMs(RUN_CREDENTIAL_TTL_SECONDS)).toBe(48 * 60 * 60_000);
  });

  it('computes the run window from one instant', () => {
    expect(
      unrevokedRunCredentialQuery({
        now: NOW as IsoDateTime,
        graceMs: 60_000,
        horizonMs: 48 * 60 * 60_000,
        limit: 10,
      }),
    ).toEqual({
      endedBefore: '2026-09-15T11:59:00.000Z',
      endedAfter: '2026-09-13T12:00:00.000Z',
      now: NOW,
      limit: 10,
    });
  });
});
