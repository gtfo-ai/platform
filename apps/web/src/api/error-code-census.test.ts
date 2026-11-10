/**
 * **Every error code the server raises has a sentence, with its next step** (S-25.18, the owner's
 * rule: the person always understands what went wrong, why, and what is required of them).
 *
 * `errorSentence` (`api/read-error.ts`) builds the visible sentence from `error.code`, out of the
 * table in `api/error-sentences.ts`. A code its
 * table did not hold used to fall back to a per-status sentence, so ten typed 409s read *"This is
 * not possible in the state it is in now. Reload to see where it stands"* — reload fixed none of
 * them — and the reason sat behind the collapsed *Technical details*. This census is the comparison
 * that keeps the table whole, the way `apps/server/src/routes/client-census.test.ts` keeps the
 * routes: the server's half read off its sources, the client's half the table itself, equal in
 * **both** directions — a code with no sentence fails, and so does a sentence for a code nothing
 * raises any more.
 *
 * ## What it reads
 *
 * Every `.ts` under `apps/server/src` that git knows about (tracked or untracked,
 * `scripts/census-files.mjs`), tests excluded, comments removed by `scripts/source-scanner.mjs`. In
 * it, a code is
 * - the code argument of `new HttpError(status, code, …)`, `new BadRequestError(code, …)` and an
 *   error class's `super(status, code, …)`, read by splitting the call's arguments at their
 *   top-level commas (strings, templates and brackets skipped);
 * - a body written by hand, `error: { code: '…' }`;
 * - a refusal table's row, `{ status: 409, code: '…' }` (`routes/task-start.ts`).
 *
 * A code argument that is **not** a string literal is a *derived* site, and every one is listed in
 * {@link DERIVED} with the codes it can carry and the file that spells them — each code is looked
 * for as a literal there, and the list of derived sites is compared with the sites found in both
 * directions, so a new `new HttpError(409, result.code, …)` fails until somebody says what it sends.
 *
 * ## What it cannot see, stated
 *
 * - `apps/server/src/remote-worker/**`: the remote worker's own process and its local page
 *   (`LocalUiError`), which this table does not serve — that page has its own words.
 * - A framework's own 4xx, which `toApiError` turns into a snake-case code at run time
 *   (`fst_err_…`): not enumerable from the sources, so it is said by its status.
 * - A code built anywhere but these spellings (a variable passed to a helper that constructs the
 *   error, a code in a reply sent with `reply.send` outside `error: { code }`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import { CODE_SENTENCE } from './error-sentences.js';
import { ApiError } from './http.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The remote worker's protocol: answered to a worker process, never to a screen of the SPA. */
const WORKER_PROTOCOL =
  'answered to a remote worker process over the worker protocol (`routes/worker/*`, `routes/worker-device.ts`), which no screen of the SPA calls';

/** Codes the server raises that no screen shows, each with why. */
export const EXEMPT: Readonly<Record<string, string>> = {
  compose_template_unavailable: WORKER_PROTOCOL,
  digests_unresolved: WORKER_PROTOCOL,
  install_script_unavailable: `${WORKER_PROTOCOL}; the install script is fetched by a shell (\`curl … | sh\`)`,
  lease_lost: WORKER_PROTOCOL,
  pause_too_long: WORKER_PROTOCOL,
  run_gone: WORKER_PROTOCOL,
  run_live: WORKER_PROTOCOL,
  run_not_startable: WORKER_PROTOCOL,
  run_started: WORKER_PROTOCOL,
  seq_out_of_range: WORKER_PROTOCOL,
  session_mirror_full: WORKER_PROTOCOL,
  tool_call_in_flight: WORKER_PROTOCOL,
  tool_not_granted: WORKER_PROTOCOL,
  tool_use_id_reused: WORKER_PROTOCOL,
  transcript_full: WORKER_PROTOCOL,
  worker_protocol_unavailable: WORKER_PROTOCOL,
  upgrade_required: WORKER_PROTOCOL,
  offer_not_claimable: WORKER_PROTOCOL,
  task_taken_by_another: WORKER_PROTOCOL,
  task_owned_by_another: WORKER_PROTOCOL,
  device_code_limit: `${WORKER_PROTOCOL}: the machine starting its device login`,
  device_code_unavailable: `${WORKER_PROTOCOL}: the machine starting its device login`,
};

