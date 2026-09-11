/**
 * The scope argument is a checkable claim about **every** call site, so it is checked.
 *
 * `PipelineIntegrationsPort.forProject` takes an `IntegrationCallScope` because Q55's redactor
 * cannot be built at binding time, and the type makes supplying one unavoidable (standing rule 31).
 * What the type cannot do is stop the *seventh* call site — the one a later work package adds —
 * from writing an inline `{ runScopedSecrets: [] }` because that was quicker than deciding. An
 * empty literal and `noRunScopedSecrets()` compile identically and read completely differently:
 * one is a decision, the other is a default with no author.
 *
 * So this walks the ring's own sources and requires the named helper at every site. It is the shape
 * of the claim the ledger used to make in prose — "resolved at four call sites", which was wrong,
 * there were six (standing rules 7 and 37: a count is a claim, and a hand-maintained one drifts).
 * Deriving it from disk means the number is never stated at all.
 *
 * **What it cannot see** (standing rule 65, and the reason the gap is listed rather than implied):
 * a call whose scope arrives through a variable, a spread, or a helper of its own is invisible to a
 * text match; a call site in another ring — `apps/*` composes the loader but does not call
 * `forProject` today — is out of its scope by construction; and it cannot tell a *correct* empty
 * scope from an unconsidered one, only that somebody wrote the word.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const RING = dirname(fileURLToPath(import.meta.url));

/** Non-test sources of this directory, read off disk rather than listed here (rule 7). */
const sources = (): readonly { file: string; text: string }[] =>
  readdirSync(RING)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ file: name, text: readFileSync(join(RING, name), 'utf8') }));

/** `integrations.forProject(` — the integrations port, never `settings.forProject(`. */
const CALL = /integrations\s*\.\s*forProject\s*\(/g;

describe('every pipeline call into the integrations port', () => {
  it('names its scope with noRunScopedSecrets(), so a new one has to decide rather than default', () => {
    const offenders: string[] = [];
    let total = 0;

    for (const { file, text } of sources()) {
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        CALL.lastIndex = 0;
        if (!CALL.test(line)) {
          continue;
        }
        total += 1;
        // The scope may sit on the same line or on the next one; biome wraps at 100 characters.
        const window = [line, lines[index + 1] ?? '', lines[index + 2] ?? ''].join(' ');
        if (!window.includes('noRunScopedSecrets()')) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }

    expect(offenders).toEqual([]);
    // Standing rule 4: a sweep that reached nothing reports no offenders either. The floor is a
    // lower bound on the sites that exist today, not a count to maintain.
    expect(total).toBeGreaterThanOrEqual(6);
  });
});
