/**
 * The Jira binding's `lifecycle` block (WP-172 criterion 6, TD-029 decision 1): the contracts'
 * `ticketLifecycleSchema` embedded — never re-declared — and `pickup_status` kept as the
 * `pick_up_from` slot, distinct from every other slot. Every status name here is invented (BD-031).
 */
import { ticketLifecycleSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { findShippedProvider } from '../../catalogue.js';
import { jiraCloudConfigSchema } from './config.js';

const BASE = {
  site_url: 'https://acme-example.atlassian.net',
  user_email: 'agentic-bot@example.test',
  api_token: 'FAKE-jira-api-token-0123456789',
};

const issuesOf = (value: unknown): string[] => {
  const parsed = jiraCloudConfigSchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
};

describe('jiraCloudConfigSchema’s lifecycle block (WP-172 criterion 6)', () => {
  it('is the contracts’ ticketLifecycleSchema itself, not a copy', () => {
    expect(jiraCloudConfigSchema.shape.lifecycle.unwrap()).toBe(ticketLifecycleSchema);
  });

  it('parses a config with a lifecycle block beside pickup_status', () => {
    const parsed = jiraCloudConfigSchema.parse({
      ...BASE,
      pickup_status: 'Ready for agent',
      lifecycle: {
        in_progress: 'Doing',
        in_review: 'Waiting for review',
        qa: 'Testing',
        returned: ['Sent back'],
        done: 'Done',
        claim: true,
      },
    });
    expect(parsed.lifecycle?.in_review).toBe('Waiting for review');
    expect(parsed.pickup_status).toBe('Ready for agent');
  });

  it('parses a config with no lifecycle block, as every binding written before M10 is', () => {
    expect(jiraCloudConfigSchema.parse(BASE).lifecycle).toBeUndefined();
  });

  it('refuses an unknown key inside the block', () => {
    expect(issuesOf({ ...BASE, lifecycle: { in_progress: 'Doing', pick_up_from: 'x' } })).toEqual([
      expect.stringContaining('lifecycle'),
    ]);
  });

  it('refuses a pickup_status that a single slot names, case-insensitively', () => {
    expect(
      issuesOf({
        ...BASE,
        pickup_status: 'In Progress',
        lifecycle: { in_progress: 'in progress' },
      }),
    ).toEqual([expect.stringMatching(/^lifecycle\.in_progress: .*pickup_status/)]);
  });

  it('refuses a pickup_status that the returned list names', () => {
    expect(
      issuesOf({ ...BASE, pickup_status: 'Sent back', lifecycle: { returned: [' sent BACK'] } }),
    ).toEqual([expect.stringMatching(/^lifecycle\.returned\.0: /)]);
  });

  it('accepts a lifecycle block when no pickup_status is set (pickup by label)', () => {
    expect(issuesOf({ ...BASE, lifecycle: { in_progress: 'Doing' } })).toEqual([]);
  });

  it('carries the refusal into the catalogue’s credential-free schema (WP-100’s configIssuesOf)', () => {
    const entry = findShippedProvider('jira-cloud');
    const { api_token: _token, ...document } = {
      ...BASE,
      pickup_status: 'Doing',
      lifecycle: { in_progress: 'doing' },
    };
    expect(entry?.accountConfigSchema.safeParse(document).success).toBe(false);
    expect(
      entry?.accountConfigSchema.safeParse({ ...document, lifecycle: { in_progress: 'Testing' } })
        .success,
    ).toBe(true);
  });
});
