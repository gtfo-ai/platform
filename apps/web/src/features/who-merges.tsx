/**
 * **Who merges** — the project's `policies.merge.by` (S-28.15, BD-007's 2026-11-10 amendment,
 * TD-038 decision 1), on the operating-mode screen the wizard and the settings page both render.
 *
 * Two choices, one plain sentence each (product/18's two sentences), written into the project's
 * configuration document through `PUT /api/projects/:id/config` — the **whole** document plus the
 * hash it was read at, like every other control on this screen, which records the
 * `project.config.write` row. A settings key, so it needs the administrator role; a reader without
 * it sees the choices disabled and why. **A person** is the default: an upgrade never lets the
 * platform merge. A repository file may only choose *a person* (`repository-grades.ts`).
 */
import type { MergeBy } from '@platform/contracts';
import type { ReactElement } from 'react';
import { useOnboardingCommands, useProjectConfig, useSession } from '../app/queries.js';
import { Card, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';

/** The two choices and their sentences (product/18, TD-038). */
export const WHO_MERGES_CHOICES = [
  {
    value: 'person',
    label: 'A person',
    sentence:
      'A person merges the merge request when it is ready; the platform tells you it is waiting.',
  },
  {
    value: 'platform',
    label: 'The platform',
    sentence:
      'The platform merges it once the reviews approved it, CI passed on that commit and GitLab says it can be merged, once its plan was approved or needed no approval.',
  },
] as const satisfies readonly { value: MergeBy; label: string; sentence: string }[];

/** The document with `policies.merge.by` set — the one save a choice makes. */
export const withMergeBy = (
  whole: Record<string, unknown>,
  by: MergeBy,
): Record<string, unknown> => {
  const policies = (whole.policies ?? {}) as Record<string, unknown>;
  return { ...whole, policies: { ...policies, merge: { by } } };
};

export const WhoMerges = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const session = useSession();
  const commands = useOnboardingCommands();
  const document = config.data?.config as { policies?: { merge?: { by?: MergeBy } } } | undefined;
  const by: MergeBy = document?.policies?.merge?.by ?? 'person';
  const mayChange = session.data?.user.role === 'admin';
  const disabled = !config.isSuccess || commands.writeConfig.isPending || !mayChange;

  return (
    <Card className="flex flex-col gap-3" data-who-merges="">
      <SectionHeading>Who merges</SectionHeading>
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Who merges a ready merge request</legend>
        {WHO_MERGES_CHOICES.map((choice) => (
          <label key={choice.value} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`who-merges-${projectId}`}
              value={choice.value}
              checked={by === choice.value}
              disabled={disabled}
              onChange={() => {
                if (!config.isSuccess) return;
                commands.writeConfig.mutate({
                  projectId,
                  config: withMergeBy(config.data.config as Record<string, unknown>, choice.value),
                  base_hash: config.data.hash,
                });
              }}
            />
            <span className="flex flex-col">
              <span className="font-semibold">{choice.label}</span>
              <span className="text-xs text-fg-muted" data-who-merges-sentence={choice.value}>
                {choice.sentence}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {mayChange || session.isPending ? null : (
        <p className="text-xs text-fg-muted" data-who-merges-role="">
          Changing who merges needs the administrator role.
        </p>
      )}
      {commands.writeConfig.isError ? (
        <ErrorNotice title="Who merges was not saved." error={commands.writeConfig.error} />
      ) : null}
    </Card>
  );
};
