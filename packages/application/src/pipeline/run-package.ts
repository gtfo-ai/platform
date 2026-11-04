/**
 * **The run plan, stored and read back** (WP-275a, TD-031's 2026-11-04 amendment on decisions 1–3
 * and 6, §2).
 *
 * Once the stage job ends at the offer (WP-276), the process that runs a run is a claimant holding
 * nothing but what is stored — so the plan is persisted **once**, in transaction 1b beside the run
 * row (where the prompt columns and the context pack are written, and for the same reason: written
 * there and never re-derived), and the session runs from what is read back. WP-275a already makes the
 * `stage.execute` job do so, so WP-276 moves a call rather than inventing a read.
 *
 * ## Sealed, not redacted
 *
 * {@link sealRunPlan} stores `storedRunSpecSchema` — the spec with its secret `env` values removed,
 * the prompts **byte-identical** — envelope-sealed through the {@link RunPlanSealer} port, bounded at
 * {@link RUN_PLAN_MAX_BYTES} of canonical JSON and **refused past it, never cut**. It is never run
 * through a redactor and never refused for a pattern match: the session is handed exactly the bytes
 * the planner assembled, and the readable record of the prompt is still `runs.system_prompt` /
 * `user_prompt`, redacted, unchanged (TD-012). The seal is cleared by `RunRepository.finish`.
 *
 * ## What a claimant runs
 *
 * {@link loadRunPackage} opens the seal and re-attaches the secret values from the claimant's **own**
 * `agentRunEnvironment`. A name it cannot resolve is a non-transient start failure
 * (`credential_unavailable`); a seal it cannot open — an `APP_SECRET_KEY` rotated without its previous
 * generation, a blob of another run — is `run_plan_unreadable`; a run planned before this row (no
 * plan at all) is `run_plan_missing`. Each is thrown as a terminal {@link RunStartError}, so the
 * caller's existing start-failure path settles it as `not_started` with no new branch.
 */
import type { Id, RunSpec } from '@platform/contracts';
import { runSpecSchema, storedRunSpecOf, storedRunSpecSchema } from '@platform/contracts';
import type { RunPlanSealer } from '../ports/run-plan-sealer.js';
import { RunPlanUnreadableError } from '../ports/run-plan-sealer.js';
import { RunStartError } from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { RunSecretEnvironment } from './run-redaction.js';
import { canonicalJson } from './settings-snapshot.js';
import type {
  AppliedChecklistRecord,
  NewRunPlan,
  RunPlanRepository,
  StoredRunPlan,
} from './store.js';

/** The sealed document's shape — `run_plans.format`; bumped when {@link storedRunSpecSchema} changes. */
export const RUN_PLAN_FORMAT = 1;

/**
 * The largest plan stored: **1 MiB** of canonical JSON before sealing (TD-031's 2026-11-04
 * amendment §2). A prompt is bounded far below it by the context budget; a plan past it is a defect
 * the platform refuses by name rather than a document it cuts.
 */
export const RUN_PLAN_MAX_BYTES = 1024 * 1024;

/** A plan past {@link RUN_PLAN_MAX_BYTES}: refused, never cut. */
export class RunPlanTooLargeError extends Error {
  override readonly name = 'RunPlanTooLargeError';
  readonly runId: Id;
  readonly bytes: number;

  constructor(runId: Id, bytes: number) {
    super(
      `the plan of run ${runId} is ${bytes} bytes of canonical JSON, over the ${RUN_PLAN_MAX_BYTES}-byte bound; it is refused rather than cut`,
    );
    this.runId = runId;
    this.bytes = bytes;
  }
}

/**
 * The `run_plans` row for one planned run: the spec without its secret values, sealed for the run.
 * Pure but for the sealer; the caller writes it in the run row's transaction.
 *
 * @throws {RunPlanTooLargeError} past {@link RUN_PLAN_MAX_BYTES}.
 */
export const sealRunPlan = (
  sealer: RunPlanSealer,
  input: {
    readonly spec: RunSpec;
    readonly reviewChecklists: readonly AppliedChecklistRecord[] | null;
    readonly questionTimeout: string;
  },
): NewRunPlan => {
  const stored = storedRunSpecSchema.parse(storedRunSpecOf(input.spec));
  const document = canonicalJson(stored);
  const bytes = new TextEncoder().encode(document).byteLength;
  if (bytes > RUN_PLAN_MAX_BYTES) {
    throw new RunPlanTooLargeError(input.spec.runId, bytes);
  }
  const sealed = sealer.seal(input.spec.runId, document);
  return {
    runId: input.spec.runId,
    format: RUN_PLAN_FORMAT,
    sealedSpec: sealed.sealed,
    keyId: sealed.keyId,
    secretEnvNames: [...input.spec.secretEnvNames],
    reviewChecklists:
      input.reviewChecklists === null
        ? null
        : input.reviewChecklists.map((entry) => ({ ...entry })),
    questionTimeout: input.questionTimeout,
  };
};

