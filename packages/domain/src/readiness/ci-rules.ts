/**
 * **Would this project's CI give an agent's merge request any test job?** — WP-143 (Q114, the
 * founder's answer of 2026-10-04: *the operator fixes CI; the platform warns*).
 *
 * The agent's branch is fixed (`agentic/<ticket key>`, BD-025 §3), and a project whose GitLab CI
 * selects jobs by branch prefix — Autix runs its Composer build only for source branches matching
 * `^(feature|bugfix)/` — can give such a branch a partial pipeline or none, which the CI gate then
 * reads as a project without CI or waits on. This module is a **pure, best-effort evaluator** of the
 * default branch's CI file in two synthetic contexts:
 *
 *  - a **push** pipeline for `agentic/X-1` ({@link pushContextFor});
 *  - a **merge-request** pipeline from it to the stored default branch, title not draft
 *    ({@link mergeRequestContextFor}).
 *
 * It reads `workflow:rules`, a job's `rules:` (`if` with `==`, `!=`, `=~`, `!~`, `&&`, `||`,
 * parentheses and `null`, over the predefined variables a context sets) and `only`/`except` (refs,
 * the `branches`/`merge_requests`/`pushes` keywords, literal names, regexes; a job with neither is
 * `only: [branches, tags]`), and answers per job *runs / skipped / unknown*.
 *
 * ## It warns only on rules it fully understood
 *
 * `unknown` is anything it cannot read: `include:` (every kind — the file is then not evaluated at
 * all), `extends`, `!reference`, `changes:`, `exists:`, `trigger:`, a variable a context does not
 * set (every variable the file or the project defines included: a project CI/CD variable overrides
 * the file's), a regular expression JavaScript cannot compile (GitLab's are RE2), an expression it
 * cannot parse. A rule whose match is unknown is not a dead end: the job's **possible** outcomes are
 * collected (that rule's, and the rest of the list's), and the job is decided when they agree — so a
 * `$CI_COMMIT_MESSAGE =~ /^WIP/ → manual` rule in front of rules that skip the branch anyway still
 * decides *skipped*.
 *
 * The warning ({@link CI_RULES_WARNING_CODE}) fires only when, in **both** contexts, none of the
 * counted jobs runs and none of them is unknown, with no `include:` and a decided `workflow:rules`.
 * The counted jobs are those in stage `test` (GitLab's default stage), or every job when the file
 * has none there — the plan row's *"no job in stage `test` and no job at all"*, read as one test
 * (WP-143's notes). Otherwise anything unknown yields a quieter note ({@link CI_RULES_NOTE_CODE})
 * that says what was not seen. A false alarm therefore needs a rule the evaluator understood.
 *
 * ## What it assumes, stated
 *
 * The merge request's title and the head commit's message are the agent's, so they are taken as a
 * plain `X-1: change` — neither `Draft:` nor `WIP` — because `mr_ready` undrafts before the CI gate
 * reads a pipeline. `CI_OPEN_MERGE_REQUESTS`, `CI_MERGE_REQUEST_DRAFT` and
 * `CI_MERGE_REQUEST_EVENT_TYPE` are **not** set (they differ between the first push and a later one,
 * or between GitLab tiers), so a rule over them is unknown. `when: manual`, `never` and `on_failure`
 * count as skipped: none of them runs a test on a green pipeline without a person.
 *
 * Variables: https://docs.gitlab.com/ci/variables/predefined_variables/ (retrieved 2026-10-04:
 * `CI_COMMIT_BRANCH` is *"not available in merge request pipelines or tag pipelines"*). Rules:
 * https://docs.gitlab.com/ci/jobs/job_rules/.
 *
 * Every string in a finding that came out of the file (a job name, an expression) is **untrusted**
 * (BD-022) and bounded here; the caller redacts the file before it is parsed (TD-012), so nothing
 * quoted from it can carry a secret the binding knows.
 */

/** The warning's code — `readiness_evaluations.notices[].code`, and the API's. */
export const CI_RULES_WARNING_CODE = 'ci_rules_skip_agent_branch';

/** The quieter note's code: something the evaluator could not see. */
export const CI_RULES_NOTE_CODE = 'ci_rules_not_seen';

/** One platform-computed notice on a readiness evaluation (WP-143) — never a criterion. */
export interface ReadinessNotice {
  readonly code: typeof CI_RULES_WARNING_CODE | typeof CI_RULES_NOTE_CODE;
  readonly severity: 'warning' | 'note';
  /** Platform sentences around bounded, redacted repository text (job names, one expression). */
  readonly message: string;
}

/**
 * How the YAML parser hands a `!reference [a, b]` tag to the domain: a mapping with this one key.
 * The domain reads it as unknown wherever it appears; it never resolves it.
 */
