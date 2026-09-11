/**
 * What a project's integration bindings look like to the ring that instantiates them
 * (technical/03: `integrations(id, org_id, type, provider, name, config, secret_ids, …)` and
 * `bindings(id, project_id, integration_id, config)`).
 *
 * Two tables, one row here. `integrations` is the **account** — a Jira site, a GitLab instance,
 * with credentials and a rate-limit budget of its own — and `bindings` is *this project's* use of
 * it, which is where a project-specific setting lives (`bindings.config`). The loader needs both
 * and nothing else, so the port hands back the join rather than making its caller perform one.
 *
 * ## Why `config` is already merged
 *
 * A provider's `configSchema` is **strict** (TD-020), so a caller that wanted to validate
 * `integrations.config` and `bindings.config` separately would have to make every field optional
 * in one of the two — which is precisely how a required credential becomes an absent one. The
 * merge happens once, in the adapter that reads the rows, with the **binding** winning: a project
 * overriding `pickup_label` for its own tickets is the reason the column exists, and an account
 * setting it globally is the default that override is against.
 *
 * `secretIds` stays a list of ids rather than resolved values: this ring does not hold plaintext
 * credentials, and `SecretStore` is the port that turns them into one (`../secrets.js`).
 */
import type { Id, IntegrationType, JsonObject } from '@platform/contracts';

export interface ProjectBinding {
  readonly bindingId: Id;
  readonly integrationId: Id;
  readonly type: IntegrationType;
  /** Registered provider id: `gitlab`, `jira-cloud`, … — what `IntegrationRegistry.get` takes. */
  readonly provider: string;
  /** The operator's name for the account, for a log line and a settings screen. */
  readonly name: string;
  /** `integrations.config` with `bindings.config` merged over it. */
  readonly config: JsonObject;
  readonly secretIds: readonly Id[];
}

export interface BindingRepository {
  /** Every binding of a project, in a stable order (type, then provider, then name). */
  forProject(projectId: Id): Promise<readonly ProjectBinding[]>;
}
