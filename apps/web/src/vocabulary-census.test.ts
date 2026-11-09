/**
 * **One word per concept** (S-23.23, the UX audit's § 4; research/19 rule 9): the words the audit
 * found naming one thing several ways, and the one each now uses. This census refuses the retired
 * spelling anywhere in the application's text outside a comment — the cheap half of the vocabulary,
 * the phrases a string can be checked for. The agreed words:
 *
 * | concept | the word | retired here |
 * |---|---|---|
 * | a person must act | **Needs you** (state), *a person* (prose) | "Escalated", "a human" |
 * | capacity | **slot**, on a **machine** | "free seat" |
 * | who runs it | **Runs on** | "claimant" in text |
 * | re-execution | **Retry** a stage, **Re-run** a run | "Retry run" |
 * | attempt | **Attempt 2** | "try 2", "2nd attempt" |
 * | a project's integrations | **Connections**, **Used by N projects** | "Bound to", "Not bound" |
 * | merge request | **merge request**, spelled out | "Open MR" |
 * | money vs tokens | **Cost**, **Cap**, **Token budget**; one window per label | "$… tokens", "Spend this month" |
 *
 * **S-25.5 (research/21 § 4, product/10's 2026-11-06 *Plain words* rule)** adds the internal terms a
 * person saw on a screen, each retired for its plain words — the census table, one row each:
 *
 * | internal term | the plain words |
 * |---|---|
 * | Tamper check, protected paths | **Protected files** |
 * | Rebase status, rebase gate | **Up to date**, *the up-to-date check* |
 * | Coverage delta, "+2.5 pp" | **Test coverage**, *+2.5 points* |
 * | Risk classes | **Sensitive areas** |
 * | Gate, System step, advisory | **Automatic check**, **Automatic step**, *for information only* |
 * | "costs an iteration of the loop" | *uses one of the rounds* |
 * | Context pack, in no context pack | **Knowledge given** (the run tab), *What the agent was given* (its heading), *never given to agents* |
 * | Steer | **Message the agent**, **Send** |
 * | Take over, Hand back, Taken over | **Work on it yourself**, **Give it back to the agent** |
 * | workpad | *the ticket's progress comment* |
 * | N redactions | *N secrets hidden* |
 * | local provider mode | *on a Claude subscription, cost is estimated* |
 * | vault, significance 0.72 | **knowledge base**; the score is dropped |
 * | pickup rule, WIP limits, lifecycle slot, bindings | **start rule**, **Parallel tasks**, *moment*, **connections** |
 * | probation | *extra checks on the first N tasks* |
 * | Re-queue | **Try again** |
 * | a raw role, integration type or project status | the label maps in `ui/humanize.ts` |
 *
 * **S-25.7** (product/10's 2026-11-06 IA amendment, research/21 F7 and F15) adds two more:
 *
 * | internal term | the plain words |
 * |---|---|
 * | Shadow, shadow batch, shadow mode, claim (shadow) | **Trial**, *a trial run*, **Trial runs** |
 * | N observations | *From N tasks* (what the samples count) |
 *
 * **S-25.20 adds the shape that printed a code value**: a record's enum field rendered bare as a
 * JSX child — `<Badge>{item.status}</Badge>`, `>{mapping.kind}<` — which put `review_only`,
 * `not_a_file` and `applied` on screens. {@link rawEnumsInJsx} refuses a child that is nothing but
 * a member access ending in `.status`, `.state`, `.kind`, `.mode`, `.type`, `.role`, `.outcome` or
 * `.cause`, on one line after a tag's `>` or alone on its line; the value goes through a label map
 * in `ui/words/*` instead (`STATUS_LABEL[item.status]` is not refused: the child is an index, not
 * the member). **Its limits**: a value given another name first (`const s = item.status`), a field
 * called anything else (`entry.action`, `block.decision` — free-form or another slice's, and
 * filed), a value inside a template literal or a prop, and a child split across lines with other
 * text are not seen; it is a census of the spelling that shipped, not a type check.
 *
 * **What it cannot see, stated**: a word assembled at run time, a server-written string (the
 * server's catalogues are their own census's), and a concept spelled a way this table does not
 * list. A word that is also a code identifier (`claimant_kind`, `escalated` as an enum value) is
 * matched only in the capitalised or phrase form the screen would print.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The retired spelling → the word the screens use instead. */
