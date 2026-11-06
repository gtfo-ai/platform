/**
 * The task page's **Artifacts** tab (S-23.9b): the task's documents on the left, by type and version,
 * and the one selected on the right — selected by `?artifact=<id>` (WP-52), which is what makes an
 * artifact *addressable*: the ask thread's citation and the flow's *Open artifact* set the same
 * parameter, and a link that names one opens this tab on it (`./task-tab.ts`).
 *
 * **It renders JSON and prose as text, never markup, and never a link.** The document is a model's
 * structured output (BD-022), so its markdown goes through `UntrustedProse` and its data through
 * `UntrustedText` inside a `<pre>` — collapsed behind *Raw JSON* when the document has prose of its
 * own: no markdown step, no sanitiser, no `href` (`apps/web/src/no-html.test.ts`). `<pre>` is a
 * layout decision about whitespace, not a rendering mode.
 *
 * Every artifact used to be a row a reader could see and not open: the task projection published
 * `url: null` as a literal and no route served a body. Both halves landed together at WP-52,
 * because a read surface over `artifacts.data` before TD-012 applied at the write was a way for a
 * credential to leave the building (backlog 35, measured). An artifact stored **before** migration
 * 0038 — when nothing redacted one — is refused by the API with 409 `artifact_not_redacted` rather
 * than served; the refusal arrives here as an ordinary error and says so.
 *
 * So every body this tab renders has passed TD-012 — **except a `ShadowReport`**, which the platform
 * assembles from its own rows and writes through an empty redactor (PROGRESS backlog **131**). Its
 * exposure is the endpoint's (`GET /api/shadow-batches/:id` serves the whole document at
 * `project.read`), not this tab's; the clause is here because the sentence above needs it.
 */
import type { TaskDetailResponse } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useArtifactBody } from '../app/queries.js';
import { cx, FOCUS_RING } from '../ui/cx.js';
import { DetailsDisclosure } from '../ui/details.js';
import { ARTIFACT_TYPE_LABEL } from '../ui/humanize.js';
import { EmptyState, ErrorNotice, formatDateTime, Loading } from '../ui/kit.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';

const ArtifactBody = ({
  taskId,
  artifactId,
}: {
  readonly taskId: string;
  readonly artifactId: string;
}): ReactElement => {
  const body = useArtifactBody(taskId, artifactId);
  if (body.isPending) {
    return <Loading label="Loading artifact…" />;
  }
  if (body.isError) {
    return <ErrorNotice title="Artifact could not be loaded." error={body.error} />;
  }
  const artifact = body.data;
  return (
    // A document in a box (S-25.10b), as a knowledge page is.
    <article
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-default p-4"
      aria-label="Artifact"
    >
      <header className="flex flex-col gap-0.5">
        <h2 className="text-base font-semibold">
          {`${ARTIFACT_TYPE_LABEL[artifact.artifact_type]} v${artifact.version}`}
        </h2>
        <p className="text-xs text-fg-muted">
          schema {artifact.schema_version} · {formatDateTime(artifact.created_at)} ·{' '}
          {`${artifact.redaction_count} secret${artifact.redaction_count === 1 ? '' : 's'} hidden`}
        </p>
      </header>
      {artifact.markdown === null ? null : <UntrustedProse value={artifact.markdown} />}
      <DetailsDisclosure summary="Raw JSON" defaultOpen={artifact.markdown === null}>
        <pre className="overflow-x-auto text-xs">
          <UntrustedText value={JSON.stringify(artifact.data, null, 2)} />
        </pre>
      </DetailsDisclosure>
    </article>
  );
};

export const TaskArtifacts = ({
  taskId,
  artifacts,
  openArtifactId,
}: {
  readonly taskId: string;
  readonly artifacts: TaskDetailResponse['artifacts'];
  /** `?artifact=`, already resolved against this task's own artifacts (`null` for none). */
  readonly openArtifactId: string | null;
}): ReactElement => {
  if (artifacts.length === 0) {
    return (
      <EmptyState
        title="No artifacts yet"
        hint="Every stage that produces a document — Refined Spec, Plan, RCA, Review Verdict, Retro — lists it here with its version history."
      />
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Artifacts">
        <ul className="flex flex-col gap-0.5">
          {artifacts.map((artifact) => {
            const current = openArtifactId === artifact.id;
            return (
              <li key={artifact.id}>
                {/*
                 * A router `Link`, never an `href` (WP-52): the body is rendered on this screen
                 * rather than downloaded. `url` on the DTO says where the *API* serves it, which is
                 * what an OpenAPI consumer needs and what a browser must not be sent to.
                 */}
                <Link
                  to="."
                  search={(previous: Record<string, unknown>) => ({
                    ...previous,
                    tab: 'artifacts' as const,
                    artifact: artifact.id,
                  })}
                  // Exact: the router's partial active test would mark a link this page did not.
                  activeOptions={{ exact: true }}
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                  className={cx(
                    'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted',
                    current ? 'bg-muted font-semibold text-fg' : 'text-fg-muted',
                    FOCUS_RING,
                  )}
                >
                  <span>{ARTIFACT_TYPE_LABEL[artifact.artifact_type]}</span>
                  <span className="text-xs text-fg-muted">{`v${artifact.version}`}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0">
        {openArtifactId === null ? (
          <p className="text-sm text-fg-muted">Choose a document on the left to read it here.</p>
        ) : (
          <ArtifactBody taskId={taskId} artifactId={openArtifactId} />
        )}
      </div>
    </div>
  );
};
