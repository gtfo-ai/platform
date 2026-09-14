/**
 * Query keys, in one place, because the realtime bridge invalidates by **prefix**.
 *
 * Everything a project owns is keyed under `['project', id, …]` and everything a run owns under
 * `['run', id, …]`, so a `project:<id>` SSE topic maps onto exactly one prefix. A key invented at
 * a call site would be outside that tree and would silently stop being live — a screen that never
 * updates and never errors, which is the failure mode this app has to avoid most.
 */
export const queryKeys = {
  session: ['session'] as const,
  version: ['version'] as const,
  orgUsers: ['org', 'users'] as const,
  audit: (filters: Readonly<Record<string, unknown>> = {}) => ['org', 'audit', filters] as const,
  agents: ['org', 'agents'] as const,
  inbox: ['org', 'inbox'] as const,
  integrations: ['integrations'] as const,
  integrationSetupGuide: (id: string) => ['integrations', id, 'setup-guide'] as const,
  orgBudgets: ['org', 'budgets'] as const,

  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  projectConfig: (id: string) => ['project', id, 'config'] as const,
  projectReadiness: (id: string) => ['project', id, 'readiness'] as const,
  projectBindings: (id: string) => ['project', id, 'bindings'] as const,
  projectBudgets: (id: string) => ['project', id, 'budgets'] as const,
  projectAutonomy: (id: string) => ['project', id, 'autonomy'] as const,
  projectAudit: (id: string) => ['project', id, 'audit'] as const,
  /** WP-34: under the project's prefix, so a `project:<id>` frame refreshes the Shadow screen. */
  shadowBatches: (id: string) => ['project', id, 'shadow-batches'] as const,
  shadowBatch: (projectId: string, batchId: string) =>
    ['project', projectId, 'shadow-batches', batchId] as const,
  projectTasks: (id: string, filters: Readonly<Record<string, unknown>> = {}) =>
    ['project', id, 'tasks', filters] as const,
  kbTree: (id: string) => ['project', id, 'kb', 'tree'] as const,
  kbDoc: (id: string, path: string) => ['project', id, 'kb', 'doc', path] as const,
  kbProposals: (id: string) => ['project', id, 'kb', 'proposals'] as const,

  task: (id: string) => ['task', id] as const,
  /** The ask-the-task thread and the task's own audit trail (WP-31). */
  taskAsks: (id: string) => ['task', id, 'asks'] as const,
  taskAudit: (id: string) => ['task', id, 'audit'] as const,
  run: (id: string) => ['run', id] as const,
  runMessages: (id: string) => ['run', id, 'messages'] as const,
  runPrompt: (id: string) => ['run', id, 'prompt'] as const,
  runContextPack: (id: string) => ['run', id, 'context-pack'] as const,
} as const;
