/**
 * The repository layer — WP-63 criteria 2 and 4.
 *
 * The codec here is JSON, which is valid YAML 1.2 and keeps this ring free of the parser (the YAML
 * codec itself is `packages/infrastructure/src/config/yaml-codec.ts`, tested there). Every branch of
 * {@link interpretRepositoryConfig} is driven with a document that reaches it (standing rule 40),
 * and the refusal is asserted in both directions: the invalid key is named, and a valid file is
 * applied (standing rule 42).
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { TransactionOpenError, withOpenTransaction } from '../events/open-transaction.js';
import {
  type ConfigDocumentCodec,
  describeRepositoryConfigIssues,
  interpretRepositoryConfig,
  MAX_REPOSITORY_CONFIG_DETAIL_CHARS,
  REPOSITORY_CONFIG_PATH,
  type RepositoryConfigSnapshot,
  type RepositoryFileEntry,
  type RepositoryFileSource,
  refreshRepositoryConfig,
  revalidateRepositorySnapshot,
} from './repository-config.js';
import { REPOSITORY_AUTONOMY_NOT_APPLIED } from './repository-grades.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const AT = '2026-09-26T10:00:00.000Z' as IsoDateTime;
const SHA = 'a'.repeat(40);

const jsonCodec: ConfigDocumentCodec = {
  parse: (text) => {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  },
  stringify: (document) => JSON.stringify(document),
};

/** A pattern redactor in miniature: the planted token is what a real rule set would catch. */
const PLANTED = 'glpat-FAKE-wp63-key-name-credential-000';
const redactText = (value: string): string => value.replaceAll(PLANTED, '[REDACTED:pattern]');

const file = (text: string): RepositoryFileEntry => ({
  kind: 'file',
  text,
  blobSha: 'b'.repeat(40),
});

const interpret = (entry: RepositoryFileEntry | undefined): RepositoryConfigSnapshot =>
  interpretRepositoryConfig({ entry, commitSha: SHA, readAt: AT, codec: jsonCodec, redactText });

