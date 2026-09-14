/**
 * The registry client's six guards, each asserted as a **countable** effect (WP-38, Q84).
 *
 * The client is what stands in for `IntegrationActionExecutor` on this one path, so what its
 * docblock claims has to be checked rather than described (standing rule 44). Every case below is
 * about what does or does not reach the network: the injected `fetch` records every call, and
 * "nothing was asked" is asserted as an **empty** recording rather than as a returned status.
 *
 * The response shapes are the ones measured off the live services on 2026-09-14 and quoted in the
 * module docblock; nothing here re-invents a field name.
 */
import { MemoryEventing, markTransactions, TransactionOpenError } from '@platform/application';
import { dependencyMetadataSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  createDependencyMetadataClient,
  MAX_LICENCE_CHARS,
  MAX_REGISTRY_BYTES,
  REGISTRY_TIMEOUT_MS,
} from './registry-metadata.js';

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const NPM_LATEST = {
  name: 'left-pad',
  version: '1.3.0',
  license: 'WTFPL',
  deprecated: 'use String.prototype.padStart()',
};

const NPM_ABBREVIATED = {
  name: 'left-pad',
  'dist-tags': { latest: '1.3.0' },
  versions: { '1.3.0': { name: 'left-pad', version: '1.3.0' } },
  modified: '2024-04-16T05:01:57.431Z',
};

const PYPI = {
  info: {
    version: '2.34.2',
    license: 'Apache-2.0',
    license_expression: null,
    classifiers: ['License :: OSI Approved :: Apache Software License'],
    yanked: false,
  },
  urls: [{ upload_time_iso_8601: '2026-05-14T19:25:26.443000Z' }],
  releases: {},
};

