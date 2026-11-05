/**
 * **Names only an administrator types, behind "For administrators"** (S-23.22, the final UX audit's
 * item 11).
 *
 * An environment variable (`APP_INTEGRATION_HOSTS`), a configuration key
 * (`features.history_bootstrap.budget_usd`) or the repository's settings file path is exact and
 * useful to the person who edits the server's environment or the repository — and means nothing to
 * anyone else reading the screen. So the visible copy says it in a plain sentence ("an administrator
 * must allow this host first") and the exact name sits here, in a collapsed disclosure beside it.
 *
 * **This module is the only place in `apps/web/src` such a name may be written**:
 * `apps/web/src/admin-names-census.test.ts` refuses an `APP_*` variable, a `_FILE` companion, an
 * `.agentic/` path or a dotted configuration key in a `<code>` anywhere else, so a screen that wants
 * one adds a note here rather than a string in its copy.
 */
import type { ReactElement } from 'react';
import { DetailsDisclosure } from './details.js';

export const ADMIN_NOTE = {
  bootstrap_admin:
    'The first administrator is the account whose email the server’s APP_BOOTSTRAP_ADMIN_EMAIL names. It is set when the instance is installed.',
  integration_hosts:
    'Hosts are allowed in the server’s APP_INTEGRATION_HOSTS setting: an exact list of host names, empty (so nothing is allowed) until an operator sets it.',
  secret_env:
    'The variable’s name must be listed in the server’s APP_INTEGRATION_SECRET_ENV setting. Its _FILE companion (the same name with _FILE added) is read too, for a secret mounted as a file.',
  history_bootstrap_cap:
    'The cap is features.history_bootstrap.budget_usd in the repository’s .agentic/config.yml.',
  status_mapping:
    'The configuration key is status_mapping, in the project settings or the repository’s .agentic/config.yml.',
  risk_classes:
    'Accepting writes policies.risk_classes, and the checklists as policies.review_checklists, into the project’s configuration. Both can be edited afterwards in the repository’s .agentic/config.yml.',
  reviewers:
    'Named reviewers are policies.reviewers in the project’s configuration or the repository’s .agentic/config.yml; a CODEOWNERS match comes first.',
  human_time_breakdown:
    'The per-user breakdown is features.human_time.per_user_breakdown in the repository’s .agentic/config.yml.',
  feature_caps:
    'These caps are features.shadow_mode.budget_usd and features.maintenance.budget_usd in the repository’s .agentic/config.yml.',
  verification_mode:
    'The key is verification.mode, in the project settings or the repository’s .agentic/config.yml.',
  wip_limits:
    'The keys are under pipeline.wip, in the project settings or the repository’s .agentic/config.yml.',
  repository_config: 'The repository’s settings file is .agentic/config.yml on the default branch.',
  prompt_files:
    'Prompt files live in .agentic/prompts/ on the default branch, named <stage>.md and <stage>.append.md, or named by a stage’s prompt / prompt_append key.',
  command_allow: 'The list is commands.allow in the repository’s .agentic/config.yml.',
} as const;

export type AdminNote = keyof typeof ADMIN_NOTE;

/** The collapsed "For administrators" disclosure carrying one note's exact names. */
export const ForAdministrators = ({
  note,
  className,
}: {
  readonly note: AdminNote;
  readonly className?: string;
}): ReactElement => (
  <DetailsDisclosure
    summary="For administrators"
    {...(className === undefined ? {} : { className })}
  >
    <p className="text-xs [overflow-wrap:anywhere]" data-admin-note={note}>
      {ADMIN_NOTE[note]}
    </p>
  </DetailsDisclosure>
);
