/**
 * **The words of Settings, knowledge, budgets and the audit log** (S-23.11b).
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */
import type {
  AutonomyLevel,
  BudgetScope,
  BudgetWindow,
  KnowledgeProposalKind,
  KnowledgeProposalSource,
  KnowledgeProposalStatus,
  KnowledgeProposalType,
  OrgUsersResponse,
} from '@platform/contracts';
import { titleCase } from './stages.js';

export type UserStatus = OrgUsersResponse['items'][number]['status'];

export const USER_STATUS_LABEL: Readonly<Record<UserStatus, string>> = {
  active: 'Active',
  invited: 'Invited',
  disabled: 'Disabled',
};

/** The autonomy dial's positions, as the dial itself names them. */
export const AUTONOMY_LEVEL_LABEL: Readonly<Record<AutonomyLevel, string>> = {
  observe: 'Observe',
  assist: 'Assist',
  supervised: 'Supervised',
  autonomous: 'Autonomous',
};

/** A budget's window, as the sentence "spent … per month" reads it. */
export const BUDGET_WINDOW_LABEL: Readonly<Record<BudgetWindow, string>> = {
  day: 'Per day',
  week: 'Per week',
  month: 'Per month',
  total: 'In total',
};

export const BUDGET_SCOPE_LABEL: Readonly<Record<BudgetScope, string>> = {
  org: 'Organisation',
  project: 'Project',
  task: 'Task',
  run: 'Run',
};

export const KNOWLEDGE_PROPOSAL_TYPE_LABEL: Readonly<Record<KnowledgeProposalType, string>> = {
  lesson: 'Lesson',
  pitfall: 'Pitfall',
  rule: 'Rule',
  decision: 'Decision',
  'skill-draft': 'Skill draft',
  'doc-update': 'Document update',
};

export const KNOWLEDGE_PROPOSAL_KIND_LABEL: Readonly<Record<KnowledgeProposalKind, string>> = {
  business: 'Business',
  technical: 'Technical',
  process: 'Process',
};

export const KNOWLEDGE_PROPOSAL_STATUS_LABEL: Readonly<Record<KnowledgeProposalStatus, string>> = {
  scored: 'Waiting for review',
  queued: 'Waiting for review',
  auto_applied: 'Applied automatically',
  applied: 'Applied',
  apply_failed: 'Apply failed',
  rejected: 'Rejected',
  discarded: 'Discarded',
};

/**
 * Where a proposal came from, in a maintainer's words — `knowledge_proposal_source` (WP-35). A page
 * mined from merged history cites merge requests somebody can follow; a page the Discovery agent
 * drafted is a model's reading of a repository it had just met, and the queue says which.
 */
export const KNOWLEDGE_PROPOSAL_SOURCE_LABEL: Readonly<Record<KnowledgeProposalSource, string>> = {
  task: 'from a task',
  run: 'from a run',
  feedback: 'from feedback',
  bootstrap: 'drafted at project setup',
  human: 'written by a person',
  history: 'mined from merged history',
};

/**
 * The entity types the audit log's filter offers, with what a change to one is called.
 *
 * `config_audit.entity_type` is free text on the wire (`nonEmptyStringSchema`), so this is the
 * **known** set rather than an exhaustive record: the platform's configurable entities. A row whose
 * type is not here is still listed, with its type title-cased (`auditEntityLabel`), never dropped.
 */
export const AUDIT_ENTITY_LABEL: Readonly<Record<string, string>> = {
  organization: 'the organisation settings',
  project: 'a project’s settings',
  integration: 'an integration',
  binding: 'a project’s connections',
  budget: 'a budget',
  user: 'a person’s account',
};

/** The filter menu's word for an entity type ("Project"), and the row's ("a project’s settings"). */
export const AUDIT_ENTITY_FILTER_LABEL: Readonly<Record<string, string>> = {
  organization: 'Organisation',
  project: 'Project',
  integration: 'Integration',
  binding: 'Connections',
  budget: 'Budget',
  user: 'Person',
};

export const auditEntityLabel = (type: string): string =>
  Object.hasOwn(AUDIT_ENTITY_LABEL, type) ? (AUDIT_ENTITY_LABEL[type] as string) : titleCase(type);
