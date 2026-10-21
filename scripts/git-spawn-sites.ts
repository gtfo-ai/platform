/**
 * Where a test spawns `git`, or a script that runs it, and whether the call takes the environment of
 * `scripts/git-scratch-env.mjs` (WP-162, PROGRESS backlog 499) — read by the census
 * (`git-scratch-env-census.test.ts`) and by the reproduction that picks the suites it runs
 * (`git-fixture-isolation.test.ts`). The census's docblock states the rules and what they cannot see.
 */
import { censusFiles } from './census-files.mjs';
import { withoutComments } from './source-scanner.mjs';

/** The scripts the tests spawn that run `git` themselves (backlog 499's list). */
export const GIT_RUNNING_SCRIPTS =
  /\b(?:census-files|version|changelog|check-[\w-]+|gitleaks)\.mjs\b/;

/** The child-process functions, and a name the file binds to `promisify` of one (`run`). */
const BASE_CALLEES = [
  'execFileSync',
  'execFileAsync',
  'execFile',
  'spawnSync',
  'spawn',
  'execSync',
  'exec',
];

const callees = (source: string): RegExp => {
  const aliases = [
    ...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*promisify\s*\(\s*(?:execFile|exec)\s*\)/g),
  ].map((match) => match[1] as string);
  const names = [...new Set([...BASE_CALLEES, ...aliases])].join('|');
  return new RegExp(`(?:\\bpromisify\\s*\\(\\s*execFile\\s*\\)|\\b(?:${names}))\\s*\\(`, 'g');
};

/** The test files of the tiers that spawn processes. */
export const isTestSource = (path: string): boolean => {
  if (path.startsWith('node_modules/') || path.startsWith('apps/web/')) return false;
  if (path.startsWith('test/web-e2e/') || path.startsWith('test/fixtures/')) return false;
  if (/\.test\.tsx?$/.test(path)) return true;
  return path.startsWith('test/') && /\.tsx?$/.test(path);
};

/** The index just past the bracket matching the one at `open`, skipping strings and templates. */
export const matchingClose = (source: string, open: number): number => {
  const closers: string[] = [];
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  let index = open;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === "'" || char === '"') {
      index += 1;
      while (index < source.length && source[index] !== char) {
        index += source[index] === '\\' ? 2 : 1;
      }
    } else if (char === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') index += 2;
        else if (source.startsWith('${', index)) index = matchingClose(source, index + 1);
        else index += 1;
      }
    } else if (char in pairs) {
      closers.push(pairs[char] as string);
    } else if (char === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) return index + 1;
    }
    index += 1;
  }
  return source.length;
};

/** The index just past the string or template that opens at `start`. */
export const skipString = (source: string, start: number): number => {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length && source[index] !== quote) {
    if (source[index] === '\\') index += 2;
    else if (quote === '`' && source.startsWith('${', index))
      index = matchingClose(source, index + 1);
    else index += 1;
  }
  return index + 1;
};

/**
 * `source` with every regular-expression literal's body blanked to spaces, so a bracket inside one
 * (`/\bsave\s*\(/g`) does not unbalance the matcher. Offsets and newlines are kept. A `/` is read
 * as a literal's start after an operator, a bracket, a comma or the start, and after `return`.
 * The other way round, a division after `++`/`--` (`n++ / 2`) or a JSX closing tag (`</p>`) is read
 * as a literal and blanked to the end of its line, so a call there can run past its close (review,
 * WP-256). An unterminated literal at the end of the source adds one character.
 */
export const blankRegularExpressions = (source: string): string => {
  let output = '';
  let index = 0;
  let previous = '';
  while (index < source.length) {
    const char = source[index] as string;
    if (`'"\``.includes(char)) {
      const end = skipString(source, index);
      output += source.slice(index, end);
      index = end;
      previous = char;
    } else if (
      char === '/' &&
      (/^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(previous) || /\breturn$/.test(output.trimEnd()))
    ) {
      let end = index + 1;
      let inClass = false;
      while (end < source.length && source[end] !== '\n') {
        const next = source[end] as string;
        if (next === '\\') end += 1;
        else if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
        end += 1;
      }
      output += `/${' '.repeat(end - index - 1)}/`;
      index = end + 1;
      previous = '/';
    } else {
      output += char;
      index += 1;
      if (!/\s/.test(char)) previous = char;
    }
  }
  return output;
};

/** Identifiers this file binds to a helper call, directly or as an arrow returning one. */
const helperBindings = (source: string): Set<string> => {
  const bindings = new Set<string>();
  const binding =
    /\b(?:const|let)\s+(\w+)\b[^=;]*=\s*(?:\([^)]*\)\s*(?::\s*[^=]+)?=>\s*)?(?:scratchGitEnv|initScratchRepository|checkoutGitEnv)\s*\(/g;
  for (const match of source.matchAll(binding)) bindings.add(match[1] as string);
  return bindings;
};

/** Identifiers this file initialises with a string naming a git-running script. */
const scriptConstants = (source: string): Set<string> => {
  const constants = new Set<string>();
  for (const match of source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/g)) {
    if (GIT_RUNNING_SCRIPTS.test(match[2] as string)) constants.add(match[1] as string);
  }
  return constants;
};

const admitted = (call: string, bindings: ReadonlySet<string>): boolean => {
  const startsWithHelper = (expression: string): boolean => {
    const trimmed = expression.replace(/^\{\s*\.\.\./, '').trimStart();
    if (/^(?:scratchGitEnv|initScratchRepository|checkoutGitEnv)\s*\(/.test(trimmed)) return true;
    const leading = /^(\w+)/.exec(trimmed)?.[1];
    return leading !== undefined && bindings.has(leading);
  };
  for (const match of call.matchAll(/\benv\s*:\s*/g)) {
    if (startsWithHelper(call.slice((match.index ?? 0) + match[0].length))) return true;
  }
  // The shorthand: `{ cwd, env }`.
  return /[{,]\s*env\s*[,}]/.test(call) && bindings.has('env');
};

export interface GitSpawnSite {
  readonly path: string;
  readonly line: number;
  readonly call: string;
  /** The call's options take the helper's environment. */
  readonly admitted: boolean;
}

/** Every site under `root` that spawns git, or a git-running script, and whether it is admitted. */
export const gitSpawnSites = (
  root: string,
  include: (path: string) => boolean = isTestSource,
): GitSpawnSite[] =>
  censusFiles(root, { include }).flatMap(({ path, contents }) => {
    const source = withoutComments(contents);
    const blanked = blankRegularExpressions(source);
    const bindings = helperBindings(source);
    const constants = scriptConstants(source);
    const sites: GitSpawnSite[] = [];
    for (const match of source.matchAll(callees(source))) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const call = source.slice(open, matchingClose(blanked, open));
      const runsGit = /^\(\s*['"`]git['"`]\s*[,)]/.test(call);
      const runsScript =
        GIT_RUNNING_SCRIPTS.test(call) ||
        [...constants].some((name) => new RegExp(`\\b${name}\\b`).test(call));
      if (runsGit || runsScript) {
        sites.push({
          path,
          line: source.slice(0, open).split('\n').length,
          call: call.slice(0, 80).replace(/\s+/g, ' '),
          admitted: admitted(call, bindings),
        });
      }
    }
    return sites;
  });
