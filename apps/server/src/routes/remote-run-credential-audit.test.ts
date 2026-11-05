/**
 * The remote-worker opt-in's audit (WP-282, TD-031 decision 5, Q124 (a)): the `PATCH` that sets or
 * removes `remote_run_credential` records which way it went, and only a value from the closed list.
 */
import { describe, expect, it } from 'vitest';
import { integrationCreateAuditParams, remoteRunCredentialAudit } from './onboarding.js';

describe('remoteRunCredentialAudit', () => {
  it('records allow and deny as set, deny for a removal, and nothing for a PATCH that did not touch it', () => {
    expect(remoteRunCredentialAudit({ remote_run_credential: 'allow' }, undefined)).toEqual({
      remote_run_credential: 'allow',
    });
    expect(remoteRunCredentialAudit({ remote_run_credential: 'deny' }, [])).toEqual({
      remote_run_credential: 'deny',
    });
    expect(remoteRunCredentialAudit({}, ['remote_run_credential'])).toEqual({
      remote_run_credential: 'deny',
    });
    expect(
      remoteRunCredentialAudit({ base_url: 'https://gitlab.example.test' }, ['project']),
    ).toEqual({});
  });

  it('copies no other text into the audit, whatever the body says', () => {
    expect(
      remoteRunCredentialAudit({ remote_run_credential: 'glpat-FAKE-not-a-choice' }, []),
    ).toEqual({});
  });
});

describe('integrationCreateAuditParams', () => {
  it('records the opt-in a create sets, beside the field names and never a value', () => {
    const params = integrationCreateAuditParams(
      {
        provider: 'gitlab',
        name: 'acme',
        config: { base_url: 'https://gitlab.example.test', remote_run_credential: 'allow' },
        secret_refs: { token: 'GITLAB_TOKEN' },
      },
      'key-1',
      'digest-1',
    );
    expect(params).toEqual({
      provider: 'gitlab',
      name: 'acme',
      secret_fields: ['token'],
      idempotency_key: 'key-1',
      body_digest: 'digest-1',
      remote_run_credential: 'allow',
    });
    expect(
      integrationCreateAuditParams({ provider: 'sentry', name: 's', config: {} }, 'k', 'd'),
    ).not.toHaveProperty('remote_run_credential');
  });
});
