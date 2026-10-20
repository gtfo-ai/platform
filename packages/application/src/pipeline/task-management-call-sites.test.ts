/**
 * **Every task-management port call is made inside one executor call** (WP-212 review round 1).
 *
 * Since WP-212 no shipped adapter enters `IntegrationActionExecutor` itself, so the caller's wrap is
 * the only thing between a port call and an unaudited, unrate-limited, unscrubbed provider call —
 * and in shadow mode, between a mutation and a real write. Before WP-212 the Jira adapter's own wrap
 * was a backstop; replacing the pipeline's `statuses` wrap with a bare `binding.port.listStatuses()`
 * then survived the unit and contract tiers. This census is the backstop now: every call of a
 * `TaskManagementPort` member in product code is the body of a `perform` lambda handed directly to
 * the pipeline's `read` or `mutate` (`integrations.ts`), and the call sites are counted.
 *
 * A text census over every source git knows about, tracked or untracked (standing rule 85), with the
 * test tier and comments excluded. What it cannot see, stated rather than implied: a member reached
 * through a variable (`const read = port.readTicket`) or a computed name, a port not spelled
 * `….port`, and the prober's `testConnection`, which it reaches through `probeOf(port)` and wraps in
 * its own `test_connection` executor call (`bindings/prober.ts`).
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { censusPaths, censusText } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');

const MEMBERS = [
  'readTicket',
  'matchTickets',
  'transition',
  'upsertWorkpad',
  'addComment',
  'setLabels',
  'linkMergeRequest',
  'createTicket',
  'resolveIdentity',
  'listStatuses',
  'listTransitions',
  'selfIdentity',
  'assignToSelf',
  'unassign',
  'listComments',
  'testConnection',
] as const;

const PORT_CALL = new RegExp(`\\bport\\s*\\.\\s*(${MEMBERS.join('|')})\\s*\\(`, 'g');

const isTestTier = (file: string): boolean =>
  file.startsWith('test/') ||
  /\.(?:test|spec)\.[cm]?tsx?$/.test(file) ||
  /(?:^|\/)(?:testing|fixtures)\.ts$/.test(file) ||
  file.includes('/src/testing/');

/** The callee of the nearest call whose argument list encloses `index`, or `null`. */
export const enclosingCallee = (text: string, index: number): string | null => {
  let depth = 0;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = text[at];
    if (char === ')' || char === ']' || char === '}') {
      depth += 1;
    } else if (char === '(' || char === '[' || char === '{') {
      if (depth > 0) {
        depth -= 1;
      } else if (char === '(') {
        return /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, at - 80), at))?.[1] ?? null;
      }
    }
  }
  return null;
};

/** Is the call at `index` a `perform` lambda's body handed straight to `read` or `mutate`? */
export const isWrapped = (text: string, index: number): boolean =>
  /=>\s*$/.test(text.slice(Math.max(0, index - 200), index).replace(/\b\w+\s*\.\s*$/, '')) &&
  ['read', 'mutate'].includes(enclosingCallee(text, index) ?? '');

interface Site {
  readonly file: string;
  readonly member: string;
  readonly wrapped: boolean;
}

const sites = (): Site[] => {
  const found: Site[] = [];
  for (const file of censusPaths(REPO_ROOT, { pathspecs: ['*.ts', '*.tsx'] })) {
    if (isTestTier(file)) {
      continue;
    }
    const text = withoutComments(censusText(REPO_ROOT, file));
    for (const match of text.matchAll(PORT_CALL)) {
      found.push({ file, member: match[1] as string, wrapped: isWrapped(text, match.index) });
    }
  }
  return found;
};

describe('every task-management port call is inside one executor call (WP-212)', () => {
  // WP-249: slowest of 10 green CI runs 2370 ms (median 2138 ms); 2× it, 15 s floor.
  it('calls the port members from the pipeline’s ticket wrappers alone, fifteen times', () => {
    const counts: Record<string, number> = {};
    for (const site of sites()) {
      counts[site.file] = (counts[site.file] ?? 0) + 1;
    }
    expect(counts).toEqual({ 'packages/application/src/pipeline/integrations.ts': 15 });
  }, 15_000);

  // WP-249: slowest of 10 green CI runs 2203 ms (median 1957 ms); 2× it, 15 s floor.
  it('makes every one of them the body of a perform lambda handed to read or mutate', () => {
    const bare = sites().filter((site) => !site.wrapped);
    expect(bare.map((site) => `${site.file} › port.${site.member}`)).toEqual([]);
  }, 15_000);

  it('tells a wrapped call from a bare one (the census’s own control, rule 42)', () => {
    const wrapped =
      'read(integrations, ref, "x", {}, ctx, async () =>\n  binding.port.listStatuses(),\n);';
    const bare = 'statuses: async (context) => {\n  return binding.port.listStatuses();\n},';
    const bareArrow = 'statuses: async (context) => binding.port.listStatuses(),';
    const at = (text: string) => text.indexOf('binding.port');
    expect(isWrapped(wrapped, at(wrapped))).toBe(true);
    expect(isWrapped(bare, at(bare))).toBe(false);
    expect(isWrapped(bareArrow, at(bareArrow))).toBe(false);
  });
});