export const CI_REFERENCE_KEY = '!reference';

/** The synthetic ticket key both contexts use: the branch is `agentic/X-1`. */
export const CI_RULES_SAMPLE_BRANCH = 'agentic/X-1';

const SAMPLE_TITLE = 'X-1: change';

/** Longest job name or expression quoted in a notice; longest notice. */
const MAX_QUOTED_CHARS = 120;
const MAX_NOTICE_CHARS = 1_200;
/** How many job names a notice lists before it says "and N more". */
const MAX_LISTED = 4;

export type CiContextKind = 'push' | 'merge_request';

export interface CiContext {
  readonly kind: CiContextKind;
  /** The branch the pipeline is for — the agent's. */
  readonly branch: string;
  /** Predefined variables this context sets; `null` is *set to nothing* (GitLab's `null`). */
  readonly variables: Readonly<Record<string, string | null>>;
}

const COMMON_UNSET = {
  CI_COMMIT_TAG: null,
  CI_COMMIT_TAG_MESSAGE: null,
  CI_EXTERNAL_PULL_REQUEST_IID: null,
  CI_PIPELINE_TRIGGERED: null,
} as const;

/** A push of the agent's branch (no tag, no merge request variables). */
export const pushContextFor = (branch: string, defaultBranch: string): CiContext => ({
  kind: 'push',
  branch,
  variables: {
    ...COMMON_UNSET,
    CI_PIPELINE_SOURCE: 'push',
    CI_COMMIT_BRANCH: branch,
    CI_COMMIT_REF_NAME: branch,
    CI_COMMIT_REF_SLUG: refSlugOf(branch),
    CI_DEFAULT_BRANCH: defaultBranch,
    CI_COMMIT_MESSAGE: SAMPLE_TITLE,
    CI_COMMIT_TITLE: SAMPLE_TITLE,
    CI_MERGE_REQUEST_ID: null,
    CI_MERGE_REQUEST_IID: null,
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: null,
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: null,
    CI_MERGE_REQUEST_TITLE: null,
    CI_MERGE_REQUEST_LABELS: null,
  },
});

/** A merge-request pipeline from the agent's branch into the stored default branch. */
export const mergeRequestContextFor = (branch: string, defaultBranch: string): CiContext => ({
  kind: 'merge_request',
  branch,
  variables: {
    ...COMMON_UNSET,
    CI_PIPELINE_SOURCE: 'merge_request_event',
    CI_COMMIT_BRANCH: null,
    CI_COMMIT_REF_NAME: branch,
    CI_COMMIT_REF_SLUG: refSlugOf(branch),
    CI_DEFAULT_BRANCH: defaultBranch,
    CI_COMMIT_MESSAGE: SAMPLE_TITLE,
    CI_COMMIT_TITLE: SAMPLE_TITLE,
    CI_MERGE_REQUEST_ID: '1',
    CI_MERGE_REQUEST_IID: '1',
    CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: branch,
    CI_MERGE_REQUEST_TARGET_BRANCH_NAME: defaultBranch,
    CI_MERGE_REQUEST_TITLE: SAMPLE_TITLE,
  },
});

/** GitLab's `CI_COMMIT_REF_SLUG`: lower-cased, non-`[a-z0-9]` runs to `-`, trimmed, ≤ 63. */
const refSlugOf = (ref: string): string =>
  ref
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');

// ── File-supplied regular expressions: a safe subset only (WP-143 review round 1) ──

/** Longest pattern the evaluator compiles; a longer one is `unknown`. */
export const MAX_CI_REGEX_CHARS = 200;

/** Escapes a pattern may use: classes, and an escaped character that is not a letter or digit. */
const SAFE_ESCAPE = /^[dDwWsS]$|^[^A-Za-z0-9]$/;

/**
 * Compiles a pattern **from the CI file** only when it cannot backtrack catastrophically, else
 * `null` (the caller reads it as `unknown`, so a note, never a warning). The patterns run
 * synchronously in the server against platform strings, and JavaScript's engine backtracks — the
 * reviewer measured `^(.*)*…z$` doubling per group. So, with no new dependency, the accepted subset:
 * literals, `^`/`$`, `.`, `[…]` classes, the escapes {@link SAFE_ESCAPE} names, alternation, and
 * groups `(…)`/`(?:…)`; a repeating quantifier (`*`, `+`, `{n,m}`) on a single atom only — a group
 * may carry `?` alone, which never repeats it, so nothing quantified is ever repeated; never two
 * quantifiers on one atom
 * (`a**`, `a+?`). No backreference, no lookaround, no named group, at most
 * {@link MAX_CI_REGEX_CHARS} characters, flags `i`/`m`/`s` only. A non-nested pattern of
 * quantified atoms matches in polynomial time; the subjects are short platform strings.
 */
