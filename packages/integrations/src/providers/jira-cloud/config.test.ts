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
      pickup_status: 'To pick up',
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
    expect(parsed.pickup_status).toBe('To pick up');
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

  it('refuses a pickup_status that the closed list names (S-28.4)', () => {
    expect(
      issuesOf({ ...BASE, pickup_status: 'Ready', lifecycle: { closed: ['Done', 'ready'] } }),
    ).toEqual([expect.stringMatching(/^lifecycle\.closed\.1: .*finished/)]);
  });

  it('refuses a pickup_status that qa_pass names (S-28.24, TD-029 amendment G)', () => {
    expect(
      issuesOf({
        ...BASE,
        pickup_status: 'Ready',
        lifecycle: { qa: 'CR accepted', qa_pass: ['Releasable', ' READY'] },
      }),
    ).toEqual([expect.stringMatching(/^lifecycle\.qa_pass\.1: .*pass QA/)]);
    expect(
      issuesOf({
        ...BASE,
        pickup_status: 'Ready',
        lifecycle: { qa: 'CR accepted', qa_pass: ['Releasable'] },
      }),
    ).toEqual([]);
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

describe('jiraCloudConfigSchema’s claim_label (BACKLOG 1611)', () => {
  it('is off by default', () => {
    expect(jiraCloudConfigSchema.parse(BASE).claim_label).toBeNull();
  });

  it('accepts a label beside the pick-up label', () => {
    expect(
      jiraCloudConfigSchema.parse({ ...BASE, claim_label: 'agentic-working' }).claim_label,
    ).toBe('agentic-working');
  });

  it('accepts an explicit null', () => {
    expect(jiraCloudConfigSchema.parse({ ...BASE, claim_label: null }).claim_label).toBeNull();
  });

  it.each([
    ['a space', 'agentic working'],
    ['a tab', 'agentic\tworking'],
    ['a leading space', ' agentic-working'],
    ['the empty string', ''],
    ['256 characters', 'a'.repeat(256)],
  ])('refuses a label with %s', (_what, label) => {
    // The empty string fails both the length bound and the label pattern, so it may carry two issues.
    const issues = issuesOf({ ...BASE, claim_label: label });
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toMatch(/^claim_label: /);
    }
  });

  it('accepts a label of exactly 255 characters (the bound’s other side)', () => {
    expect(issuesOf({ ...BASE, claim_label: 'a'.repeat(255) })).toEqual([]);
  });

  it('refuses the default pick-up label, case-insensitively, naming both keys', () => {
    expect(issuesOf({ ...BASE, claim_label: 'Agentic' })).toEqual([
      expect.stringMatching(/^claim_label: claim_label names the label pickup_label names/),
    ]);
  });

  it('refuses a claim label equal to a configured pick-up label', () => {
    expect(issuesOf({ ...BASE, pickup_label: 'ready', claim_label: 'ready' })).toEqual([
      expect.stringContaining('claim_label'),
    ]);
  });

  it('accepts the former pick-up label once label pick-up is off', () => {
    expect(issuesOf({ ...BASE, pickup_label: null, claim_label: 'agentic' })).toEqual([]);
  });
});