export const RETIRED_WORDS: readonly { readonly pattern: RegExp; readonly use: string }[] = [
  { pattern: /\bEscalated\b/, use: 'Needs you' },
  { pattern: /\b(?:by|to|for) a human\b/, use: 'a person' },
  { pattern: /\bfree seats?\b/, use: 'free slot' },
  { pattern: /\bown claimant\b/, use: 'Runs on' },
  { pattern: /\bRetry run\b/, use: 'Re-run' },
  { pattern: /\btry \$\{/, use: 'Attempt N' },
  { pattern: /\} attempt`/, use: 'Attempt N' },
  { pattern: /\bNot bound\b|\bBound to \b/, use: 'Used by N projects' },
  { pattern: /\bOpen MR\b/, use: 'Open merge request' },
  { pattern: /\} tokens · /, use: 'a cost in dollars, never "tokens"' },
  { pattern: /\bSpend this month\b/, use: 'one time window per label' },
  // S-25.5: research/21 § 4's census.
  { pattern: /\bTamper check\b|\btamper check\b/, use: 'Protected files' },
  { pattern: /\bRebase status\b|\brebase gate\b/, use: 'Up to date / the up-to-date check' },
  { pattern: /\bCoverage delta\b|\} pp`/, use: 'Test coverage, in points' },
  { pattern: /\bRisk classes\b/, use: 'Sensitive areas' },
  { pattern: /\bSystem step\b|word: 'Gate'|\(advisory:/, use: 'Automatic check / step' },
  { pattern: /\biteration of the loop\b/, use: 'one of the rounds' },
  {
    pattern: /\bContext pack\b|\bin no context pack\b/,
    use: 'Knowledge given / What the agent was given',
  },
  { pattern: /\bSteer the agent\b|label="Steer"|'Steer'/, use: 'Message the agent' },
  {
    pattern: /\bTake over…|'Take over'|\bTaken over\b|\bHand back\b|\bHand the task back\b/,
    use: 'Work on it yourself / Give it back to the agent',
  },
  { pattern: /\bworkpad\b/, use: 'the ticket’s progress comment' },
  { pattern: /\} redactions?\b|\b\d+ redactions?\b/, use: 'N secrets hidden' },
  { pattern: /\blocal provider mode\b/, use: 'on a Claude subscription, cost is estimated' },
  { pattern: /\b[Tt]he vault\b|\bsignificance \$\{/, use: 'knowledge base; no score' },
  { pattern: /\b[Pp]ickup rules?\b/, use: 'start rule' },
  { pattern: /\bWIP limits\b/, use: 'Parallel tasks' },
  // A lifecycle slot is a *moment* (the form's own word), never *step*, the pipeline's (review of PR #84).
  {
    pattern: /\bMap the slots\b|\blifecycle slots?\b|\bslots? empty\b|\bstep (?:unmapped|mapped)\b/,
    use: 'moment',
  },
  { pattern: /\bbindings (?:could|were) not\b|\bBound: /, use: 'connections' },
  { pattern: /\bon probation\b|\bProbation ends\b/, use: 'extra checks on the first N tasks' },
  { pattern: /\bRe-queue\b/, use: 'Try again' },
  // A raw role, integration type or project status (the last closed BACKLOG 1262 at S-25.7).
  {
    pattern: /`Role: \$\{user\.role\}`|<Badge>\{integration\.type\}|>\{project\.status\}</,
    use: 'a label map',
  },
  // S-25.7: *Shadow* is shown as *Trial*; the route and the contract keep their words.
  {
    pattern:
      /\bShadow (?:batch|batches|mode|screen|report|similarity)\b|\bclaim \(shadow\)|label: 'Shadow'/,
    use: 'Trial / a trial run',
  },
  { pattern: /\bobservations\b/, use: 'From N tasks' },
];

/** The enum-valued fields a record carries whose bare value is a code word, never a label. */
const ENUM_FIELDS = 'status|state|kind|mode|type|role|outcome|cause';
const MEMBER = `[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.(?:${ENUM_FIELDS})`;
/** After a tag's `>` on one line: `<Badge>{item.status}</Badge>`, `<span>{x.kind}</span>{' '}`. */
const RAW_ENUM_AFTER_TAG = new RegExp(`>\\s*\\{\\s*${MEMBER}\\s*\\}`);
/** Alone on its line, between a multi-line element's tags. */
const RAW_ENUM_ALONE = new RegExp(`^\\s*\\{\\s*${MEMBER}\\s*\\}\\s*$`);

/** Each line of `source` outside comments; a `//` that follows a non-space is kept (a URL). */
const codeLines = (source: string): string[] => {
  const kept = withoutComments(source, { keepLineComments: true }).split('\n');
  const cut = withoutComments(source).split('\n');
  return kept.map((line, index) => {
    const before = cut[index] ?? '';
    return before === line || before === '' || /\s$/.test(before) ? before : line;
  });
};

/** Every retired word in `source`, outside a comment, as `line: word → use`. */
export const retiredWords = (source: string): string[] =>
  codeLines(source).flatMap((text, index) =>
    RETIRED_WORDS.filter(({ pattern }) => pattern.test(text)).map(
      ({ pattern, use }) => `${index + 1}: ${pattern.source} → ${use}`,
    ),
  );

/** Every bare enum value rendered as a JSX child in `source`, outside a comment (S-25.20). */
export const rawEnumsInJsx = (source: string): string[] =>
  codeLines(source).flatMap((text, index) =>
    RAW_ENUM_AFTER_TAG.test(text) || RAW_ENUM_ALONE.test(text)
      ? [`${index + 1}: ${text.trim()}`]
      : [],
  );

describe('the raw-enum scanner (S-25.20)', () => {
  it.each([
    ['a badge', '<Badge>{record.mode}</Badge>'],
    ['a toned badge', '<Badge tone={TONE[command.state]}>{command.state}</Badge>'],
    ['a span before a space', '<span className="text-fg-muted">{citation.kind}</span>{\' \'}'],
    ['a deep member', '<Badge>{detail.task.state}</Badge>'],
    ['a child alone on its line', '<Badge tone="accent">\n  {mapping.kind}\n</Badge>'],
    ['a spaced child', '<p> { page.status } </p>'],
  ])('finds a raw enum in %s', (_name, source) => {
    expect(rawEnumsInJsx(source)).not.toEqual([]);
  });

  it.each([
    ['a label map', '<Badge>{RUN_MODE_LABEL[record.mode]}</Badge>'],
    ['an attribute', '<li data-command-state={command.state}>'],
    ['a comparison', "{record.mode === 'normal' ? null : <Badge>{label}</Badge>}"],
    ['a comment', '/* <Badge>{item.status}</Badge> */\nconst a = 1;'],
    ['another field', '<span>{entry.title}</span>'],
    ['a function of it', '<span>{statusWord(item.status)}</span>'],
  ])('ignores %s', (_name, source) => {
    expect(rawEnumsInJsx(source)).toEqual([]);
  });
});

describe('the vocabulary scanner', () => {
  it.each([
    ['a string literal', "const t = 'Escalated to a human.';"],
    ['JSX text', '<h2>\n  Taken over by a human\n</h2>'],
    ['a template literal', 'const t = `${count} free seats`;'],
    ['a button label', '<Button>Retry run</Button>'],
    ['a link label', '<ActionMenuLinkItem label="Open MR" />'],
    ['a badge', '<Badge>{`try ${stage.attempt}`}</Badge>'],
    // S-25.5: research/21 § 4's terms, one spelling each.
    ['a check row', "{ label: 'Tamper check' }"],
    ['a tab', "{ id: 'context', label: 'Context pack' }"],
    ['a steer box', '<input aria-label="Steer the agent" />'],
    ['a menu item', '<ActionMenuItem>Take over…</ActionMenuItem>'],
    ['a button', '<Button>Hand back</Button>'],
    ['a placeholder', 'placeholder="it goes onto the ticket’s workpad"'],
    ['a count', '{`${count} redactions`}'],
    ['a coverage value', 'return `${delta} pp`;'],
    ['a stage kind', "gate: { icon: ShieldCheckIcon, word: 'Gate' },"],
    ['a significance score', '`· significance ${score}`'],
    ['a raw role', '{`Role: ${user.role}`}'],
    ['a lifecycle slot called a step', "'None selected leaves the step unmapped.'"],
    ['a raw integration type', '<Badge>{integration.type}</Badge>'],
    // S-25.7.
    ['a raw project status', '<Badge tone="neutral">{project.status}</Badge>'],
    ['a shadow heading', '<SectionHeading>Shadow mode</SectionHeading>'],
    ['a shadow tab', "{ tab: 'shadow', label: 'Shadow', icon: EyeIcon },"],
    ['a shadow claim badge', "shadow: { label: 'claim (shadow)', tone: 'warning' },"],
    ['an observation count', '`${formatInteger(samples)} observations`'],
  ])('finds a retired word in %s', (_name, source) => {
    expect(retiredWords(source)).not.toEqual([]);
  });

  it.each([
    ['a comment', '/** Escalated to a human: the old word. */\nconst a = 1;'],
    ['a line comment', "// 'Open MR' was the card's label\nconst a = 1;"],
    ['an enum value', "const state = 'escalated';"],
    ['an identifier', 'const kind = run.claimant_kind;'],
    ['the agreed words', "const t = 'Needs you: handed to a person · 2 free slots · Re-run';"],
    // S-25.5: the identifiers the retired words are spelled like.
    [
      'an identifier spelled like a term',
      'const ref = task.workpad_ref; const steer = useSteer();',
    ],
    [
      'the plain words',
      "const t = 'Protected files · Up to date · Message the agent · 2 secrets hidden';",
    ],
    // S-25.7: the route, the contract's words and a mapped status are not the retired words.
    [
      'the trial words and the identifiers',
      "const t = 'Trial run · From 3 tasks · An observation, not an instruction'; to='/projects/$key/shadow'; useShadowBatches(); PROJECT_STATUS_LABEL[project.status];",
    ],
  ])('ignores %s', (_name, source) => {
    expect(retiredWords(source)).toEqual([]);
  });
});

describe('the screens use one word per concept (S-23.23)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.path === 'apps/web/src/features/stage-outcome.ts')).toBe(true);
  });

  it('finds no retired word outside a comment', () => {
    const offenders = files.flatMap((file) =>
      retiredWords(file.contents).map((found) => `${file.path}:${found}`),
    );
    expect(offenders).toEqual([]);
  });

  it('renders no bare enum value as a JSX child (S-25.20)', () => {
    const offenders = files
      .filter((file) => file.path.endsWith('.tsx'))
      .flatMap((file) => rawEnumsInJsx(file.contents).map((found) => `${file.path}:${found}`));
    expect(offenders).toEqual([]);
  });
});