/** Codes the client itself raises (`api/http.ts`), which have a sentence and no server source. */
const CLIENT_CODES = ['invalid_response', 'platform_updated'] as const;

interface Derived {
  /** The server file the derived code argument is in. */
  readonly site: string;
  /** The argument as written, whitespace collapsed. */
  readonly expression: string;
  /** The codes it can carry. */
  readonly codes: readonly string[];
  /** Where each code (less `prefix`) is spelled as a string literal; `null` for a pass-through. */
  readonly source: string | null;
  readonly prefix?: string;
}

/** Every code argument that is not a string literal, with what it can carry. */
const DERIVED: readonly Derived[] = [
  // `BadRequestError` forwards its caller's code; every caller is read where it constructs one.
  { site: 'apps/server/src/errors.ts', expression: 'code', codes: [], source: null },
  {
    site: 'apps/server/src/errors.ts',
    expression: 'error.code',
    codes: [
      'approval_subject_mismatch',
      'approval_subject_superseded',
      'approval_subject_unrecorded',
    ],
    source: 'packages/application/src/pipeline/commands.ts',
  },
  {
    site: 'apps/server/src/errors.ts',
    expression: 'error.reason',
    codes: ['owner_change_not_permitted', 'owner_not_project_member', 'task_finished'],
    source: 'packages/domain/src/tasks/owner.ts',
  },
  {
    site: 'apps/server/src/queries/onboarding-queries.ts',
    expression: 'refusal.code',
    codes: ['invalid_integration_config'],
    source: 'apps/server/src/queries/integration-queries.ts',
  },
  {
    site: 'apps/server/src/routes/onboarding.ts',
    expression: 'refusal.code',
    codes: ['invalid_integration_config'],
    source: 'apps/server/src/queries/integration-queries.ts',
  },
  {
    site: 'apps/server/src/routes/bootstrap.ts',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
    expression: '`bootstrap_${result.blocker}`',
    prefix: 'bootstrap_',
    codes: [
      'bootstrap_feature_disabled',
      'bootstrap_no_git_binding',
      'bootstrap_already_running',
      'bootstrap_merge_requests_out_of_range',
    ],
    source: 'packages/application/src/bootstrap/batch.ts',
  },
  {
    site: 'apps/server/src/routes/shadow.ts',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
    expression: '`shadow_${result.blocker}`',
    prefix: 'shadow_',
    codes: ['shadow_feature_disabled', 'shadow_shadow_not_allowed', 'shadow_no_templates'],
    source: 'packages/application/src/shadow/batch.ts',
  },
  {
    site: 'apps/server/src/routes/rediscovery.ts',
    expression: 'result.code',
    // `discovery_in_flight` is the gate's read, never a refusal: the command answers it as 200.
    codes: ['discovery_unavailable', 'discovery_not_started', 'rediscovery_attempts_spent'],
    source: 'packages/application/src/onboarding/rediscovery.ts',
  },
  {
    site: 'apps/server/src/routes/task-start.ts',
    expression: 'answer.code',
    codes: [
      'no_task_management_binding',
      'project_does_not_pick_up_tickets',
      'ticket_has_task',
      'ticket_not_found',
      'ticket_outside_binding_scope',
      'ticket_status_not_startable',
      'ticket_unreadable',
    ],
    source: 'apps/server/src/routes/task-start.ts',
  },
  {
    site: 'apps/server/src/routes/worker/pick-verbs.ts',
    expression: 'refusal',
    codes: ['task_taken_by_another', 'task_owned_by_another'],
    source: 'apps/server/src/routes/worker/pick-verbs.ts',
  },
];

// ── The reader ───────────────────────────────────────────────────────────────

/**
 * The arguments of the call whose `(` is at `open`, split at their top-level commas and trimmed.
 * Strings, template literals (with `${…}` nested to any depth) and brackets are skipped over.
 */
