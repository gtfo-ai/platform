/**
 * The offline half of the eval sets: what can be checked with no credential and no model.
 *
 * It is deliberately **not** a stand-in for running the evals — that is blocked and the blocker
 * brief is in `PROGRESS.md`. What it checks is the thing that rots without a model: a case whose
 * assertions read a field the artifact schema does not have. Those cases would fail against a
 * *correct* model, and the failure would be attributed to the prompt.
 *
 * Standing rule 3, stated plainly: this test fails when a case drifts from the schema and passes
 * otherwise. It says nothing whatever about whether a model would satisfy the case.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentRoleSchema, artifactDataSchemas } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { artifactSchemaPathFor, ROLE_EVALS, roleEvalPath } from './evals.js';

const ROLES = agentRoleSchema.options;
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('the eval sets', () => {
  it('ship one per role, and only for roles that exist', () => {
    expect(Object.keys(ROLE_EVALS).sort()).toEqual([...ROLES].sort());
  });

  it('give every case a globally unique id', () => {
    const ids = ROLES.flatMap((role) => ROLE_EVALS[role].cases.map((entry) => entry.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.each(ROLES.map((role) => [role] as const))('the %s eval set', (role) => {
  const set = ROLE_EVALS[role];

  it('is a file on disk with at least three cases', () => {
    expect(existsSync(roleEvalPath(role))).toBe(true);
    expect(set.cases.length).toBeGreaterThanOrEqual(3);
  });

  it('carries at least one case whose input tries to instruct the agent (BD-022)', () => {
    // Every role is exposed to untrusted text, so every role's eval set has to ask what it does
    // with an instruction inside one (standing rule 68 — the set is the ten roles).
    const hostile = set.cases.filter((entry) =>
      Object.values(entry.vars).some((value) =>
        /ignore all previous instructions|<system>/i.test(value),
      ),
    );
    expect(hostile.length).toBeGreaterThanOrEqual(1);
  });

  it('names only fields the artifact schema has', () => {
    if (set.artifact_type === null) {
      // A role with no artifact type has no schema to drift from; its assertions are the contract.
      expect(set.cases.every((entry) => entry.expect_fields.length > 0)).toBe(true);
      return;
    }
    const fields = new Set(Object.keys(artifactDataSchemas[set.artifact_type].shape));
    for (const entry of set.cases) {
      for (const field of entry.expect_fields) {
        expect(fields, `${entry.id} reads ${field}`).toContain(field);
      }
    }
  });

  it('actually reads every field it declares, so the declaration cannot go stale', () => {
    for (const entry of set.cases) {
      const assertions = entry.assert.map((assertion) => assertion.value).join('\n');
      for (const field of entry.expect_fields) {
        expect(assertions, `${entry.id} declares ${field}`).toContain(field);
      }
    }
  });

  it('points its is-json assertion at a generated schema that exists', () => {
    if (set.artifact_type === null) {
      expect(set.cases.every((entry) => entry.assert.every((a) => a.type !== 'is-json'))).toBe(
        true,
      );
      return;
    }
    const schemaPath = `${repoRoot}${artifactSchemaPathFor(set.artifact_type)}`;
    expect(existsSync(schemaPath), schemaPath).toBe(true);
    expect(JSON.parse(readFileSync(schemaPath, 'utf8'))).toHaveProperty('$schema');
    for (const entry of set.cases) {
      expect(entry.assert.some((assertion) => assertion.type === 'is-json')).toBe(true);
    }
  });
});
