/**
 * WP-92: which project prompt file a stage is given, and in which state.
 *
 * The rule under test is rule 20's answer for this row, decided in `project-prompts.ts`: a file the
 * configuration **names** and the platform cannot read is still a block, with a status and no body
 * (the run proceeds and says so); a **convention** file the project never wrote is no block at all.
 */

import type { ConfigValues } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  isProjectPromptPath,
  MAX_PROJECT_PROMPT_FILES,
  type ProjectPromptReading,
  projectPromptPathOf,
  projectPromptReadingSummary,
  projectPromptsForStage,
  projectPromptValueNotApplied,
  stagePromptResolutions,
} from './project-prompts.js';
import type { RepositoryFileEntry } from './repository-config.js';

const file = (text: string): RepositoryFileEntry => ({
  kind: 'file',
  text,
  blobSha: 'c'.repeat(40),
});

const reading = (
  files: Record<string, RepositoryFileEntry>,
  truncated = false,
): ProjectPromptReading => ({ files, truncated });

describe('projectPromptPathOf', () => {
  it.each([
    ['prompts/implementation.md', '.agentic/prompts/implementation.md'],
    ['.agentic/prompts/implementation.md', '.agentic/prompts/implementation.md'],
    ['prompts/implementation.append.md', '.agentic/prompts/implementation.append.md'],
    ['prompts/docs-update.md', '.agentic/prompts/docs-update.md'],
  ])('resolves %s into the prompt directory', (value, expected) => {
    expect(projectPromptPathOf(value)).toBe(expected);
    expect(isProjectPromptPath(expected)).toBe(true);
  });

  it.each([
    'extra.md',
    'prompts/sub/dir.md',
    'prompts/../config.yml',
    'prompts/..md',
    'prompts/.hidden.md',
    '/etc/passwd',
    'prompts/*.md',
    'prompts/notes.txt',
    '.agentic/rules/x.md',
    'prompts/a b.md',
    `prompts/${'a'.repeat(98)}.md`,
  ])('refuses %s', (value) => {
    expect(projectPromptPathOf(value)).toBeNull();
  });

  it('accepts a name at the length bound and refuses one past it (rule 42)', () => {
    // 97 characters before `.md`: a leading character and up to 96 more.
    expect(projectPromptPathOf(`prompts/${'a'.repeat(98)}.md`)).toBeNull();
    expect(projectPromptPathOf(`prompts/${'a'.repeat(97)}.md`)).toBe(
      `.agentic/prompts/${'a'.repeat(97)}.md`,
    );
  });
});

