/**
 * TD-012 step 1 for **one run**: exact match of every secret the platform injected into it.
 *
 * ## Why it is in this ring rather than in the composition root
 *
 * It used to live in `apps/server/src/agent.ts`, where the runner is composed, and that was the
 * right place while the transcript sink was the only consumer. WP-52 added two more — the run's
 * **artifact** (`artifacts/redaction.ts`) and the two **prompt columns**, both written by the stage
 * executor and the ask executor, which are `packages/application` and cannot import a composition
 * root. Duplicating the construction there would have made "the artifact and the transcript of the
 * run that produced it cannot name different secrets" a claim about two pieces of code agreeing
 * (standing rule 63). So the construction moved down one ring and `apps/server/src/agent.ts`
 * re-exports it; `apps/server/src/agent.test.ts` asserts the two names are the *same function
 * object*, which is an equality no future edit can satisfy by accident.
 *
 * ## Built from the spec, not from configuration
 *
 * The spec is what the CLI was actually given: a value that is not in `env` cannot leak through
 * this run, and a value that *is* must be redacted whatever put it there. A name whose value is
 * missing or too short to redact safely is **skipped with a warning** rather than failing the run —
 * `exactSecretRedactor` refuses a value under {@link MIN_SECRET_LENGTH} because redacting it would
 * erase ordinary text, and the fail-closed answer to "this run has an 8-character credential" is a
 * warning about the credential, not a run that cannot start.
 */
import {
  exactSecretRedactor,
  type InjectedSecret,
  MIN_SECRET_LENGTH,
} from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Logger } from '../ports/logger.js';
import type { RunSpec } from '../ports/runner.js';

/** The two fields of a `RunSpec` this redactor is made of, so a caller may pass either. */
export interface RunSecretEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly secretEnvNames: readonly string[];
}

/**
 * The redactor for a run, from the run's own spec.
 *
 * Every WP-52 write path takes it from here: the transcript sink through the runner, the artifact
 * through the stage/ask executor, and `runs.system_prompt`/`user_prompt` at run creation.
 */
export const injectedSecretRedactorFor = (spec: RunSpec, logger: Logger): SecretRedactor =>
  injectedSecretRedactorForEnvironment(
    { env: spec.env, secretEnvNames: spec.secretEnvNames },
    logger,
    { runId: spec.runId },
  );

/**
 * The same redactor, built from the environment a run *would* be given rather than from one run.
 *
 * Its second caller is the Librarian (WP-18b): a proposal's text is model output on its way to a
 * `kb_proposals` row and to a commit on the project's repository, and the model that wrote it was
 * handed this process' own model credential. The run-scoped redactor lives inside the runner and is
 * gone by the time a proposal is curated, so the composition root builds the same set of secrets
 * from `agentRunEnvironment` — the one function that decides what a run's environment contains, so
 * the two cannot name different values.
 */
export const injectedSecretRedactorForEnvironment = (
  environment: RunSecretEnvironment,
  logger: Logger,
  context: { readonly runId?: string } = {},
): SecretRedactor => {
  const secrets = environment.secretEnvNames.flatMap((name) => {
    const value = environment.env[name];
    if (value === undefined || value.length < MIN_SECRET_LENGTH) {
      logger.warn(
        {
          ...(context.runId === undefined ? {} : { run_id: context.runId }),
          env_name: name,
          present: value !== undefined,
        },
        'a run names a secret environment variable that cannot be redacted, so its value is not replaced in this run’s transcript',
      );
      return [];
    }
    // The placeholder is the variable's own name, lower-cased: it is stable, unique inside one spec
    // (env names are unique by construction), and readable in an audit row as
    // `[REDACTED:integration:anthropic_api_key]`.
    return [{ name: name.toLowerCase(), value }];
  });
  return exactSecretRedactor(secrets);
};

