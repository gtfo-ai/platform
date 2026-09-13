/**
 * The platform's own three readiness answers (WP-21).
 *
 * `evaluateReadiness` is a pure fold and is tested where it lives; what is here is the thing that
 * *obtains* R9, R11 and R12 — and every one of its decisions is a failure mode rather than a happy
 * path, which is exactly the shape that reads as tested because the happy path runs constantly
 * (standing rule 67):
 *
 *  - a git provider that **throws** must produce `null` ("could not ask"), not `false`
 *    ("unprotected"), because the difference is what a human reads in a stored record;
 *  - a project that has **never been indexed** must produce `null`, not an empty list, because an
 *    empty vault is 0 % complete and an unindexed one is unknown (the knowledge ports' own rule);
 *  - `kb_documents.path` is repository-relative and `knowledgeCompleteness` compares
 *    **vault**-relative paths, so the knowledge directory has to come off — a mapping that is easy
 *    to get silently wrong, because getting it wrong produces 0 % rather than an error.
 *
 * The pool is scripted by SQL substring rather than mocked by call order: a test that depended on
 * the order of four independent reads would fail on a harmless reordering and say nothing.
 */
import type { PipelineIntegrationsPort } from '@platform/application';
import { silentLogger } from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createPlatformReadinessProbe } from './onboarding.js';

const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;

/** Answers each read by what its SQL names; anything unrecognised is a test bug, not an empty row. */
const scriptedPool = (rows: Readonly<Record<string, readonly Record<string, unknown>[]>>) =>
  ({
    query: async (text: string) => {
      for (const [needle, answer] of Object.entries(rows)) {
        if (text.includes(needle)) {
          return { rows: answer };
        }
      }
      throw new Error(`the test did not script a read matching: ${text}`);
    },
  }) as never;

/** A loader whose `forProject` either answers or throws — the two branches R9 has. */
const integrationsOf = (outcome: 'protected' | 'unprotected' | 'throws' | 'no-git') =>
  ({
    forProject: async () => {
      if (outcome === 'throws') {
        throw new Error('the git binding could not be loaded');
      }
      return {
        executor: {
          execute: async (request: { perform: () => Promise<unknown> }) => ({
            status: 'ok' as const,
            result: await request.perform(),
            attempts: 1,
            durationMs: 1,
          }),
        },
        git:
          outcome === 'no-git'
            ? null
            : {
                ref: { integrationId: PROJECT, provider: 'fake-git', type: 'git' as const },
                project: 'acme/api',
                port: {
                  getDefaultBranchHead: async () => ({ branch: 'main', sha: 'a'.repeat(40) }),
                  isBranchProtected: async () => outcome === 'protected',
                },
              },
        taskManagement: null,
      };
    },
  }) as unknown as PipelineIntegrationsPort;

const probeFor = (
  outcome: Parameters<typeof integrationsOf>[0],
  rows: Readonly<Record<string, readonly Record<string, unknown>[]>>,
) =>
  createPlatformReadinessProbe({
    pool: scriptedPool(rows),
    integrations: integrationsOf(outcome),
    logger: silentLogger,
  });

const indexed = (paths: readonly string[], built: boolean) => ({
  'from bindings b': [{ type: 'errors' }],
  'select knowledge_dir from projects': [{ knowledge_dir: '.agentic/knowledge' }],
  'from kb_documents d': paths.map((path) => ({ path, built })),
  'from kb_index_state': built ? [{ built: true }] : [],
});

describe('createPlatformReadinessProbe', () => {
  it('reports a protected default branch as protected', async () => {
    const signals = await probeFor('protected', indexed([], true)).read(PROJECT);
    expect(signals.defaultBranchProtected).toBe(true);
  });

  it('reports an unprotected branch as unprotected, which is not the same as unknown', async () => {
    const signals = await probeFor('unprotected', indexed([], true)).read(PROJECT);
    expect(signals.defaultBranchProtected).toBe(false);
  });

  it('answers null when the provider read throws, so R9 is "could not ask"', async () => {
    // Standing rule 18: an absent answer that silently becomes a definitive one is the defect. A
    // provider outage must not write "unprotected" into a record a human then acts on.
    const signals = await probeFor('throws', indexed([], true)).read(PROJECT);
    expect(signals.defaultBranchProtected).toBeNull();
  });

  it('answers null when the project has no git binding at all', async () => {
    const signals = await probeFor('no-git', indexed([], true)).read(PROJECT);
    expect(signals.defaultBranchProtected).toBeNull();
  });

  it('strips the knowledge directory, because completeness compares vault-relative paths', async () => {
    const signals = await probeFor(
      'protected',
      indexed(['.agentic/knowledge/business/overview.md', 'CLAUDE.md'], true),
    ).read(PROJECT);
    // The prefixed path loses the directory; a path outside it is passed through unchanged rather
    // than dropped, because the caller compares and this is not the place to decide.
    expect(signals.indexedKnowledgePaths).toEqual(['business/overview.md', 'CLAUDE.md']);
  });

  it('tells "never indexed" from "indexed and empty"', async () => {
    // Both directions (rule 42): `null` is unknown and `[]` is 0 % complete, and only one of them
    // is a claim about the project.
    expect(
      (await probeFor('protected', indexed([], false)).read(PROJECT)).indexedKnowledgePaths,
    ).toBeNull();
    expect(
      (await probeFor('protected', indexed([], true)).read(PROJECT)).indexedKnowledgePaths,
    ).toEqual([]);
  });

  it('reports the integration types the project is bound to', async () => {
    const signals = await probeFor('protected', {
      ...indexed([], true),
      'from bindings b': [{ type: 'errors' }, { type: 'git' }],
    }).read(PROJECT);
    expect(signals.boundIntegrationTypes).toEqual(['errors', 'git']);
  });
});
