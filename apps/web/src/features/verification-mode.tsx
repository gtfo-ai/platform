/**
 * Where a project's verification runs — `verification.mode` (BD-025's 2026-10-05 amendment, PROGRESS
 * backlog 460).
 *
 * Two choices, written as one key of the project's configuration document through
 * `PUT /api/projects/:id/config`, which takes the **whole** document plus the hash it was read at —
 * the shape `FeatureToggles` uses, for the reason it gives: a fragment would discard every other key.
 *
 * What it shows is the **effective** mode with the layer that set it, because the repository's
 * `.agentic/config.yml` may move a project to CI over these settings (and never back): a control that
 * showed only the settings layer would say *local* while every run is planned with *ci*. The choice
 * it offers writes the settings layer; when the repository holds `ci`, choosing *local* here changes
 * nothing the runs see, and the screen says so rather than letting the write look like it did.
 */
import type { ReactElement } from 'react';
import { useOnboardingCommands, useProjectConfig } from '../app/queries.js';
import { Card, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';

type Mode = 'local' | 'ci';

const MODES: readonly { readonly mode: Mode; readonly label: string; readonly hint: string }[] = [
  {
    mode: 'local',
    label: 'Agents run the checks',
    hint: 'The Developer, Reviewer, Acceptance Tester and Discovery run the project’s declared test, lint and build commands in their workspace (2 CPUs, 4 GiB).',
  },
  {
    mode: 'ci',
    label: 'CI runs the checks',
    hint: 'No agent runs the test suite, static analysis, builds or dependency installs: those commands are blocked and every agent with a shell is told the CI gate runs them on the merge request. Discovery reads R1, R2 and R6 from the CI configuration instead of running them.',
  },
];

const modeOf = (value: unknown): Mode | undefined =>
  value === 'local' || value === 'ci' ? value : undefined;

export const VerificationMode = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const commands = useOnboardingCommands();
  // Nothing is claimed before the configuration has answered: `local` is a fact about a document,
  // not a placeholder for one that has not arrived.
  const effective = config.isSuccess
    ? (modeOf(config.data.effective.verification?.mode) ?? 'local')
    : undefined;
  const source = config.data?.sources['verification.mode'] ?? 'default';

  const choose = (mode: Mode): void => {
    if (!config.isSuccess) {
      return;
    }
    const document = config.data.config as Record<string, unknown>;
    const existing = (document.verification ?? {}) as Record<string, unknown>;
    commands.writeConfig.mutate({
      projectId,
      config: { ...document, verification: { ...existing, mode } },
      base_hash: config.data.hash,
    });
  };

  return (
    <Card className="flex flex-col gap-2">
      <SectionHeading>Verification</SectionHeading>
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      {config.isError ? (
        <ErrorNotice
          title="The verification mode could not be read: the project’s configuration did not load."
          detail={String(config.error)}
        />
      ) : null}
      <fieldset className="flex flex-col gap-2" disabled={!config.isSuccess}>
        <legend className="text-xs text-fg-muted">
          {effective === undefined ? null : (
            <>
              In force: <strong data-testid="verification-mode-effective">{effective}</strong> (
              {source}) —{' '}
            </>
          )}
          <code>verification.mode</code> in the settings or <code>.agentic/config.yml</code>. A
          repository file may move a project to CI, never back.
        </legend>
        {MODES.map((choice) => (
          <label key={choice.mode} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="verification-mode"
              value={choice.mode}
              checked={effective === choice.mode}
              disabled={commands.writeConfig.isPending}
              onChange={() => choose(choice.mode)}
            />
            <span>
              <strong>{choice.label}</strong>
              <span className="block text-xs text-fg-muted">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {effective === 'ci' && source === 'repo' ? (
        <p className="text-xs text-fg-muted">
          The repository’s <code>.agentic/config.yml</code> sets CI; choosing local here is not
          applied while it does.
        </p>
      ) : null}
      {commands.writeConfig.isError ? (
        <ErrorNotice
          title="The verification mode was not saved."
          detail={String(commands.writeConfig.error)}
        />
      ) : null}
    </Card>
  );
};