export const compileSafeCiRegex = (source: string, flags: string): RegExp | null => {
  if (source.length > MAX_CI_REGEX_CHARS || !/^[ims]*$/.test(flags)) return null;
  /** Per open group: whether something inside it is quantified. */
  const groups: boolean[] = [];
  /** What the last atom was: none, a plain atom, a quantified atom, or a closed group. */
  let last: 'none' | 'atom' | 'quantified' | { readonly group: boolean } = 'none';
  const quantify = (repeats: boolean): boolean => {
    if (last === 'none' || last === 'quantified') return false;
    // A group may be made optional; it may never repeat (`(…)*`, `(…)+`, `(…){n}`).
    if (typeof last === 'object' && repeats) return false;
    last = 'quantified';
    if (groups.length > 0) groups[groups.length - 1] = true;
    return true;
  };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] ?? '';
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (!SAFE_ESCAPE.test(next)) return null;
      i += 1;
      last = 'atom';
    } else if (c === '[') {
      const end = source.indexOf(']', i + 2);
      if (end === -1) return null;
      const body = source.slice(i + 1, end);
      if (/\\(?![dDwWsS]|[^A-Za-z0-9])/.test(body) || body.includes('[')) return null;
      i = end;
      last = 'atom';
    } else if (c === '(') {
      if (source[i + 1] === '?') {
        if (source[i + 2] !== ':') return null;
        i += 2;
      }
      groups.push(false);
      last = 'none';
    } else if (c === ')') {
      const inner = groups.pop();
      if (inner === undefined) return null;
      last = { group: inner };
    } else if (c === '|') {
      last = 'none';
    } else if (c === '*' || c === '+') {
      if (!quantify(true)) return null;
    } else if (c === '?') {
      if (!quantify(false)) return null;
    } else if (c === '{') {
      const bound = /^\{\d{1,3}(,\d{0,3})?\}/.exec(source.slice(i));
      if (bound === null || !quantify(true)) return null;
      i += bound[0].length - 1;
    } else if (c === '^' || c === '$') {
      last = 'none';
    } else {
      last = 'atom';
    }
  }
  if (groups.length > 0) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
};

// ── Three-valued values and the `if:` expression ────────────────────────────

type Tri = true | false | 'unknown';

const and3 = (a: Tri, b: Tri): Tri =>
  a === false || b === false ? false : a === 'unknown' || b === 'unknown' ? 'unknown' : true;
const or3 = (a: Tri, b: Tri): Tri =>
  a === true || b === true ? true : a === 'unknown' || b === 'unknown' ? 'unknown' : false;
const not3 = (a: Tri): Tri => (a === 'unknown' ? 'unknown' : !a);

type Operand =
  | { readonly kind: 'value'; readonly value: string | null }
  | { readonly kind: 'regex'; readonly regex: RegExp }
  | { readonly kind: 'unknown'; readonly why: string };

type Token =
  | { readonly t: 'var'; readonly name: string }
  | { readonly t: 'str'; readonly value: string }
  | { readonly t: 'regex'; readonly source: string; readonly flags: string }
  | { readonly t: 'null' }
  | { readonly t: 'op'; readonly op: '==' | '!=' | '=~' | '!~' | '&&' | '||' | '(' | ')' };

class ExpressionError extends Error {}

