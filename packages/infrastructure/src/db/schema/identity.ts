/**
 * Identity and configuration tables (technical/03 § "Identity and configuration").
 * Mirrors `migrations/0003_identity.sql`; the DDL is authoritative and the parity test enforces it.
 */
import type { ConfigSource, JsonObject } from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
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

/**
 * `users`, `sessions`, `accounts` and `verifications` are Better Auth's tables (TD-022): 0003
 * created the first two from technical/03 and 0011 gave them the columns Better Auth needs. The
 * camelCase field names Better Auth uses are mapped onto these snake_case columns in
 * `apps/server/src/auth/better-auth.ts`; nothing here writes them.
 */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(uuidv7),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: userRoleEnum('role').notNull().default('member'),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  status: text('status').notNull().default('active'),
  banned: boolean('banned'),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().default(uuidv7),
  userId: uuid('user_id').notNull(),
  /** The opaque bearer value in the session cookie; the row is looked up by it. */
  token: text('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  impersonatedBy: text('impersonated_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().default(uuidv7),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  /** Argon2id hash for the `credential` provider (TD-022). Never selected into a response. */
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verifications = pgTable('verifications', {
  id: uuid('id').primaryKey().default(uuidv7),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
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
  accounts,
  verifications,
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
