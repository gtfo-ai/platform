/**
 * One pending approval, **with what it approves** (S-25.1; BD-006's 2026-11-06 amendment; product/10
 * § "Task detail", *Approvals*; research/21 F1 — *"I'm blind and blind approve is no-go"*).
 *
 * The card carries the three things the amendment asks for, beside the buttons:
 *
 * 1. **The subject** — for a plan, *the* plan the gate asked about (`subject.artifact_id`), read and
 *    shown **open**: its approach, size, files and risks, then *Read the whole plan*, open by
 *    default (Q-UX-4: *Approve* is never disabled-until-opened; the plan is simply on screen). For a
 *    budget, the estimate and the threshold it crossed. A subject that was not recorded says so.
 * 2. **Why it was asked** — every reason the gate recorded, in words (`./approval-text.ts`).
 * 3. **How to stop being asked** — per reason, the lever and a link to the setting that holds it.
 *
 * And what each answer does next. *Approve* echoes the plan it showed (`subject_artifact_id`), so the
 * server approves exactly that plan or refuses (`approval_subject_mismatch`/`_superseded`/
 * `_unrecorded`, TD-035 decision 6). A plan approval whose plan was not recorded, or whose plan is
 * no longer the task's latest, offers *Reject* only — approving it would approve something nobody
 * was shown. The header's *Review plan* moves focus here ({@link approvalCardId}); it opens nothing
 * else. Not the page's amber primary: the header's button is (one beacon per screen).
 *
 * **Everything in the plan is model output** (BD-022) and is rendered through `ui/untrusted.tsx` as
 * text — no markdown step, no link it did not pass through `safeHref`.
 */
import type { ApprovalReason, ApprovalView, TaskDetailResponse } from '@platform/contracts';
import { implementationPlanDataSchema, MAX_COMMAND_TEXT_CHARS } from '@platform/contracts';
import { Link } from '@tanstack/react-router';
import { type ReactElement, type ReactNode, useState } from 'react';
import type { useTaskCommands } from '../app/queries.js';
import { useArtifactBody } from '../app/queries.js';
import { ConfirmDialog } from '../ui/confirm-dialog.js';
import { DetailsDisclosure } from '../ui/details.js';
import { APPROVAL_KIND_LABEL, stageLabel } from '../ui/humanize.js';
import { Badge, Button, Card, ErrorNotice, formatDateTime, formatUsd, Loading } from '../ui/kit.js';
import { UntrustedProse, UntrustedText } from '../ui/untrusted.js';
import { approveConsequence, reasonCopy, rejectConsequence, rejectNext } from './approval-text.js';

type TaskCommands = ReturnType<typeof useTaskCommands>;
type PlanSubject = Extract<NonNullable<ApprovalView['subject']>, { kind: 'plan' }>;

/** The id of an approval's card, so the header's *Review plan* can move focus onto it. */
export const approvalCardId = (approvalId: string): string => `approval-${approvalId}`;

/** The newest `ImplementationPlan` version this task has, or `null` for none. */
const latestPlanVersion = (artifacts: TaskDetailResponse['artifacts']): number | null =>
  artifacts
    .filter((artifact) => artifact.artifact_type === 'ImplementationPlan')
    .reduce<number | null>(
      (newest, artifact) =>
        newest === null || artifact.version > newest ? artifact.version : newest,
      null,
    );

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement => (
  <div className="flex flex-col gap-1">
    <h4 className="text-xs font-semibold text-fg-muted">{title}</h4>
    {children}
  </div>
);

const TextList = ({ items }: { readonly items: readonly string[] }): ReactElement | null =>
  items.length === 0 ? null : (
    <ul className="list-disc pl-5 text-sm">
      {items.map((item, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a plan's list is positional and never reordered.
        <li key={index}>
          <UntrustedText value={item} />
        </li>
      ))}
    </ul>
  );

