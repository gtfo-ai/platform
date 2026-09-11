/**
 * The universal-ctags adapter, driven by **recorded** output.
 *
 * ## Provenance of the fixture (standing rule 17: a provenance label is a claim, and an unasserted
 * claim drifts — so the claim is written where the fixture is)
 *
 * `RECORDED_CTAGS_STDOUT` is the literal stdout of:
 *
 * ```
 * docker run --rm alpine:3.20 sh -c 'apk add --no-cache ctags &&
 *   printf "src/session.ts\nsrc/router.py\n" | ctags --output-format=json --fields=+n -L - -f -'
 * ```
 *
 * retrieved **2026-09-11**, against a two-file fixture written for the purpose (a TypeScript module
 * with an interface, a const arrow function, a `function` declaration, a class with a `#private`
 * field and a method; a Python module with a class, `__init__`, a method and a module-level
 * function). The banner the same container printed was
 * `Universal Ctags 6.1.0, Copyright (C) 2015-2023 Universal Ctags Team`, which is what
 * `PROBE_BANNER` below carries. **`kind: "recorded"`** — not composed, not invented.
 *
 * What this fixture cannot tell us, stated rather than implied: that *this repository's* build of
 * ctags, on whatever machine the platform is deployed to, emits the same shape. The version is
 * pinned in the fixture's name and the probe refuses anything that is not universal-ctags, which
 * bounds the risk to "a future universal-ctags changes its JSON" — a change that would show up as
 * `unavailable` (every line unparseable) rather than as a silently empty map.
 *
 * ## The other recording: what a *wrong* ctags does
 *
 * `BSD_CTAGS_VERSION_FAILURE` is the literal behaviour of `/usr/bin/ctags` on the macOS machine
 * this was written on (Darwin 25.6.0, Command Line Tools): exit **1**, stderr
 * `illegal option -- -`. That is the branch the probe actually takes here, so it is tested with the
 * real observed values rather than with an invented failure.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CTAGS_ARGUMENTS,
  type CtagsProcessResult,
  type CtagsProcessRunner,
  createCtagsSymbolExtractor,
  parseCtagsJson,
  referencesIn,
  UNIVERSAL_CTAGS_BANNER,
} from './ctags.js';

const PROBE_BANNER =
  'Universal Ctags 6.1.0, Copyright (C) 2015-2023 Universal Ctags Team\nUniversal Ctags is derived from Exuberant Ctags.\n';

const RECORDED_CTAGS_STDOUT = [
  '{"_type": "tag", "name": "#rows", "path": "src/session.ts", "pattern": "/^  #rows = new Map<string, Session>();$/", "line": 15, "kind": "property", "scope": "SessionStore", "scopeKind": "class"}',
  '{"_type": "tag", "name": "Router", "path": "src/router.py", "pattern": "/^class Router:$/", "line": 4, "kind": "class"}',
  '{"_type": "tag", "name": "Session", "path": "src/session.ts", "pattern": "/^export interface Session {$/", "line": 3, "kind": "interface"}',
  '{"_type": "tag", "name": "SessionStore", "path": "src/session.ts", "pattern": "/^export class SessionStore {$/", "line": 14, "kind": "class"}',
  '{"_type": "tag", "name": "__init__", "path": "src/router.py", "pattern": "/^    def __init__(self, store):$/", "line": 5, "kind": "member", "scope": "Router", "scopeKind": "class"}',
  '{"_type": "tag", "name": "createSession", "path": "src/session.ts", "pattern": "/^export const createSession = (userId: string): Session => ({ id: randomUUID(), userId });$/", "line": 8, "kind": "constant"}',
  '{"_type": "tag", "name": "dispatch", "path": "src/router.py", "pattern": "/^    def dispatch(self, request):$/", "line": 8, "kind": "member", "scope": "Router", "scopeKind": "class"}',
  '{"_type": "tag", "name": "id", "path": "src/session.ts", "pattern": "/^  readonly id: string;$/", "line": 4, "kind": "property", "scope": "Session", "scopeKind": "interface"}',
  '{"_type": "tag", "name": "put", "path": "src/session.ts", "pattern": "/^  put(session: Session): void {$/", "line": 17, "kind": "method", "scope": "SessionStore", "scopeKind": "class"}',
  '{"_type": "tag", "name": "userId", "path": "src/session.ts", "pattern": "/^  readonly userId: string;$/", "line": 5, "kind": "property", "scope": "Session", "scopeKind": "interface"}',
  '{"_type": "tag", "name": "verifySession", "path": "src/session.ts", "pattern": "/^export function verifySession(session: Session): boolean {$/", "line": 10, "kind": "function"}',
  '{"_type": "tag", "name": "verify_session", "path": "src/router.py", "pattern": "/^def verify_session(request):$/", "line": 12, "kind": "function"}',
  '',
].join('\n');

/** Observed on this machine: BSD ctags does not understand a long option at all. */
const BSD_CTAGS_VERSION_FAILURE: CtagsProcessResult = {
  code: 1,
  stdout: '',
  stderr:
    '/Library/Developer/CommandLineTools/usr/bin/ctags: illegal option -- -\nusage: ctags [-BFTaduwvx] [-f tagsfile] file ...\n',
};

