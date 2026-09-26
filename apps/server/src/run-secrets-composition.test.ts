/**
 * TD-028's WP-76 amendment, decision 8, **at the composition root**: the run credentials this
 * process mints reach the three sinks WP-76 composed them into — the executor, the binding loader's
 * platform redactor and the stage executor's artifact write — and the minter registers them in the
 * **same** registry those sinks read (WP-76 review rounds 1 and 2: removing the registry from any
 * sink, or building a second one, survived every tier).
 *
 * ## The shape that makes it structural
 *
 * `composeIntegrationStack` builds the process's one registry and `stack.platformRedactor` over it;
 * the executor is given that redactor there, `createProjectIntegrationsPort` takes the stack and
 * passes `stack.platformRedactor` to the loader, the stage executor is given `stack.platformRedactor`,
 * and `composeRunWorkspaces` takes the stack and registers minted values in `stack.runSecrets`.
 *
 * ## What each case proves, and what it cannot
 *
 * - **Behaviour**: a value registered in `stack.runSecrets` after the stack exists is replaced by
 *   `stack.platformRedactor` and by the executor (driven end to end: the audit write's own failure
 *   leaves `execute` scrubbed with the redactor it was composed with).
 * - **One registry**: `createRunScopedSecrets(` has exactly one construction site in the non-test
 *   sources under `apps/server/src`, read off `git ls-files` (tracked and untracked, rule 85).
 * - **The loader's and the artifact write's hand-over are a text census** of
 *   `apps/server/src/pipeline.ts`: each property line must read `stack.platformRedactor`. The
 *   residual, stated: building either for real needs a database (the loader decrypts `secrets`
 *   rows; the stage executor is the whole pipeline), so no case here watches a value being redacted
 *   *at* those two sinks. The census cannot see a redactor that reaches them through a variable or a
 *   spread, and whether each sink *applies* what it is given is its own test
 *   (`bindings/loader.test.ts`, `artifacts/redaction.test.ts`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRunScopedSecrets,
  type IntegrationRef,
  runGitCredentialSecretName,
  silentLogger,
} from '@platform/application';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { composeIntegrationStack, platformRedactorFor } from './pipeline.js';
import { repositoryRoot, sourceFilesUnder, withoutComments } from './routes/web-sources.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'fake_run_credential_composition_0001';
const PLACEHOLDER = `[REDACTED:integration:${runGitCredentialSecretName(RUN)}]`;

const failing = async (): Promise<never> => {
  throw new Error(`the event store is down while writing ${TOKEN}`);
};

/** A stack whose audit write fails with the token in its message, so `execute`'s scrub is visible. */
const stackWithFailingAudit = () =>
  composeIntegrationStack({
    pool: {} as pg.Pool,
    eventing: {
      unitOfWork: { transaction: failing },
      store: { nextStreamSequence: failing },
    } as never,
    integrationHosts: [],
    logger: silentLogger,
  });

describe('the run credentials reach every sink WP-76 composed them into', () => {
  it('platformRedactorFor replaces a value registered after it was built', () => {
    const secrets = createRunScopedSecrets({ now: () => 0 });
    const redactor = platformRedactorFor(secrets);
    expect(redactor.redactText(TOKEN).count).toBe(0);
    secrets.add(RUN, TOKEN, '2099-01-01T00:00:00.000Z');
    expect(redactor.redactText(`x ${TOKEN} y`).value).toBe(`x ${PLACEHOLDER} y`);
  });

  it('the stack’s platform redactor reads the stack’s own registry', () => {
    const stack = stackWithFailingAudit();
    stack.runSecrets.add(RUN, TOKEN, '2099-01-01T00:00:00.000Z');
    expect(stack.platformRedactor.redactText(TOKEN).value).toBe(PLACEHOLDER);
  });

  it('the executor scrubs a value registered in the stack’s registry after it was composed', async () => {
    const stack = stackWithFailingAudit();
    stack.runSecrets.add(RUN, TOKEN, '2099-01-01T00:00:00.000Z');
    const ref: IntegrationRef = {
      integrationId: '44444444-4444-4444-8444-444444444444',
      provider: 'fake-git',
      type: 'git',
      host: null,
    };
    const settled = await stack.executor
      .execute({
        integration: ref,
        action: 'get_default_branch_head',
        payload: {},
        mutating: false,
        perform: async () => 'main',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toContain(PLACEHOLDER);
    expect((settled as Error).message).not.toContain(TOKEN);
  });

  it('builds the registry once in the whole server: the minter and the sinks cannot diverge', () => {
    const sites = sourceFilesUnder('apps/server/src').flatMap((file) => {
      const source = withoutComments(readFileSync(join(repositoryRoot, file), 'utf8'));
      return source.split('createRunScopedSecrets(').length > 1 ? [file] : [];
    });
    const count = sourceFilesUnder('apps/server/src')
      .map(
        (file) =>
          withoutComments(readFileSync(join(repositoryRoot, file), 'utf8')).split(
            'createRunScopedSecrets(',
          ).length - 1,
      )
      .reduce((sum, n) => sum + n, 0);
    expect(sites).toEqual(['apps/server/src/pipeline.ts']);
    expect(count).toBe(1);
  });

  it.each([
    ['the executor', /^\s*redactor: platformRedactor,$/m],
    ['the stack it returns', /^\s*platformRedactor,$/m],
    [
      'the binding loader’s platform redactor',
      /^\s*platformRedactor: options\.stack\.platformRedactor,$/m,
    ],
    ['the stage executor’s artifact write', /^\s*redactor: stack\.platformRedactor,$/m],
    ['the minter, through the stack', /^\s*runSecrets: options\.stack\.runSecrets,$/m],
  ])('%s is handed the stack’s redactor or registry', (_sink, line) => {
    const file = _sink === 'the minter, through the stack' ? 'workspaces.ts' : 'pipeline.ts';
    const source = withoutComments(
      readFileSync(join(repositoryRoot, 'apps/server/src', file), 'utf8'),
    );
    expect(source.match(new RegExp(line.source, 'gm'))).toHaveLength(1);
  });
});
