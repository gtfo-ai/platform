import type { DomainEvent, Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  createStreamMergeRequestLifecycle,
  lifecycleKeyOf,
  lifecycleKeyText,
  type MergeRequestLifecycleEvent,
  repeatsLifecycle,
} from './merge-request-lifecycle.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000b2' as Id;

const lifecycle = (
  type: string,
  iid: number,
  projectPath: string | null = 'acme/api',
  projectId: Id = PROJECT,
  occurredAt = '2026-06-01T10:00:00.000Z',
): DomainEvent =>
  ({
    type,
    stream_id: projectId,
    occurred_at: occurredAt,
    payload: {
      project_id: projectId,
      mr: { iid, project_path: projectPath, url: `https://git.example.test/mr/${iid}` },
    },
  }) as unknown as DomainEvent;

const readerOver = (events: readonly DomainEvent[]) =>
  createStreamMergeRequestLifecycle({
    readStream: async (_type, id) =>
      events
        .filter((event) => (event as unknown as { stream_id: string }).stream_id === id)
        .map((event, index) => ({ position: index + 1, causeEventPosition: null, event })),
  });

describe('which lifecycle draft repeats the log (WP-110)', () => {
  const table: readonly [MergeRequestLifecycleEvent | null, MergeRequestLifecycleEvent, boolean][] =
    [
      // Nothing known: every transition is news.
      [null, 'mr.opened', false],
      [null, 'mr.merged', false],
      [null, 'mr.closed', false],
      // The same transition twice is the only thing a repeat can be.
      ['mr.opened', 'mr.opened', true],
      ['mr.merged', 'mr.merged', true],
      ['mr.closed', 'mr.closed', true],
      // An open after a close is a reopen; a close after an open is a close.
      ['mr.closed', 'mr.opened', false],
      ['mr.opened', 'mr.closed', false],
      ['mr.opened', 'mr.merged', false],
      // Merged is terminal on GitLab: nothing follows it.
      ['mr.merged', 'mr.opened', true],
      ['mr.merged', 'mr.closed', true],
      // A merge after a close is not one GitLab makes, but the log is not the place to refuse it.
      ['mr.closed', 'mr.merged', false],
    ];
  it.each(table)('after %s, %s repeats: %s', (latest, next, repeats) => {
    expect(repeatsLifecycle(latest, next)).toBe(repeats);
  });
});

describe('the lifecycle key', () => {
  it('is read off a payload’s merge request, and a payload with none has no key', () => {
    expect(lifecycleKeyOf(PROJECT, { mr: { iid: 7, project_path: 'acme/api' } })).toEqual({
      projectId: PROJECT,
      projectPath: 'acme/api',
      iid: 7,
    });
    expect(lifecycleKeyOf(PROJECT, { mr: { iid: 7 } })?.projectPath).toBeNull();
    expect(lifecycleKeyOf(PROJECT, { ticket: { key: 'ACME-1' } })).toBeNull();
    expect(lifecycleKeyOf(PROJECT, null)).toBeNull();
  });

  it('spells the path into the identity, so two repositories’ !7 are two merge requests', () => {
    const one = lifecycleKeyText({ projectId: PROJECT, projectPath: 'acme/api', iid: 7 });
    const two = lifecycleKeyText({ projectId: PROJECT, projectPath: 'acme/web', iid: 7 });
    expect(one).not.toBe(two);
  });
});

describe('the stream reader', () => {
  it('answers the newest lifecycle event of exactly that merge request', async () => {
    const reader = readerOver([
      lifecycle('mr.opened', 7),
      lifecycle('mr.updated', 7),
      lifecycle('mr.closed', 7, 'acme/api', PROJECT, '2026-06-01T10:02:00.000Z'),
      lifecycle('mr.opened', 8),
      lifecycle('mr.merged', 7, 'acme/web'),
      lifecycle('mr.merged', 7, 'acme/api', OTHER),
    ]);
    // `mr.updated` is not a lifecycle event; the other repository's and the other project's !7
    // are other merge requests.
    expect(await reader.latest({ projectId: PROJECT, projectPath: 'acme/api', iid: 7 })).toBe(
      'mr.closed',
    );
    expect(await reader.latest({ projectId: PROJECT, projectPath: 'acme/api', iid: 8 })).toBe(
      'mr.opened',
    );
    expect(await reader.latest({ projectId: PROJECT, projectPath: 'acme/api', iid: 9 })).toBeNull();
  });
});