/** A `fetch` that records and answers from a table; anything unlisted is a 404. */
const recordingFetch = (
  bodies: Readonly<Record<string, unknown>>,
): { readonly calls: Call[]; readonly fetch: typeof globalThis.fetch } => {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = bodies[url];
    if (body === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
};

describe('the package-registry metadata client (Q84, WP-38)', () => {
  it('asks nobody and says "not checked" when no host is declared — the shipped default', async () => {
    const recorded = recordingFetch({});
    const client = createDependencyMetadataClient({ allowedHosts: [], fetch: recorded.fetch });

    const answer = await client.describe({ ecosystem: 'npm', name: 'left-pad' });

    expect(answer.status).toBe('not_checked');
    expect(answer.license).toBeNull();
    // The whole security property, as a count: nothing left this process.
    expect(recorded.calls).toEqual([]);
  });

  it('reads npm’s licence, deprecation and last release when the host is declared', async () => {
    const recorded = recordingFetch({
      'https://registry.npmjs.org/left-pad/latest': NPM_LATEST,
      'https://registry.npmjs.org/left-pad': NPM_ABBREVIATED,
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    const answer = await client.describe({ ecosystem: 'npm', name: 'left-pad' });

    expect(answer).toEqual({
      status: 'checked',
      license: 'WTFPL',
      deprecated: true,
      last_published_at: '2024-04-16T05:01:57.431Z',
      source_url: 'https://www.npmjs.com/package/left-pad',
    });
    expect(recorded.calls.map((call) => call.url)).toEqual([
      'https://registry.npmjs.org/left-pad/latest',
      'https://registry.npmjs.org/left-pad',
    ]);
    // The abbreviated packument, which is the only reason the second call is affordable.
    expect(recorded.calls[1]?.init?.headers).toEqual({
      accept: 'application/vnd.npm.install-v1+json',
    });
    // No credential, no cookie, no redirect, and a bound on the wait — the four things the
    // executor would otherwise be enforcing.
    for (const call of recorded.calls) {
      expect(JSON.stringify(call.init?.headers)).not.toMatch(/authorization|cookie/i);
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(REGISTRY_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('reads PyPI’s licence and upload time, preferring a classifier over free text', async () => {
    const recorded = recordingFetch({ 'https://pypi.org/pypi/requests/json': PYPI });
    const client = createDependencyMetadataClient({
      allowedHosts: ['pypi.org'],
      fetch: recorded.fetch,
    });

    const answer = await client.describe({ ecosystem: 'pypi', name: 'requests' });

    expect(answer.status).toBe('checked');
    expect(answer.license).toBe('Apache Software License');
    expect(answer.last_published_at).toBe('2026-05-14T19:25:26.443Z');
    expect(answer.deprecated).toBe(false);
    expect(answer.source_url).toBe('https://pypi.org/project/requests/');
  });

  it('refuses a licence that is a whole document rather than a name', async () => {
    const recorded = recordingFetch({
      'https://pypi.org/pypi/verbose/json': {
        info: { license: 'A'.repeat(4000), classifiers: [], yanked: false },
        urls: [],
      },
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['pypi.org'],
      fetch: recorded.fetch,
    });

    const answer = await client.describe({ ecosystem: 'pypi', name: 'verbose' });

    // A truncated licence text on a merge-readiness panel would read as a licence nobody has.
    expect(answer.status).toBe('checked');
    expect(answer.license).toBeNull();
  });

  it('drops an npm licence the record cannot hold and keeps one that fits — both ways', async () => {
    /**
     * Review round 2's first major, as the two cases that separate a bound from a blanket `null`.
     *
     * npm's `license` was read through `asString` (trim only) while `dependencyMetadataSchema`
     * caps it at 200, so a package publishing its whole licence made `taskDependenciesSchema.parse`
     * throw **in the gate** — the record was never written, nobody was asked, no block was applied
     * and the outbound job died. The long one is therefore dropped rather than truncated, and the
     * other two facts survive it; the one that fits is kept, because a client that answered `null`
     * for every licence would pass the first half on its own.
     */
    const recorded = recordingFetch({
      'https://registry.npmjs.org/wordy/latest': { license: 'A'.repeat(300), deprecated: null },
      'https://registry.npmjs.org/wordy': { modified: '2026-02-03T04:05:06.000Z' },
      'https://registry.npmjs.org/terse/latest': { license: 'B'.repeat(MAX_LICENCE_CHARS) },
      'https://registry.npmjs.org/terse': { modified: '2026-02-03T04:05:06.000Z' },
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    const wordy = await client.describe({ ecosystem: 'npm', name: 'wordy' });
    expect(wordy.status).toBe('checked');
    expect(wordy.license).toBeNull();
    // Only the licence is lost: the package is still described, so the gate still has something to
    // put in the question.
    expect(wordy.last_published_at).toBe('2026-02-03T04:05:06.000Z');
    // The property, rather than the instance: what this client answers is what the record takes.
    expect(dependencyMetadataSchema.safeParse(wordy).success).toBe(true);

    const terse = await client.describe({ ecosystem: 'npm', name: 'terse' });
    expect(terse.license).toBe('B'.repeat(MAX_LICENCE_CHARS));
    expect(dependencyMetadataSchema.safeParse(terse).success).toBe(true);
  });

  it('answers "unavailable" for an instant the record refuses rather than handing it on', async () => {
    /**
     * The same class one field over, which is why the guard is the schema and not a list of
     * bounds: `modified` is whatever the registry serialised, and
     * `new Date(Date.parse('+275760-09-13T00:00:00Z')).toISOString()` is `'+275760-09-13…'` —
     * an instant `isoDateTimeSchema` refuses (measured 2026-09-14, and asserted below so the
     * premise cannot rot).
     */
    expect(
      dependencyMetadataSchema.safeParse({
        status: 'checked',
        license: null,
        last_published_at: '+275760-09-13T00:00:00.000Z',
        deprecated: null,
        source_url: null,
      }).success,
    ).toBe(false);

    const recorded = recordingFetch({
      'https://registry.npmjs.org/ancient/latest': { license: 'MIT' },
      'https://registry.npmjs.org/ancient': { modified: '+275760-09-13T00:00:00Z' },
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    expect((await client.describe({ ecosystem: 'npm', name: 'ancient' })).status).toBe(
      'unavailable',
    );
  });

  it('matches the host exactly, so a lookalike declaration enables nothing', async () => {
    const recorded = recordingFetch({});
    const client = createDependencyMetadataClient({
      // The shape `renderEgressConfig`'s own pattern tests record: a suffix match would admit this.
      allowedHosts: ['registry.npmjs.org.evil.test', 'evil.test'],
      fetch: recorded.fetch,
    });

    expect((await client.describe({ ecosystem: 'npm', name: 'left-pad' })).status).toBe(
      'not_checked',
    );
    expect(recorded.calls).toEqual([]);
  });

  it('answers "unsupported" for an ecosystem this build knows no registry for', async () => {
    const recorded = recordingFetch({});
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org', 'pypi.org', 'proxy.golang.org', 'crates.io'],
      fetch: recorded.fetch,
    });

    expect((await client.describe({ ecosystem: 'go', name: 'golang.org/x/text' })).status).toBe(
      'unsupported',
    );
    expect((await client.describe({ ecosystem: 'cargo', name: 'serde' })).status).toBe(
      'unsupported',
    );
    expect(recorded.calls).toEqual([]);
  });

  it('never lets a name out of a diff become a path or a host', async () => {
    const recorded = recordingFetch({});
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    for (const name of ['../../etc/passwd', 'lodash?x=1', 'evil.test/lodash', ' ']) {
      expect((await client.describe({ ecosystem: 'npm', name })).status).toBe('not_checked');
    }
    expect(recorded.calls).toEqual([]);
  });

  it('encodes a scoped package rather than refusing it', async () => {
    const recorded = recordingFetch({
      // `encodeURIComponent` escapes the `@`, and the registry serves that form — measured:
      // `GET https://registry.npmjs.org/%40babel/core/latest` answers 200 (2026-09-14).
      'https://registry.npmjs.org/%40scope/pkg/latest': { license: 'MIT' },
      'https://registry.npmjs.org/%40scope/pkg': { modified: '2026-01-02T00:00:00.000Z' },
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    const answer = await client.describe({ ecosystem: 'npm', name: '@scope/pkg' });

    expect(answer.status).toBe('checked');
    expect(answer.license).toBe('MIT');
    expect(recorded.calls[0]?.url).toBe('https://registry.npmjs.org/%40scope/pkg/latest');
  });

  it('answers "unavailable" when the registry refuses, and never throws (Q84)', async () => {
    const recorded = recordingFetch({});
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });

    // Every URL in this table is a 404: the gate has to carry on regardless.
    const answer = await client.describe({ ecosystem: 'npm', name: 'left-pad' });

    expect(answer.status).toBe('unavailable');
    expect(answer.license).toBeNull();
  });

  it('answers "unavailable" rather than reading a body without a bound', async () => {
    const recorded = recordingFetch({
      'https://pypi.org/pypi/huge/json': `{"info":{"license":"${'A'.repeat(MAX_REGISTRY_BYTES + 16)}"}}`,
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['pypi.org'],
      fetch: recorded.fetch,
    });

    expect((await client.describe({ ecosystem: 'pypi', name: 'huge' })).status).toBe('unavailable');
  });

  it('refuses to run inside an open transaction, like every other outbound call (WP-15d)', async () => {
    const recorded = recordingFetch({
      'https://registry.npmjs.org/left-pad/latest': NPM_LATEST,
      'https://registry.npmjs.org/left-pad': NPM_ABBREVIATED,
    });
    const client = createDependencyMetadataClient({
      allowedHosts: ['registry.npmjs.org'],
      fetch: recorded.fetch,
    });
    const unitOfWork = markTransactions(new MemoryEventing());

    await expect(
      unitOfWork.transaction(async () => client.describe({ ecosystem: 'npm', name: 'left-pad' })),
    ).rejects.toBeInstanceOf(TransactionOpenError);
    expect(recorded.calls).toEqual([]);
  });
});