describe('interpretRepositoryConfig', () => {
  it('reads a missing file as absent, which is a legitimate project', () => {
    expect(interpret(undefined)).toEqual({ status: 'absent', commitSha: SHA, readAt: AT });
    expect(interpret({ kind: 'absent' })).toEqual({ status: 'absent', commitSha: SHA, readAt: AT });
  });

  it('applies a valid file, minus its version', () => {
    const snapshot = interpret(
      file(JSON.stringify({ version: 1, stages: { refinement: { model: 'claude-sonnet-5' } } })),
    );
    expect(snapshot).toEqual({
      status: 'valid',
      commitSha: SHA,
      readAt: AT,
      values: { stages: { refinement: { model: 'claude-sonnet-5' } } },
      notApplied: [],
    });
  });

  it('refuses a file that fails the schema, naming the key path — and the value never', () => {
    const snapshot = interpret(
      file(JSON.stringify({ version: 1, stages: { refinement: { max_turns: 'many' } } })),
    );
    expect(snapshot.status).toBe('invalid');
    const detail = snapshot.status === 'invalid' ? snapshot.detail : '';
    expect(detail).toContain('stages.refinement.max_turns');
    expect(detail).not.toContain('many');
  });

  it('refuses an unknown key rather than dropping it, and redacts the key’s own text', () => {
    // A strict schema puts an unrecognised key into the issue — which is text somebody typed.
    const snapshot = interpret(file(JSON.stringify({ version: 1, project: { [PLANTED]: true } })));
    expect(snapshot.status).toBe('invalid');
    const detail = snapshot.status === 'invalid' ? snapshot.detail : '';
    expect(detail).toContain('project');
    expect(detail).toContain('[REDACTED:pattern]');
    expect(detail).not.toContain(PLANTED);
  });

  it('refuses a file with no version, a wrong major and a non-object document', () => {
    for (const text of ['{"stages": {}}', '{"version": 2}', '[1, 2]', 'null']) {
      const snapshot = interpret(file(text));
      expect(snapshot.status, text).toBe('invalid');
    }
    const noVersion = interpret(file('{"stages": {}}'));
    expect(noVersion.status === 'invalid' && noVersion.detail).toContain('version');
  });

  it('refuses a document that is not YAML at all, at the root', () => {
    const snapshot = interpret(file('{ not: json'));
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.status === 'invalid' && snapshot.detail).toMatch(/^\(root\) \(not YAML/);
  });

  it('refuses a symlink and an oversized blob without reading either', () => {
    const link = interpret({ kind: 'not_a_file', mode: '120000' });
    expect(link.status === 'invalid' && link.detail).toContain('120000');
    const big = interpret({ kind: 'oversized', bytes: 1_000_000 });
    expect(big.status === 'invalid' && big.detail).toContain('1000000 bytes');
  });

  /**
   * The one key a repository may state and not apply — reported, never dropped in silence. Both
   * directions: stated, it is listed and absent from the values; unstated, nothing is listed.
   */
  it('does not apply policies.autonomy, and says so', () => {
    const stated = interpret(
      file(
        JSON.stringify({
          version: 1,
          policies: { autonomy: 'autonomous', protected_paths: ['secrets/**'] },
        }),
      ),
    );
    expect(stated.status).toBe('valid');
    if (stated.status !== 'valid') return;
    expect(stated.values.policies).toEqual({ protected_paths: ['secrets/**'] });
    expect(stated.notApplied).toEqual([
      { key: 'policies.autonomy', reason: REPOSITORY_AUTONOMY_NOT_APPLIED },
    ]);
    const unstated = interpret(
      file(JSON.stringify({ version: 1, policies: { protected_paths: ['secrets/**'] } })),
    );
    expect(unstated.status === 'valid' && unstated.notApplied).toEqual([]);
  });

  /** Review round 2: the API's knowledge-directory rule, applied to the file, by path. */
  it('refuses an absolute or traversing knowledge directory, and accepts a relative one', () => {
    for (const dir of ['/etc', '../outside', 'a/./b']) {
      const snapshot = interpret(
        file(JSON.stringify({ version: 1, project: { knowledge_dir: dir } })),
      );
      expect(snapshot.status, dir).toBe('invalid');
      expect(snapshot.status === 'invalid' && snapshot.detail, dir).toContain(
        'project.knowledge_dir',
      );
    }
    const fine = interpret(
      file(JSON.stringify({ version: 1, project: { knowledge_dir: 'docs/kb' } })),
    );
    expect(fine.status).toBe('valid');
  });

  /** Review round 1: a record keyed `__proto__` is dropped by the schema, so it is refused first. */
  it('refuses a __proto__ key with its path instead of dropping it', () => {
    const snapshot = interpret(
      file('{"version": 1, "status_mapping": {"__proto__": "Done", "done": "Done"}}'),
    );
    expect(snapshot.status).toBe('invalid');
    expect(snapshot.status === 'invalid' && snapshot.detail).toContain('status_mapping.__proto__');
  });

  it('bounds the detail however many issues a file has', () => {
    const stages = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`stage_${index}`, { max_turns: 'x' }]),
    );
    const snapshot = interpret(file(JSON.stringify({ version: 1, stages })));
    expect(snapshot.status).toBe('invalid');
    const detail = snapshot.status === 'invalid' ? snapshot.detail : '';
    expect(detail.length).toBeLessThanOrEqual(MAX_REPOSITORY_CONFIG_DETAIL_CHARS);
    expect(detail).toMatch(/and \d+ more/);
  });
});

describe('describeRepositoryConfigIssues', () => {
  it('quotes a key segment that is not a plain word, so a dot or a newline cannot forge a path', () => {
    const text = describeRepositoryConfigIssues(
      [{ path: ['stages', 'a.b\nstages', 'model'], message: 'bad' }],
      (value) => value,
    );
    expect(text).toBe('stages."a.b\\nstages".model (bad)');
  });
});