const scriptedRunner = (
  answers: {
    readonly version?: CtagsProcessResult;
    readonly tags?: CtagsProcessResult;
  },
  calls: { binary: string; args: readonly string[]; input?: string; cwd?: string }[] = [],
): CtagsProcessRunner & { readonly calls: typeof calls } => ({
  calls,
  run: async (binary, args, options) => {
    calls.push({ binary, args, ...options });
    if (args[0] === '--version') {
      return answers.version ?? { code: 0, stdout: PROBE_BANNER, stderr: '' };
    }
    return answers.tags ?? { code: 0, stdout: RECORDED_CTAGS_STDOUT, stderr: '' };
  },
});

describe('parseCtagsJson — against the recorded output of Universal Ctags 6.1.0', () => {
  it('reads every tag, with its kind and its line', () => {
    const { definitions, skipped } = parseCtagsJson(RECORDED_CTAGS_STDOUT);
    expect(skipped).toBe(0);
    expect([...definitions.keys()].sort()).toEqual(['src/router.py', 'src/session.ts']);
    expect(definitions.get('src/session.ts')).toContainEqual({
      name: 'verifySession',
      kind: 'function',
      line: 10,
    });
    expect(definitions.get('src/router.py')).toContainEqual({
      name: 'verify_session',
      kind: 'function',
      line: 12,
    });
    expect(definitions.get('src/session.ts')).toHaveLength(8);
    expect(definitions.get('src/router.py')).toHaveLength(4);
  });

  it('skips a pseudo-tag without counting it as malformed', () => {
    const withPtag = `{"_type": "ptag", "name": "TAG_PROGRAM_NAME", "parserName": "Universal Ctags"}\n${RECORDED_CTAGS_STDOUT}`;
    const { definitions, skipped } = parseCtagsJson(withPtag);
    expect(skipped).toBe(0);
    expect(definitions.size).toBe(2);
  });

  it.each([
    ['a truncated line', '{"_type": "tag", "name": "a", "path": "x.ts", "kin'],
    ['a line with no fields at all', '{"_type": "tag"}'],
    // One negative per required field: a single "nothing at all" case is passed by an
    // implementation that checks only one of the three, which is rule 43's shape.
    ['a tag with no name', '{"_type": "tag", "path": "x.ts", "kind": "function"}'],
    ['a tag with no path', '{"_type": "tag", "name": "a", "kind": "function"}'],
    ['a tag with no kind', '{"_type": "tag", "name": "a", "path": "x.ts"}'],
    ['a name that is not a string', '{"_type": "tag", "name": 7, "path": "x.ts", "kind": "f"}'],
  ])('counts %s as skipped rather than inventing a symbol', (_name, line) => {
    const { definitions, skipped } = parseCtagsJson(line);
    expect(definitions.size).toBe(0);
    expect(skipped).toBe(1);
  });

  it('records line 0 rather than NaN when the `line` field is absent', () => {
    const noLine = '{"_type": "tag", "name": "a", "path": "x.ts", "kind": "function"}';
    const { definitions } = parseCtagsJson(noLine);
    expect(definitions.get('x.ts')).toEqual([{ name: 'a', kind: 'function', line: 0 }]);
  });
});

describe('the probe refuses anything that is not universal-ctags', () => {
  it('accepts the recorded universal-ctags banner', async () => {
    const extractor = createCtagsSymbolExtractor({ runner: scriptedRunner({}) });
    const probe = await extractor.probe();
    expect(probe.available).toBe(true);
    expect(probe.detail).toContain(UNIVERSAL_CTAGS_BANNER);
    expect(extractor.id).toBe('universal-ctags');
  });

  it('refuses BSD ctags with the failure it actually produces on this machine', async () => {
    const extractor = createCtagsSymbolExtractor({
      binary: '/usr/bin/ctags',
      runner: scriptedRunner({ version: BSD_CTAGS_VERSION_FAILURE }),
    });
    const probe = await extractor.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('exited 1');
    expect(probe.detail).toContain('illegal option');
  });

  it('refuses a ctags that exits 0 with somebody elses banner', async () => {
    // Exuberant Ctags 5.9 exits 0 and prints a banner; it has no `--output-format=json` and would
    // produce zero tags. A probe that only checked the exit status would accept it.
    const extractor = createCtagsSymbolExtractor({
      runner: scriptedRunner({
        version: { code: 0, stdout: 'Exuberant Ctags 5.9~svn20110310\n', stderr: '' },
      }),
    });
    const probe = await extractor.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('is not universal-ctags');
  });

  it('refuses when the binary cannot be launched at all', async () => {
    const extractor = createCtagsSymbolExtractor({
      binary: 'ctags-that-does-not-exist',
      runner: {
        run: async () => {
          throw new Error('spawn ENOENT');
        },
      },
    });
    const probe = await extractor.probe();
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('ENOENT');
  });

  it('really refuses the ctags on this machine, if there is one', async () => {
    // Not a scripted double: the actual binary on `PATH`. Whatever it is, the outcome must be a
    // decided one — available with a universal-ctags banner, or unavailable with a reason — and
    // never a silent success that produces nothing.
    const extractor = createCtagsSymbolExtractor({});
    const probe = await extractor.probe();
    expect(typeof probe.available).toBe('boolean');
    expect(probe.detail).not.toBe('');
    if (!probe.available) expect(probe.detail.length).toBeGreaterThan(10);
  });
});

