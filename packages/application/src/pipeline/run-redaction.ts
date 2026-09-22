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
import { exactSecretRedactor, MIN_SECRET_LENGTH } from '../integrations/redaction.js';
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
