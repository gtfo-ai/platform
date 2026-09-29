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
  projectPromptsForStage,
  projectPromptValueNotApplied,
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
