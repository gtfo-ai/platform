/**
 * The database's enum labels, the Drizzle `pgEnum` declarations and the zod enums published by
 * `@platform/contracts` are three spellings of one value set. This asserts all three agree, so a
 * new task state or terminal reason cannot be added to the wire format and forgotten in storage.
 *
 * The four enums with no contracts counterpart are pinned against technical/03's own wording.
 */
import {
  agentRoleSchema,
  answerChannelSchema,
  approvalKindSchema,
  approvalStatusSchema,
  artifactTypeSchema,
  autonomyLevelSchema,
  budgetScopeSchema,
  budgetWindowSchema,
  configSourceSchema,
  contextPackRecordSchema,
  effortSchema,
  integrationTypeSchema,
  knowledgeProposalRecordSchema,
  knowledgeProposalStatusSchema,
  projectRecordSchema,
  providerModeSchema,
  questionStatusSchema,
  runModeSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  sizeSchema,
  taskModeSchema,
  taskStateSchema,
  transcriptKindSchema,
  userRoleSchema,
  workspaceStatusSchema,
} from '@platform/contracts';
import { db } from '@platform/infrastructure';
import { is } from 'drizzle-orm';
import { PgEnumColumn } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

/** Reads `.options` off a zod enum reached through a nested schema, without fighting the types. */
const optionsOf = (schema: unknown, label: string): readonly string[] => {
  const candidate = schema as { options?: unknown };
  if (!Array.isArray(candidate.options)) {
    throw new Error(`${label} is not a zod enum`);
  }
  return candidate.options as readonly string[];
};

const knowledgeProposalShape = knowledgeProposalRecordSchema.shape;
const contextPackTier1 = contextPackRecordSchema.shape.tier1 as unknown as {
  element: { shape: Record<string, unknown> };
};

/** Enum type name -> the value set it must equal, and where that value set comes from. */
const EXPECTED_LABELS: Record<string, readonly string[]> = {
  // Published by @platform/contracts.
  agent_role: agentRoleSchema.options,
  answer_channel: answerChannelSchema.options,
  approval_kind: approvalKindSchema.options,
  approval_status: approvalStatusSchema.options,
  artifact_type: artifactTypeSchema.options,
  autonomy_level: autonomyLevelSchema.options,
  budget_scope: budgetScopeSchema.options,
  budget_window: budgetWindowSchema.options,
  config_source: configSourceSchema.options,
  context_pack_reason: optionsOf(contextPackTier1.element.shape.reason, 'context pack reason'),
  effort: effortSchema.options,
  integration_type: integrationTypeSchema.options,
  knowledge_proposal_kind: optionsOf(knowledgeProposalShape.kind, 'proposal kind'),
  knowledge_proposal_source: optionsOf(knowledgeProposalShape.source, 'proposal source'),
  knowledge_proposal_status: knowledgeProposalStatusSchema.options,
  knowledge_proposal_type: optionsOf(knowledgeProposalShape.type, 'proposal type'),
  project_status: optionsOf(projectRecordSchema.shape.status, 'project status'),
  provider_mode: providerModeSchema.options,
  question_status: questionStatusSchema.options,
  run_mode: runModeSchema.options,
  run_status: runStatusSchema.options,
  run_terminal_reason: runTerminalReasonSchema.options,
  task_mode: taskModeSchema.options,
  task_size: sizeSchema.options,
  task_state: taskStateSchema.options,
  transcript_kind: transcriptKindSchema.options,
  user_role: userRoleSchema.options,
  workspace_status: workspaceStatusSchema.options,

  // Storage-only vocabularies; technical/03 spells each of these out inline.
  blob_storage: ['db', 'file', 's3'],
  cost_mode: ['actual', 'estimated'],
  human_time_kind: ['review', 'question', 'approval'],
  integration_direction: ['in', 'out'],
};

describe('enum types', () => {
  let database: MigratedDatabase;
  let actual: Map<string, string[]>;

  beforeAll(async () => {
    database = await createMigratedDatabase('enums');
    actual = await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ name: string; labels: string[] }>(
        `select t.typname as name,
                array_agg(e.enumlabel::text order by e.enumsortorder) as labels
           from pg_type t
           join pg_enum e on e.enumtypid = t.oid
          where t.typnamespace = 'public'::regnamespace
          group by t.typname
          order by t.typname`,
      );
      return new Map(rows.map((row) => [row.name, row.labels]));
    });
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('creates exactly the enum types this test knows about', () => {
    expect([...actual.keys()].sort()).toEqual(Object.keys(EXPECTED_LABELS).sort());
  });

  it('gives every enum the value set its source of truth defines, in the same order', () => {
    for (const [name, expected] of Object.entries(EXPECTED_LABELS)) {
      expect(actual.get(name), `labels of ${name}`).toEqual([...expected]);
    }
  });

  it('agrees with the Drizzle pgEnum declarations used by every enum column', () => {
    const columns = Object.values(db.schema)
      .flatMap((value) => {
        const table = value as { [key: string]: unknown };
        return typeof table === 'object' && table !== null ? Object.values(table) : [];
      })
      .filter((column): column is PgEnumColumn<never> => is(column, PgEnumColumn));

    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) {
      const typeName = column.getSQLType();
      expect(actual.get(typeName), `pgEnum ${typeName}`).toEqual([...column.enumValues]);
    }
  });
});
