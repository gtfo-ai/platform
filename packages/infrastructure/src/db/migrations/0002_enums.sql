-- 0002 — enumerated types.
--
-- Every type below whose value set is also published by `@platform/contracts` is asserted against
-- that zod enum by test/integration/db/enums.integration.test.ts, so the database and the wire
-- format cannot drift apart. Columns whose value set technical/03 does not pin down (task stage
-- outcomes, SDK permission modes, knowledge-base document kinds, handler execution status) stay
-- `text`: the work package that owns the semantics gets to choose them.

-- Identity and configuration
create type user_role as enum ('admin', 'maintainer', 'member', 'viewer');
create type project_status as enum ('active', 'paused', 'archived');
create type config_source as enum ('default', 'org', 'project', 'repo');
create type integration_type as enum ('task_management', 'git', 'communication', 'logs', 'errors');
create type provider_mode as enum ('api', 'local');
create type autonomy_level as enum ('observe', 'assist', 'supervised', 'autonomous');

-- Pipeline
create type task_state as enum (
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
  'cancelled'
);
create type task_mode as enum ('normal', 'shadow');
create type task_size as enum ('S', 'M', 'L', 'XL');
create type agent_role as enum (
  'triager',
  'product_manager',
  'investigator',
  'architect',
  'developer',
  'reviewer',
  'acceptance_tester',
  'facilitator',
  'librarian',
  'discovery'
);
create type run_mode as enum (
  'normal',
  'shadow',
  'review_only',
  'linter',
  'discovery',
  'retro',
  'librarian'
);
create type run_status as enum (
  'created',
  'starting',
  'running',
  'completed',
  'failed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
  'stalled'
);
create type run_terminal_reason as enum (
  'success',
  'error_max_turns',
  'error_max_budget_usd',
  'error_max_structured_output_retries',
  'error_during_execution',
  'permission_denied',
  'cancelled',
  'stalled',
  'timed_out',
  'crash'
);
create type effort as enum ('low', 'medium', 'high');
create type context_pack_reason as enum ('paths', 'trigger', 'artifact');
create type artifact_type as enum (
  'RefinedSpec',
  'RootCauseAnalysis',
  'ImplementationPlan',
  'ImplementationNotes',
  'ReviewVerdict',
  'AcceptanceVerdict',
  'RetroReport',
  'ShadowReport',
  'ReadinessReport',
  'DiscoveryDraft'
);
create type question_status as enum ('open', 'answered', 'expired', 'escalated');
create type answer_channel as enum ('ui', 'ticket', 'slack', 'api');
create type approval_kind as enum ('plan', 'budget', 'knowledge', 'rework');
create type approval_status as enum ('pending', 'approved', 'rejected', 'expired');
create type workspace_status as enum (
  'provisioning',
  'ready',
  'in_use',
  'paused',
  'exported',
  'destroyed'
);

-- Transcripts
create type transcript_kind as enum (
  'system',
  'assistant',
  'user',
  'result',
  'stream_block',
  'hook',
  'steer',
  'compaction'
);
create type blob_storage as enum ('db', 'file', 's3');

-- Cost and governance
create type budget_scope as enum ('org', 'project', 'task', 'run');
create type budget_window as enum ('day', 'week', 'month', 'total');
create type cost_mode as enum ('actual', 'estimated');
create type human_time_kind as enum ('review', 'question', 'approval');
create type integration_direction as enum ('in', 'out');

-- Knowledge
create type knowledge_proposal_status as enum (
  'scored',
  'queued',
  'auto_applied',
  'applied',
  'rejected',
  'discarded'
);
create type knowledge_proposal_source as enum ('task', 'run', 'feedback', 'bootstrap', 'human');
create type knowledge_proposal_kind as enum ('business', 'technical', 'process');
create type knowledge_proposal_type as enum (
  'lesson',
  'pitfall',
  'rule',
  'decision',
  'skill-draft',
  'doc-update'
);
