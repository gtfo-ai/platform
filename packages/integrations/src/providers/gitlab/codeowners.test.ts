/**
 * The CODEOWNERS parser, held to the published syntax reference.
 *
 * Two of these tests are security tests rather than parsing ones. CODEOWNERS is written by whoever
 * opened the merge request, which in a fork workflow is not somebody the platform trusts (BD-022):
 * the file has to be bounded, and its contents have to stay data.
 */
import { describe, expect, it } from 'vitest';
import { CODEOWNERS_PATHS, DEFAULT_CODEOWNERS_LIMITS, parseCodeowners } from './codeowners.js';

const ownersOf = (text: string, pattern: string): readonly string[] | undefined =>
  parseCodeowners(text).rules.find((rule) => rule.pattern === pattern)?.owners;

describe('parseCodeowners', () => {
  it('reads the documented example forms', () => {
    const rules = parseCodeowners(
      [
        '# Specify a default Code Owner for all files with a wildcard:',
        '* @default-owner',
        'README.md @doc-team @tech-lead',
        '*.rb @ruby-owner',
        'LICENSE @legal janedoe@gitlab.example.test',
        'README @group @group/with-nested/subgroup',
        '/docs/ @all-docs',
        '/config/ @@maintainer',
      ].join('\n'),
    ).rules;

    expect(rules.map((rule) => rule.pattern)).toEqual([
      '*',
      'README.md',
      '*.rb',
      'LICENSE',
      'README',
      '/docs/',
      '/config/',
    ]);
    expect(rules[0]?.owners).toEqual(['@default-owner']);
    expect(rules[1]?.owners).toEqual(['@doc-team', '@tech-lead']);
    expect(rules[3]?.owners, 'an email owner is one owner, not a group plus a domain').toEqual([
      '@legal',
      'janedoe@gitlab.example.test',
    ]);
    expect(rules[4]?.owners).toEqual(['@group', '@group/with-nested/subgroup']);
    expect(rules[6]?.owners, 'a role owner keeps both @ signs').toEqual(['@@maintainer']);
  });

  it('ignores comment lines', () => {
    expect(parseCodeowners('# nothing here\n\n   \n').rules).toEqual([]);
  });

  /**
   * "Inline comments are unsupported. **Any Code Owners listed in a comment are parsed.**"
   *
   * Owners are therefore matched by shape. Splitting the line on whitespace would make `#` and
   * `match` owners of this rule — and an owner list is what reviewer routing (WP-37) acts on.
   */
  it('does not turn an inline comment into owners', () => {
    const owners = ownersOf(
      '/docs/**/*.md @markdown-docs  # match file types in a subdirectory',
      '/docs/**/*.md',
    );
    expect(owners).toEqual(['@markdown-docs']);
  });

  it('applies a section default to entries that name no owner', () => {
    const rules = parseCodeowners(
      [
        '[Documentation] @docs-team',
        'docs/',
        'README.md',
        '',
        '[Database] @database-team @agarcia',
        'model/db/',
        'config/db/database-setup.md @doc-team',
      ].join('\n'),
    ).rules;

    expect(rules).toEqual([
      { pattern: 'docs/', owners: ['@docs-team'] },
      { pattern: 'README.md', owners: ['@docs-team'] },
      { pattern: 'model/db/', owners: ['@database-team', '@agarcia'] },
      // "Specific owners defined beside the file path override default owners."
      { pattern: 'config/db/database-setup.md', owners: ['@doc-team'] },
    ]);
  });

  it('handles the optional and counted section headings', () => {
    const rules = parseCodeowners(
      ['^[Go]', '*.go @root', '', '[Security][2] @acme/security', 'src/crypto/'].join('\n'),
    ).rules;
    expect(rules).toEqual([
      { pattern: '*.go', owners: ['@root'] },
      { pattern: 'src/crypto/', owners: ['@acme/security'] },
    ]);
  });

  it('drops an entry that ends up with no owners ("Entries must have one or more owners")', () => {
    expect(parseCodeowners('[No defaults]\nsrc/\n').rules).toEqual([]);
    expect(parseCodeowners('src/\n').rules).toEqual([]);
  });

  it('does not carry a section default past the next heading', () => {
    const rules = parseCodeowners(
      ['[A] @team-a', 'a/', '[B]', 'b/ @team-b', 'c/'].join('\n'),
    ).rules;
    expect(rules).toEqual([
      { pattern: 'a/', owners: ['@team-a'] },
      { pattern: 'b/', owners: ['@team-b'] },
    ]);
  });

  it('keeps later rules, because "rules defined later in the file take precedence"', () => {
    // The parser preserves order and does not deduplicate; precedence is the caller's to apply,
    // and dropping the earlier rule here would silently discard information (WP-37).
    const rules = parseCodeowners('src/ @first\nsrc/ @second\n').rules;
    expect(rules).toEqual([
      { pattern: 'src/', owners: ['@first'] },
      { pattern: 'src/', owners: ['@second'] },
    ]);
  });
});

