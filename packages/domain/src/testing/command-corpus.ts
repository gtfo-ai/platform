/**
 * The agent-line corpus's three cells (WP-208, TD-030 decision 4): what the default policy answers
 * for one command line attended, under `auto` and under `deny`, each with the reason tag that
 * decided it. `scripts/command-corpus.mjs --write` records them in
 * `test/fixtures/commands/*.verdicts.json` and `policies/command-corpus.test.ts` recomputes them, so
 * both read the cells through this one function and a scanner change's over-ask is a diff of cells.
 *
 * Not part of the package's public API, as `testing/property.ts` is not. Nothing executes: the
 * cells are the policy's answers and nothing else.
 */
import {
  type CommandEvaluation,
  DEFAULT_COMMAND_POLICY,
  environmentSpellsFloor,
  evaluateCommand,
  expansionCompletesBlockEntry,
  flagValueHidesBlockEntry,
  hazardousArguments,
  UNCERTAINTY,
  unknownProgramRunsJudgedName,
  unreadGitConfigKey,
  xargsCompletesBlockEntry,
} from '../policies/command-policy.js';
import {
  decideUnattendedCommand,
  gitBoundaryViolation,
  type UnattendedCommandDecision,
} from '../policies/unattended-commands.js';

/** One line's cells. A cell is a value, or `value: tag` when the value is not `allow`. */
export interface CorpusCells {
  readonly attended: string;
  readonly auto: string;
  readonly deny: string;
}

export const CORPUS_MODES = ['attended', 'auto', 'deny'] as const;

const CONSTANT_REASONS = new Map<string, string>(
  Object.entries(UNCERTAINTY).map(([name, text]) => [text, name]),
);

/**
 * The uncertainty reasons built from an argument, read back as `builder(argument, …)`: each builder
 * is called with placeholders and the text around them becomes a pattern.
 */
const BUILT_REASONS = Object.entries({
  environmentSpellsFloor,
  expansionCompletesBlockEntry,
  flagValueHidesBlockEntry,
  unknownProgramRunsJudgedName,
  unreadGitConfigKey,
  xargsCompletesBlockEntry,
} as Record<string, (...args: string[]) => string>).map(([name, build]) => {
  const placeholders = Array.from({ length: build.length }, (_, index) => `\u0001${index}\u0002`);
  // A placeholder may stand more than once and out of order: its first place captures, the rest
  // must repeat what it captured.
  const source = placeholders.reduce(
    (escaped, placeholder, index) =>
      escaped.replace(placeholder, `(?<a${index}>.*?)`).replaceAll(placeholder, `\\k<a${index}>`),
    build(...placeholders).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return { name, arity: build.length, pattern: new RegExp(`^${source}$`, 's') };
});

/** `handedCommand`, `xargsCompletesBlockEntry(rm -rf /*)`, or the text itself when unnamed. */
export const uncertaintyTag = (reason: string): string => {
  const constant = CONSTANT_REASONS.get(reason);
  if (constant !== undefined) {
    return constant;
  }
  for (const { name, arity, pattern } of BUILT_REASONS) {
    const groups = pattern.exec(reason)?.groups;
    if (groups !== undefined) {
      const args = Array.from({ length: arity }, (_, index) => groups[`a${index}`]);
      return `${name}(${args.join(', ')})`;
    }
  }
  return reason;
};

const tagged = (value: string, tag: string): string => `${value}: ${tag}`;
const askTag = (evaluation: CommandEvaluation): string => evaluation.matched ?? 'unmatched';
const uncertainTags = (reasons: readonly string[]): string =>
  reasons.map(uncertaintyTag).join('; ');

const attendedCell = (evaluation: CommandEvaluation): string => {
  if (evaluation.verdict === 'block') {
    return tagged('block', evaluation.matched ?? '');
  }
  if (evaluation.uncertainty.length > 0) {
    return tagged('uncertain', uncertainTags(evaluation.uncertainty));
  }
  return evaluation.verdict === 'allow' ? 'allow' : tagged('ask', askTag(evaluation));
};

const unattendedCell = (command: string, decision: UnattendedCommandDecision): string => {
  const { evaluation } = decision;
  switch (decision.rule) {
    case 'allow_list':
      return 'allow';
    case 'unattended_auto':
      return tagged('auto', askTag(evaluation));
    case 'unattended_deny':
      return tagged('deny', askTag(evaluation));
    case 'block_list':
      return tagged('block', evaluation.matched ?? '');
    case 'git_boundary':
      return tagged('git', gitBoundaryViolation(command)?.detail ?? '');
    case 'hazardous_argument': {
      const hazard = hazardousArguments(decision.fragment ?? command).find(
        (entry) => entry.kind !== 'path',
      );
      return tagged('hazard', hazard?.pattern ?? '');
    }
    case 'uncertain':
      return tagged(
        'uncertain',
        uncertainTags(
          evaluation.uncertainty.length > 0
            ? evaluation.uncertainty
            : [gitBoundaryViolation(command)?.detail ?? ''],
        ),
      );
  }
};

/** One cell of one line under the default policy. */
const corpusCell = (command: string, mode: (typeof CORPUS_MODES)[number]): string =>
  mode === 'attended'
    ? attendedCell(evaluateCommand({ command }, DEFAULT_COMMAND_POLICY))
    : unattendedCell(command, decideUnattendedCommand({ command }, DEFAULT_COMMAND_POLICY, mode));

/** The three cells of one line under the default policy. */
export const corpusCells = (command: string): CorpusCells => ({
  attended: corpusCell(command, 'attended'),
  auto: corpusCell(command, 'auto'),
  deny: corpusCell(command, 'deny'),
});

/**
 * A corpus file's lines: one command per line, refused when a line is blank or repeated, because
 * the verdicts file is keyed by the line.
 */
export const corpusLines = (text: string, file: string): readonly string[] => {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      throw new Error(`${file}:${index + 1} is blank; a corpus line is a command`);
    }
    if (seen.has(line)) {
      throw new Error(`${file}:${index + 1} repeats ${JSON.stringify(line)}`);
    }
    seen.add(line);
  }
  return lines;
};