export const callArguments = (code: string, open: number): string[] => {
  const args: string[] = [];
  /** `(`/`[`/`{` openers, and `` ` `` for a template whose `${` is open. */
  const stack: string[] = [];
  let start = open + 1;
  let index = open + 1;
  const readString = (quote: string): void => {
    index += 1;
    while (index < code.length && code[index] !== quote) {
      index += code[index] === '\\' ? 2 : 1;
    }
  };
  /** Reads a template from just after its opening backtick; stops at `${` (pushed) or the end. */
  const readTemplate = (): void => {
    while (index < code.length) {
      const char = code[index];
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        return;
      } else if (char === '$' && code[index + 1] === '{') {
        stack.push('`');
        index += 1;
        return;
      } else {
        index += 1;
      }
    }
  };
  while (index < code.length) {
    const char = code[index] as string;
    if (char === "'" || char === '"') {
      readString(char);
    } else if (char === '`') {
      index += 1;
      readTemplate();
    } else if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
    } else if (char === '}' && stack.at(-1) === '`') {
      stack.pop();
      index += 1;
      readTemplate();
    } else if (char === ')' || char === ']' || char === '}') {
      if (stack.length === 0) {
        const last = code.slice(start, index).trim();
        if (last !== '') {
          args.push(last);
        }
        return args;
      }
      stack.pop();
    } else if (char === ',' && stack.length === 0) {
      args.push(code.slice(start, index).trim());
      start = index + 1;
    }
    index += 1;
  }
  return args;
};