/** The plan the approval is about, read by its id and shown open (F1). */
const PlanBody = ({
  taskId,
  subject,
}: {
  readonly taskId: string;
  readonly subject: PlanSubject;
}): ReactElement => {
  const body = useArtifactBody(taskId, subject.artifact_id);
  if (body.isPending) {
    return <Loading label="Loading the plan…" />;
  }
  if (body.isError) {
    return <ErrorNotice title="The plan could not be loaded." error={body.error} />;
  }
  const parsed = implementationPlanDataSchema.safeParse(body.data.data);
  if (!parsed.success) {
    // A plan written by an older schema: shown as it is stored, never hidden behind a refusal.
    return (
      <div className="flex flex-col gap-2" data-approval-plan="raw">
        {body.data.markdown === null ? null : <UntrustedProse value={body.data.markdown} />}
        <pre className="overflow-x-auto text-xs">
          <UntrustedText value={JSON.stringify(body.data.data, null, 2)} />
        </pre>
      </div>
    );
  }
  const plan = parsed.data;
  return (
    <div className="flex flex-col gap-3" data-approval-plan="parsed">
      <Section title="Approach">
        <UntrustedProse value={plan.approach} />
      </Section>
      <p className="text-sm">
        <span className="font-semibold">{`Size ${plan.estimated_size}`}</span>
        {` · ${plan.files_to_change.length === 1 ? '1 file' : `${plan.files_to_change.length} files`} to change`}
      </p>
      {plan.files_to_change.length === 0 ? null : (
        <Section title="Files">
          <ul className="flex flex-col gap-0.5 text-sm">
            {plan.files_to_change.map((file, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a plan's list is positional.
              <li key={index}>
                <UntrustedText value={file.path} className="font-mono text-xs" />
                {' — '}
                <UntrustedText value={file.change} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {plan.risks.length === 0 ? null : (
        <Section title="Risks">
          <TextList items={plan.risks} />
        </Section>
      )}
      <DetailsDisclosure summary="Read the whole plan" defaultOpen>
        <div className="flex flex-col gap-3 pt-2" data-approval-plan-whole="">
          {plan.affected_modules.length === 0 ? null : (
            <Section title="Affected modules">
              <TextList items={plan.affected_modules} />
            </Section>
          )}
          {plan.alternatives_considered.length === 0 ? null : (
            <Section title="Alternatives considered">
              <TextList
                items={plan.alternatives_considered.map(
                  (entry) => `${entry.option} — not chosen: ${entry.why_not}`,
                )}
              />
            </Section>
          )}
          {plan.data_changes.length === 0 ? null : (
            <Section title="Data changes">
              <TextList items={plan.data_changes} />
            </Section>
          )}
          {plan.api_changes.length === 0 ? null : (
            <Section title="API changes">
              <TextList items={plan.api_changes} />
            </Section>
          )}
          {plan.protected_path_changes.length === 0 ? null : (
            <Section title="Protected paths">
              <TextList
                items={plan.protected_path_changes.map(
                  (entry) => `${entry.path} — ${entry.reason}`,
                )}
              />
            </Section>
          )}
          {plan.test_plan.length === 0 ? null : (
            <Section title="Test plan">
              <TextList items={plan.test_plan} />
            </Section>
          )}
          {plan.rollout_notes === '' ? null : (
            <Section title="Rollout">
              <UntrustedProse value={plan.rollout_notes} />
            </Section>
          )}
          {plan.decisions_to_record.length === 0 ? null : (
            <Section title="Decisions to record">
              <TextList items={plan.decisions_to_record} />
            </Section>
          )}
        </div>
      </DetailsDisclosure>
    </div>
  );
};

/** Why it was asked, and per reason how to stop being asked (BD-006's 2026-11-06 amendment). */
const Reasons = ({
  reasons,
  projectKey,
}: {
  readonly reasons: readonly ApprovalReason[] | null | undefined;
  readonly projectKey: string | null;
}): ReactElement => (
  <Section title="Why you are asked">
    {reasons === null || reasons === undefined ? (
      <p className="text-sm text-fg-muted" data-approval-reasons="not-recorded">
        Not recorded: this approval was asked before approvals recorded their reasons.
      </p>
    ) : (
      <ul className="flex flex-col gap-2 text-sm" data-approval-reasons="">
        {reasons.map((reason) => {
          const copy = reasonCopy(reason);
          return (
            <li key={reason.code} data-approval-reason={reason.code}>
              {/* A risk class's name is the project's own configuration: text, never markup. */}
              <UntrustedText value={copy.why} />
              <p className="text-xs text-fg-muted" data-approval-retire={reason.code}>
                {copy.stop}{' '}
                {projectKey === null ? null : (
                  <Link
                    to="/projects/$key/settings/$section"
                    params={{ key: projectKey, section: copy.section }}
                    className="text-accent underline underline-offset-2"
                  >
                    {copy.link}
                  </Link>
                )}
              </p>
            </li>
          );
        })}
      </ul>
    )}
  </Section>
);

export const ApprovalCard = ({
  approval,
  taskId,
  artifacts,
  projectKey,
  mayDecide,
  commands,
}: {
  readonly approval: ApprovalView;
  readonly taskId: string;
  readonly artifacts: TaskDetailResponse['artifacts'];
  readonly projectKey: string | null;
  readonly mayDecide: boolean;
  readonly commands: TaskCommands;
}): ReactElement => {
  const [confirming, setConfirming] = useState(false);
  const pending = commands.decide.isPending;
  const kind = APPROVAL_KIND_LABEL[approval.kind].toLowerCase();
  const subject = approval.subject ?? null;
  const plan = subject?.kind === 'plan' ? subject : null;
  const newest = latestPlanVersion(artifacts);
  const superseded = plan !== null && newest !== null && newest > plan.artifact_version;
  // A plan is approved only as the plan on screen: none recorded, or a newer one, is reject-only.
  const approvable = approval.kind !== 'plan' || (plan !== null && !superseded);
  return (
    <Card className="flex flex-col gap-3">
      <section
        id={approvalCardId(approval.id)}
        tabIndex={-1}
        aria-label={APPROVAL_KIND_LABEL[approval.kind]}
        className="flex flex-col gap-3 outline-none"
        data-approval-card={approval.kind}
      >
        <header className="flex flex-wrap items-center gap-2">
          <Badge tone="accent">{APPROVAL_KIND_LABEL[approval.kind]}</Badge>
          {plan === null ? null : (
            <span className="text-xs text-fg-muted" data-approval-subject="plan">
              {`Plan v${plan.artifact_version} · ${stageLabel(plan.stage)}, attempt ${plan.attempt}`}
              {plan.basis === 'derived' ? ' · identified from the run that wrote it' : ''}
            </span>
          )}
          <span className="ml-auto text-xs text-fg-muted">{`requested ${formatDateTime(approval.requested_at)}`}</span>
        </header>

        {subject === null ? (
          <p className="text-sm" data-approval-subject="not-recorded">
            {approval.kind === 'plan'
              ? 'Which plan this approval is about was not recorded — it was asked before approvals recorded their plan. It can only be rejected, which asks for a fresh plan.'
              : 'What this approval is about was not recorded — it was asked before approvals recorded their subject.'}
          </p>
        ) : subject.kind === 'budget' ? (
          <p className="text-sm" data-approval-subject="budget">
            {`Estimated ${formatUsd(subject.estimate_usd)} against this project’s threshold of ${formatUsd(subject.threshold_usd)}`}
            {subject.estimate_samples === null
              ? '.'
              : `, from ${subject.estimate_samples} finished task${subject.estimate_samples === 1 ? '' : 's'}.`}
          </p>
        ) : (
          <>
            {superseded ? (
              <p className="text-sm" data-approval-superseded="">
                {`A newer plan (v${newest}) exists. This approval is about v${subject.artifact_version}, so it can only be rejected; the newer plan is asked for on its own.`}
              </p>
            ) : null}
            <PlanBody taskId={taskId} subject={subject} />
          </>
        )}

        <Reasons reasons={approval.reasons} projectKey={projectKey} />

        <Section title="What happens next">
          <ul className="text-sm" data-approval-next="">
            {approvable ? <li>{approveConsequence(approval.kind)}</li> : null}
            <li>{rejectNext(approval.kind)}</li>
          </ul>
        </Section>

        {mayDecide ? (
          <div className="flex flex-wrap gap-2">
            {approvable ? (
              <Button
                disabled={pending}
                onClick={() => {
                  commands.decide.mutate({
                    approvalId: approval.id,
                    decision: 'approve',
                    // TD-035: the plan on screen, so the server approves exactly that or refuses.
                    ...(plan === null ? {} : { subjectArtifactId: plan.artifact_id }),
                  });
                }}
              >
                Approve
              </Button>
            ) : null}
            <Button
              tone="danger"
              disabled={pending}
              onClick={() => {
                commands.decide.reset();
                setConfirming(true);
              }}
            >
              Reject…
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={`Reject the ${kind}?`}
              consequence={rejectConsequence(approval.kind)}
              confirmLabel="Reject"
              reason={{
                label: 'Reason (recorded with the decision)',
                placeholder: 'Why (optional)',
                maxLength: MAX_COMMAND_TEXT_CHARS,
              }}
              pending={pending}
              error={commands.decide.error}
              errorTitle="That decision was refused."
              onConfirm={(reason) => {
                commands.decide.mutate(
                  {
                    approvalId: approval.id,
                    decision: 'reject',
                    ...(reason === '' ? {} : { reason }),
                  },
                  {
                    onSuccess: () => {
                      setConfirming(false);
                    },
                  },
                );
              }}
            />
          </div>
        ) : (
          <p data-may-not-decide="" className="text-xs text-fg-muted">
            A maintainer decides this.
          </p>
        )}
      </section>
    </Card>
  );
};
