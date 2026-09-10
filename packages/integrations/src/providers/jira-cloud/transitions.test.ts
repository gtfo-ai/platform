/**
 * The two pure decisions the adapter makes before it talks to Jira: which transition leads to a
 * status name, and what JQL a pick-up rule becomes.
 *
 * Both are where a lazy test is easiest to write, and both are load-bearing: a resolver that
 * matched on the transition's *own* name would move tickets into whatever column a workflow author
 * happened to name "Done", and a JQL builder that pasted a value would let a label containing a
 * quote change the query.
 */
import { describe, expect, it } from 'vitest';
import {
  buildJql,
  describeTargets,
  equalsStatus,
  fixedActionContext,
  jqlLiteral,
  pickupRuleOf,
  resolveTransition,
} from './index.js';
import type { JiraTransition } from './mapping.js';

const TRANSITIONS: readonly JiraTransition[] = [
  // Atlassian's own example has a transition named "Close Issue" leading to "In Progress".
  { id: '11', name: 'Close Issue', to: { id: '3', name: 'In Progress' }, isAvailable: true },
  { id: '21', name: 'In Progress', to: { id: '10005', name: 'In Review' } },
  { id: '31', name: 'Park', to: { id: '10007', name: 'Waiting for input' }, isAvailable: false },
];

describe('resolveTransition', () => {
  it('matches the target **status**, not the transition name', () => {
    expect(resolveTransition(TRANSITIONS, 'In Progress')?.id).toBe('11');
    // "In Progress" is also the *name* of transition 21, which leads somewhere else entirely.
    expect(resolveTransition(TRANSITIONS, 'In Review')?.id).toBe('21');
  });

  it('treats an omitted isAvailable as available, as Atlassian’s example does', () => {
    expect(resolveTransition(TRANSITIONS, 'In Review')?.id).toBe('21');
  });

  it('does not offer a transition the workflow says is unavailable', () => {
    expect(resolveTransition(TRANSITIONS, 'Waiting for input')).toBeNull();
  });

  it('compares status names case- and whitespace-insensitively', () => {
    expect(resolveTransition(TRANSITIONS, '  in progress ')?.id).toBe('11');
    expect(equalsStatus('Done', 'done')).toBe(true);
    expect(equalsStatus('Done', 'Done Done')).toBe(false);
  });

  it('is null for a status nowhere in the workflow', () => {
    expect(resolveTransition(TRANSITIONS, 'Shipped To Mars')).toBeNull();
  });
});

describe('describeTargets', () => {
  it('names what the caller could have asked for, and hides what it could not', () => {
    expect(describeTargets(TRANSITIONS)).toBe('"In Progress", "In Review"');
    expect(describeTargets([])).toBe('(none)');
  });
});

describe('jqlLiteral', () => {
  it('escapes the two characters that could end the literal', () => {
    expect(jqlLiteral('agentic')).toBe('"agentic"');
    expect(jqlLiteral('needs "review"')).toBe('"needs \\"review\\""');
    expect(jqlLiteral('back\\slash')).toBe('"back\\\\slash"');
  });

  it('cannot be closed early by a crafted label', () => {
    // A pick-up label comes from `.agentic/config.yml`; a value that closed the string would let
    // a repository rewrite the query the platform polls with.
    const hostile = '" OR project = SECRET AND labels = "';
    expect(jqlLiteral(hostile).match(/(?<!\\)"/g)?.length, 'only the two delimiters').toBe(2);
  });
});

describe('buildJql', () => {
  const NOW = '2026-09-02T12:05:00.000Z';

  it('builds one clause per rule kind, ordered oldest first', () => {
    expect(buildJql({ kind: 'label', label: 'agentic' }, null, NOW)).toBe(
      'labels = "agentic" ORDER BY updated ASC',
    );
    expect(buildJql({ kind: 'status', status: 'Ready for agent' }, null, NOW)).toBe(
      'status = "Ready for agent" ORDER BY updated ASC',
    );
    // `parent` "works for both team-managed and company-managed spaces" (JQL fields reference).
    expect(buildJql({ kind: 'epic', epic_key: 'ACME-100' }, null, NOW)).toBe(
      'parent = "ACME-100" ORDER BY updated ASC',
    );
    expect(buildJql({ kind: 'query', query: 'project = ACME AND type = Bug' }, null, NOW)).toBe(
      '(project = ACME AND type = Bug) ORDER BY updated ASC',
    );
  });

  it('expresses the polling window as relative minutes, never as a local date', () => {
    // An absolute JQL literal is read "relative to your configured time zone", so a site an hour
    // ahead would skip an hour of tickets. The relative form has no zone.
    expect(buildJql({ kind: 'label', label: 'agentic' }, '2026-09-02T11:50:00.000Z', NOW)).toBe(
      'labels = "agentic" AND updated >= "-15m" ORDER BY updated ASC',
    );
  });

  it('rounds the window up, so it always covers the instant it was asked for', () => {
    expect(
      buildJql({ kind: 'label', label: 'agentic' }, '2026-09-02T12:04:29.000Z', NOW),
    ).toContain('"-1m"');
    expect(
      buildJql({ kind: 'label', label: 'agentic' }, '2026-09-02T12:03:01.000Z', NOW),
    ).toContain('"-2m"');
  });

  it('never asks for a window of zero, whatever the caller passes', () => {
    expect(buildJql({ kind: 'label', label: 'agentic' }, NOW, NOW)).toContain('"-1m"');
    expect(
      buildJql({ kind: 'label', label: 'agentic' }, '2026-09-03T00:00:00.000Z', NOW),
      'a cursor from the future',
    ).toContain('"-1m"');
    expect(buildJql({ kind: 'label', label: 'agentic' }, 'not a date', NOW)).toContain('"-1m"');
  });
});

describe('pickupRuleOf', () => {
  it('prefers the status, because it is the narrower statement', () => {
    expect(pickupRuleOf({ pickup_label: 'agentic', pickup_status: 'Ready for agent' })).toEqual({
      kind: 'status',
      status: 'Ready for agent',
    });
  });

  it('falls back to the label, and to nothing at all', () => {
    expect(pickupRuleOf({ pickup_label: 'agentic' })).toEqual({ kind: 'label', label: 'agentic' });
    expect(pickupRuleOf({ pickup_label: null, pickup_status: null })).toEqual({ kind: 'none' });
    expect(pickupRuleOf({})).toEqual({ kind: 'none' });
  });
});

describe('fixedActionContext', () => {
  it('states the mode a caller with no task is acting in', () => {
    expect(fixedActionContext('shadow')()).toEqual({
      mode: 'shadow',
      projectId: null,
      taskId: null,
    });
  });
});
