/**
 * `FakeObservabilityErrors` beyond the contract suite: capability gates, the search grammar and
 * the release filter.
 */
import { IntegrationUnsupportedError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createFakeObservabilityErrors } from './fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a4';
const PROJECT = 'api';

type Options = Parameters<typeof createFakeObservabilityErrors>[0];

const build = (options: Partial<Options> = {}) =>
  createFakeObservabilityErrors({
    integrationId: INTEGRATION_ID,
    issues: [
      {
        id: 'issue-1',
        project: PROJECT,
        title: 'TypeError: totals of undefined',
        release: '2026.06.1',
        latestEvent: { stackTrace: 'at total (totals.ts:42)' },
      },
      { id: 'issue-2', project: PROJECT, title: 'Ledger timeout', status: 'ignored' },
      { id: 'issue-3', project: 'web', title: 'Other project' },
    ],
    ...options,
  });

describe('FakeObservabilityErrors', () => {
  it('searches by release and refuses a query it cannot parse (divergence 2)', async () => {
    const port = build();
    expect(
      (await port.searchIssues({ project: PROJECT, query: 'release:2026.06.1' })).map(
        (issue) => issue.ref.id,
      ),
    ).toEqual(['issue-1']);

    await expect(
      port.searchIssues({ project: PROJECT, query: 'assigned:me' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      port.searchIssues({ project: PROJECT, query: 'is:archived' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('returns every issue of the project for an empty query, and never another project', async () => {
    const port = build();
    const all = await port.searchIssues({ project: PROJECT, query: '  ' });
    expect(all.map((issue) => issue.ref.id).sort()).toEqual(['issue-1', 'issue-2']);
  });

  it('honours `since` and `limit`', async () => {
    const port = build();
    expect(
      await port.searchIssues({
        project: PROJECT,
        query: '',
        since: '2030-01-01T00:00:00.000Z',
      }),
    ).toEqual([]);
    expect((await port.searchIssues({ project: PROJECT, query: '', limit: 1 })).length).toBe(1);
  });

  it('reports the disabled capabilities as unsupported', async () => {
    const port = build({
      capabilities: {
        search: false,
        comments: false,
        resolve: false,
        linkMergeRequest: false,
        resolveInRelease: false,
        mcp: false,
      },
    });
    const ref = { id: 'issue-1' };
    await expect(port.searchIssues({ project: PROJECT, query: '' })).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );
    await expect(port.comment(ref, 'x')).rejects.toBeInstanceOf(IntegrationUnsupportedError);
    await expect(port.resolve(ref)).rejects.toBeInstanceOf(IntegrationUnsupportedError);
    await expect(port.linkMergeRequest(ref, 'https://x.test/1')).rejects.toBeInstanceOf(
      IntegrationUnsupportedError,
    );
    expect(port.agentTooling().mcp).toBeNull();
  });

  it('refuses resolve-in-release when only plain resolve is supported', async () => {
    const port = build({ capabilities: { resolveInRelease: false } });
    await expect(
      port.resolve({ id: 'issue-1' }, { inRelease: '2026.07.0' }),
    ).rejects.toBeInstanceOf(IntegrationUnsupportedError);
    expect((await port.resolve({ id: 'issue-1' })).status).toBe('resolved');
  });

  it('records the link and the release it resolved in', async () => {
    const port = build();
    await port.linkMergeRequest(
      { id: 'issue-1' },
      'https://git.example.test/api/-/merge_requests/7',
    );
    await port.linkMergeRequest(
      { id: 'issue-1' },
      'https://git.example.test/api/-/merge_requests/7',
    );
    await port.resolve({ id: 'issue-1' }, { inRelease: '2026.07.0' });

    const stored = port.peek('issue-1');
    expect(stored?.linked_mrs).toEqual(['https://git.example.test/api/-/merge_requests/7']);
    expect(stored?.resolved_in_release).toBe('2026.07.0');
  });

  it('declares an MCP server whose headers are named, never valued', () => {
    const tooling = build().agentTooling();
    expect(tooling.mcp?.header_names).toEqual(['Authorization']);
    expect(JSON.stringify(tooling)).not.toContain('Bearer');
  });

  it('seeds another issue after construction', () => {
    const port = build();
    const issue = port.seedIssue({ project: PROJECT, title: 'New one' });
    expect(issue.ref.id).toMatch(/^issue-/);
    expect(port.peek(issue.ref.id)?.title).toBe('New one');
  });
});
