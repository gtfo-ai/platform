/**
 * PostgreSQL enum types, mirroring `migrations/0002_enums.sql`.
 *
 * The value sets that `@platform/contracts` also publishes are asserted equal to their zod
 * counterparts by `test/integration/db/enums.integration.test.ts` — against the labels the live
 * database reports, not against these literals — so a type added to one side and not the other is
 * a test failure rather than a runtime surprise.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// Identity and configuration
export const userRoleEnum = pgEnum('user_role', ['admin', 'maintainer', 'member', 'viewer']);
export const projectStatusEnum = pgEnum('project_status', ['active', 'paused', 'archived']);
export const configSourceEnum = pgEnum('config_source', ['default', 'org', 'project', 'repo']);
export const integrationTypeEnum = pgEnum('integration_type', [
  'task_management',
  'git',
  'communication',
  'logs',
  'errors',
]);
export const providerModeEnum = pgEnum('provider_mode', ['api', 'local']);
export const autonomyLevelEnum = pgEnum('autonomy_level', [
  'observe',
  'assist',
  'supervised',
  'autonomous',
]);

// Pipeline
export const taskStateEnum = pgEnum('task_state', [
  'queued',
  'active',
  'returned',
  'waiting_answers',
  'waiting_approval',
  'paused',
  'needs_human',
  'ready_for_merge',
  'merged',
  'retro',
  'done',
  'cancelled',
]);
export const taskModeEnum = pgEnum('task_mode', ['normal', 'shadow']);
export const taskSizeEnum = pgEnum('task_size', ['S', 'M', 'L', 'XL']);
export const agentRoleEnum = pgEnum('agent_role', [
  'triager',
  'product_manager',
  'investigator',
  'architect',
  'developer',
  'reviewer',
  'acceptance_tester',
  'facilitator',
  'librarian',
  'discovery',
]);
export const runModeEnum = pgEnum('run_mode', [
  'normal',
  'shadow',
  'review_only',
  'linter',
  'discovery',
  'retro',
  'librarian',
]);
export const runStatusEnum = pgEnum('run_status', [
  'created',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'stalled',
]);
export const runTerminalReasonEnum = pgEnum('run_terminal_reason', [
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
  'permission_denied',
  'cancelled',
  'stalled',
  'timed_out',
  'crash',
]);
export const effortEnum = pgEnum('effort', ['low', 'medium', 'high']);
export const contextPackReasonEnum = pgEnum('context_pack_reason', [
  'paths',
  'trigger',
  'artifact',
]);
export const artifactTypeEnum = pgEnum('artifact_type', [
  'RefinedSpec',
  'RootCauseAnalysis',
  'ImplementationPlan',
  'ImplementationNotes',
  'ReviewVerdict',
  'AcceptanceVerdict',
  'RetroReport',
  'ShadowReport',
  'ReadinessReport',
  'DiscoveryDraft',
]);
export const questionStatusEnum = pgEnum('question_status', [
  'open',
  'answered',
  'expired',
  'escalated',
]);
export const answerChannelEnum = pgEnum('answer_channel', ['ui', 'ticket', 'slack', 'api']);
export const approvalKindEnum = pgEnum('approval_kind', ['plan', 'budget', 'knowledge', 'rework']);
export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);
export const workspaceStatusEnum = pgEnum('workspace_status', [
  'provisioning',
  'ready',
  'in_use',
  'paused',
  'exported',
  'destroyed',
]);

// Transcripts
export const transcriptKindEnum = pgEnum('transcript_kind', [
  'system',
  'assistant',
  'user',
  'result',
  'stream_block',
  'hook',
  'steer',
  'compaction',
]);
export const blobStorageEnum = pgEnum('blob_storage', ['db', 'file', 's3']);

// Cost and governance
export const budgetScopeEnum = pgEnum('budget_scope', ['org', 'project', 'task', 'run']);
export const budgetWindowEnum = pgEnum('budget_window', ['day', 'week', 'month', 'total']);
export const costModeEnum = pgEnum('cost_mode', ['actual', 'estimated']);
export const humanTimeKindEnum = pgEnum('human_time_kind', ['review', 'question', 'approval']);
export const integrationDirectionEnum = pgEnum('integration_direction', ['in', 'out']);

// Knowledge
export const knowledgeProposalStatusEnum = pgEnum('knowledge_proposal_status', [
  'scored',
  'queued',
  'auto_applied',
  'applied',
  'rejected',
  'discarded',
]);
export const knowledgeProposalSourceEnum = pgEnum('knowledge_proposal_source', [
  'task',
  'run',
  'feedback',
  'bootstrap',
  'human',
]);
export const knowledgeProposalKindEnum = pgEnum('knowledge_proposal_kind', [
  'business',
  'technical',
  'process',
]);
export const knowledgeProposalTypeEnum = pgEnum('knowledge_proposal_type', [
  'lesson',
  'pitfall',
  'rule',
  'decision',
  'skill-draft',
  'doc-update',
]);