/**
 * The secrets a run was given **after** its redactors were built — TD-028's WP-76 amendment,
 * decision 8.
 *
 * The run's git credential is minted inside `provision`, which runs after the stage executor has
 * built the redactor it writes the run's prompt columns and — later — its artifact with, so a
 * redactor that is a closure over the spec cannot hold it. This is a redactor that reads a
 * **registry** at call time instead: the process that mints registers the value, and every
 * redactor composed over {@link RunScopedSecrets.redactor} replaces it from that moment on.
 *
 * ## Process-wide, and why that is the right width
 *
 * It redacts every live run credential this process minted, not only one run's. A value is a
 * credential whichever run's transcript echoes it, and a narrower scope would need a run id at
 * every call site that already has a redactor and no run id (the artifact write, the loader's
 * platform redactor). The placeholder names the run the credential belonged to.
 *
 * ## Kept until the credential expires, not until it is revoked
 *
 * The workspace is released — and the credential revoked — *before* the stage executor writes the
 * run's artifact, so forgetting on revoke would let the one structured output that most plausibly
 * quotes the token be stored unredacted. A revoked token is still a credential-shaped string an
 * operator must not find in a row, and the entry is a few dozen bytes; it is pruned lazily once the
 * provider's own expiry has passed.
 *
 * ## What it does not reach
 *
 * Another **process**: the registry is memory. **On the shipped topology that is not an edge
 * case**: `app` never mints (it composes no provisioner) and serves every webhook, and it takes
 * `pipeline.outbound` jobs beside `runner`, so a CI log, an MR diff or an MR comment quoting a run
 * credential is stored or posted by a process that never knew the value. What redacts it there is
 * step 2: **WP-72 took decision (a)** for PROGRESS backlog **154** — the pattern rules — which was
 * sufficient for GitLab's documented default shape (`glpat-…`) and not for a GitLab whose
 * administrator changed the token prefix (backlog **259**). **Since WP-80** (TD-012's M5
 * amendment) the minting process records the value's non-secret *shape* beside the mint's audit
 * row and every process compiles it into a step-2 rule (`minted_credential_shapes`,
 * `packages/infrastructure/src/redaction/minted-credential-shapes.ts`), so a custom prefix is
 * covered too — asserted through the two processes by `test/e2e/topology/two-processes.e2e.test.ts`
 * with a credential the runner minted. Decision (b), a registry of values shared through the
 * `secrets` store, is **rejected for 0.1** by that amendment.
 *
 * **Nor a process that died** — the crash path. The registry dies with the runner that minted, and
 * so did the one revoke that runner owed. Since WP-77 the revoke is recovered
 * (`../recovery/run-credential.ts`, PROGRESS backlog **155**): a terminal run whose credential no
 * audit row confirms revoked is revoked by address from the mint's `revoke_id`, a pass interval
 * after the run ends. The *redaction* does not need this registry: no other process ever held the
 * value, and text quoting it that another process stores is covered by the step-2 rule compiled
 * from its recorded shape (WP-80) — for as long as the shape's expiry says the credential lives.
 */
export interface RunScopedSecrets {
  /** Registers a value minted for `runId`. Refuses one too short to redact, rather than dropping it. */
  add(runId: string, value: string, expiresAt: string): void;
  /** The values registered for one run, named — for `IntegrationCallScope.runScopedSecrets` (Q55). */
  secretsFor(runId: string): readonly InjectedSecret[];
  /**
   * Drops a run's entry before its expiry (WP-137 review round 1) — for a **static** run credential,
   * whose declared expiry is weeks away and which every run of the project registers again under its
   * own name. Safe there because the value is also a sealed secret of the integration, so every
   * binding redactor in every process still knows it by exact value. A minted value keeps its entry
   * to its expiry, for the reason above (a revoked token is still credential-shaped).
   */
  forget(runId: string): void;
  /** A redactor over every live value, read at call time. */
  readonly redactor: SecretRedactor;
  /** How many values are held. Diagnostics; never the values. */
  readonly size: number;
}

/** The placeholder name a run's git credential is redacted to. Unique per run, by construction. */
export const runGitCredentialSecretName = (runId: string): string =>
  `run_git_credential_${runId.toLowerCase()}`;

export const createRunScopedSecrets = (clock: { readonly now: () => number }): RunScopedSecrets => {
  const held = new Map<
    string,
    { readonly runId: string; readonly value: string; readonly until: number }
  >();
  const prune = (): void => {
    const now = clock.now();
    for (const [key, entry] of held) {
      if (entry.until <= now) {
        held.delete(key);
      }
    }
  };
  const current = (): SecretRedactor => {
    prune();
    return exactSecretRedactor(
      [...held.values()].map((entry) => ({
        name: runGitCredentialSecretName(entry.runId),
        value: entry.value,
      })),
    );
  };
  return {
    add: (runId, value, expiresAt) => {
      if (value.length < MIN_SECRET_LENGTH) {
        throw new TypeError(
          `run ${runId}'s credential is shorter than ${MIN_SECRET_LENGTH} characters and could not be redacted; it is refused rather than used`,
        );
      }
      const until = Date.parse(expiresAt);
      // An unreadable expiry keeps the value for a week rather than for nothing: the failure
      // direction of a redaction registry is "held too long", never "dropped early".
      held.set(runGitCredentialSecretName(runId), {
        runId,
        value,
        until: Number.isNaN(until) ? clock.now() + 7 * 24 * 60 * 60 * 1_000 : until,
      });
    },
    forget: (runId) => {
      held.delete(runGitCredentialSecretName(runId));
    },
    secretsFor: (runId) => {
      prune();
      const entry = held.get(runGitCredentialSecretName(runId));
      return entry === undefined
        ? []
        : [{ name: runGitCredentialSecretName(runId), value: entry.value }];
    },
    redactor: {
      redactText: (text) => current().redactText(text),
      redactJson: (value) => current().redactJson(value),
    },
    get size() {
      prune();
      return held.size;
    },
  };
};
