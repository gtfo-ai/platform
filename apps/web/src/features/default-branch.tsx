/**
 * A project's default branch — the wizard's step 1 and the project settings page render this same
 * component (product/18:55, WP-139).
 *
 * The stored branch is what every run checks out, every merge request targets and the knowledge
 * mirror reads; before WP-139 every project was `main` because nothing sent it. The field is
 * **prefilled from the git provider** (`GET …/repository`) once a git binding is known, and from the
 * stored value otherwise; it is never saved without a person pressing the button, and the server
 * refuses the change while a task is live — which the read already says, so the button is disabled
 * with the reason rather than offered for a 409.
 *
 * Every provider string (its branch, its CI path) is untrusted text (BD-022) and is rendered as such.
 */
import { type ReactElement, useState } from 'react';
import { useProjectRepository, useSettingsCommands } from '../app/queries.js';
import { Badge, Button, ErrorNotice, Field } from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/** The CI configuration's location as a sentence; provider text stays a text node. */
const CiLocation = ({
  ci,
}: {
  readonly ci:
    | { readonly kind: 'repository'; readonly path: string }
    | { readonly kind: 'external'; readonly location: string }
    | { readonly kind: 'unknown'; readonly reason: string };
}): ReactElement =>
  ci.kind === 'repository' ? (
    <>
      CI configuration at <UntrustedText value={ci.path} />.
    </>
  ) : ci.kind === 'external' ? (
    <>
      CI configuration outside the repository, at <UntrustedText value={ci.location} />.
    </>
  ) : (
    <>
      Where the CI configuration lives is unknown (<UntrustedText value={ci.reason} />
      ); the CI gate waits rather than reading “no CI”.
    </>
  );

export const DefaultBranch = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const repository = useProjectRepository(projectId);
  const commands = useSettingsCommands();
  // `null` until the person types: the field then follows the reads, so a binding saved after the
  // first read (the wizard's order) prefills it with the provider's answer.
  const [typed, setTyped] = useState<string | null>(null);

  const data = repository.data;
  const providerBranch = data?.provider?.default_branch ?? null;

  if (data === undefined) {
    return repository.isError ? (
      <ErrorNotice
        title="The project’s default branch could not be read."
        detail={String(repository.error)}
      />
    ) : (
      <p className="text-xs text-fg-muted">Reading the default branch…</p>
    );
  }
  // Prefill: what the person typed, else the provider's answer, else the stored value — never saved
  // until a person presses the button.
  const value = typed ?? providerBranch ?? data.default_branch;
  const differs = providerBranch !== null && providerBranch !== data.default_branch;
  const blocked = data.live_tasks > 0;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        Default branch: <Badge tone={differs ? 'warning' : 'neutral'}>{data.default_branch}</Badge>
      </p>
      {data.provider === null ? (
        <p className="text-xs text-fg-muted">
          <UntrustedText value={data.provider_unavailable ?? 'The git provider was not asked.'} />
        </p>
      ) : (
        <p className="text-xs text-fg-muted">
          <UntrustedText value={data.provider.provider} /> says the default branch is{' '}
          {providerBranch === null ? 'not set' : <UntrustedText value={providerBranch} />}.{' '}
          <CiLocation ci={data.provider.ci_config} />
        </p>
      )}
      {differs ? (
        <p className="text-xs" role="status">
          The stored branch is not the provider’s: runs would check out and merge requests would
          target <UntrustedText value={data.default_branch} />.
        </p>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          commands.setDefaultBranch.mutate(
            { projectId, default_branch: value.trim() },
            { onSuccess: () => setTyped(null) },
          );
        }}
      >
        <Field
          label="Default branch"
          hint="The branch every run checks out, every merge request targets and the knowledge base is read from."
          value={value}
          onChange={(event) => setTyped(event.target.value)}
        />
        <div>
          <Button
            type="submit"
            disabled={
              blocked ||
              commands.setDefaultBranch.isPending ||
              value.trim() === '' ||
              value.trim() === data.default_branch
            }
          >
            Save default branch
          </Button>
        </div>
        {blocked ? (
          <p className="text-xs text-fg-muted">
            {data.live_tasks} task{data.live_tasks === 1 ? ' is' : 's are'} not finished; the
            default branch can be changed once {data.live_tasks === 1 ? 'it is' : 'they are'} done
            or cancelled.
          </p>
        ) : null}
        {commands.setDefaultBranch.isError ? (
          <ErrorNotice
            title="The default branch was not changed."
            detail={String(commands.setDefaultBranch.error)}
          />
        ) : null}
      </form>
    </div>
  );
};
