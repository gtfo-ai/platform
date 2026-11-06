/**
 * A provider's identity on the integrations screens (S-25.3, product/08's 2026-11-06 amendment):
 * an Octicons glyph for **what the provider does for a project**, with the provider's **name as
 * text** beside it — never the provider's logo.
 *
 * The brands' own terms decided it (research/21 § 8, retrieved 2026-11-06): GitLab refuses its logo
 * in a third party's interface, Slack needs a written licence and forbids other colours, Atlassian
 * allows only its unmodified files and Grafana Labs forbids colour changes — and a monochrome
 * re-colour is exactly that change. So the glyph is the role's: a merge for a git host, an open
 * issue for a ticket tracker, a discussion for chat, a bug for an error tracker, a log for a log
 * store. The glyphs are `@primer/octicons-react` (MIT), already a dependency and already in
 * `THIRD_PARTY_NOTICES.md`; nothing is vendored. Keyed by the integration **type**, so a sixth
 * provider of a known role gets its role's glyph without a line here, and a type this build does
 * not know cannot reach it (the type is a closed enum in the contract).
 *
 * The glyph is decoration (`aria-hidden`, Octicons' default without a label): the name beside it is
 * what a screen reader reads. {@link PROVIDER_TRADEMARK_NOTICE} is the one line the screen and
 * `docs/user-guide.md` carry.
 */
import type { IntegrationType } from '@platform/contracts';
import { BugIcon } from '@primer/octicons-react/BugIcon';
import { CommentDiscussionIcon } from '@primer/octicons-react/CommentDiscussionIcon';
import { GitMergeIcon } from '@primer/octicons-react/GitMergeIcon';
import { IssueOpenedIcon } from '@primer/octicons-react/IssueOpenedIcon';
import { LogIcon } from '@primer/octicons-react/LogIcon';
import type { Icon } from '@primer/octicons-react/types';
import type { ReactElement } from 'react';
import { cx } from './cx.js';
import { UntrustedText } from './untrusted.js';

/** The role glyph of each integration type (research/21 § 8's decision). */
export const PROVIDER_ROLE_GLYPH: Readonly<Record<IntegrationType, Icon>> = {
  task_management: IssueOpenedIcon,
  git: GitMergeIcon,
  communication: CommentDiscussionIcon,
  errors: BugIcon,
  logs: LogIcon,
};

/** The non-affiliation line the integrations screen and the user guide carry (research/21 § 8). */
export const PROVIDER_TRADEMARK_NOTICE =
  'GitLab, Jira, Slack, Sentry and Loki are trademarks of their respective owners; this project is not affiliated with or endorsed by them.';

/** The role's glyph alone, for a place that already shows the name (a row's leading slot). */
export const ProviderGlyph = ({
  type,
  size = 16,
  className,
}: {
  readonly type: IntegrationType;
  readonly size?: number;
  readonly className?: string;
}): ReactElement => {
  const Icon = PROVIDER_ROLE_GLYPH[type];
  return (
    <span data-provider-glyph={type} className={cx('inline-flex shrink-0', className)}>
      <Icon size={size} />
    </span>
  );
};

/**
 * The glyph and the provider's name as text: *GitLab*, *Jira Cloud*. `name` is the catalogue's
 * display name, or the stored provider id for one this build does not ship — operator text either
 * way, so it is rendered as text.
 */
export const ProviderIcon = ({
  type,
  name,
  className,
}: {
  readonly type: IntegrationType;
  readonly name: string;
  readonly className?: string;
}): ReactElement => (
  <span data-provider-icon="" className={cx('inline-flex items-center gap-1', className)}>
    <ProviderGlyph type={type} size={14} />
    <UntrustedText value={name} />
  </span>
);
