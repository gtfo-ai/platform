/**
 * The Librarian's read of a project's settings — WP-106, PROGRESS backlog 311's project half.
 *
 * Before WP-106 this read cast `projects.config`, so a stored value the schema refuses (and that
 * `GET …/config` refused with a 409) decided whether a proposal was auto-applied. It now parses the
 * column through the one reading the settings port and the route use, and a document that fails
 * throws {@link ProjectSettingsInvalidError} by name — never an empty layer.
 */

import { ProjectSettingsInvalidError, silentLogger } from '@platform/application';
import { describe, expect, it, vi } from 'vitest';
import { createLibrarianProjectRead } from './knowledge.js';

const PROJECT = '00000000-0000-4000-8000-0000000000c1' as never;

const readWith = (config: unknown) =>
  createLibrarianProjectRead(
    {
      query: vi.fn(async () => ({
        rows: [
          {
            knowledge_dir: '.agentic/knowledge',
            config,
            autonomy_policies: null,
            org_settings: {},
          },
        ],
        rowCount: 1,
      })),
    } as never,
    silentLogger,
  )(PROJECT);

describe('the Librarian’s project read', () => {
  it('refuses a stored pipeline.wip the schema refuses, by name, instead of reading it or reading nothing', async () => {
    const refused = readWith({ version: 1, pipeline: { wip: { max_parallel_tasks: 500 } } });
    await expect(refused).rejects.toBeInstanceOf(ProjectSettingsInvalidError);
    await expect(refused).rejects.toThrow(/pipeline\.wip\.max_parallel_tasks: 500/);
    await expect(refused).rejects.toThrow(
      /PUT \/api\/projects\/00000000-0000-4000-8000-0000000000c1\/config/,
    );
  });

  it('reads a document the schema admits, and the never-configured `{}`', async () => {
    const configured = await readWith({
      version: 1,
      policies: { knowledge_apply: { auto_apply: true } },
    });
    expect(configured?.thresholds.autoApply).toBe(true);
    expect((await readWith({}))?.thresholds.autoApply).toBe(false);
  });
});