/** What {@link loadRunPackage} answers: the spec the session runs, and the plan row it came from. */
export interface RunPackage {
  readonly spec: RunSpec;
  readonly plan: StoredRunPlan;
}

const refused = (
  runId: Id,
  reason: 'credential_unavailable' | 'run_plan_unreadable' | 'run_plan_missing',
  message: string,
  cause?: unknown,
): RunStartError =>
  new RunStartError(`run ${runId} cannot be started from its stored plan: ${message}`, {
    retryable: false,
    diagnosis: { kind: 'invalid_spec', reason, commit: null },
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * **The spec a claimant runs**, read back from the stored plan (module docblock): the seal opened,
 * the document re-validated, and every secret value re-attached from `environment`, the claimant's
 * own `agentRunEnvironment`.
 *
 * @throws {RunStartError} terminal, with the reason `credential_unavailable`, `run_plan_unreadable`
 * or `run_plan_missing` — never a value of the environment, never a byte of the plan.
 */
export const loadRunPackage = async (
  deps: { readonly runPlans: RunPlanRepository; readonly sealer: RunPlanSealer },
  tx: Transaction,
  runId: Id,
  environment: RunSecretEnvironment,
): Promise<RunPackage> => {
  const { stored, plan } = await openRunPlan(deps, tx, runId);
  const secrets: Record<string, string> = {};
  for (const name of stored.secretEnvNames) {
    const value = environment.env[name];
    if (value === undefined || value === '') {
      throw refused(
        runId,
        'credential_unavailable',
        `the secret environment variable ${name} the plan names has no value in this process`,
      );
    }
    secrets[name] = value;
  }
  /**
   * **The claimant's own credentials join the plan's** (WP-276). Since the job ends at the offer, the
   * process that planned the run is not the one that runs it — on a core with no runner it has no
   * model credential at all, so its plan names none. The claimant injects its own (the model key of
   * its `agentRunEnvironment`), and it must name them, or TD-012 step 1 would not know them: the
   * transcript would carry the key under a pattern placeholder at best. Measured: the topology e2e
   * (`app` plans, `runner` runs) showed `[REDACTED sha256:…]` where the run's own placeholder was due.
   */
  const names = [...stored.secretEnvNames];
  for (const name of environment.secretEnvNames) {
    const value = environment.env[name];
    if (names.includes(name) || value === undefined || value === '') continue;
    names.push(name);
    secrets[name] = value;
  }
  return {
    spec: runSpecSchema.parse({
      ...stored,
      env: { ...stored.env, ...secrets },
      secretEnvNames: names,
    }),
    plan,
  };
};

/**
 * **The stored plan opened, with no secret value attached** (WP-281): the spec exactly as sealed —
 * `storedRunSpecSchema`, every `env` entry named in `secretEnvNames` absent — which is what a run
 * package is built from (TD-031 decision 4: the core never puts a secret value in a package).
 * {@link loadRunPackage} is this plus the claimant's own values.
 *
 * @throws {RunStartError} terminal, `run_plan_missing` or `run_plan_unreadable`.
 */
export const openRunPlan = async (
  deps: { readonly runPlans: RunPlanRepository; readonly sealer: RunPlanSealer },
  tx: Transaction,
  runId: Id,
): Promise<{ readonly stored: RunSpec; readonly plan: StoredRunPlan }> => {
  const plan = await deps.runPlans.load(tx, runId);
  if (plan === null) {
    throw refused(runId, 'run_plan_missing', 'it has no stored plan');
  }
  if (plan.sealedSpec === null) {
    throw refused(runId, 'run_plan_unreadable', 'its plan was cleared when the run ended');
  }
  let stored: RunSpec;
  try {
    const document = deps.sealer.open(runId, plan.sealedSpec, plan.keyId);
    stored = storedRunSpecSchema.parse(JSON.parse(document));
  } catch (error) {
    throw refused(
      runId,
      'run_plan_unreadable',
      error instanceof RunPlanUnreadableError
        ? 'its seal does not open under this process’s APP_SECRET_KEY'
        : 'its stored plan does not parse',
      error,
    );
  }
  if (stored.runId !== runId) {
    throw refused(runId, 'run_plan_unreadable', 'its stored plan names another run');
  }
  return { stored, plan };
};
