/**
 * **Every command the setup wizard can fire is reachable from a settings screen** — product/18:55.
 *
 * > *"Settings pages mirror the wizard one-to-one, so nothing is only reachable during
 * > onboarding."*
 *
 * That is a claim about two screens, and a claim about two screens decays the moment somebody adds
 * a control to one of them. `client-census.test.ts` is the precedent and this is its shape one layer
 * in: instead of comparing the client's paths against the router, it compares the **wizard's**
 * command set against the **settings screens'**, off disk, in both directions.
 *
 * ## How each half is obtained
 *
 * Both are read from the transitive closure of a screen's own relative imports, over every file git
 * knows about under `apps/web/src` — tracked **and** untracked-but-not-ignored, which is standing
 * rule 85: a guard that reads only `git ls-files` is green on a file the author has not committed,
 * so it would pass locally and fail on CI.
 *
 * A "command" is a TanStack mutation **invoked**: `something.<name>.mutate(`. That is what a control
 * a person can press compiles to, and it is why the closure matters — `features/operating-mode.tsx`
 * is rendered by the wizard *and* by the settings page, so every control in it belongs to both sets
 * without being written twice. Not having two of something is the only way a mirror stays true, and
 * this census is what notices when somebody makes a second one.
 *
 * ## What it cannot see, stated rather than implied
 *
 * A mutation invoked through a variable (`const run = commands.pause; run.mutate()`), a control
 * behind a dynamic `import()`, and a command fired from a module reached by a bare-specifier import
 * rather than a relative one. It also says nothing about whether a control **works**: `verify:ui`
 * renders the components and the e2e tier drives the endpoints.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repositoryRoot, webSourceFiles, withoutComments } from './web-sources.js';

/** The wizard, as one file: everything it can do is reachable from here. */
const WIZARD = 'apps/web/src/features/onboarding.tsx';

/**
 * The settings screens product/10 names: the project's own page, the org page and the integrations
 * page, which is where product/10 puts "test connection" and where an integration is created.
 */
const SETTINGS_SCREENS = [
  'apps/web/src/features/project-settings.tsx',
  'apps/web/src/features/settings.tsx',
  'apps/web/src/features/integrations.tsx',
];

/**
 * A wizard command the settings screens deliberately do not have, with the reason.
 *
 * It is an **admitted-omission list, not a filter**: the assertions below are equalities in both
 * directions, so an entry that stops being an omission fails, and one that was never a wizard
 * command fails too. A list that only suppressed failures would outlive what it excuses (standing
 * rule 7's corollary).
 */
const ADMITTED_OMISSIONS: Readonly<Record<string, string>> = {
  createProject:
    'a settings page belongs to a project that exists; creating one is the wizard’s first step and the dashboard’s "new project" action, not a setting of anything',
};

/** `./operating-mode.js` from `features/onboarding.tsx` → `apps/web/src/features/operating-mode.tsx`. */
const resolveRelative = (fromFile: string, specifier: string, known: ReadonlySet<string>) => {
  const base = resolve(dirname(join(repositoryRoot, fromFile)), specifier).slice(
    repositoryRoot.length,
  );
  // The repository writes `.js` on every relative import and the file on disk is `.ts`/`.tsx`.
  const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base];
  return candidates.find((candidate) => known.has(candidate));
};

const RELATIVE_IMPORT = /from\s+'(\.[^']*)'/g;
/** A TanStack mutation being fired: `commands.createProject.mutate(` — what a control compiles to. */
const MUTATION_CALL = /\.([A-Za-z][A-Za-z0-9_]*)\.mutate\(/g;

const commandsReachableFrom = (entry: string, files: ReadonlySet<string>): Set<string> => {
  const sources = new Map<string, string>();
  const read = (path: string): string => {
    const cached = sources.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const source = withoutComments(readFileSync(join(repositoryRoot, path), 'utf8'));
    sources.set(path, source);
    return source;
  };

  const seen = new Set<string>();
  const queue = [entry];
  const found = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const source = read(current);
    for (const [, name] of source.matchAll(MUTATION_CALL)) {
      if (name !== undefined) {
        found.add(name);
      }
    }
    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      const target =
        specifier === undefined ? undefined : resolveRelative(current, specifier, files);
      if (target !== undefined) {
        queue.push(target);
      }
    }
  }
  return found;
};

