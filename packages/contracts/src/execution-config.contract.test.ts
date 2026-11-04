/**
 * `.agentic/config.yml` refuses an `execution` key **by name** (WP-278 criterion 2, TD-031 decision
 * 8): where a project's runs execute is an administrator's setting (`PUT /api/projects/:id/execution`),
 * and a pushed commit must not change it (BD-025's config-trust reasoning). A strict schema would
 * refuse the key anyway as "unrecognized"; this holds that the refusal says why, whatever the value.
 */
import { describe, expect, it } from 'vitest';
import { agenticConfigSchema } from './config.js';

describe('.agentic/config.yml and the execution settings', () => {
  it.each([
    { mode: 'workers_only' },
    { mode: 'hybrid', prefer: 'server' },
    'server_only',
    {},
    null,
  ])('refuses an execution key (%j) by name, pointing at the settings page', (value) => {
    const parsed = agenticConfigSchema.safeParse({ version: 1, execution: value });
    expect(parsed.success).toBe(false);
    const issues = parsed.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toEqual(['execution']);
    expect(issues[0]?.message).toMatch(/execution is not a repository setting/);
    expect(issues[0]?.message).toMatch(/PUT \/api\/projects\/:id\/execution/);
  });

  it('still accepts a document with no execution key', () => {
    expect(agenticConfigSchema.safeParse({ version: 1 }).success).toBe(true);
  });
});