const recordingStore = () => {
  const recorded: RepositoryConfigSnapshot[] = [];
  return {
    recorded,
    store: {
      record: async (_projectId: Id, snapshot: RepositoryConfigSnapshot) => {
        recorded.push(snapshot);
      },
      read: async () => recorded.at(-1) ?? null,
    },
  };
};

const sourceOf = (
  result: Awaited<ReturnType<RepositoryFileSource['read']>>,
  seen: unknown[] = [],
): RepositoryFileSource => ({
  read: async (request) => {
    seen.push(request);
    return result;
  },
});

describe('revalidateRepositorySnapshot', () => {
  it('applies this release’s rules to a stored reading: a newly not-applied key, a failing schema', () => {
    const stored: RepositoryConfigSnapshot = {
      status: 'valid',
      commitSha: SHA,
      readAt: AT,
      // Written before review round 1 graded `probation_tasks` not applied.
      values: { policies: { probation_tasks: 0 } },
      notApplied: [],
    };
    const now = revalidateRepositorySnapshot(stored, redactText);
    expect(now?.status === 'valid' && now.values).toEqual({});
    expect(now?.status === 'valid' && now.notApplied.map((item) => item.key)).toEqual([
      'policies.probation_tasks',
    ]);
    const failing = revalidateRepositorySnapshot(
      { ...stored, values: { stages: { refinement: { max_turns: 'x' } } } as never },
      redactText,
    );
    expect(failing?.status).toBe('invalid');
    expect(failing?.status === 'invalid' && failing.detail).toContain(
      'stages.refinement.max_turns',
    );
    expect(revalidateRepositorySnapshot(null, redactText)).toBeNull();
  });
});

