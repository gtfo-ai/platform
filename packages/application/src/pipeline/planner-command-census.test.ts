/**
 * WP-211 ruling (a) (backlog 607): the planner's two command tables add `allow` entries outside
 * the default lists WP-206's census reads (`command-policy.test.ts`), so this census holds every
 * first token of {@link COMMAND_ALLOW_BY_STAGE} and {@link COMMAND_ALLOW_BY_SKILL} on exactly one
 * reader, read off the constants. The domain's three readers — **known by name** (floored exactly,
 * a wrapper, shell, package runner or `git`, or a reader of a handed command), the **valve** and
 * **known by match only** — and a fourth, the planner's: a **subcommand valve**, a name on none of
 * the three whose every entry has its subcommand's option grammar cited
 * ({@link SKILL_COMMAND_GRAMMARS}). A program valve would exempt every subcommand of the name, and
 * `glab alias set --shell` and `acli rovodev` run programs (PROGRESS § WP-211). The other direction —
 * every recipe line of a skill admitted — is `test/contract/prompts/platform-skills.contract.test.ts`.
 */
import {
  COMMAND_READERS,
  decideUnattendedCommand,
  environmentSpellsFloor,
  evaluateCommand,
  FLOORED_NAMES,
  hazardousArguments,
  KNOWN_NON_WRAPPERS,
  PRECISE_ALLOW_ENTRIES,
  PROGRAMS_THAT_RUN_A_COMMAND,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  COMMAND_ALLOW_BY_SKILL,
  COMMAND_ALLOW_BY_STAGE,
  commandBaselineFor,
  SKILL_COMMAND_GRAMMARS,
  type SkillCommandGrammar,
} from './planner.js';

const firstToken = (entry: string): string => entry.trim().split(/\s+/)[0] as string;

/** The readers a first token stands on, among `entries` (the planner's entries naming it). */
const plannerReadersOf = (
  name: string,
  entries: readonly string[],
  grammars: Readonly<Record<string, unknown>> = SKILL_COMMAND_GRAMMARS,
): readonly string[] => {
  const named = entries.filter((entry) => firstToken(entry) === name);
  const byName =
    FLOORED_NAMES.includes(name) ||
    PROGRAMS_THAT_RUN_A_COMMAND.has(name) ||
    COMMAND_READERS.has(name);
  const valve = Object.hasOwn(KNOWN_NON_WRAPPERS, name);
  const byMatchOnly =
    !byName && named.every((entry) => PRECISE_ALLOW_ENTRIES.has(entry) || entry.trim() === name);
  const subcommandValve =
    !byName && !valve && !byMatchOnly && named.every((entry) => Object.hasOwn(grammars, entry));
  return [
    ...(byName ? ['known by name'] : []),
    ...(valve ? ['valve'] : []),
    ...(byMatchOnly ? ['known by match only'] : []),
    ...(subcommandValve ? ['subcommand valve'] : []),
  ];
};

/** `name: readers` for every first token of `entries` not on exactly one reader. */
const plannerCensus = (
  entries: readonly string[],
  grammars: Readonly<Record<string, unknown>> = SKILL_COMMAND_GRAMMARS,
): readonly string[] =>
  [...new Set(entries.map(firstToken))]
    .map((name) => [name, plannerReadersOf(name, entries, grammars)] as const)
    .filter(([, readers]) => readers.length !== 1)
    .map(([name, readers]) => `${name}: ${readers.join(', ') || 'no reader'}`);

const PLANNER_ENTRIES = [
  ...Object.values(COMMAND_ALLOW_BY_STAGE).flat(),
  ...Object.values(COMMAND_ALLOW_BY_SKILL).flat(),
];