/** The verdicts file's text: one entry per line, in corpus order. */
export const verdictsText = (lines: readonly string[]): string =>
  `${JSON.stringify(Object.fromEntries(lines.map((line) => [line, corpusCells(line)])), null, 2)}\n`;

/** One changed cell: `line | cell | before | after`. */
export interface CellChange {
  readonly line: string;
  readonly cell: (typeof CORPUS_MODES)[number];
  readonly before: string | undefined;
  readonly after: string;
}

/** The value a cell carries, without its tag. */
const cellValue = (cell: string | undefined): string | undefined => cell?.split(':')[0];
const refuses = (cell: string | undefined): boolean => {
  const value = cellValue(cell);
  return value !== undefined && value !== 'allow' && value !== 'auto' && value !== 'ask';
};

/**
 * Every cell that differs between the recorded verdicts and the recomputed ones, and the two counts
 * a scanner row quotes: cells newly refused (a run that ran no longer runs, or an attended line is
 * now refused or uncertain) and cells newly allowed (the converse).
 */
export const corpusDiff = (
  recorded: Readonly<Record<string, Partial<CorpusCells>>>,
  lines: readonly string[],
): {
  readonly changes: readonly CellChange[];
  readonly newlyRefused: number;
  readonly newlyAllowed: number;
} => {
  const changes: CellChange[] = [];
  for (const line of lines) {
    for (const cell of CORPUS_MODES) {
      const before = recorded[line]?.[cell];
      // A policy that throws is a changed cell on every line it throws for, not one stopped census.
      let after: string;
      try {
        after = corpusCell(line, cell);
      } catch (error) {
        after = `throws: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (before !== after) {
        changes.push({ line, cell, before, after });
      }
    }
  }
  const newlyRefused = changes.filter(
    (change) => !refuses(change.before) && refuses(change.after),
  ).length;
  const newlyAllowed = changes.filter(
    (change) => refuses(change.before) && !refuses(change.after),
  ).length;
  return { changes, newlyRefused, newlyAllowed };
};
