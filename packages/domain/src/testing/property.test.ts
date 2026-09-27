/**
 * The fixed seed reaches every property in this package (PROGRESS backlog 253).
 *
 * The seed is set as a side effect of importing `property.ts`, and vitest isolates each test file,
 * so a file that runs `fc.assert` without importing it draws a fresh seed per run — the defect the
 * seed exists to remove. This census holds every such file, tracked **and** untracked (standing
 * rule 85), to the import.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import { PROPERTY_SEED } from './property.js';

const repositoryRoot = new URL('../../../../', import.meta.url).pathname;
const RUNS_A_PROPERTY = /\bfc\s*\.\s*(?:assert|check)\s*\(/;
const IMPORTS_SETTINGS =
  /from\s+['"][^'"]*testing\/property\.js['"]|import\s+['"][^'"]*testing\/property\.js['"]|from\s+['"]\.\/property\.js['"]/;

/** Every file under `packages/domain/src` that runs a property and does not take the seed. */
const unseededProperties = (
  files: readonly { readonly path: string; readonly contents: string }[],
): string[] =>
  files
    .filter(({ path }) => !path.endsWith('/testing/property.ts'))
    .filter(({ contents }) => RUNS_A_PROPERTY.test(contents) && !IMPORTS_SETTINGS.test(contents))
    .map(({ path }) => path);

describe('the package’s fast-check seed', () => {
  it('is set once this module is imported', () => {
    expect(fc.readConfigureGlobal().seed).toBe(PROPERTY_SEED);
  });

  it('reaches every file in the package that runs a property', () => {
    const files = censusFiles(repositoryRoot, {
      pathspecs: ['packages/domain/src'],
      include: (path) => path.endsWith('.ts'),
    });
    expect(files.some(({ contents }) => RUNS_A_PROPERTY.test(contents))).toBe(true);
    expect(unseededProperties(files)).toEqual([]);
  });

  it('names a planted property file that does not import the settings', () => {
    expect(
      unseededProperties([
        { path: 'packages/domain/src/a.test.ts', contents: 'fc.assert(fc.property(x, f));' },
        {
          path: 'packages/domain/src/b.test.ts',
          contents: "import '../testing/property.js';\nfc.assert(p);",
        },
      ]),
    ).toEqual(['packages/domain/src/a.test.ts']);
  });
});