describe('WP-211: every program the planner’s tables name is on exactly one reader (census)', () => {
  it('holds every stage and skill first token on exactly one reader', () => {
    expect(plannerCensus(PLANNER_ENTRIES)).toEqual([]);
  });

  it('names each first token with its reader', () => {
    expect(
      Object.fromEntries(
        [...new Set(PLANNER_ENTRIES.map(firstToken))].map((name) => [
          name,
          plannerReadersOf(name, PLANNER_ENTRIES),
        ]),
      ),
    ).toEqual({
      git: ['known by name'],
      logcli: ['subcommand valve'],
      'sentry-cli': ['known by name'],
      acli: ['subcommand valve'],
      jira: ['subcommand valve'],
      glab: ['subcommand valve'],
    });
  });

  it('cites a grammar for every skill entry, and for nothing else', () => {
    expect(Object.keys(SKILL_COMMAND_GRAMMARS).sort()).toEqual(
      Object.values(COMMAND_ALLOW_BY_SKILL).flat().sort(),
    );
    for (const [entry, grammar] of Object.entries(SKILL_COMMAND_GRAMMARS)) {
      expect(grammar.cli, entry).toMatch(new RegExp(`^${firstToken(entry)} \\d+\\.\\d+\\.\\d+`));
      expect(
        grammar.options.some((option) => /--(?:\[no-\])?help$/.test(option)),
        entry,
      ).toBe(true);
    }
  });

  it('refuses an entry for a program on no reader, naming it', () => {
    expect(plannerCensus([...PLANNER_ENTRIES, 'frobnicate *'])).toEqual(['frobnicate: no reader']);
    // A skill entry with no cited grammar is no subcommand valve.
    expect(plannerCensus([...PLANNER_ENTRIES, 'glab api *'])).toEqual(['glab: no reader']);
  });
});

/**
 * WP-211 review round 1 (backlog 625): an environment name that makes a skill CLI run a program
 * reads uncertain before the CLI, though the skill's `allow` entry admits the line without it.
 * `GLAB_PAGER='sudo id' glab mr view 1` read `allow` attended and `unattended_auto` with the skill
 * before the round (measured); the controls keep `allow`.
 */
describe('WP-211 review round 1: the environment a skill CLI runs a program from is uncertain', () => {
  const SKILLS = ['loki-logs', 'sentry-issue', 'jira-ticket', 'gitlab-mr'];
  const BASELINES = {
    implementation: commandBaselineFor('developer', 'implementation', SKILLS),
    read_only: commandBaselineFor('investigator', 'investigation', SKILLS),
  };
  const cell = (command: string, policy: (typeof BASELINES)['read_only']): string =>
    [
      evaluateCommand({ command }, policy).verdict,
      decideUnattendedCommand({ command }, policy, 'auto').rule,
      decideUnattendedCommand({ command }, policy, 'deny').rule,
    ].join(' / ');

  it.each([
    ["GLAB_PAGER='sudo id' glab mr view 1", 'glab'],
    ["env GLAB_PAGER='sudo id' glab mr view 1", 'glab'],
    ["export GLAB_PAGER='sudo id'; glab mr view 1", 'glab'],
    ['GLAB_CONFIG_DIR=/tmp/x glab mr view 1', 'glab'],
    ['GLAB_EDITOR=x glab mr diff 1', 'glab'],
    ["PAGER='sudo id' glab mr view 1", 'npm'],
    ["BROWSER='sudo id' glab mr view 1 -w", 'npm'],
    ["JIRA_PAGER='sudo id' jira issue view X-1", 'jira'],
    ['JIRA_BROWSER=x jira issue view X-1', 'jira'],
    ['JIRA_EDITOR=x jira issue list', 'jira'],
    ['ACLI_CONFIG_DIR=/tmp/x acli jira workitem view X-1', 'acli'],
  ])('%j reads ask / uncertain / uncertain, naming the %s floor', (command, verb) => {
    for (const [name, policy] of Object.entries(BASELINES)) {
      expect(cell(command, policy), name).toBe('ask / uncertain / uncertain');
      expect(evaluateCommand({ command }, policy).uncertainty, name).toContain(
        environmentSpellsFloor(verb),
      );
    }
  });

  it.each([
    'glab mr view 1',
    'glab mr view 1 -w',
    'jira issue view X-1',
    'acli jira workitem view X-1',
    'logcli query \'{app="x"}\' --since=1h',
  ])('control: %j keeps allow', (command) => {
    for (const [name, policy] of Object.entries(BASELINES)) {
      expect(cell(command, policy), name).toBe('allow / allow_list / allow_list');
    }
  });

  it('keeps glab off the floored names, so its other subcommands stay read', () => {
    expect(FLOORED_NAMES).not.toContain('glab');
    expect(
      evaluateCommand({ command: "glab alias set x '!sudo id'" }, BASELINES.implementation)
        .uncertainty,
    ).not.toEqual([]);
  });
});