const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? '';
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (
      two === '==' ||
      two === '!=' ||
      two === '=~' ||
      two === '!~' ||
      two === '&&' ||
      two === '||'
    ) {
      tokens.push({ t: 'op', op: two });
      i += 2;
      continue;
    }
    if (c === '(' || c === ')') {
      tokens.push({ t: 'op', op: c });
      i += 1;
      continue;
    }
    if (c === '$') {
      const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(
        text.slice(i),
      );
      if (match === null) throw new ExpressionError('a `$` that names no variable');
      tokens.push({ t: 'var', name: match[1] ?? match[2] ?? '' });
      i += match[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new ExpressionError('an unterminated string');
      tokens.push({ t: 'str', value: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '/') {
      let j = i + 1;
      while (j < text.length && text[j] !== '/') j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new ExpressionError('an unterminated regular expression');
      const flags = /^[a-z]*/.exec(text.slice(j + 1))?.[0] ?? '';
      tokens.push({ t: 'regex', source: text.slice(i + 1, j), flags });
      i = j + 1 + flags.length;
      continue;
    }
    if (/^null\b/.test(text.slice(i))) {
      tokens.push({ t: 'null' });
      i += 4;
      continue;
    }
    throw new ExpressionError(`an unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
};

/**
 * `rules:if` → true / false / unknown in one context. `&&` binds tighter than `||`, as GitLab's
 * does; a bare operand is true when it is set and not empty.
 */
export const evaluateCiExpression = (
  text: string,
  variables: Readonly<Record<string, string | null>>,
): { readonly value: Tri; readonly why: string | null } => {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    return { value: 'unknown', why: `an expression it cannot read (${(error as Error).message})` };
  }
  let position = 0;
  const reasons: string[] = [];
  const peek = (): Token | undefined => tokens[position];
  const isOp = (op: string): boolean => {
    const token = peek();
    return token?.t === 'op' && token.op === op;
  };

  const operand = (): Operand => {
    const token = tokens[position];
    position += 1;
    if (token === undefined) throw new ExpressionError('an expression that ends early');
    switch (token.t) {
      case 'var':
        if (Object.hasOwn(variables, token.name)) {
          return { kind: 'value', value: variables[token.name] ?? null };
        }
        return { kind: 'unknown', why: `the variable $${token.name}, which it does not set` };
      case 'str':
        return { kind: 'value', value: token.value };
      case 'null':
        return { kind: 'value', value: null };
      case 'regex': {
        const regex = compileSafeCiRegex(token.source, token.flags);
        return regex === null
          ? {
              kind: 'unknown',
              why: `a regular expression it does not evaluate (/${token.source.slice(0, 40)}/: outside the safe subset, or one JavaScript cannot compile)`,
            }
          : { kind: 'regex', regex };
      }
      default:
        throw new ExpressionError(`an operator where a value belongs (${token.op})`);
    }
  };

  const truthy = (value: Operand): Tri => {
    if (value.kind === 'unknown') {
      reasons.push(value.why);
      return 'unknown';
    }
    if (value.kind === 'regex') return true;
    return value.value !== null && value.value !== '';
  };

  const comparison = (): Tri => {
    if (isOp('(')) {
      position += 1;
      const inner = disjunction();
      if (!isOp(')')) throw new ExpressionError('an unclosed parenthesis');
      position += 1;
      return inner;
    }
    const left = operand();
    const token = peek();
    if (token?.t !== 'op' || !['==', '!=', '=~', '!~'].includes(token.op)) {
      return truthy(left);
    }
    position += 1;
    const right = operand();
    if (left.kind === 'unknown' || right.kind === 'unknown') {
      for (const side of [left, right]) if (side.kind === 'unknown') reasons.push(side.why);
      return 'unknown';
    }
    if (token.op === '==' || token.op === '!=') {
      if (left.kind === 'regex' || right.kind === 'regex') {
        reasons.push('a regular expression compared with == or !=');
        return 'unknown';
      }
      const equal = left.value === right.value;
      return token.op === '==' ? equal : !equal;
    }
    if (right.kind !== 'regex' || left.kind !== 'value') {
      reasons.push('a pattern match whose right side is not a /regular expression/');
      return 'unknown';
    }
    const matched = left.value !== null && right.regex.test(left.value);
    return token.op === '=~' ? matched : !matched;
  };

  const conjunction = (): Tri => {
    let value = comparison();
    while (isOp('&&')) {
      position += 1;
      value = and3(value, comparison());
    }
    return value;
  };

  const disjunction = (): Tri => {
    let value = conjunction();
    while (isOp('||')) {
      position += 1;
      value = or3(value, conjunction());
    }
    return value;
  };

  try {
    if (tokens.length === 0) throw new ExpressionError('an empty expression');
    const value = disjunction();
    if (position !== tokens.length) throw new ExpressionError('a token after the expression');
    return { value, why: value === 'unknown' ? (reasons[0] ?? 'an unknown value') : null };
  } catch (error) {
    return { value: 'unknown', why: `an expression it cannot read (${(error as Error).message})` };
  }
};

// ── Jobs ─────────────────────────────────────────────────────────────────────

/** A job's answer in one context. `decidedBy` names the rule that decided, when one did. */
export type CiJobVerdict =
  | { readonly verdict: 'runs'; readonly decidedBy: string }
  | { readonly verdict: 'skipped'; readonly decidedBy: string }
  | { readonly verdict: 'unknown'; readonly why: string };

type Outcome = 'runs' | 'skipped';

const RUNNING_WHEN = new Set(['on_success', 'always', 'delayed']);
const SKIPPING_WHEN = new Set(['never', 'manual', 'on_failure']);

/** Variables that name the branch — a rule over one is the rule that kept the branch out. */
const BRANCH_VARIABLES =
  /\$\{?(CI_COMMIT_BRANCH|CI_COMMIT_REF_NAME|CI_COMMIT_REF_SLUG|CI_MERGE_REQUEST_SOURCE_BRANCH_NAME)\b/;

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isReference = (value: unknown): boolean =>
  isMapping(value) && Object.hasOwn(value, CI_REFERENCE_KEY);

/** Nesting past which a value is not read — a document that deep is not a CI rule. */
const MAX_RULE_DEPTH = 20;

/**
 * Why a value cannot be read: it holds a `!reference`, or it nests past {@link MAX_RULE_DEPTH}
 * (too deep, or cyclic through a shared alias); `null` when neither.
 */
const unreadableIn = (value: unknown, depth = 0): string | null => {
  if (depth > MAX_RULE_DEPTH) return 'nests too deep or cyclically';
  if (isReference(value)) return 'uses !reference';
  const children = Array.isArray(value) ? value : isMapping(value) ? Object.values(value) : [];
  for (const entry of children) {
    const found = unreadableIn(entry, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

/** A quoted, bounded piece of repository text — untrusted, so cut and shown as data. */
export const quoteCiText = (text: string): string =>
  JSON.stringify(text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text);

const whenOutcome = (when: unknown, fallback: Outcome | 'unknown'): Outcome | 'unknown' => {
  if (when === undefined) return fallback;
  if (typeof when !== 'string') return 'unknown';
  if (RUNNING_WHEN.has(when)) return 'runs';
  if (SKIPPING_WHEN.has(when)) return 'skipped';
  return 'unknown';
};

const ruleLabel = (owner: string, index: number, rule: Record<string, unknown>): string =>
  `${owner} rules[${index}]${typeof rule.if === 'string' ? ` if: ${quoteCiText(rule.if)}` : ''}`;

/**
 * A `rules:` list in one context: the set of outcomes it can produce, and the rule that decided.
 * A rule whose match is unknown adds its outcome and the evaluation goes on (module docblock).
 */
const evaluateRules = (
  owner: string,
  rules: unknown,
  context: CiContext,
  jobWhen: Outcome | 'unknown',
): CiJobVerdict => {
  if (!Array.isArray(rules)) {
    return { verdict: 'unknown', why: `${owner}'s rules are not a list` };
  }
  const possible = new Set<Outcome>();
  let firstUnknown: string | null = null;
  let excludedBy: string | null = null;
  for (const [index, rule] of rules.entries()) {
    const unreadable = unreadableIn(rule);
    if (unreadable !== null) {
      return { verdict: 'unknown', why: `${owner} ${unreadable} in its rules` };
    }
    if (!isMapping(rule)) {
      return { verdict: 'unknown', why: `${owner}'s rules[${index}] is not a mapping` };
    }
    let matched: Tri = true;
    let why: string | null = null;
    if (rule.if !== undefined) {
      if (typeof rule.if !== 'string') {
        matched = 'unknown';
        why = `${owner}'s rules[${index}] has an if that is not text`;
      } else {
        const evaluated = evaluateCiExpression(rule.if, context.variables);
        matched = evaluated.value;
        why =
          evaluated.why === null ? null : `${ruleLabel(owner, index, rule)} reads ${evaluated.why}`;
        if (matched === false && excludedBy === null && BRANCH_VARIABLES.test(rule.if)) {
          excludedBy = ruleLabel(owner, index, rule);
        }
      }
    }
    for (const clause of ['changes', 'exists'] as const) {
      if (rule[clause] !== undefined && matched !== false) {
        matched = and3(matched, 'unknown');
        why ??= `${owner}'s rules[${index}] uses ${clause}:`;
      }
    }
    const outcome = whenOutcome(rule.when, jobWhen);
    if (matched === false) continue;
    if (outcome === 'unknown') {
      return { verdict: 'unknown', why: `${owner}'s rules[${index}] has a when it does not know` };
    }
    if (matched === true) {
      possible.add(outcome);
      if (possible.size === 1 && firstUnknown === null) {
        return {
          verdict: outcome,
          decidedBy: `${ruleLabel(owner, index, rule)}${rule.when === undefined ? '' : ` (when: ${String(rule.when)})`}`,
        };
      }
      return settle(possible, firstUnknown, ruleLabel(owner, index, rule));
    }
    possible.add(outcome);
    firstUnknown ??= why ?? `${owner}'s rules[${index}]`;
  }
  possible.add('skipped');
  return settle(possible, firstUnknown, excludedBy ?? `${owner}: no rule matched`);
};

const settle = (
  possible: ReadonlySet<Outcome>,
  firstUnknown: string | null,
  decidedBy: string,
): CiJobVerdict => {
  if (possible.size === 1) {
    const only = [...possible][0] as Outcome;
    return { verdict: only, decidedBy };
  }
  return { verdict: 'unknown', why: firstUnknown ?? decidedBy };
};

/** `only`/`except` in their three spellings → `{ refs, variables, other }`. */
const policyOf = (
  value: unknown,
): { refs: unknown[] | null; variables: unknown[] | null; other: string | null } | null => {
  if (value === undefined) return null;
  if (typeof value === 'string') return { refs: [value], variables: null, other: null };
  if (Array.isArray(value)) return { refs: value, variables: null, other: null };
  if (!isMapping(value)) return { refs: null, variables: null, other: 'a value it does not know' };
  const other = Object.keys(value).find((key) => key !== 'refs' && key !== 'variables');
  const refs = value.refs;
  const variables = value.variables;
  return {
    refs: refs === undefined ? null : Array.isArray(refs) ? refs : [refs],
    variables: variables === undefined ? null : Array.isArray(variables) ? variables : [variables],
    other: other === undefined ? null : `${other}:`,
  };
};

const PUSH_KEYWORDS = new Set(['branches', 'pushes']);
const MR_KEYWORDS = new Set(['merge_requests']);
const OTHER_KEYWORDS = new Set([
  'tags',
  'api',
  'external',
  'pipelines',
  'schedules',
  'triggers',
  'web',
  'chat',
  'external_pull_requests',
]);

/** One `only`/`except` ref in one context. */
const refMatches = (ref: unknown, context: CiContext): Tri => {
  if (typeof ref !== 'string') return 'unknown';
  if (PUSH_KEYWORDS.has(ref)) return context.kind === 'push';
  if (MR_KEYWORDS.has(ref)) return context.kind === 'merge_request';
  if (OTHER_KEYWORDS.has(ref)) return false;
  if (ref.includes('@')) return 'unknown';
  // A branch name or a /regex/: read against the pushed branch. A merge-request pipeline is added
  // only by the `merge_requests` keyword (https://docs.gitlab.com/ci/yaml/deprecated_keywords/,
  // retrieved 2026-10-04: *"Enables merge request pipelines"*), so a name never admits one.
  if (context.kind === 'merge_request') return false;
  const regex = /^\/(.*)\/([a-z]*)$/s.exec(ref);
  if (regex === null) return ref === context.branch;
  const compiled = compileSafeCiRegex(regex[1] ?? '', regex[2] ?? '');
  return compiled === null ? 'unknown' : compiled.test(context.branch);
};

const policyMatches = (
  policy: NonNullable<ReturnType<typeof policyOf>>,
  context: CiContext,
): { value: Tri; why: string | null } => {
  if (policy.other !== null) return { value: 'unknown', why: `uses ${policy.other}` };
  let refs: Tri = true;
  if (policy.refs !== null) {
    refs = false;
    for (const ref of policy.refs) refs = or3(refs, refMatches(ref, context));
  }
  let variables: Tri = true;
  let why: string | null = refs === 'unknown' ? 'names a ref it cannot read here' : null;
  if (policy.variables !== null) {
    variables = false;
    for (const expression of policy.variables) {
      if (typeof expression !== 'string') {
        variables = or3(variables, 'unknown');
        continue;
      }
      const evaluated = evaluateCiExpression(expression, context.variables);
      variables = or3(variables, evaluated.value);
      why ??= evaluated.why;
    }
  }
  return { value: and3(refs, variables), why };
};

/** `only`/`except` → a verdict, for a job with no `rules:`. */
const evaluateOnlyExcept = (
  name: string,
  job: Record<string, unknown>,
  context: CiContext,
  jobWhen: Outcome | 'unknown',
): CiJobVerdict => {
  const only = policyOf(job.only) ?? { refs: ['branches', 'tags'], variables: null, other: null };
  const except = policyOf(job.except);
  const included = policyMatches(only, context);
  const excluded =
    except === null ? { value: false as Tri, why: null } : policyMatches(except, context);
  const result = and3(included.value, not3(excluded.value));
  if (result === 'unknown') {
    return {
      verdict: 'unknown',
      why: `${name}'s ${included.value === 'unknown' ? 'only' : 'except'} ${(included.value === 'unknown' ? included.why : excluded.why) ?? 'cannot be read here'}`,
    };
  }
  if (result === false) {
    return {
      verdict: 'skipped',
      decidedBy:
        included.value === false
          ? `${name} only: ${quoteCiText(JSON.stringify(job.only ?? ['branches', 'tags']))}`
          : `${name} except: ${quoteCiText(JSON.stringify(job.except))}`,
    };
  }
  if (jobWhen === 'unknown')
    return { verdict: 'unknown', why: `${name} has a when it does not know` };
  return {
    verdict: jobWhen,
    decidedBy: `${name} ${job.only === undefined ? '(no only/except: branches and tags)' : 'only/except'}`,
  };
};

/** The top-level keys that are not jobs (https://docs.gitlab.com/ci/yaml/). */
const RESERVED_KEYS = new Set([
  'default',
  'include',
  'stages',
  'variables',
  'workflow',
  'image',
  'services',
  'cache',
  'before_script',
  'after_script',
  'spec',
]);

export interface CiJob {
  readonly name: string;
  /** `stage:`, `test` when absent; `null` when it cannot be read. */
  readonly stage: string | null;
}

const jobVerdict = (
  job: CiJob,
  body: Record<string, unknown>,
  context: CiContext,
): CiJobVerdict => {
  const name = quoteCiText(job.name);
  if (body.extends !== undefined) return { verdict: 'unknown', why: `${name} uses extends` };
  if (body.trigger !== undefined) return { verdict: 'unknown', why: `${name} is a trigger job` };
  if (job.stage === null) return { verdict: 'unknown', why: `${name}'s stage cannot be read` };
  for (const key of ['rules', 'only', 'except', 'when'] as const) {
    const unreadable = unreadableIn(body[key]);
    if (unreadable !== null) return { verdict: 'unknown', why: `${name} ${unreadable} in ${key}:` };
  }
  const jobWhen = whenOutcome(body.when, 'runs');
  if (body.rules !== undefined) {
    if (body.only !== undefined || body.except !== undefined) {
      return {
        verdict: 'unknown',
        why: `${name} mixes rules: with only/except, which GitLab refuses`,
      };
    }
    return evaluateRules(name, body.rules, context, jobWhen);
  }
  return evaluateOnlyExcept(name, body, context, jobWhen);
};

// ── The file ─────────────────────────────────────────────────────────────────

export interface CiContextEvaluation {
  readonly context: CiContextKind;
  /** `null` when the file has no `workflow:rules`; otherwise whether a pipeline is created. */
  readonly workflow: CiJobVerdict | null;
  readonly jobs: readonly (CiJob & { readonly result: CiJobVerdict })[];
}

export type CiRulesEvaluation =
  | { readonly kind: 'not_evaluated'; readonly why: string }
  | {
      readonly kind: 'evaluated';
      readonly contexts: readonly [CiContextEvaluation, CiContextEvaluation];
      /** Whether the counted jobs are those in stage `test` (else: every job). */
      readonly countsTestStage: boolean;
    };

/**
 * Evaluates a parsed CI document for the agent's branch. `document` is what the YAML parser
 * answered (`!reference` as {@link CI_REFERENCE_KEY}); anything that is not a mapping is
 * `not_evaluated`, never a throw.
 */
export const evaluateCiRules = (input: {
  readonly document: unknown;
  readonly branch: string;
  readonly defaultBranch: string;
}): CiRulesEvaluation => {
  const { document } = input;
  if (!isMapping(document)) {
    return { kind: 'not_evaluated', why: 'the file is not a YAML mapping of jobs' };
  }
  if (document.include !== undefined) {
    return {
      kind: 'not_evaluated',
      why: `it includes other configuration (include: ${quoteCiText(JSON.stringify(document.include))}), which the platform does not read`,
    };
  }
  const jobs: { job: CiJob; body: Record<string, unknown> }[] = [];
  for (const [name, body] of Object.entries(document)) {
    if (RESERVED_KEYS.has(name) || name.startsWith('.') || !isMapping(body)) continue;
    const stage =
      body.stage === undefined ? 'test' : typeof body.stage === 'string' ? body.stage : null;
    jobs.push({ job: { name, stage }, body });
  }
  const contexts = [
    pushContextFor(input.branch, input.defaultBranch),
    mergeRequestContextFor(input.branch, input.defaultBranch),
  ] as const;
  const workflowRules = isMapping(document.workflow) ? document.workflow.rules : undefined;
  const evaluateIn = (context: CiContext): CiContextEvaluation => ({
    context: context.kind,
    workflow:
      workflowRules === undefined
        ? null
        : unreadableIn(workflowRules) !== null
          ? { verdict: 'unknown', why: `workflow:rules ${unreadableIn(workflowRules)}` }
          : evaluateRules('workflow', workflowRules, context, 'runs'),
    jobs: jobs.map(({ job, body }) => ({ ...job, result: jobVerdict(job, body, context) })),
  });
  return {
    kind: 'evaluated',
    contexts: [evaluateIn(contexts[0]), evaluateIn(contexts[1])],
    countsTestStage: jobs.some(({ job }) => job.stage === 'test'),
  };
};

// ── The notice ───────────────────────────────────────────────────────────────

/** Where the CI configuration was found, and what the parser made of it. */
export type CiRulesReading =
  | { readonly kind: 'absent' }
  | { readonly kind: 'external'; readonly location: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly parsed:
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly reason: string };
    };

const CONTEXT_WORDS: Record<CiContextKind, string> = {
  push: 'a push pipeline',
  merge_request: 'a merge-request pipeline',
};

const listed = (names: readonly string[]): string =>
  names.length <= MAX_LISTED
    ? names.join(', ')
    : `${names.slice(0, MAX_LISTED).join(', ')} and ${names.length - MAX_LISTED} more`;

const bounded = (message: string): string =>
  message.length > MAX_NOTICE_CHARS ? `${message.slice(0, MAX_NOTICE_CHARS - 1)}…` : message;

const note = (message: string): ReadinessNotice => ({
  code: CI_RULES_NOTE_CODE,
  severity: 'note',
  message: bounded(message),
});

/** Is a job counted, given whether the file has any job in stage `test`? */
const counted =
  (countsTestStage: boolean) =>
  (job: CiJob): boolean =>
    !countsTestStage || job.stage === 'test';

/**
 * The notice a reading earns: the warning, a note naming what was not seen, or `null` when there is
 * nothing to say (no CI file at all; or every counted job decided and one runs). See the module
 * docblock for when each fires.
 */
export const ciRulesNotice = (input: {
  readonly reading: CiRulesReading;
  readonly branch: string;
  readonly defaultBranch: string;
}): ReadinessNotice | null => {
  const { reading } = input;
  switch (reading.kind) {
    case 'absent':
      return null;
    case 'external':
      return note(
        `The CI rules for an agentic/ branch were not read: the CI configuration is outside the repository (${quoteCiText(reading.location)}), and the platform reads only a file in it.`,
      );
    case 'unavailable':
      return note(`The CI rules for an agentic/ branch were not read: ${reading.reason}.`);
    case 'file':
      break;
  }
  const path = quoteCiText(reading.path);
  if (!reading.parsed.ok) {
    return note(
      `The CI rules for an agentic/ branch were not read: ${path} could not be parsed as YAML (${reading.parsed.reason}).`,
    );
  }
  const evaluation = evaluateCiRules({
    document: reading.parsed.value,
    branch: input.branch,
    defaultBranch: input.defaultBranch,
  });
  if (evaluation.kind === 'not_evaluated') {
    return note(
      `The CI rules in ${path} were not evaluated for an agentic/ branch: ${evaluation.why}.`,
    );
  }
  const isCounted = counted(evaluation.countsTestStage);
  const jobsWord = evaluation.countsTestStage ? 'test job (stage test)' : 'job';
  const unseen: string[] = [];
  const running: string[] = [];
  const reasons: string[] = [];
  for (const context of evaluation.contexts) {
    const pipelineGone =
      context.workflow !== null && context.workflow.verdict === 'skipped' ? context.workflow : null;
    if (context.workflow?.verdict === 'unknown') {
      unseen.push(`in ${CONTEXT_WORDS[context.context]}, workflow:rules (${context.workflow.why})`);
      continue;
    }
    if (pipelineGone !== null) {
      reasons.push(`${CONTEXT_WORDS[context.context]} is not created (${pipelineGone.decidedBy})`);
      continue;
    }
    const jobs = context.jobs.filter(isCounted);
    const unknown = jobs.filter((job) => job.result.verdict === 'unknown');
    const runs = jobs.filter((job) => job.result.verdict === 'runs');
    for (const job of unknown) {
      if (job.result.verdict === 'unknown') unseen.push(job.result.why);
    }
    if (runs.length > 0) {
      running.push(
        `${CONTEXT_WORDS[context.context]} runs ${listed(runs.map((job) => quoteCiText(job.name)))}`,
      );
      continue;
    }
    if (unknown.length > 0) continue;
    const first = jobs[0];
    reasons.push(
      first === undefined
        ? `${CONTEXT_WORDS[context.context]} has no ${jobsWord} at all`
        : `${CONTEXT_WORDS[context.context]} runs no ${jobsWord}${first.result.verdict === 'skipped' ? ` — first, ${first.result.decidedBy}` : ''}`,
    );
  }
  if (running.length === 0 && unseen.length === 0 && reasons.length === 2) {
    return {
      code: CI_RULES_WARNING_CODE,
      severity: 'warning',
      message: bounded(
        `${path} gives an agentic/ branch (${input.branch}) no ${jobsWord}: ${reasons.join('; ')}. The CI gate will see no pipeline or a pipeline without tests. Fix: admit agentic/ in that rule (for example ^(feature|bugfix|agentic)/), and let test jobs run on merge-request pipelines.`,
      ),
    };
  }
  if (unseen.length === 0) return null;
  const uniqueUnseen = [...new Set(unseen)];
  return note(
    `The CI rules in ${path} were read only in part for an agentic/ branch (${input.branch}), so no warning is given${running.length === 0 ? '' : ` (${running.join('; ')})`}. Not seen: ${listed(uniqueUnseen)}. The platform does not read include:, extends, !reference, changes:, exists:, trigger:, or variables it does not set.`,
  );
};
