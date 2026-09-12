import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/eval.mjs` refuses, and refuses for the **stated** reasons.
 *
 * Standing rule 33: a guard shipped as a `scripts/*.mjs` step has no test tier of its own, so
 * mutating the guard passes the whole suite — `check-ignored.test.ts` is the precedent this copies.
 * Here the guard *is* the refusal: the whole value of `pnpm eval` in a repository with no promptfoo
 * and no credential is that it exits non-zero and says what a human must provide, and the failure
 * mode to prevent is the one PROGRESS backlog 8 records live — a check that scanned nothing and
 * printed a green line.
 *
 * The credential case is asserted **both ways** (standing rule 42): an empty `ANTHROPIC_API_KEY`
 * must be reported as missing (rule 18 — an empty credential is not a credential) and a non-empty
 * one must not be. Without the second half, a guard that reported "missing" unconditionally would
 * pass.
 */
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'eval.mjs');

const run = (env: Record<string, string | undefined>) => {
  const result = spawnSync(process.execPath, [SCRIPT, '--check'], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};

describe('pnpm eval', () => {
  it('exits non-zero and names promptfoo when it is not installed', () => {
    const { status, output } = run({});
    expect(status).toBe(1);
    expect(output).toContain('promptfoo is not installed');
    expect(output).toContain('pnpm add -Dw promptfoo');
    expect(output).toContain('FAIL: eval');
    // The line that must never appear on a run that evaluated nothing.
    expect(output).not.toContain('PASS: eval\n');
  });

  it('treats an empty credential as no credential (standing rule 18)', () => {
    const { output } = run({ ANTHROPIC_API_KEY: '   ' });
    expect(output).toContain('no model credential is set');
    expect(output).toContain('llm-ci');
  });

  it('does not report the credential missing when one is set', () => {
    const { status, output } = run({ ANTHROPIC_API_KEY: 'sk-ant-obviously-fake-eval-key' });
    // promptfoo is still absent, so the run still fails — but for one reason, not two.
    expect(status).toBe(1);
    expect(output).not.toContain('no model credential is set');
    expect(output).toContain('promptfoo is not installed');
  });

  it('refuses a role that is not an AgentRole', () => {
    const { status, output } = run({});
    expect(status).toBe(1);
    const bad = spawnSync(process.execPath, [SCRIPT, '--roles=not_a_role', '--check'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..'),
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-obviously-fake-eval-key' },
    });
    expect(bad.status).toBe(1);
    expect(`${bad.stdout}${bad.stderr}`).toContain('unknown role');
    expect(output).toContain('Nothing was evaluated');
  });
});