/**
 * WP-221 ruling (b) (backlog 624): every grammar option marked `pathWriting` meets a `path` floor
 * of the domain's, in both spellings, on a line its entry admits. Omission fails closed: a marked
 * option with no floor, or one its grammar does not list, is named.
 */
const pathWritingSpellings = (
  grammars: Readonly<Record<string, SkillCommandGrammar>>,
): readonly { readonly entry: string; readonly option: string; readonly line: string }[] =>
  Object.entries(grammars).flatMap(([entry, grammar]) =>
    (grammar.pathWriting ?? []).flatMap((option) => {
      const long = option.split('/').at(-1) as string;
      const admitted = entry.replace(/\s*\*$/, ' x');
      return [`${long}=f`, `${long} f`].map((spelling) => ({
        entry,
        option,
        line: `${admitted} ${spelling}`,
      }));
    }),
  );

const pathWritingCensus = (
  grammars: Readonly<Record<string, SkillCommandGrammar>> = SKILL_COMMAND_GRAMMARS,
): readonly string[] => [
  ...Object.entries(grammars).flatMap(([entry, grammar]) =>
    (grammar.pathWriting ?? [])
      .filter((option) => !grammar.options.includes(option))
      .map((option) => `${entry}: ${option} is not an option of its grammar`),
  ),
  ...pathWritingSpellings(grammars)
    .filter(({ line }) => !hazardousArguments(line).some((floor) => floor.kind === 'path'))
    .map(({ entry, line }) => `${entry}: ${JSON.stringify(line)} meets no path floor`),
];

describe('WP-221, backlog 624: every path-writing grammar option meets a path floor (census)', () => {
  it('holds every marked option to a path floor, in both spellings', () => {
    expect(pathWritingSpellings(SKILL_COMMAND_GRAMMARS).map(({ line }) => line)).toEqual([
      'logcli query x --cpuprofile=f',
      'logcli query x --cpuprofile f',
      'logcli query x --memprofile=f',
      'logcli query x --memprofile f',
      'logcli query x --part-path-prefix=f',
      'logcli query x --part-path-prefix f',
    ]);
    expect(pathWritingCensus()).toEqual([]);
  });

  it('refuses a marked option with no floor, naming it', () => {
    const logcli = SKILL_COMMAND_GRAMMARS['logcli query *'] as SkillCommandGrammar;
    const marked = {
      ...SKILL_COMMAND_GRAMMARS,
      'logcli query *': { ...logcli, pathWriting: [...(logcli.pathWriting ?? []), '--limit'] },
    };
    expect(pathWritingCensus(marked)).toEqual([
      'logcli query *: "logcli query x --limit=f" meets no path floor',
      'logcli query *: "logcli query x --limit f" meets no path floor',
    ]);
  });

  it('refuses a mark its grammar does not list, naming it', () => {
    const logcli = SKILL_COMMAND_GRAMMARS['logcli query *'] as SkillCommandGrammar;
    const marked = {
      ...SKILL_COMMAND_GRAMMARS,
      'logcli query *': {
        ...logcli,
        pathWriting: [...(logcli.pathWriting ?? []), '--cpu-profile'],
      },
    };
    expect(pathWritingCensus(marked)).toEqual([
      'logcli query *: --cpu-profile is not an option of its grammar',
      'logcli query *: "logcli query x --cpu-profile=f" meets no path floor',
      'logcli query *: "logcli query x --cpu-profile f" meets no path floor',
    ]);
  });
});
