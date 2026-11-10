/**
 * **The words of the low-risk plan rule** (S-28.8, the M28 ruling amending BD-006): what each risk
 * factor means, on an approval card and in the settings checklist.
 *
 * A module of its own, imported by the screens that show it (the task page's card, the Inbox and the
 * operating-mode settings), never by `ui/humanize.ts` — the first paint has no use for them (TD-013's
 * budget). The chat message words the same factors on the server (`notify/approval-text.ts`), held
 * to the same vocabulary by its own census.
 */
import type { RiskFactor } from '@platform/contracts';

/** What a factor means, as the end of a sentence that starts *"The plan …"*. */
export const RISK_FACTOR_WORDS: Readonly<Record<RiskFactor, string>> = {
  schema_migration: 'touches database migrations or stored data',
  auth_security: 'touches sign-in, permissions or security code',
  payments: 'touches payments or billing',
  public_api: 'changes a public API',
  infra_ci: 'changes CI, deployment or infrastructure',
  data_deletion: 'deletes data',
  many_files: 'changes many files',
  unclear_requirements: 'rests on requirements that are not clear yet',
  new_dependency: 'adds or changes a dependency',
  other: 'has another risk the agent named',
  protected_paths: 'changes protected files (tests, CI or agent configuration)',
  split_proposed: 'proposes splitting the ticket',
};

/** The factor as an item of the settings' *Always wait for you when the plan…* checklist. */
export const RISK_FACTOR_LABEL: Readonly<Record<RiskFactor, string>> = {
  schema_migration: 'Database migrations or stored data',
  auth_security: 'Sign-in, permissions or security code',
  payments: 'Payments or billing',
  public_api: 'A public API',
  infra_ci: 'CI, deployment or infrastructure',
  data_deletion: 'Deleting data',
  many_files: 'Many files (more than 10)',
  unclear_requirements: 'Requirements that are not clear yet',
  new_dependency: 'New or changed dependencies',
  other: 'Any other risk the agent names',
  protected_paths: 'Protected files (tests, CI, agent configuration)',
  split_proposed: 'A proposal to split the ticket',
};

/** Who found a factor, said after it: a platform finding cannot be argued away. */
export const RISK_SOURCE_WORDS = {
  platform: 'found by the platform',
  plan: 'the agent’s own assessment',
} as const satisfies Record<'platform' | 'plan', string>;