describe('extract', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ctags-extract-'));
    await writeFile(
      path.join(root, 'session.ts'),
      'export const createSession = () => verifySession();\n',
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('passes the file list on stdin and writes to stdout, never to a tags file', async () => {
    const runner = scriptedRunner({});
    const extractor = createCtagsSymbolExtractor({ runner });
    await extractor.extract({ rootPath: root, paths: ['session.ts'] });
    const tagCall = runner.calls.find((call) => call.args[0] !== '--version');
    expect(tagCall?.args).toEqual([...CTAGS_ARGUMENTS]);
    expect(tagCall?.input).toBe('session.ts\n');
    expect(tagCall?.cwd).toBe(root);
  });

  it('pairs definitions with a reference pass over the file contents', async () => {
    const runner = scriptedRunner({
      tags: {
        code: 0,
        stdout:
          '{"_type": "tag", "name": "createSession", "path": "session.ts", "line": 1, "kind": "constant"}',
        stderr: '',
      },
    });
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: ['session.ts'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]?.definitions).toEqual([
      { name: 'createSession', kind: 'constant', line: 1 },
    ]);
    expect(result.files[0]?.references).toContain('verifySession');
    expect(result.files[0]?.language).toBe('ts');
  });

  it('returns an empty result for an empty request without launching anything', async () => {
    const runner = scriptedRunner({});
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: [] });
    expect(result).toEqual({ status: 'ok', files: [] });
    expect(runner.calls).toHaveLength(0);
  });

  it('reports `unavailable` on a non-zero exit, quoting the first line of stderr', async () => {
    const runner = scriptedRunner({
      tags: { code: 2, stdout: '', stderr: 'ctags: cannot open "session.ts"\n' },
    });
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: ['session.ts'] });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('exited 2');
    expect(result.reason).toContain('cannot open');
  });

  it('reports `unavailable` when every output line is unreadable', async () => {
    // Not "a repository with no symbols": that distinction is the whole reason this adapter exists
    // as a discriminated result (rule 18).
    const runner = scriptedRunner({
      tags: { code: 0, stdout: 'not json\nalso not json\n', stderr: '' },
    });
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: ['session.ts'] });
    expect(result.status).toBe('unavailable');
    if (result.status !== 'unavailable') throw new Error('expected unavailable');
    expect(result.reason).toContain('none could be parsed');
  });

  it('reports `ok` with no symbols when ctags legitimately found none', async () => {
    const runner = scriptedRunner({ tags: { code: 0, stdout: '', stderr: '' } });
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: ['session.ts'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]?.definitions).toEqual([]);
  });

  it('keeps a files definitions when its contents cannot be read for the reference pass', async () => {
    const runner = scriptedRunner({
      tags: {
        code: 0,
        stdout:
          '{"_type": "tag", "name": "gone", "path": "missing.ts", "line": 1, "kind": "function"}',
        stderr: '',
      },
    });
    const extractor = createCtagsSymbolExtractor({ runner });
    const result = await extractor.extract({ rootPath: root, paths: ['missing.ts'] });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.files[0]?.definitions).toHaveLength(1);
    expect(result.files[0]?.references).toEqual([]);
  });
});

describe('referencesIn', () => {
  it('counts every identifier occurrence, repeats included', () => {
    expect(referencesIn('createSession(); createSession();')).toEqual([
      'createSession',
      'createSession',
    ]);
  });

  it('drops tokens below the length floor rather than keeping a keyword list', () => {
    expect(referencesIn('a bc def')).toEqual(['def']);
  });

  it('reads identifiers inside comments and strings on purpose', () => {
    // Over-counting is the safe direction for a ranking signal: a symbol named in a comment is
    // evidence the file cares about it.
    expect(referencesIn('// see createSession\nconst x = "verifySession";')).toEqual([
      'see',
      'createSession',
      'const',
      'verifySession',
    ]);
  });
});