describe('refreshRepositoryConfig', () => {
  /** Review round 1: a late, older wake-up must not replace a newer reading (and lose a block). */
  it('keeps the newer reading when the commit read is older than the recorded one', async () => {
    const { recorded, store } = recordingStore();
    const newer: RepositoryConfigSnapshot = {
      status: 'valid',
      commitSha: 'b'.repeat(40),
      readAt: AT,
      values: { commands: { block: ['make deploy*'] } },
      notApplied: [],
    };
    recorded.push(newer);
    const seen: unknown[] = [];
    const options = (behindRecorded: boolean) => ({
      source: sourceOf(
        {
          status: 'ok' as const,
          commitSha: SHA,
          files: { [REPOSITORY_CONFIG_PATH]: file('{"version": 1}'), 'CLAUDE.md': undefined },
          behindRecorded,
        },
        seen,
      ),
      codec: jsonCodec,
      store,
      redactText,
      clock: { now: () => AT },
    });
    const stale = await refreshRepositoryConfig(options(true), {
      projectId: PROJECT,
      commitSha: SHA,
    });
    expect(stale).toEqual({ status: 'stale', snapshot: newer });
    expect(recorded).toEqual([newer]);
    expect(seen[0]).toMatchObject({ recordedCommit: 'b'.repeat(40) });
    // …and a commit that is not older (a newer one, or a rewritten branch) is recorded.
    const fresh = await refreshRepositoryConfig(options(false), { projectId: PROJECT });
    expect(fresh.status).toBe('recorded');
    expect(recorded).toHaveLength(2);
  });

  it('records what the default branch says, pinned to the commit it was asked for', async () => {
    const { recorded, store } = recordingStore();
    const seen: unknown[] = [];
    const outcome = await refreshRepositoryConfig(
      {
        source: sourceOf(
          {
            status: 'ok',
            commitSha: SHA,
            files: { [REPOSITORY_CONFIG_PATH]: file('{"version": 1}'), 'CLAUDE.md': undefined },
          },
          seen,
        ),
        codec: jsonCodec,
        store,
        redactText,
        clock: { now: () => AT },
      },
      { projectId: PROJECT, commitSha: SHA },
    );
    expect(outcome.status).toBe('recorded');
    expect(recorded).toEqual([
      { status: 'valid', commitSha: SHA, readAt: AT, values: {}, notApplied: [] },
    ]);
    // Only the configuration path is asked for: the pointer file is the export's business. The
    // prompt directory is asked for in the same pass (WP-92), so both describe one commit.
    expect(seen).toEqual([
      {
        projectId: PROJECT,
        paths: [REPOSITORY_CONFIG_PATH],
        promptDirectory: true,
        commitSha: SHA,
      },
    ]);
  });

  it('records the prompt directory beside the configuration, every text redacted and none cut (WP-92)', async () => {
    const { recorded, store } = recordingStore();
    const long = `${'x'.repeat(12_000)} ${PLANTED}`;
    const outcome = await refreshRepositoryConfig(
      {
        source: sourceOf({
          status: 'ok',
          commitSha: SHA,
          files: { [REPOSITORY_CONFIG_PATH]: { kind: 'absent' } },
          prompts: {
            files: {
              '.agentic/prompts/implementation.md': file(`Use pnpm. ${PLANTED}`),
              '.agentic/prompts/refinement.md': file(long),
              '.agentic/prompts/huge.md': { kind: 'oversized', bytes: 20_000 },
              '.agentic/prompts/link.md': { kind: 'not_a_file', mode: '120000' },
            },
            truncated: false,
          },
        }),
        codec: jsonCodec,
        store,
        redactText,
        clock: { now: () => AT },
      },
      { projectId: PROJECT },
    );
    expect(outcome.status).toBe('recorded');
    const stored = recorded[0];
    // An absent configuration file still records the prompt directory: the convention files need
    // no configuration to be read.
    expect(stored?.status).toBe('absent');
    expect(stored?.prompts).toEqual({
      files: {
        '.agentic/prompts/implementation.md': file('Use pnpm. [REDACTED:pattern]'),
        '.agentic/prompts/refinement.md': file(`${'x'.repeat(12_000)} [REDACTED:pattern]`),
        '.agentic/prompts/huge.md': { kind: 'oversized', bytes: 20_000 },
        '.agentic/prompts/link.md': { kind: 'not_a_file', mode: '120000' },
      },
      truncated: false,
    });
    expect(JSON.stringify(stored)).not.toContain(PLANTED);
  });

  it('keeps a stored prompt directory through re-validation, dropping a path the reader would not list', () => {
    const snapshot: RepositoryConfigSnapshot = {
      status: 'valid',
      commitSha: SHA,
      readAt: AT,
      values: {},
      notApplied: [],
      prompts: {
        files: {
          '.agentic/prompts/implementation.md': file('ok'),
          '.agentic/prompts/sub/nested.md': file('never listed'),
          'src/elsewhere.md': file('never listed'),
        },
        truncated: false,
      },
    };
    expect(revalidateRepositorySnapshot(snapshot, redactText)?.prompts).toEqual({
      files: { '.agentic/prompts/implementation.md': file('ok') },
      truncated: false,
    });
    // A reading that did not read the directory stays one that did not.
    const { prompts: _dropped, ...unread } = snapshot;
    expect(revalidateRepositorySnapshot(unread, redactText)?.prompts).toBeUndefined();
  });

  it('records nothing when the repository cannot be read — the previous reading stands', async () => {
    const { recorded, store } = recordingStore();
    const outcome = await refreshRepositoryConfig(
      {
        source: sourceOf({ status: 'unavailable', reason: 'the mirror could not be refreshed' }),
        codec: jsonCodec,
        store,
        redactText,
        clock: { now: () => AT },
      },
      { projectId: PROJECT },
    );
    expect(outcome).toEqual({ status: 'unavailable', reason: 'the mirror could not be refreshed' });
    expect(recorded).toEqual([]);
  });

  it('refuses to run inside a transaction: it spawns git and may fetch', async () => {
    const { store } = recordingStore();
    await expect(
      withOpenTransaction(() =>
        refreshRepositoryConfig(
          {
            source: sourceOf({ status: 'unavailable', reason: 'x' }),
            codec: jsonCodec,
            store,
            redactText,
            clock: { now: () => AT },
          },
          { projectId: PROJECT },
        ),
      ),
    ).rejects.toBeInstanceOf(TransactionOpenError);
  });
});
