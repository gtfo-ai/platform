/**
 * The one copy of the policy, held to the original (WP-15j review round 3).
 *
 * What the header *is* is asserted where it is served — `web-serving.test.ts` over three paths,
 * `test/e2e/server/web-bundle.e2e.test.ts` through a whole process, `test/web-e2e/csp.spec.ts` in
 * a real browser. What cannot be asserted there is that
 * `scripts/web-compose-check.mjs` — which measures the **image**, from a plain Node process whose
 * version this repository does not pin, and therefore keeps a literal copy rather than importing
 * `csp.ts` — still holds the same string. A copy nobody compares is the drift this file exists to
 * refuse (standing rule 62).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY } from './csp.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');

/** The value of the script's own `CONTENT_SECURITY_POLICY`, read out of its source. */
const policyInComposeCheck = (source: string): string => {
  const assignment = /const CONTENT_SECURITY_POLICY =([\s\S]*?);\n/.exec(source);
  if (assignment === null) {
    throw new Error('scripts/web-compose-check.mjs declares no CONTENT_SECURITY_POLICY');
  }
  // The literal is written as concatenated fragments so the source stays inside the line width;
  // joining them back is what makes the comparison about the policy rather than about formatting.
  const fragments = assignment[1]?.match(/"[^"]*"/g) ?? [];
  return fragments.map((fragment) => fragment.slice(1, -1)).join('');
};

describe('the content-security-policy', () => {
  it('is spelled the same way in the compose check as in the server', () => {
    const source = readFileSync(join(REPO, 'scripts', 'web-compose-check.mjs'), 'utf8');
    expect(policyInComposeCheck(source)).toBe(CONTENT_SECURITY_POLICY);
  });

  it('is a well-formed serialisation with no directive stated twice', () => {
    const directives = CONTENT_SECURITY_POLICY.split('; ');
    const names = directives.map((directive) => directive.split(' ')[0]);
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/[;,]\s*$/);
    expect(new Set(names).size).toBe(names.length);
    // A directive with a name and no source list allows nothing and is almost never what was
    // meant; `'none'` is how that is said on purpose.
    expect(directives.filter((directive) => !directive.includes(' '))).toEqual([]);
  });
});