describe('projectPromptsForStage', () => {
  it('gives no block to a project that wrote no prompt file and named none', () => {
    expect(projectPromptsForStage('implementation', {}, reading({}))).toEqual([]);
    expect(projectPromptsForStage('implementation', {}, null)).toEqual([]);
  });

  it('reads the convention files, prompt first and append second', () => {
    const blocks = projectPromptsForStage(
      'implementation',
      {},
      reading({
        '.agentic/prompts/implementation.append.md': file('Also run the linter.'),
        '.agentic/prompts/implementation.md': file('Use pnpm.'),
        '.agentic/prompts/refinement.md': file('Not this stage.'),
      }),
    );
    expect(blocks).toEqual([
      {
        key: 'prompt',
        status: 'read',
        path: '.agentic/prompts/implementation.md',
        body: 'Use pnpm.',
      },
      {
        key: 'prompt_append',
        status: 'read',
        path: '.agentic/prompts/implementation.append.md',
        body: 'Also run the linter.',
      },
    ]);
  });

  it('reads the files the configuration names instead of the convention ones', () => {
    const config: ConfigValues = {
      stages: {
        implementation: {
          prompt: 'prompts/dev.md',
          prompt_append: '.agentic/prompts/shared.md',
        },
      },
    };
    const blocks = projectPromptsForStage(
      'implementation',
      config,
      reading({
        '.agentic/prompts/implementation.md': file('the convention file, not named'),
        '.agentic/prompts/dev.md': file('named'),
        '.agentic/prompts/shared.md': file('shared'),
      }),
    );
    expect(blocks.map((block) => [block.key, block.path, block.body])).toEqual([
      ['prompt', '.agentic/prompts/dev.md', 'named'],
      ['prompt_append', '.agentic/prompts/shared.md', 'shared'],
    ]);
  });

  it('renders a named file it could not read with its status and no body — the run proceeds and says so', () => {
    const config: ConfigValues = {
      stages: {
        implementation: { prompt: 'prompts/missing.md', prompt_append: 'prompts/big.md' },
        code_review: { prompt: 'prompts/link.md', prompt_append: '../outside.md' },
      },
    };
    const files = reading({
      '.agentic/prompts/big.md': { kind: 'oversized', bytes: 20_000 },
      '.agentic/prompts/link.md': { kind: 'not_a_file', mode: '120000' },
    });
    expect(projectPromptsForStage('implementation', config, files)).toEqual([
      { key: 'prompt', status: 'absent', path: '.agentic/prompts/missing.md', body: '' },
      { key: 'prompt_append', status: 'oversized', path: '.agentic/prompts/big.md', body: '' },
    ]);
    expect(projectPromptsForStage('code_review', config, files)).toEqual([
      { key: 'prompt', status: 'not_a_file', path: '.agentic/prompts/link.md', body: '' },
      { key: 'prompt_append', status: 'outside_directory', path: '../outside.md', body: '' },
    ]);
  });

  it('says `unread` for a named file when no reading has read the directory, and nothing for the convention', () => {
    const config: ConfigValues = { stages: { implementation: { prompt: 'prompts/dev.md' } } };
    expect(projectPromptsForStage('implementation', config, null)).toEqual([
      { key: 'prompt', status: 'unread', path: '.agentic/prompts/dev.md', body: '' },
    ]);
  });

  it('says `not_listed` rather than `absent` when the directory was cut at its bound', () => {
    expect(projectPromptsForStage('implementation', {}, reading({}, true))).toEqual([
      { key: 'prompt', status: 'not_listed', path: '.agentic/prompts/implementation.md', body: '' },
      {
        key: 'prompt_append',
        status: 'not_listed',
        path: '.agentic/prompts/implementation.append.md',
        body: '',
      },
    ]);
    expect(MAX_PROJECT_PROMPT_FILES).toBe(64);
  });

  it('renders a convention file that exists but cannot be read — the project wrote it', () => {
    expect(
      projectPromptsForStage(
        'implementation',
        {},
        reading({ '.agentic/prompts/implementation.md': { kind: 'oversized', bytes: 17_000 } }),
      ),
    ).toEqual([
      { key: 'prompt', status: 'oversized', path: '.agentic/prompts/implementation.md', body: '' },
    ]);
  });

  it('gives one block when both keys name the same file', () => {
    const config: ConfigValues = {
      stages: {
        implementation: { prompt: 'prompts/x.md', prompt_append: '.agentic/prompts/x.md' },
      },
    };
    expect(
      projectPromptsForStage(
        'implementation',
        config,
        reading({ '.agentic/prompts/x.md': file('x') }),
      ),
    ).toEqual([{ key: 'prompt', status: 'read', path: '.agentic/prompts/x.md', body: 'x' }]);
  });

  it('does not read a file keyed by a prototype name', () => {
    const files = Object.create({ '.agentic/prompts/implementation.md': file('inherited') });
    expect(projectPromptsForStage('implementation', {}, reading(files))).toEqual([]);
  });
});

