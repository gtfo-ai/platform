/**
 * **Server text a screen shows as it is, in plain words** (S-23.22, the final UX audit's item 2;
 * extended at S-25.5, research/21 § 4 and F18).
 *
 * Most of what the server writes — a problem document's `message`, a refusal's reason — is a
 * diagnostic, and the web app shows it only behind *Technical details*. A few sentences are written
 * *for* a screen and rendered there verbatim; those are listed here and held to the web side's rule
 * (`apps/web/src/spec-reference-census.test.ts`, `apps/web/src/admin-names-census.test.ts`): no spec
 * reference, no environment variable, no `.agentic/` path, no API path, no id, no table row.
 *
 * **Two halves, because the sentences have two shapes.**
 *
 *  - **Constants** are held whole, against every pattern: the list below is by hand, and says so — a
 *    new user-facing constant is added here when it is written.
 *  - **Sentences built at run time** — research/21 § 4's list: the readiness `notice.message`,
 *    `escalation.reason` and `brief`, the shadow and bootstrap `blocked_reason`,
 *    `findings_unrecorded.reason` and `withheld.reason` — have no value to test, only the module that
 *    writes them. Each module's code (comments removed) is held to the **spec-reference** pattern,
 *    which a sentence is the only place in code to carry. The escalation's producers are many and
 *    grow, so they are **discovered**, not listed: every non-test source under `packages/domain`,
 *    `packages/application` and `apps/server` that names a `blockerBrief`/`blocker_brief` or defines
 *    a `…Brief` builder. The other fields' writers are few and named, each with the marker that
 *    proves it is still the writer, so the list cannot outlive the code it names.
 *
 * **What it cannot see, stated**: a sentence assembled out of another module's words (a provider's
 * reason, a secret store's) is that module's; a producer of an escalation that names neither marker;
 * an id or an API path inside a run-time sentence (the source half reads spec references only —
 * `run <id>: …` in a lease sweep's escalation reason is the known instance); and the worker's
 * `state.reason`, which belongs to the worker session and is not listed here.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_BOOTSTRAP_BLOCKED_DETAIL,
  PATTERN_READING_WITHHELD_REASON,
  SHADOW_BATCH_BLOCKED_DETAIL,
} from '@platform/application';
import {
  BINDING_ACCOUNT_IS_A_PERSON_MESSAGE,
  KNOWLEDGE_COMPLETENESS_SECTIONS,
  LIFECYCLE_NOT_CONFIGURED_MESSAGE,
  READINESS_CRITERIA,
} from '@platform/domain';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import { censusFiles } from '../../../../scripts/census-files.mjs';
import { withoutComments } from '../../../../scripts/source-scanner.mjs';
import { ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE } from './integration-queries.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every server sentence a screen renders verbatim, by name. */
const USER_FACING: Readonly<Record<string, string>> = {
  ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE,
  // S-25.3: what a project uses an integration for — `used_by[].uses[].label`, shown as it is.
  ...Object.fromEntries(
    SHIPPED_PROVIDERS.flatMap((provider) =>
      provider.usageFields.map((usage) => [`${provider.id} use: ${usage.field}`, usage.label]),
    ),
  ),
  // S-25.5: the shadow and history-bootstrap screens' `blocked_reason`.
  ...Object.fromEntries(
    Object.entries(SHADOW_BATCH_BLOCKED_DETAIL).map(([code, text]) => [
      `shadow blocked: ${code}`,
      text,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(HISTORY_BOOTSTRAP_BLOCKED_DETAIL).map(([code, text]) => [
      `bootstrap blocked: ${code}`,
      text,
    ]),
  ),
  // S-25.5: `prompts_withheld.reason` for a reading stored before exact redaction.
  PATTERN_READING_WITHHELD_REASON,
  // S-25.5: two readiness `notices[].message` the read computes from the binding.
  LIFECYCLE_NOT_CONFIGURED_MESSAGE,
  BINDING_ACCOUNT_IS_A_PERSON_MESSAGE,
  // S-25.5, BACKLOG 1241: what a criterion and a knowledge section unlock, on the wizard's panel.
  ...Object.fromEntries(
    READINESS_CRITERIA.map((criterion) => [`unlocks: ${criterion.id}`, criterion.unlocks]),
  ),
  ...Object.fromEntries(
    KNOWLEDGE_COMPLETENESS_SECTIONS.map((section) => [`unlocks: ${section.id}`, section.unlocks]),
  ),
};

const SPEC_REFERENCE = /\b(?:BD|TD|WP|Q)-?\d+\b|product\/\d+|technical\/\d+|PROGRESS/;

const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['a spec reference', SPEC_REFERENCE],
  ['an environment variable', /\bAPP_[A-Z0-9_]+|(?<![A-Za-z0-9])_FILE\b/],
  ['a repository path', /\.agentic\//],
  ['an API path', /\/api\//],
  ['an id', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['a table row or a sealing word', /\bsecrets row\b|\bdecrypt|\bre-?seal/i],
];

describe('server sentences a screen shows verbatim are plain words (S-23.22)', () => {
  it.each(Object.entries(USER_FACING))('%s', (_name, text) => {
    const found = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([what]) => what);
    expect(found).toEqual([]);
  });

  it.each(FORBIDDEN)('the check sees %s', (what, pattern) => {
    // Calibration: each pattern refuses the old sentence's kind of text.
    const planted = {
      'a spec reference': 'see WP-157',
      'an environment variable': 'a changed APP_SECRET_KEY',
      'a repository path': 'none of .agentic/prompts/',
      'an API path': 'PATCH /api/integrations/x',
      'an id': 'integration 00000000-0000-4000-8000-00000000a358',
      'a table row or a sealing word': 'a damaged secrets row',
    }[what];
    expect(pattern.test(planted ?? '')).toBe(true);
  });
});

// ── The sentences built at run time (S-25.5, F18) ─────────────────────────────

/** A non-test source of the rings that write what a screen shows. */
const isRingSource = (path: string): boolean =>
  /^(?:packages\/(?:domain|application)|apps\/server)\/src\/.+\.ts$/.test(path) &&
  !/\.test\.ts$/.test(path) &&
  !path.includes('/testing/');

/** A module that writes an escalation's reason or brief, or builds a brief another module uses. */
const ESCALATION_WRITER = /\bblocker_?[bB]rief\b|\b[A-Za-z]+Brief\s*=\s*\(/;

/**
 * The named writers of the other fields research/21 § 4 lists, each with the marker that proves it
 * still writes that field — `notice.message`, `findings_unrecorded.reason`, `withheld.reason`.
 */
const NAMED_WRITERS: readonly {
  readonly field: string;
  readonly path: string;
  readonly marker: RegExp;
}[] = [
  {
    field: 'notice.message',
    path: 'packages/domain/src/readiness/ci-rules.ts',
    marker: /\bmessage: bounded\(/,
  },
  {
    field: 'notice.message',
    path: 'packages/domain/src/readiness/criteria.ts',
    marker: /\bmessage: `/,
  },
  {
    field: 'notice.message',
    path: 'packages/domain/src/lifecycle/readiness-notes.ts',
    marker: /\bCONSEQUENCE\b/,
  },
  {
    field: 'findings_unrecorded.reason',
    path: 'packages/application/src/recovery/discovery-record.ts',
    marker: /\brecovery pass asked for it once more\b/,
  },
  {
    field: 'withheld.reason',
    path: 'packages/application/src/config/repository-config.ts',
    marker: /\bconst withheldPrompts\b/,
  },
  {
    field: 'blocked_reason',
    path: 'packages/application/src/shadow/batch.ts',
    marker: /\bSHADOW_BATCH_BLOCKED_DETAIL\b/,
  },
];

/** Every spec reference in `source`'s code, comments removed, as `line: reference`. */
export const specReferencesInCode = (source: string): string[] =>
  withoutComments(source)
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(new RegExp(SPEC_REFERENCE, 'g'))].map(
        (match) => `${index + 1}: ${match[0]}`,
      ),
    );

describe('the modules that build a screen’s server sentences cite no spec (S-25.5, F18)', () => {
  const sources = censusFiles(REPO_ROOT, {
    pathspecs: ['packages/domain/src', 'packages/application/src', 'apps/server/src'],
    include: isRingSource,
  });
  const byPath = new Map(sources.map((file) => [file.path, file.contents]));
  const escalationWriters = sources.filter((file) => ESCALATION_WRITER.test(file.contents));

  it('discovers the escalation writers, and still finds each named writer’s field', () => {
    // An empty walk would report a clean scan of nothing; these are known writers.
    expect(escalationWriters.length).toBeGreaterThan(15);
    for (const known of [
      'packages/application/src/pipeline/saga.ts',
      'packages/application/src/pipeline/gate-outage.ts',
      'packages/application/src/recovery/stranded-stage.ts',
      'packages/domain/src/pipeline/interpreter.ts',
    ]) {
      expect(
        escalationWriters.some((file) => file.path === known),
        known,
      ).toBe(true);
    }
    for (const writer of NAMED_WRITERS) {
      const contents = byPath.get(writer.path);
      expect(contents, `${writer.path} exists`).toBeDefined();
      expect(
        writer.marker.test(contents ?? ''),
        `${writer.path} still writes ${writer.field}`,
      ).toBe(true);
    }
  });

  it('finds no spec reference in their code outside a comment', () => {
    const scanned = [
      ...escalationWriters.map((file) => file.path),
      ...NAMED_WRITERS.map((writer) => writer.path),
    ];
    const offenders = [...new Set(scanned)].flatMap((path) =>
      specReferencesInCode(byPath.get(path) ?? '').map((found) => `${path}:${found}`),
    );
    expect(offenders).toEqual([]);
  });

  it('the scan sees a reference in a sentence and ignores one in a comment (calibration)', () => {
    expect(
      specReferencesInCode(
        "const brief = 'the gate gave up (PROGRESS backlog 490)';\nconst b = `see it (WP-49)`;",
      ),
    ).toEqual(['1: PROGRESS', '2: WP-49']);
    expect(specReferencesInCode('/** WP-49: why. */\n// TD-031 §2\nconst a = 1;')).toEqual([]);
    expect(ESCALATION_WRITER.test('export const gateOutageBrief = (facts) =>')).toBe(true);
    expect(ESCALATION_WRITER.test('{ reason, blockerBrief: brief }')).toBe(true);
    expect(ESCALATION_WRITER.test('const briefing = 1;')).toBe(false);
  });
});
