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
import { artifactSchemaPathFor, caseArtifactType, ROLE_EVALS, roleEvalPath } from './evals.js';

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
    for (const entry of set.cases) {
      // Per case since WP-40: a case may name an artifact type of its own when the role produces a
      // second one (`caseArtifactType`), so the schema this is held to is the case's.
      const type = caseArtifactType(set, entry);
      if (type === null) {
        // A role with no artifact type has no schema to drift from; its assertions are the contract.
        expect(entry.expect_fields.length, entry.id).toBeGreaterThan(0);
        continue;
      }
      const fields = new Set(Object.keys(artifactDataSchemas[type].shape));
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
    for (const entry of set.cases) {
      const type = caseArtifactType(set, entry);
      if (type === null) {
        expect(
          entry.assert.every((assertion) => assertion.type !== 'is-json'),
          entry.id,
        ).toBe(true);
        continue;
      }
      const schemaPath = `${repoRoot}${artifactSchemaPathFor(type)}`;
      expect(existsSync(schemaPath), schemaPath).toBe(true);
      expect(JSON.parse(readFileSync(schemaPath, 'utf8'))).toHaveProperty('$schema');
      // …and the assertion has to point at **that** document rather than at any generated one: a
      // `TicketBreakdown` case validated against `refined-spec.schema.json` would pass here and
      // fail against a correct model (standing rule 10 — assert which branch ran).
      const json = entry.assert.find((assertion) => assertion.type === 'is-json');
      expect(json, `${entry.id} has an is-json assertion`).toBeDefined();
      expect(json?.value, entry.id).toContain(artifactSchemaPathFor(type).replace('schemas/', ''));
    }
  });
});
