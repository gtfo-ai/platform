/**
 * **No environment variable or configuration key in visible copy** (S-23.22, the final UX audit's
 * item 11; research/19 § 3 item 8).
 *
 * `APP_BOOTSTRAP_ADMIN_EMAIL`, `APP_INTEGRATION_HOSTS`, a `_FILE` companion, the repository's
 * `.agentic/config.yml` and a dotted key such as `features.history_bootstrap.budget_usd` are exact
 * names for the person who edits the server's environment or the repository. On a screen they read
 * as noise to everyone else, so the copy says it in a plain sentence and the name moves into the
 * collapsed **For administrators** disclosure, whose texts all live in one module,
 * `ui/admin-notes.tsx`. This census refuses such a name anywhere else in the application's sources.
 *
 * **What it reads**: every `.ts`/`.tsx` under `apps/web/src` that git knows about, tracked or
 * untracked (`scripts/census-files.mjs`), tests excluded, with comments removed by the shared
 * scanner — so a comment may still name the variable it explains.
 *
 * **What it looks for**: an `APP_*` name, a `_FILE` companion, an `.agentic/` path, and a dotted or
 * snake-case key written as `<code>…</code>` (`<code>policies.reviewers</code>`,
 * `<code>status_mapping</code>`). **What it cannot see, stated**: a configuration key in prose
 * outside a `<code>` — `(features.human_time.per_user_breakdown)` in a string reads the same as
 * `formatUsd(features.maintenance.budget_usd)` in code, so a general dotted-key rule would refuse
 * every property access — and JSX text after a `//` on the same line, which the scanner reads as a
 * comment.
 *
 * **The opt-out list** names a file another slice owns while this one lands; every entry must still
 * match, so an entry outlives nothing it excuses.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../scripts/census-files.mjs';
import { withoutComments } from '../../../scripts/source-scanner.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The one module the names may be written in. */
const NOTES_MODULE = 'apps/web/src/ui/admin-notes.tsx';

export const ADMIN_NAME =
  /\bAPP_[A-Z0-9_]+|(?<![A-Za-z0-9])_FILE\b|\.agentic\/|<code>\s*[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\s*<\/code>/g;

/** `path` → why its names are left for now. */
const OPT_OUT: Readonly<Record<string, string>> = {
  // S-23.20 owns this file while S-23.22 lands; BACKLOG 933 moves its `.agentic/config.yml`.
  'apps/web/src/features/execution-settings.tsx': 'owned by S-23.20 (BACKLOG 933)',
  // The worker's local page (`worker/*`, another slice's) names `APP_WORKER_UI_AUTH` to the person
  // who runs that worker and set it; BACKLOG 938 decides whether it moves behind the disclosure.
  'apps/web/src/worker/worker-app.tsx':
    'the worker operator’s own page, owned elsewhere (BACKLOG 938)',
};

/**
 * **Commands, not prose.** A line the person copies and pastes — a shell command or an env-file
 * line in a `CopyField` — must carry the exact name, so it is excused here **by its exact source
 * text**, never by file: prose elsewhere in the same file is still read. Each entry must still
 * match, so one that outlives its line fails.
 */
const COMMAND_LINES: Readonly<
  Record<string, readonly { readonly text: string; readonly why: string }[]>
> = {
  'apps/web/src/features/worker-wizard-steps.ts': [
    {
      // Split so the linter does not read the literal as a template.
      text: 'coreUrlLine: `APP_CORE_URL=$' + '{origin}`,',
      why: 'the `.env.worker` line the Add a worker wizard copies (worker-wizard.tsx, a CopyField)',
    },
  ],
};

/** Every administrator-only name in `source` outside a comment, with its line and its text. */
export const adminNames = (source: string): { line: number; name: string; text: string }[] =>
  withoutComments(source)
    .split('\n')
    .flatMap((text, index) =>
      [...text.matchAll(ADMIN_NAME)].map((match) => ({
        line: index + 1,
        name: match[0],
        text: text.trim(),
      })),
    );

describe('the administrator-name scanner', () => {
  it.each([
    [
      'an environment variable in JSX text',
      '<p>Use APP_BOOTSTRAP_ADMIN_EMAIL.</p>',
      ['APP_BOOTSTRAP_ADMIN_EMAIL'],
    ],
    ['a _FILE companion in a string', "const h = 'its _FILE companion';", ['_FILE']],
    ['the repository file', '<code>.agentic/config.yml</code>', ['.agentic/']],
    [
      'a dotted key in code',
      '<code>policies.reviewers</code>',
      ['<code>policies.reviewers</code>'],
    ],
    ['a snake-case key in code', '<code>status_mapping</code>', ['<code>status_mapping</code>']],
  ])('finds %s', (_name, source, expected) => {
    expect(adminNames(source).map((found) => found.name)).toEqual(expected);
  });

  it.each([
    ['a comment', '// APP_INTEGRATION_HOSTS is the allow-list\nconst a = 1;'],
    ['a JSX comment', '<p>{/* features.x.y */}text</p>'],
    ['a command in code', '<code>npm test</code>'],
    ['a file name in code', '<code>CLAUDE.md</code>'],
    ['a constant that merely ends in _FILE', 'const PROMPT_FILE = 1;'],
    ['a word containing APP', "'MAPP_X and WRAPPED'"],
  ])('ignores %s', (_name, source) => {
    expect(adminNames(source)).toEqual([]);
  });
});

describe('visible copy names no environment variable or configuration key (S-23.22)', () => {
  const files = censusFiles(REPO_ROOT, {
    pathspecs: ['apps/web/src'],
    include: (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path),
  });

  it('has the sources to scan, and the notes module holds the names', () => {
    expect(files.length).toBeGreaterThan(80);
    const notes = files.find((file) => file.path === NOTES_MODULE);
    expect(notes).toBeDefined();
    // The module the names moved into is read by the same scanner and does hold them.
    expect(adminNames(notes?.contents ?? '').length).toBeGreaterThan(5);
  });

  it('finds them only in the notes module', () => {
    const offenders: string[] = [];
    const excused = new Set<string>();
    const commandsUsed = new Set<string>();
    for (const file of files) {
      if (file.path === NOTES_MODULE) {
        continue;
      }
      const commands = COMMAND_LINES[file.path] ?? [];
      const found = adminNames(file.contents).filter((entry) => {
        const command = commands.find((each) => each.text === entry.text);
        if (command !== undefined) {
          commandsUsed.add(`${file.path}\0${command.text}`);
        }
        return command === undefined;
      });
      if (found.length === 0) {
        continue;
      }
      if (Object.hasOwn(OPT_OUT, file.path)) {
        excused.add(file.path);
        continue;
      }
      offenders.push(...found.map((entry) => `${file.path}:${entry.line}: ${entry.name}`));
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(OPT_OUT).filter((path) => !excused.has(path))).toEqual([]);
    const staleCommands = Object.entries(COMMAND_LINES).flatMap(([path, entries]) =>
      entries
        .filter((entry) => !commandsUsed.has(`${path}\0${entry.text}`))
        .map((entry) => `${path}: ${entry.text}`),
    );
    expect(staleCommands).toEqual([]);
  });
});
