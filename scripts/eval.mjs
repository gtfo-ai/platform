#!/usr/bin/env node
/**
 * `pnpm eval` — run the role-prompt evals (TD-016, product/13 § "Prompt quality process").
 *
 *   node scripts/eval.mjs             run every role's eval set
 *   node scripts/eval.mjs --roles a,b run only those roles
 *   node scripts/eval.mjs --check     report what is missing and exit non-zero; run nothing
 *
 * ## This script's first job is to refuse
 *
 * `CLAUDE.md` has documented a `pnpm eval` since WP-00 and there was no script; WP-17 owns adding
 * or dropping that line. It is added — as a command that **fails loudly and names exactly what a
 * human must provide** — because the alternative on offer was worse than nothing.
 *
 * > **An eval that ran nothing and reported green is worse than no eval.** Standing rule 18's
 * > shape ("an empty credential is not a credential"), and PROGRESS backlog **8** is the same
 * > defect live in this repository right now: a gitleaks scan of zero bytes printing
 * > `no leaks found`.
 *
 * So: every precondition is checked *before* anything runs, an unmet one is a non-zero exit with
 * the exact remedy, and the only path to exit 0 is promptfoo having actually evaluated cases.
 * There is no `--skip`, no "no cases, nothing to do" success, and no default credential.
 *
 * ## What it builds
 *
 * The checked-in artefacts are the platform's: `packages/prompts/roles/<role>/evals/cases.json`
 * (validated offline by `evals.test.ts`), `packages/prompts/roles/<role>/prompt.md`, and
 * `packages/prompts/evals/promptfoo.base.json`. promptfoo's own input shape is **generated** into a
 * temporary directory from those three plus `PLATFORM_PROMPT` from `@platform/domain` — so layer 1
 * has exactly one copy in this repository, and the prompt the evals measure is assembled from the
 * same constant production assembles from.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import './ts-source-resolver.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const promptsRoot = path.join(repoRoot, 'packages', 'prompts');

const { PLATFORM_PROMPT } = await import('../packages/domain/src/prompt/assembly.ts');
const { agentRoleSchema } = await import('../packages/contracts/src/common.ts');

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const rolesArg = argv.find((arg) => arg.startsWith('--roles='));
const roles = rolesArg === undefined ? agentRoleSchema.options : rolesArg.slice(8).split(',');

/** Every reason this cannot run, gathered before anything is attempted. */
const blockers = [];

if (spawnSync('pnpm', ['exec', 'promptfoo', '--version'], { cwd: repoRoot }).status !== 0) {
  blockers.push({
    what: 'promptfoo is not installed',
    why: 'TD-016 makes promptfoo the eval runner; it is not a dependency of this repository',
    remedy: 'pnpm add -Dw promptfoo',
  });
}

const credential = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'].find(
  // An empty string is not a credential (standing rule 18): `?? ''` and `|| ''` are how an unset
  // secret becomes a permissive default, and this is the check that refuses it.
  (name) => (process.env[name] ?? '').trim() !== '',
);
if (credential === undefined) {
  blockers.push({
    what: 'no model credential is set',
    why: 'the anthropic:claude-agent-sdk provider calls a live model; there is no offline provider that would measure a prompt',
    remedy:
      'export ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) locally; in CI, create the `llm-ci` environment and give it an ANTHROPIC_API_KEY secret (13-implementation-plan.md names `llm-ci` for WP-33)',
  });
}

for (const role of roles) {
  if (!agentRoleSchema.options.includes(role)) {
    blockers.push({
      what: `unknown role ${JSON.stringify(role)}`,
      why: 'roles come from `agentRoleSchema`',
      remedy: `use one of: ${agentRoleSchema.options.join(', ')}`,
    });
  }
}

if (blockers.length > 0 || checkOnly) {
  if (blockers.length === 0) {
    process.stdout.write('eval: every precondition is met; re-run without --check\n');
    process.stdout.write('PASS: eval --check\n');
    process.exit(0);
  }
  process.stderr.write('\npnpm eval cannot run. What is missing:\n\n');
  for (const blocker of blockers) {
    process.stderr.write(
      `  * ${blocker.what}\n    why: ${blocker.why}\n    fix: ${blocker.remedy}\n\n`,
    );
  }
  process.stderr.write(
    'Nothing was evaluated. This exit is deliberate: an eval that ran nothing and reported green\n' +
      'is worse than no eval (standing rule 18). See docs/technical/PROGRESS.md, WP-17.\n',
  );
  process.stderr.write('FAIL: eval\n');
  process.exit(1);
}

// ── build promptfoo's input from the platform's own artefacts ────────────────

const base = JSON.parse(
  readFileSync(path.join(promptsRoot, 'evals', 'promptfoo.base.json'), 'utf8'),
);
const work = mkdtempSync(path.join(tmpdir(), 'agentic-eval-'));
let failed = 0;

try {
  writeFileSync(path.join(work, 'platform-prompt.md'), PLATFORM_PROMPT, 'utf8');
  for (const role of roles) {
    const set = JSON.parse(
      readFileSync(path.join(promptsRoot, 'roles', role, 'evals', 'cases.json'), 'utf8'),
    );
    const rolePrompt = readFileSync(path.join(promptsRoot, 'roles', role, 'prompt.md'), 'utf8');
    const varNames = [...new Set(set.cases.flatMap((entry) => Object.keys(entry.vars)))];
    const userMessage = varNames
      .map(
        (name) =>
          `## ${name}\n\n<untrusted-data-{{ nonce }} kind="${name}">\n{{ ${name} }}\n</untrusted-data-{{ nonce }}>`,
      )
      .join('\n\n');
    writeFileSync(
      path.join(work, `${role}-prompt.json`),
      JSON.stringify(
        [
          {
            role: 'system',
            content: `${PLATFORM_PROMPT}\n\n## Your role: ${role}\n\n${rolePrompt}`,
          },
          { role: 'user', content: userMessage },
        ],
        null,
        2,
      ),
      'utf8',
    );
    const nonce = 'e'.repeat(32);
    writeFileSync(
      path.join(work, `${role}.json`),
      JSON.stringify(
        {
          ...base,
          description: `${role} role prompt, ${set.cases.length} cases`,
          prompts: [`file://${role}-prompt.json`],
          tests: set.cases.map((entry) => ({
            description: `${entry.id}: ${entry.description}`,
            vars: { ...entry.vars, nonce },
            assert: entry.assert.map((assertion) =>
              assertion.type === 'is-json'
                ? {
                    ...assertion,
                    value: `file://${path.join(repoRoot, assertion.value.replace(/^file:\/\/(\.\.\/)+/, ''))}`,
                  }
                : assertion,
            ),
          })),
        },
        null,
        2,
      ),
      'utf8',
    );
    const result = spawnSync(
      'pnpm',
      ['exec', 'promptfoo', 'eval', '-c', path.join(work, `${role}.json`)],
      { cwd: repoRoot, stdio: 'inherit' },
    );
    if (result.status !== 0) failed += 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(failed === 0 ? 'PASS: eval\n' : `FAIL: eval (${failed} role(s) failed)\n`);
process.exit(failed === 0 ? 0 : 1);