const LITERAL_CODE = /^'([a-z][a-z0-9_]*)'$/;
const CALL = /\bnew\s+(HttpError|BadRequestError)\s*\(|\bsuper\s*\(/g;
const BODY_CODE = /\berror:\s*\{\s*code:\s*'([a-z][a-z0-9_]*)'/g;
const TABLE_CODE = /\{\s*status:\s*\d+\s*,\s*code:\s*'([a-z][a-z0-9_]*)'\s*\}/g;

export interface CodeSites {
  readonly literal: ReadonlySet<string>;
  /** `expression` for every code argument that is not a string literal. */
  readonly derived: readonly string[];
}

/** The codes one source raises, and the expressions of the code arguments it does not spell. */
export const codesIn = (source: string): CodeSites => {
  const code = withoutComments(source);
  const literal = new Set<string>();
  const derived: string[] = [];
  for (const match of code.matchAll(CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = callArguments(code, open);
    const which = match[1] ?? 'super';
    const argument =
      which === 'BadRequestError'
        ? args[0]
        : which === 'HttpError'
          ? args[1]
          : /^\d+$/.test(args[0] ?? '')
            ? args[1]
            : undefined;
    if (argument === undefined) {
      continue;
    }
    const found = LITERAL_CODE.exec(argument);
    if (found?.[1] === undefined) {
      derived.push(argument.replaceAll(/\s+/g, ' '));
    } else {
      literal.add(found[1]);
    }
  }
  for (const pattern of [BODY_CODE, TABLE_CODE]) {
    for (const match of code.matchAll(pattern)) {
      if (match[1] !== undefined) {
        literal.add(match[1]);
      }
    }
  }
  return { literal, derived };
};

// ── The reader, calibrated ───────────────────────────────────────────────────

describe('the error-code reader', () => {
  it.each([
    ["new HttpError(409, 'a_code', 'message')", ['a_code']],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
      "new HttpError(\n  409,\n  'a_code',\n  `x ${y.join(', ')} z`,\n  [{ path: 'p', message: 'm' }],\n)",
      ['a_code'],
    ],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
    ["throw new BadRequestError('bad_one', `a ${b(`c ${d}, e`)}, f`);", ['bad_one']],
    [
      "class X extends HttpError { constructor() { super(409, 'from_super', 'm'); } }",
      ['from_super'],
    ],
    ["reply.code(400).send({ error: { code: 'by_hand', message: 'm' } })", ['by_hand']],
    ["const T = { a: { status: 409, code: 'in_table' } };", ['in_table']],
  ])('reads the code of %s', (source, codes) => {
    expect([...codesIn(source).literal]).toEqual(codes);
    expect(codesIn(source).derived).toEqual([]);
  });

  it('reports a code argument it cannot spell as derived, and ignores comments and messages', () => {
    const sites = codesIn(
      [
        "// new HttpError(409, 'in_a_comment', 'm')",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
        'throw new HttpError(409, `prefix_${result.blocker}`, result.detail);',
        "throw new HttpError(status, error.reason, 'a message, with commas');",
        "class E extends Error { constructor() { super('not a code'); } }",
      ].join('\n'),
    );
    expect([...sites.literal]).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text read as data, not a template
    expect(sites.derived).toEqual(['`prefix_${result.blocker}`', 'error.reason']);
  });
});

// ── The census ───────────────────────────────────────────────────────────────

const SERVER_FILES = censusFiles(REPO_ROOT, {
  pathspecs: ['apps/server/src'],
  include: (path: string) =>
    path.endsWith('.ts') &&
    !path.endsWith('.test.ts') &&
    !path.startsWith('apps/server/src/remote-worker/'),
});

const serverSites = SERVER_FILES.map((file) => ({ path: file.path, ...codesIn(file.contents) }));
const literalCodes = new Set(serverSites.flatMap((file) => [...file.literal]));
const derivedCodes = new Set(DERIVED.flatMap((entry) => entry.codes));
const serverCodes = new Set([...literalCodes, ...derivedCodes]);

describe('every code the server raises has a sentence (S-25.18)', () => {
  it('has the server’s sources to read', () => {
    expect(SERVER_FILES.length).toBeGreaterThan(50);
    expect(literalCodes.has('integration_bound')).toBe(true);
    expect(literalCodes.has('illegal_transition')).toBe(true);
    expect(literalCodes.has('cross_site_request')).toBe(true);
    expect(literalCodes.has('ticket_has_task')).toBe(true);
  });

  it('lists every derived code argument, and nothing it no longer finds', () => {
    const found = serverSites
      .flatMap((file) => file.derived.map((expression) => `${file.path} ${expression}`))
      .sort();
    const declared = DERIVED.map((entry) => `${entry.site} ${entry.expression}`).sort();
    expect(found).toEqual(declared);
  });

  it('finds each derived code spelled where its site says it is', () => {
    const missing = DERIVED.flatMap((entry) => {
      if (entry.source === null) {
        return [];
      }
      const text = readFileSync(join(REPO_ROOT, entry.source), 'utf8');
      return entry.codes
        .filter((code) => !text.includes(`'${code.slice(entry.prefix?.length ?? 0)}'`))
        .map((code) => `${entry.source}: ${code}`);
    });
    expect(missing).toEqual([]);
  });

  it('has a sentence for every code the server raises that is not exempt', () => {
    const unsaid = [...serverCodes]
      .filter((code) => !Object.hasOwn(CODE_SENTENCE, code) && !Object.hasOwn(EXEMPT, code))
      .sort();
    expect(unsaid).toEqual([]);
  });

  it('has no sentence for a code nothing raises any more', () => {
    const client = new Set<string>(CLIENT_CODES);
    const stale = Object.keys(CODE_SENTENCE)
      .filter((code) => !serverCodes.has(code) && !client.has(code))
      .sort();
    expect(stale).toEqual([]);
  });

  it('exempts only codes the server raises, and none that also has a sentence', () => {
    expect(Object.keys(EXEMPT).filter((code) => !serverCodes.has(code))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((code) => Object.hasOwn(CODE_SENTENCE, code))).toEqual([]);
  });

  it('finds the client’s own codes in the client', () => {
    const http = readFileSync(join(REPO_ROOT, 'apps/web/src/api/http.ts'), 'utf8');
    expect(CLIENT_CODES.filter((code) => !http.includes(`'${code}'`))).toEqual([]);
  });

  it('says each one as a whole sentence that never offers a reload as the only fix', () => {
    const bare = new ApiError(409, 'x', 'diagnostic');
    const faulty = Object.entries(CODE_SENTENCE)
      .map(([code, said]) => [code, typeof said === 'string' ? said : said(bare)] as const)
      .filter(
        ([, sentence]) =>
          !/^[A-Z].*\.$/s.test(sentence) || /Reload to see where it stands/.test(sentence),
      )
      .map(([code]) => code);
    expect(faulty).toEqual([]);
  });
});
