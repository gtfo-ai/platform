/**
 * **Every action the server records has words, and every word is for an action it records**
 * (S-25.22, BACKLOG 1372). `human_actions.action` is an open string on the wire, so no type holds
 * {@link HUMAN_ACTION_WORDS} to the server: this census reads the server's sources off disk
 * (`censusFiles` — tracked and untracked) and compares the two sets **in both directions**.
 *
 * What it reads as "an action the server records", outside comments, in the server's rings
 * (`apps/server/src`, `packages/{application,infrastructure,integrations}/src`, tests and fakes
 * excluded):
 *
 * - `action: '<a.b>'` — a command's `command({ action })`, `recordAction` input, an applier's entry;
 *   except `routes/commands.ts`' `taskCommand({ action, name })`, whose `action` is the **permission**
 *   the guard asks and whose `name` is what the row records (`action: route.name`);
 * - `const action = '<a.b>'` and `<NAME>_ACTION = '<a.b>'` — a route's constant;
 * - in a file that writes `insert into human_actions` itself (the worker writers, the pick audit),
 *   each `'worker.…'`/`'task.…'` literal, and the one template, `` `worker.device.${decision}` ``,
 *   expanded over the decision's two values.
 *
 * **Its limits, stated**: an action assembled any other way at run time, or named through a
 * variable from another module, is not seen. `sse/topic-access.ts` is excluded by name: its
 * `{ action }` is the permission a topic needs, not a record.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../../scripts/source-scanner.mjs';
import {
  actorName,
  HUMAN_ACTION_WORDS,
  humanActionWords,
  UNKNOWN_HUMAN_ACTION,
} from './human-actions.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const ACTION = '[a-z_]+(?:\\.[a-z_]+)+';
/** `taskCommand({ action: '<permission>', name: '<recorded>' })` in `routes/commands.ts`. */
const PERMISSION_THEN_NAME = new RegExp(`\\baction: '${ACTION}',\\s*name: '(${ACTION})'`, 'g');
const ACTION_PROPERTY = new RegExp(`\\baction: '(${ACTION})'`, 'g');
const ACTION_CONSTANT = new RegExp(`(?:\\bconst action|_ACTION) = '(${ACTION})'`, 'g');
const SQL_LITERAL = /'((?:worker|task)(?:\.[a-z_]+)+)'/g;
/** `worker.device.${input.decision}` — `WorkerDeviceDecisionInput.decision`. */
const DEVICE_TEMPLATE = /`worker\.device\.\$\{/;
const DEVICE_DECISIONS = ['approve', 'deny'] as const;

/** Every action `source` records, by the shapes above. */
export const recordedActions = (path: string, source: string): string[] => {
  if (path.endsWith('sse/topic-access.ts')) {
    return [];
  }
  const code = withoutComments(source);
  const found: string[] = [];
  const rest = code.replace(PERMISSION_THEN_NAME, (_match, name: string) => {
    found.push(name);
    return '';
  });
  for (const match of rest.matchAll(ACTION_PROPERTY)) found.push(match[1] as string);
  for (const match of rest.matchAll(ACTION_CONSTANT)) found.push(match[1] as string);
  if (/insert into human_actions/.test(code)) {
    for (const match of rest.matchAll(SQL_LITERAL)) found.push(match[1] as string);
    if (DEVICE_TEMPLATE.test(rest)) {
      found.push(...DEVICE_DECISIONS.map((decision) => `worker.device.${decision}`));
    }
  }
  return found;
};

describe('the recorded-action scanner (S-25.22)', () => {
  it.each([
    [
      'a command',
      "command({ request, action: 'task.retry_stage', key: 'required' })",
      'task.retry_stage',
    ],
    [
      'a constant',
      "export const SHADOW_START_ACTION = 'project.shadow.start';",
      'project.shadow.start',
    ],
    ['a local', "const action = 'integration.secrets.write';", 'integration.secrets.write'],
    [
      'the recorded name beside a permission',
      "taskCommand({\n    action: 'budget.write',\n    name: 'task.budget.raise',",
      'task.budget.raise',
    ],
    [
      'a worker writer',
      "insert into human_actions (user_id, action) values (${id}, ${paused ? 'worker.pause' : 'worker.resume'})",
      'worker.resume',
    ],
    [
      'the device template',
      'insert into human_actions values (${`worker.device.${input.decision}`})',
      'worker.device.deny',
    ],
  ])('finds %s', (_name, source, action) => {
    expect(recordedActions('apps/server/src/x.ts', source)).toContain(action);
  });

  it.each([
    [
      'the permission beside a name',
      "action: 'task.owner.take',\n    name: 'task.owner',",
      'task.owner.take',
    ],
    ['a comment', "/** action: 'task.gone' */\nconst a = 1;", 'task.gone'],
    ['a literal where nothing writes the table', "where h.action = 'worker.pause'", 'worker.pause'],
    ['an integration call', "action: 'mint_credential'", 'mint_credential'],
  ])('ignores %s', (_name, source, action) => {
    expect(recordedActions('apps/server/src/x.ts', source)).not.toContain(action);
  });

  it('ignores the permissions a topic needs', () => {
    expect(
      recordedActions('apps/server/src/sse/topic-access.ts', "return { action: 'org.read' };"),
    ).toEqual([]);
  });
});

describe('every recorded action has words, both directions (S-25.22, BACKLOG 1372)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: [
      'apps/server/src',
      'packages/application/src',
      'packages/infrastructure/src',
      'packages/integrations/src',
    ],
    include: (path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path) && !/\/testing\//.test(path),
  });
  const recorded = new Map<string, string>();
  for (const file of files) {
    for (const action of recordedActions(file.path, file.contents)) {
      if (!recorded.has(action)) recorded.set(action, file.path);
    }
  }

  it('has the writers to scan', () => {
    // One of each shape: a route command, a task command's name, a constant, a worker writer.
    expect(recorded.get('run.steer')).toBe('apps/server/src/routes/commands.ts');
    expect(recorded.get('task.budget.raise')).toBe('apps/server/src/routes/commands.ts');
    expect(recorded.has('task.start')).toBe(true);
    expect(recorded.has('worker.take_offer')).toBe(true);
    expect(recorded.has('worker.device.approve')).toBe(true);
    // The permission beside a recorded name is not a record.
    expect(recorded.has('task.owner.take')).toBe(false);
  });

  it('has words for every action the server records', () => {
    const missing = [...recorded]
      .filter(([action]) => !Object.hasOwn(HUMAN_ACTION_WORDS, action))
      .map(([action, path]) => `${action} (${path})`);
    expect(missing).toEqual([]);
  });

  it('has no words for an action nothing records', () => {
    expect(Object.keys(HUMAN_ACTION_WORDS).filter((action) => !recorded.has(action))).toEqual([]);
  });
});

describe('the words', () => {
  it('are a sentence, never the code name', () => {
    for (const [action, words] of Object.entries(HUMAN_ACTION_WORDS)) {
      expect(words, action).toMatch(/^[A-Z][^.]*[^.\s]$/);
      expect(words, action).not.toContain(action);
      expect(words, action).not.toMatch(/[a-z]\.[a-z]|_/);
    }
  });

  it('reads an unknown action as the unknown sentence, never its code name', () => {
    expect(humanActionWords('task.pause')).toBe('Paused the task');
    expect(humanActionWords('task.something_new')).toBe(UNKNOWN_HUMAN_ACTION);
    expect(humanActionWords('constructor')).toBe(UNKNOWN_HUMAN_ACTION);
  });

  it('names the actor by name, then e-mail, never by id', () => {
    const people = [
      { id: 'u1', name: 'Pat', email: 'pat@example.invalid' },
      { id: 'u2', name: null, email: 'kim@example.invalid' },
    ];
    expect(actorName('u1', people)).toBe('Pat');
    expect(actorName('u2', people)).toBe('kim@example.invalid');
    expect(actorName('u3', people, 'gone@example.invalid')).toBe('gone@example.invalid');
    expect(actorName('u3', undefined)).toBe('Someone');
    expect(actorName(null, people)).toBe('A removed account');
  });
});
