/**
 * Which platform skills a project's bindings name — the first reader `AgentTooling.skill` has
 * outside a contract test (WP-54, PROGRESS backlog 40).
 *
 * The stage planner provisions a **provider skill** (`gitlab-mr`, `jira-ticket`, `loki-logs`,
 * `sentry-issue`) only when this answers its name, so a project with no Loki binding gets no
 * `loki-logs` in any run's `WorkspaceSpec.skills` — and, because the skill brings its command
 * patterns with it, no `logcli` in any run's `allow` list either. Before WP-54 every investigator
 * run was handed the recipes for every observability system whether the project had one or not.
 *
 * ## What it reads, and what it does not
 *
 * The project's `bindings` rows through {@link BindingRepository.forProject}, and each bound
 * provider's `agentTooling` out of the **catalogue** (`SHIPPED_PROVIDERS`) — metadata, true without
 * an adapter. It decrypts nothing and builds nothing: a skill is prompt material, and the question
 * is which provider a binding names, not whether its credential opens. **Not the pipeline's
 * registry**, measured: that registry builds only the three types the pipeline calls (GitLab, Jira,
 * Slack), so a Loki or Sentry binding is not in it and its skill would never have been provisioned.
 *
 * A binding whose provider this build does not ship — or whose type disagrees with the provider's —
 * names no skill here; the loader is what refuses such a binding by name (`BindingLoadError`), and
 * answering "no skill" rather than throwing keeps the refusal in one place: a run with one skill
 * fewer is the narrower direction.
 */
import type { BindingRepository, Logger } from '@platform/application';
import { silentLogger } from '@platform/application';
import type { Id } from '@platform/contracts';
import { type ProviderCatalogueEntry, SHIPPED_PROVIDERS } from '../catalogue.js';

export interface BoundSkillsOptions {
  readonly repository: BindingRepository;
  /** The providers whose tooling may name a skill. The shipped catalogue unless a test says. */
  readonly providers?: readonly ProviderCatalogueEntry[];
  readonly logger?: Logger;
}

/** The skill ids the project's bound providers' `AgentTooling.skill` name, sorted and unique. */
export const createBoundSkillsReader =
  (options: BoundSkillsOptions) =>
  async (projectId: Id): Promise<readonly string[]> => {
    const logger = options.logger ?? silentLogger;
    const providers = options.providers ?? SHIPPED_PROVIDERS;
    const skills = new Set<string>();
    for (const binding of await options.repository.forProject(projectId)) {
      const provider = providers.find(
        (entry) => entry.id === binding.provider && entry.type === binding.type,
      );
      if (provider === undefined) {
        logger.debug(
          { project_id: projectId, provider: binding.provider, type: binding.type },
          'a binding names a provider this build does not ship for its type, so it names no platform skill',
        );
        continue;
      }
      const id = provider.agentTooling?.skill?.id;
      if (id !== undefined) {
        skills.add(id);
      }
    }
    return [...skills].sort();
  };