describe('projectPromptValueNotApplied', () => {
  it('names each prompt key whose value no reader reads, and none whose value resolves', () => {
    expect(
      projectPromptValueNotApplied({
        stages: {
          implementation: { prompt: 'prompts/ok.md', prompt_append: 'elsewhere/x.md' },
          refinement: { model: 'claude-sonnet-5' },
        },
      }),
    ).toEqual([
      {
        key: 'stages.implementation.prompt_append',
        reason: expect.stringMatching(/\.agentic\/prompts\//),
      },
    ]);
    expect(projectPromptValueNotApplied({})).toEqual([]);
  });
});

/**
 * WP-113 (backlog 315 (a)): the read surface's two halves. The resolution is the planner's own, so
 * every case is asserted against `projectPromptsForStage` too — the screen and the prompt agree by
 * construction, and these cases are what would notice if they stopped sharing it.
 */
describe('stagePromptResolutions', () => {
  const given = (stage: string, config: ConfigValues, at: ProjectPromptReading | null) =>
    stagePromptResolutions(stage, config, at)
      .filter((entry) => entry.given)
      .map((entry) => ({ key: entry.key, status: entry.status, path: entry.path }));
  const planned = (stage: string, config: ConfigValues, at: ProjectPromptReading | null) =>
    projectPromptsForStage(stage, config, at).map((block) => ({
      key: block.key,
      status: block.status,
      path: block.path,
    }));

  it('lists both keys of a stage, says which the planner gives, and never carries the text', () => {
    const at = reading({ '.agentic/prompts/implementation.md': file('Use pnpm.') });
    const resolved = stagePromptResolutions('implementation', {}, at);
    expect(resolved).toEqual([
      {
        stage: 'implementation',
        key: 'prompt',
        path: '.agentic/prompts/implementation.md',
        declared: false,
        status: 'read',
        given: true,
        cut: false,
      },
      {
        stage: 'implementation',
        key: 'prompt_append',
        path: '.agentic/prompts/implementation.append.md',
        declared: false,
        status: 'absent',
        given: false,
        cut: false,
      },
    ]);
    expect(JSON.stringify(resolved)).not.toContain('Use pnpm.');
    expect(given('implementation', {}, at)).toEqual(planned('implementation', {}, at));
  });

  it('says the cut applies one character past 8 000, and not at exactly 8 000 (rule 42)', () => {
    const at = (chars: number) =>
      reading({ '.agentic/prompts/review.md': file('x'.repeat(chars)) });
    const config: ConfigValues = { stages: { code_review: { prompt: 'prompts/review.md' } } };
    expect(stagePromptResolutions('code_review', config, at(8_000))[0]?.cut).toBe(false);
    expect(stagePromptResolutions('code_review', config, at(8_001))[0]).toMatchObject({
      declared: true,
      status: 'read',
      given: true,
      cut: true,
    });
  });

  it.each([
    ['no reading', {}, null],
    ['a declared file no reading has read', { stages: { x: { prompt: 'prompts/dev.md' } } }, null],
    ['a declared absent file', { stages: { x: { prompt: 'prompts/dev.md' } } }, reading({})],
    ['a truncated directory', {}, reading({}, true)],
    ['a value outside the directory', { stages: { x: { prompt_append: '../o.md' } } }, reading({})],
    [
      'both keys naming one file',
      { stages: { x: { prompt: 'prompts/a.md', prompt_append: 'prompts/a.md' } } },
      reading({ '.agentic/prompts/a.md': file('a') }),
    ],
    [
      'an oversized convention file',
      {},
      reading({ '.agentic/prompts/x.md': { kind: 'oversized', bytes: 17_000 } }),
    ],
  ] as const)('gives exactly what the planner gives: %s', (_name, config, at) => {
    expect(given('x', config as ConfigValues, at)).toEqual(
      planned('x', config as ConfigValues, at),
    );
  });

  it('marks an append naming the prompt file as not given — it is given once, under prompt', () => {
    const config: ConfigValues = {
      stages: { x: { prompt: 'prompts/a.md', prompt_append: 'prompts/a.md' } },
    };
    const resolved = stagePromptResolutions(
      'x',
      config,
      reading({ '.agentic/prompts/a.md': file('a') }),
    );
    expect(resolved.map((entry) => [entry.key, entry.status, entry.given])).toEqual([
      ['prompt', 'read', true],
      ['prompt_append', 'read', false],
    ]);
  });
});

describe('projectPromptReadingSummary', () => {
  it('publishes path, status, pre-cut length and the cut per file, sorted, never the text', () => {
    const summary = projectPromptReadingSummary(
      reading({
        '.agentic/prompts/z.md': file('y'.repeat(8_001)),
        '.agentic/prompts/m.md': file('m'.repeat(8_000)),
        '.agentic/prompts/a.md': file('Short instruction.'),
        '.agentic/prompts/big.md': { kind: 'oversized', bytes: 20_000 },
        '.agentic/prompts/link.md': { kind: 'not_a_file', mode: '120000' },
      }),
    );
    expect(summary).toEqual([
      { path: '.agentic/prompts/a.md', status: 'file', chars: 18, bytes: null, cut: false },
      {
        path: '.agentic/prompts/big.md',
        status: 'oversized',
        chars: null,
        bytes: 20_000,
        cut: false,
      },
      {
        path: '.agentic/prompts/link.md',
        status: 'not_a_file',
        chars: null,
        bytes: null,
        cut: false,
      },
      // Both sides of the cut (rule 42): exactly 8 000 is given whole, one more is cut.
      { path: '.agentic/prompts/m.md', status: 'file', chars: 8_000, bytes: null, cut: false },
      { path: '.agentic/prompts/z.md', status: 'file', chars: 8_001, bytes: null, cut: true },
    ]);
    expect(JSON.stringify(summary)).not.toContain('Short instruction.');
  });
});
