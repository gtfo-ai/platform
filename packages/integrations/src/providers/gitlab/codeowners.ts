/**
 * The `CODEOWNERS` parser.
 *
 * Transcribed from <https://docs.gitlab.com/user/project/codeowners/reference/> and
 * <https://docs.gitlab.com/user/project/codeowners/> (retrieved 2026-09-10). The rules that shape
 * this code, quoted:
 *
 *  - "Comments: Lines starting with `#` are ignored. **Inline comments are unsupported. Any Code
 *    Owners listed in a comment are parsed.**" — so owners are extracted by *shape*, not by
 *    splitting the line on whitespace. Splitting would make `#` and `Match` owners of
 *    `/docs/**\/*.md @markdown-docs  # Match specific file types`.
 *  - Section headings: `[Section name]`, `^[Section name]` (optional), `[Section name][5]`
 *    (required approvals) and default owners after the heading, e.g. `[Section name][2] @group`.
 *  - "Default owners are applied when specific owners are not specified for file paths." — a rule
 *    line inside a section with no owners of its own inherits the section's.
 *  - "Entries must have one or more owners." — a rule that ends up with none is dropped.
 *  - Owner forms: `@username`, `@group`, `@group/with-nested/subgroup`, `email@example.com`, and
 *    `@@maintainer` for a role.
 *
 * **This file is attacker-controlled data (BD-022).** In a fork workflow the contributor writes
 * it, and its output feeds reviewer routing (WP-37). So it is parsed with hard caps and it is
 * never anything but data: no pattern is compiled into a regular expression here, and nothing in
 * it is passed to a shell, a prompt or an approval decision by this module.
 */
import type { CodeownersRules } from '@platform/application';

export interface CodeownersLimits {
  /** Lines read before the rest of the file is ignored. */
  readonly maxLines: number;
  readonly maxRules: number;
  readonly maxOwnersPerRule: number;
  readonly maxPatternLength: number;
}

export const DEFAULT_CODEOWNERS_LIMITS: CodeownersLimits = {
  maxLines: 5_000,
  maxRules: 2_000,
  maxOwnersPerRule: 64,
  maxPatternLength: 512,
};

/**
 * `^[Name]`, `[Name]`, `[Name][2]`, each optionally followed by default owners.
 *
 * **A line that begins with `[` is a heading, always — including `[abc]*.ts @owner`, whose rule is
 * then dropped.** That is deliberate rather than an oversight (WP-09 review round 1): the grammar
 * GitLab publishes has no escape for a leading bracket ("To add a section to the `CODEOWNERS`
 * file, enter a section name in square brackets…"), and it documents no character-class matching
 * for entries either — the reference lists absolute paths, directories, `*`, `**` and `!`
 * exclusions, and nothing else (<https://docs.gitlab.com/user/project/codeowners/reference/>,
 * retrieved 2026-09-10). So a leading `[…]` is a section name to GitLab's own parser, and reading
 * it as one keeps this parser's owner routing identical to the enforcement GitLab applies. Making
 * it a *rule* here would be the dangerous direction: it would route reviewers by a pattern the
 * provider ignores.
 */
const SECTION_HEADING = /^\^?\[[^\]\n]+\](\[\d+\])?/;

/**
 * Owners, matched by shape. The email alternative comes first so `jane@example.com` is one owner
 * rather than `@example.com`.
 */
const OWNER =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+|@@?[A-Za-z0-9][A-Za-z0-9._\-/]*/g;

const ownersIn = (text: string, limit: number): string[] => {
  const found = text.match(OWNER) ?? [];
  return found.slice(0, limit);
};

export const parseCodeowners = (
  text: string,
  limits: CodeownersLimits = DEFAULT_CODEOWNERS_LIMITS,
): CodeownersRules => {
  const rules: { pattern: string; owners: string[] }[] = [];
  let sectionDefaults: string[] = [];

  const lines = text.split('\n');
  const readable = Math.min(lines.length, limits.maxLines);

  for (let index = 0; index < readable && rules.length < limits.maxRules; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const heading = SECTION_HEADING.exec(line);
    if (heading !== null) {
      sectionDefaults = ownersIn(line.slice(heading[0].length), limits.maxOwnersPerRule);
      continue;
    }

    // The pattern is the first whitespace-delimited token; everything after it may hold owners.
    const boundary = line.search(/\s/);
    const pattern = (boundary === -1 ? line : line.slice(0, boundary)).trim();
    if (pattern === '' || pattern.length > limits.maxPatternLength) {
      continue;
    }
    const explicit = boundary === -1 ? [] : ownersIn(line.slice(boundary), limits.maxOwnersPerRule);
    const owners = explicit.length > 0 ? explicit : sectionDefaults;
    if (owners.length === 0) {
      continue;
    }
    rules.push({ pattern, owners: [...owners] });
  }

  return { rules };
};

/**
 * Where GitLab looks for the file, **in this order**
 * (<https://docs.gitlab.com/user/project/codeowners/>, 2026-09-10):
 *
 * > Each repository uses a single `CODEOWNERS` file. GitLab checks these locations in your
 * > repository in this order. The first `CODEOWNERS` file found is used, and all others are
 * > ignored.
 */
export const CODEOWNERS_PATHS = ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'] as const;