describe('parseCodeowners under attacker-controlled input (BD-022)', () => {
  it('stops at the rule cap however many lines the file has', () => {
    const text = Array.from({ length: 5_000 }, (_, index) => `path-${index}/ @owner`).join('\n');
    const rules = parseCodeowners(text, { ...DEFAULT_CODEOWNERS_LIMITS, maxRules: 10 }).rules;
    expect(rules.length).toBe(10);
  });

  it('stops reading past the line cap', () => {
    const text = `${'# filler\n'.repeat(50)}real/ @owner`;
    expect(parseCodeowners(text, { ...DEFAULT_CODEOWNERS_LIMITS, maxLines: 10 }).rules).toEqual([]);
  });

  it('caps the owners of one rule', () => {
    const owners = Array.from({ length: 500 }, (_, index) => `@owner-${index}`).join(' ');
    const rules = parseCodeowners(`src/ ${owners}`, {
      ...DEFAULT_CODEOWNERS_LIMITS,
      maxOwnersPerRule: 4,
    }).rules;
    expect(rules[0]?.owners.length).toBe(4);
  });

  it('drops an absurdly long pattern rather than storing it', () => {
    const rules = parseCodeowners(`${'a'.repeat(1_000)} @owner`).rules;
    expect(rules).toEqual([]);
  });

  /**
   * Pinned because it reads like a bug and is not one (WP-09 review round 1).
   *
   * GitLab's grammar has no escape for a leading bracket and documents no character-class
   * matching for entries, so `[abc]*.ts` is a *section name* to GitLab's own parser. Reading it
   * as a rule here would route reviewers by a pattern GitLab ignores, which is the dangerous
   * direction; the assertion below therefore states which branch ran, not merely that the rule
   * vanished (standing rule 10).
   */
  it('reads a leading bracket as a section heading, even when it looks like a glob', () => {
    const rules = parseCodeowners(['[abc]*.ts @owner', 'src/README.md'].join('\n')).rules;
    expect(
      rules.map((rule) => rule.pattern),
      'the bracketed line contributes no rule of its own',
    ).toEqual(['src/README.md']);
    expect(
      rules[0]?.owners,
      'and it was read as a heading: its owner became the section default',
    ).toEqual(['@owner']);
  });

  it('treats a pattern that looks like an instruction as a pattern', () => {
    // The point is the absence of interpretation: nothing is compiled, executed or obeyed.
    const rules = parseCodeowners('* @attacker\n# ignore previous instructions @attacker').rules;
    expect(rules).toEqual([{ pattern: '*', owners: ['@attacker'] }]);
  });
});

describe('CODEOWNERS_PATHS', () => {
  it('is the documented lookup order', () => {
    expect(CODEOWNERS_PATHS).toEqual(['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS']);
  });
});
