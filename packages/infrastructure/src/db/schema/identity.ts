/**
 * Identity and configuration tables (technical/03 § "Identity and configuration").
 * Mirrors `migrations/0003_identity.sql`; the DDL is authoritative and the parity test enforces it.
 */
import type { ConfigSource, JsonObject } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import { jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { bytea } from './columns.js';
import {
  autonomyLevelEnum,
  integrationTypeEnum,
  projectStatusEnum,
  userRoleEnum,
} from './enums.js';

const uuidv7 = sql`uuidv7()`;

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().default(uuidv7),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  settings: jsonb('settings').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(uuidv7),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: userRoleEnum('role').notNull().default('member'),
  passwordHash: text('password_hash'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(uuidv7),
  userId: uuid('user_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userIdentities = pgTable(
  'user_identities',
  {
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    userId: uuid('user_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.externalId] })],
);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().default(uuidv7),
  orgId: uuid('org_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  repoUrl: text('repo_url').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  agenticDir: text('agentic_dir').notNull().default('.agentic'),
  knowledgeDir: text('knowledge_dir').notNull().default('.agentic/knowledge'),
  config: jsonb('config').$type<JsonObject>().notNull().default({}),
  /** Per-key provenance of the effective configuration (technical/12). */
  configSource: jsonb('config_source').$type<Record<string, ConfigSource>>().notNull().default({}),
  configHash: text('config_hash'),
  autonomyLevel: autonomyLevelEnum('autonomy_level').notNull().default('supervised'),
  readinessLevel: smallint('readiness_level').notNull().default(0),
  status: projectStatusEnum('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: userRoleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
);

export const secrets = pgTable('secrets', {
  id: uuid('id').primaryKey().default(uuidv7),
  ciphertext: bytea('ciphertext').notNull(),
  keyId: text('key_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().default(uuidv7),
  orgId: uuid('org_id').notNull(),
  type: integrationTypeEnum('type').notNull(),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  config: jsonb('config').$type<JsonObject>().notNull().default({}),
  secretIds: uuid('secret_ids').array().notNull().default(sql`'{}'`),
  health: jsonb('health').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const bindings = pgTable('bindings', {
  id: uuid('id').primaryKey().default(uuidv7),
  projectId: uuid('project_id').notNull(),
  integrationId: uuid('integration_id').notNull(),
  config: jsonb('config').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only, monthly partitions. Secret values appear as "changed" (technical/03). */
export const configAudit = pgTable(
  'config_audit',
  {
    id: uuid('id').notNull().default(uuidv7),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    userId: uuid('user_id'),
    diff: jsonb('diff').$type<JsonObject>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.createdAt] })],
);

/** Deliberately not exported as a queryable surface elsewhere — see `platform.ts`. */
export const identityTables = {
  organizations,
  users,
  sessions,
  userIdentities,
  projects,
  projectMembers,
  secrets,
  integrations,
  bindings,
  configAudit,
} as const;

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Binding = typeof bindings.$inferSelect;
export type ConfigAuditRow = typeof configAudit.$inferSelect;
