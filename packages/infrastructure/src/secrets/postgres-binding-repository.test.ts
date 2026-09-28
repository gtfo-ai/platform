/**
 * WP-79, PROGRESS backlog 268 — a binding stored **before** WP-73b's write refusal can still carry
 * `socket_mode`, and the merge let it win. The repository now drops a provider's account-only keys
 * from `bindings.config` on read, so the account's value is the one every project reads.
 *
 * The rows below are the SQL's own shape, handed back by a recording executor, so both reads
 * (`forProject` and `forIntegration`) are exercised without a database; the same pre-WP-73b row
 * against PostgreSQL is `test/integration/secrets/bindings.integration.test.ts`.
 */
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import {
  type AccountOnlyFieldsLookup,
  createPostgresBindingRepository,
  overlayBindingConfig,
} from './postgres-binding-repository.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-00000000a001' as Id;

/** Slack's registration declares `socket_mode` account-only; nothing else here does. */
const SLACK_ONLY: AccountOnlyFieldsLookup = (provider) =>
  provider === 'slack' ? ['socket_mode'] : [];

/** The account says webhooks; the pre-WP-73b binding row says Socket Mode. */
const ACCOUNT = { channel: '#platform', socket_mode: false };
const PRE_WP73B_BINDING = { channel: '#api', socket_mode: true };

const executor = (rows: readonly Record<string, unknown>[]): SqlExecutor => ({
  query: async <R extends Record<string, unknown>>() => ({
    rows: rows as unknown as R[],
    rowCount: rows.length,
  }),
});

describe('a binding’s copy of an account-only key (WP-79, backlog 268)', () => {
  it('is dropped by the overlay, and every other key still overrides the account', () => {
    expect(overlayBindingConfig(ACCOUNT, PRE_WP73B_BINDING, ['socket_mode'])).toEqual({
      channel: '#api',
      socket_mode: false,
    });
    // The other direction (standing rule 42): with no account-only key declared, the binding wins
    // as it always did — the drop is the list's, not a blanket refusal of overrides.
    expect(overlayBindingConfig(ACCOUNT, PRE_WP73B_BINDING, [])).toEqual(PRE_WP73B_BINDING);
  });

  it('never reaches a project’s merged config through forProject', async () => {
    const repository = createPostgresBindingRepository(
      executor([
        {
          binding_id: '00000000-0000-4000-8000-00000000b001',
          integration_id: INTEGRATION,
          type: 'communication',
          provider: 'slack',
          name: 'acme slack',
          integration_config: ACCOUNT,
          binding_config: PRE_WP73B_BINDING,
          secret_ids: [],
        },
      ]),
      SLACK_ONLY,
    );
    const [binding] = await repository.forProject(PROJECT);
    expect(binding?.config).toEqual({ channel: '#api', socket_mode: false });
  });

  it('never reaches a binding of the account through forIntegration', async () => {
    const repository = createPostgresBindingRepository(
      executor([
        {
          type: 'communication',
          provider: 'slack',
          name: 'acme slack',
          integration_config: ACCOUNT,
          secret_ids: [],
          binding_id: '00000000-0000-4000-8000-00000000b001',
          project_id: PROJECT,
          binding_config: PRE_WP73B_BINDING,
        },
      ]),
      SLACK_ONLY,
    );
    const account = await repository.forIntegration(INTEGRATION);
    expect(account?.config).toEqual(ACCOUNT);
    expect(account?.bindings[0]?.config).toEqual({ channel: '#api', socket_mode: false });
  });

  it('leaves a provider that declares no account-only key exactly as it merged before', async () => {
    const repository = createPostgresBindingRepository(
      executor([
        {
          binding_id: '00000000-0000-4000-8000-00000000b002',
          integration_id: INTEGRATION,
          type: 'git',
          provider: 'gitlab',
          name: 'acme gitlab',
          integration_config: { base_url: 'https://gitlab.example.test', project: 'acme/web' },
          binding_config: { project: 'acme/api' },
          secret_ids: [],
        },
      ]),
      SLACK_ONLY,
    );
    const [binding] = await repository.forProject(PROJECT);
    expect(binding?.config).toEqual({
      base_url: 'https://gitlab.example.test',
      project: 'acme/api',
    });
  });
});