describe('the settings screens mirror the wizard (product/18:55)', () => {
  const files = new Set(webSourceFiles());

  it('finds both screens and the component they share', () => {
    // The scope, asserted before anything is concluded from it (standing rule 4): a sweep that
    // found nothing would report a perfectly clean mirror.
    expect(files.has(WIZARD)).toBe(true);
    for (const screen of SETTINGS_SCREENS) {
      expect(files.has(screen), screen).toBe(true);
    }
    expect(files.has('apps/web/src/features/operating-mode.tsx')).toBe(true);
  });

  it('reaches the shared operating-mode controls from both sides', () => {
    // The positive half (standing rule 10): "no missing command" is also satisfied by a sweep that
    // found no commands at all. These five are step 4's, and they are in one component precisely so
    // that both screens have them.
    const wizard = commandsReachableFrom(WIZARD, files);
    const settings = new Set(
      SETTINGS_SCREENS.flatMap((screen) => [...commandsReachableFrom(screen, files)]),
    );
    for (const command of ['setAutonomy', 'setProjectBudget', 'writeConfig']) {
      expect(wizard.has(command), `wizard ${command}`).toBe(true);
      expect(settings.has(command), `settings ${command}`).toBe(true);
    }
    // …and the two the wizard's step 1 and step 2 carry, which the settings page also has.
    for (const command of ['startDiscovery', 'putBindings']) {
      expect(wizard.has(command), `wizard ${command}`).toBe(true);
      expect(settings.has(command), `settings ${command}`).toBe(true);
    }
  });

  it('has every wizard command on a settings screen, or admits the omission with its reason', () => {
    const wizard = commandsReachableFrom(WIZARD, files);
    const settings = new Set(
      SETTINGS_SCREENS.flatMap((screen) => [...commandsReachableFrom(screen, files)]),
    );

    // Direction 1 — a control only the wizard has, which is what product/18:55 forbids.
    const missing = [...wizard].filter((command) => !settings.has(command)).sort();
    expect(missing.filter((command) => ADMITTED_OMISSIONS[command] === undefined)).toEqual([]);

    // Direction 2 — an omission that is no longer one, or was never a wizard command. Without this
    // the list is a filter that silently outlives what it excuses.
    expect(
      Object.keys(ADMITTED_OMISSIONS).filter(
        (command) => settings.has(command) || !wizard.has(command),
      ),
    ).toEqual([]);
  });

  it('names the controls the settings screens have and the wizard does not', () => {
    // The other direction is *allowed* — product/18:55 is about nothing being reachable **only**
    // during onboarding — but it is named rather than left silent, because a settings screen that
    // quietly lost `createIntegration` is PROGRESS backlog 55 happening again.
    const settings = new Set(
      SETTINGS_SCREENS.flatMap((screen) => [...commandsReachableFrom(screen, files)]),
    );
    // The create and test controls backlog 55 is about, and the organisation budget WP-30 added.
    for (const command of ['createIntegration', 'testIntegration', 'setOrgBudget']) {
      expect(settings.has(command), command).toBe(true);
    }
  });
});

describe('the mirror census’s own instruments', () => {
  it('follows a relative import across the closure and ignores a call in a comment', () => {
    // Calibrated on the real tree: `operating-mode.tsx` is reached from `onboarding.tsx` only
    // through its import, so a sweep that did not follow imports would find none of its commands.
    const files = new Set(webSourceFiles());
    const direct = commandsReachableFrom('apps/web/src/features/operating-mode.tsx', files);
    expect(direct.has('setAutonomy')).toBe(true);
    const throughTheWizard = commandsReachableFrom(WIZARD, files);
    expect(throughTheWizard.has('setAutonomy')).toBe(true);
    // A mutation named only in prose is not a control.
    expect([
      ...withoutComments('/**\n * calls commands.notAControl.mutate() one day\n */\n').matchAll(
        MUTATION_CALL,
      ),
    ]).toEqual([]);
  });
});
