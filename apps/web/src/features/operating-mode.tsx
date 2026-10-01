/**
 * **"Operating mode and features" — product/18:50-54, rendered in exactly one place.**
 *
 * product/18:55 is unconditional: *"Settings pages mirror the wizard one-to-one, so nothing is only
 * reachable during onboarding."* The cheapest way to keep a mirror true is not to have two of
 * something — so the wizard's step 4 (`features/onboarding.tsx`) and the project settings page
 * (`features/project-settings.tsx`) both render **this** component, and
 * `apps/server/src/routes/settings-mirror.test.ts` compares the two screens' command sets in both
 * directions so a control added to one and not the other fails.
 *
 * Step 4 has five items and this file has five sections, in the document's order:
 *
 * 1. **The autonomy dial** (BD-027) — including *Custom*, the differences, and "re-apply preset".
 * 2. **Feature toggles**, each carrying product/19:124's five card fields.
 * 3. **Risk classes** — the configured set, the proposal, and the checklists accepting asks for.
 * 4. **Budgets**, including the separate shadow and maintenance budgets.
 * 5. **Notifications** — digest and quiet hours; the channel is *named as a gap*.
 *
 * ## The gap that is left is on the screen, not in a comment
 *
 * A control that silently does nothing is worse than an absent one (the shape step 3 already uses
 * at `onboarding.tsx`), so the item this build cannot honestly carry says so where an operator
 * reads it. **Risk classes left this list at WP-37**: the proposal is real (the server sends one,
 * a Discovery run can produce it and accepting it writes the configuration document). Since WP-45
 * all six of product/19 §14's rows are proposed, and the two *"stricter checklist"* rows ask the
 * operator for the checklist's items by name before the accept button is enabled — the platform
 * ships none (Q83), and a class naming an undefined list is refused by the configuration schema.
 *
 * - **The notification channel.** A channel is a property of a `communication` binding, and this
 *   build resolves `git` and `task_management` only — `CommunicationPort` has no caller anywhere
 *   (WP-32). Digest and quiet hours are stored keys and are editable; the channel would be a field
 *   whose value nothing could ever read.
 *
 * ## Two switches for one feature, and which one wins
 *
 * `AutonomyPreset.reviewOnly` and `features.review_only.enabled` are both "review-only mode". The
 * **opt-in key wins**: BD-028 makes every adoption feature an opt-in and WP-24 wired
 * `features.review_only` to the pipeline, while the preset field has no reader and is recorded as
 * such in `AUTONOMY_POLICY_READERS`. The dial *recommends* — selecting Observe preselects the
 * feature — and the card writes the key. The card says this in one line, because an operator who
 * moves the dial to Observe and expects review-only to switch itself on is otherwise surprised.
 *
 * ## Everything from the server is data
 *
 * A project's configuration is partly written by its repository (`.agentic/config.yml`, layer
 * `repo`), so every string rendered from it goes through `ui/untrusted.tsx` (BD-022). Nothing here
 * builds markup from a string and nothing writes a URL attribute.
 */
import type { AutonomyResponse, BudgetRecord } from '@platform/contracts';
import { type ReactElement, useState } from 'react';
import {
  useOnboardingCommands,
  useProjectAudit,
  useProjectAutonomy,
  useProjectBindings,
  useProjectBudgets,
  useProjectConfig,
  useSettingsCommands,
} from '../app/queries.js';
import {
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  formatDateTime,
  formatUsd,
  Loading,
  SectionHeading,
} from '../ui/kit.js';
import { UntrustedText } from '../ui/untrusted.js';

/**
 * The configuration a binding already carries, by integration id (WP-32).
 *
 * `PUT /api/projects/:id/bindings` replaces the **whole** set, so every caller that re-sends it has
 * to send each binding's `config` back or erase it — and the notification channel is a key of that
 * document. It lives here because this is the component both screens already share; the two "Save
 * bindings" buttons call it for exactly that reason.
 */
export const bindingConfigOf = (
  items: readonly { readonly integration_id: string; readonly config?: unknown }[],
  integrationId: string,
): Record<string, unknown> | undefined => {
  const found = items.find((item) => item.integration_id === integrationId);
  const config = found?.config;
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : undefined;
};

/** product/19 §11's four dial positions, in order, with the one sentence each one is. */
export const AUTONOMY_CHOICES = [
  { level: 'observe', label: 'Observe', hint: 'Nothing is picked up; shadow runs only.' },
  { level: 'assist', label: 'Assist', hint: 'Scoping only — the agent stops after architecture.' },
  {
    level: 'supervised',
    label: 'Supervised',
    hint: 'The default: plan approval above size L, probation for the first 5 tasks.',
  },
  {
    level: 'autonomous',
    label: 'Autonomous',
    hint: 'No plan approval except for risk classes; still never merges (BD-007).',
  },
] as const satisfies readonly {
  level: 'observe' | 'assist' | 'supervised' | 'autonomous';
  label: string;
  hint: string;
}[];

export type AutonomyChoice = (typeof AUTONOMY_CHOICES)[number]['level'];

/**
 * product/19 §124's card, as data: *"name · one-sentence value · default · cost implication · what
 * it touches externally"*.
 *
 * Every entry names a key of `featuresConfigSchema`, because a card whose toggle wrote a key nothing
 * reads is the defect PROGRESS backlog 58 is about. **The list is compared with the platform's own
 * tables** (WP-44, backlog 108 and 72) rather than trusted: `operating-mode.test.tsx` holds the cards
 * plus {@link FEATURES_WITHOUT_A_SWITCH}'s keyed entries equal to `PLATFORM_DEFAULT_CONFIG.features`
 * in both directions, each card's default to that key's shipped `enabled`, and says a card may carry
 * an `unbuilt` line **exactly when** `FEATURE_READERS` names no reader for its key. That comparison
 * is what the epic split's missing card and the digest's stale *"nothing in this build sends a
 * notification"* each needed and did not have.
 */
export interface FeatureCard {
  readonly key:
    | 'review_only'
    | 'shadow_mode'
    | 'ticket_linter'
    | 'maintenance'
    | 'digest'
    | 'epic_split'
    | 'spike'
    | 'ask'
    | 'history_bootstrap';
  readonly name: string;
  readonly value: string;
  readonly defaultState: string;
  readonly cost: string;
  readonly touches: string;
  /**
   * One line where two switches exist, or a limit worth knowing before turning it on.
   *
   * **Not checked for a denial** (PROGRESS backlog 208): the comparison below holds `unbuilt` to
   * `FEATURE_READERS`, and nothing reads this line's meaning — a *"does nothing in this build"*
   * sentence typed here instead of in `unbuilt` passes every check. No source-text guard can tell a
   * limit from a denial; `operating-mode.test.tsx` states the same residual at the check.
   */
  readonly caveat?: string;
  /**
   * The one place a card may say its feature does **nothing** in this build — and the comparison
   * allows it only when `FEATURE_READERS` names no reader for the key. Every card is built today,
   * so no card has one.
   */
  readonly unbuilt?: string;
}

export const FEATURE_CARDS: readonly FeatureCard[] = [
  {
    key: 'review_only',
    name: 'Review-only mode',
    value:
      'Get review findings on your team’s merge requests today; teaches the knowledge base before the agent writes code.',
    defaultState: 'off',
    cost: '~$1–3 per merge request',
    touches: 'posts discussion threads on merge requests',
    caveat:
      'This toggle is what turns the mode on. Selecting Observe on the dial only *recommends* it — the dial’s own review-only field has no reader (BD-028: adoption features are opt-in).',
  },
  {
    key: 'shadow_mode',
    name: 'Shadow mode',
    value: 'See what the agent would have built for your last N tickets, at what cost.',
    defaultState: 'off',
    cost: '~$5–15 per ticket, from a separate budget',
    touches: 'nothing external',
    caveat:
      'This toggle and the autonomy dial both have to allow it: shadow runs are what the Observe position runs, so a project past Observe answers “not allowed” even with this on. Start a batch from the project’s Shadow screen.',
  },
  {
    key: 'ticket_linter',
    name: 'Ticket readiness linter',
    value: 'Questions a developer would ask, posted as one comment on new tickets.',
    defaultState: 'off',
    cost: '~$0.10 per ticket',
    touches: 'one comment per ticket on the ticket board',
  },
  {
    key: 'maintenance',
    name: 'Maintenance pipeline',
    value:
      'Weekly chores: dependency bumps, flaky tests, docs drift, lint debt, knowledge hygiene.',
    defaultState: 'off',
    cost: 'the budget you set',
    touches: 'opens merge requests',
    caveat:
      'The autonomy dial’s level applies here and its per-stage policies do not: at Observe no chore is created (Observe means no agent merge requests), and at Assist, Supervised and Autonomous each chore runs to a merge request a human reviews. Two of the five chore types run in this build — dependency bumps, from what the dependency gate recorded about this project’s packages, and knowledge-base hygiene, from the nightly pass. The other three are refused by name when they are configured, and the nightly pass reports them in the project’s daily digest (in the server log when the project has no digest or no chat binding): Flaky tests and docs drift have no detector in this build, and lint debt has no finding source — nothing records your project’s lint output for a chore to be briefed from.',
  },
  {
    key: 'digest',
    name: 'Digest and quiet hours',
    value: 'One chat summary a day; urgent items still immediate.',
    defaultState: 'on (digest at 09:00, quiet hours off)',
    cost: 'none',
    touches: 'posts to the chat channel',
    caveat: 'Needs a chat integration bound to the project; without one there is nowhere to post.',
  },
  {
    key: 'epic_split',
    name: 'Epic split',
    value:
      'An epic becomes a proposed ticket breakdown with acceptance criteria, for a maintainer to accept child by child on the task page.',
    defaultState: 'off',
    cost: 'one agent run per epic, within the stage’s run budget',
    touches: 'creates tickets in your tracker — one for each child you accept, never more',
    caveat:
      'Only tickets of the epic issue types are routed to it, and nothing is created until a maintainer accepts a child. Rejected children stay on the task with their reason.',
  },
  {
    key: 'spike',
    name: 'Spike template',
    value:
      'Tickets typed Spike get a research run that ends at a human with a report, not a merge request.',
    defaultState: 'off',
    cost: 'one agent run per spike, within the stage’s run budget',
    touches: 'nothing external beyond the workpad comment',
    caveat:
      'Turning it on changes what an existing Spike-typed ticket gets: it stops going through the default pipeline.',
  },
  {
    key: 'history_bootstrap',
    name: 'History bootstrap',
    value:
      'Mine your last merged merge requests and closed tickets for conventions and recurring review requests, as knowledge-base proposals you review.',
    defaultState: 'off',
    cost: 'shown before it runs, capped by its own budget',
    touches: 'nothing external — it reads your git host and tracker and writes proposals here',
    caveat:
      'Turning it on allows a batch; the batch itself is started from the History bootstrap step, with its estimate shown first.',
  },
  {
    key: 'ask',
    name: 'Ask the task',
    value:
      'Ask “why did you choose X?” on a task and get an answer from its audit trail and artifacts.',
    defaultState: 'on',
    cost: 'up to $0.50 per question by default',
    touches: 'nothing external unless mirroring answers to the ticket is turned on',
  },
];

/**
 * The adoption features product/18 lists that have no switch this screen can toggle — the declared
 * **exemption list** the card comparison reads (WP-44). An entry with a `key` is a shipped
 * `features.<key>` deliberately without a card, with the reason; an entry without one is a feature
 * with no configuration key at all, and it names the **routes** the client calls for the control
 * its `why` says is on (WP-62, PROGRESS backlog 208) — `operating-mode.test.tsx` resolves each one
 * against the paths the app's own sources name, so an exemption claiming a control nobody calls
 * fails instead of reading as a working feature. That these paths are *served* is
 * `apps/server/src/routes/client-census.test.ts`'s half.
 *
 * The `why` itself is free text and **is not checked for a denial** — the residual the feature
 * card's `caveat` has, stated there and at the test.
 */
export const FEATURES_WITHOUT_A_SWITCH: readonly {
  readonly name: string;
  readonly why: string;
  readonly key?: 'human_time';
  /** Normalised client paths (`${…}` → `{}`), required on every entry without a `key`. */
  readonly routes?: readonly string[];
}[] = [
  {
    name: 'Steer',
    why: 'on for members and maintainers; the run page carries the control',
    routes: ['/api/runs/{}/steer'],
  },
  {
    name: 'Take over / hand back',
    why: 'on; the task page carries both controls, and a taken-over workspace is kept for fourteen days, which is fixed in this build',
    routes: ['/api/tasks/{}/take-over', '/api/tasks/{}/hand-back'],
  },
  {
    name: 'Cost estimate before spend',
    why: 'the estimate is on and shown on the task page; its approval threshold is the dial’s',
    routes: ['/api/tasks/{}', '/api/tasks/{}/approvals/{}/decide'],
  },
  {
    name: 'Human time accounting',
    key: 'human_time',
    why: 'always recorded from events; the per-user breakdown is off by default and is set in the project’s configuration file (features.human_time.per_user_breakdown), not by a toggle',
  },
];

/**
 * The dial's policies that **set nothing by themselves**, by wire name, with what an operator should
 * know instead (WP-62, criterion 6; PROGRESS backlog 72).
 *
 * The dial's policy list printed all fifteen as facts until WP-62, and seven of them set nothing.
 * Thirteen have a reader now; these two are decided rather than deferred, and the list is held to
 * the platform's own `AUTONOMY_POLICY_READERS` in both directions by `operating-mode.test.tsx`, so a
 * policy that gains a reader and keeps its mark — or loses one and gains none — fails there.
 */
export const POLICIES_THAT_SET_NOTHING: Readonly<Record<string, string>> = {
  review_only:
    'a recommendation only — the Review-only mode card below is the switch (BD-028: adoption features are opt-in)',
  suggested_readiness_min:
    'published only — the suggested cap shown above is computed from the project’s readiness level',
};

/**
 * What a move of the dial does to a task that is **already running** (WP-62 review round 1).
 *
 * Three policies are frozen onto a task when it starts — `business_review` and `stop_after_stage`
 * (`tasks.pipeline_dial`) and the human-round ceiling (`tasks.iteration_limits`) — and every other
 * policy with a reader is read when it is used. Saying "a task keeps the position it started under"
 * would be false for the second group, so the line under the control names both.
 */
export const DIAL_TIMING_NOTE =
  'A move applies to running tasks in part: whether business review runs, the stop after architecture and the number of human review rounds are fixed when a task starts; plan approval, probation, the budget threshold, the question timeout and knowledge auto-apply are read when they are used.';

/** BD-010's windows, in the order a person thinks about them. */
const BUDGET_WINDOWS = ['day', 'week', 'month', 'total'] as const;

const LEVEL_TONE: Record<AutonomyChoice, BadgeTone> = {
  observe: 'danger',
  assist: 'warning',
  supervised: 'accent',
  autonomous: 'success',
};

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): ReactElement => (
  <Card className="flex flex-col gap-3">
    <SectionHeading>{title}</SectionHeading>
    {children}
  </Card>
);

// ── 1. The dial ──────────────────────────────────────────────────────────────

/**
 * product/18:50 — *"Pick the autonomy dial level (default Supervised; the wizard suggests a cap from
 * readiness)"*, plus BD-027's two consequences: *Custom* with the differences listed, and
 * "re-apply preset".
 */
export const AutonomyDial = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const autonomy = useProjectAutonomy(projectId);
  const commands = useSettingsCommands();
  const [chosen, setChosen] = useState<AutonomyChoice | null>(null);
  const [reason, setReason] = useState('');
  const current = autonomy.data ?? null;
  const level = chosen ?? (current?.level as AutonomyChoice | undefined) ?? 'supervised';
  const aboveCap =
    current !== null &&
    AUTONOMY_CHOICES.findIndex((choice) => choice.level === level) >
      AUTONOMY_CHOICES.findIndex((choice) => choice.level === current.suggested_cap);

  return (
    <Section title="Autonomy dial">
      {autonomy.isPending ? <Loading label="Loading the dial…" /> : null}
      {autonomy.isError ? (
        <ErrorNotice
          title="The autonomy dial could not be loaded."
          detail={String(autonomy.error)}
        />
      ) : null}

      {current === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={LEVEL_TONE[current.level as AutonomyChoice] ?? 'neutral'}>
            {current.level}
          </Badge>
          {current.is_custom ? <Badge tone="warning">Custom</Badge> : null}
          {current.materialised ? null : <Badge tone="warning">never applied</Badge>}
          {current.preset_outdated ? <Badge tone="warning">preset out of date</Badge> : null}
          <span className="text-xs text-fg-muted">
            preset v{current.preset_version}
            {current.applied_at === null
              ? ' · not applied in this release'
              : ` · applied ${formatDateTime(current.applied_at)}`}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-1">
        {AUTONOMY_CHOICES.map((choice) => (
          <label key={choice.level} className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="autonomy"
              checked={level === choice.level}
              onChange={() => setChosen(choice.level)}
            />
            <span>
              <span className="font-semibold">{choice.label}</span>
              <span className="block text-xs text-fg-muted">{choice.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <p className="text-xs text-fg-muted">{DIAL_TIMING_NOTE}</p>

      {current === null ? null : (
        <p className="text-xs text-fg-muted">
          Readiness is level {current.readiness_level}, which suggests at most{' '}
          <strong>{current.suggested_cap}</strong>. A suggestion is all it is — a maintainer may
          choose any position, visibly (BD-027, Q21).
        </p>
      )}
      {aboveCap ? (
        <Field
          label="Why above the suggested cap?"
          hint="Recorded in the audit row, redacted. Optional."
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          tone="primary"
          disabled={commands.setAutonomy.isPending}
          onClick={() => {
            commands.setAutonomy.mutate({
              projectId,
              autonomy: level,
              ...(reason.trim() === '' ? {} : { override_reason: reason }),
            });
          }}
        >
          Save operating mode
        </Button>
        {current === null ? null : (
          <Button
            disabled={commands.setAutonomy.isPending}
            onClick={() => {
              // "Re-apply preset" is selecting the position the project already has: the server
              // materialises this release's table for it (BD-027). One command, not two.
              commands.setAutonomy.mutate({
                projectId,
                autonomy: current.level as AutonomyChoice,
              });
            }}
          >
            Re-apply preset
          </Button>
        )}
      </div>
      {commands.setAutonomy.isError ? (
        <ErrorNotice title="The dial was not saved." detail={String(commands.setAutonomy.error)} />
      ) : null}

      {current !== null && current.overrides.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold">
            Custom — these policies differ from the preset this project was given
          </p>
          <ul className="flex flex-col gap-0.5 text-xs">
            {current.overrides.map((override) => (
              <li key={override.policy}>
                <code>
                  <UntrustedText value={override.policy} />
                </code>{' '}
                — preset {String(override.preset)}, in force {String(override.effective)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {current === null ? null : <PolicyTable autonomy={current} />}
    </Section>
  );
};

/**
 * What the dial actually set — read from the stored preset, never re-derived from the level — with
 * a mark on every policy that sets nothing by itself ({@link POLICIES_THAT_SET_NOTHING}).
 */
export const PolicyTable = ({
  autonomy,
}: {
  readonly autonomy: AutonomyResponse;
}): ReactElement => {
  const entries = Object.entries(autonomy.policies);
  const inert = entries.filter(([policy]) => policy in POLICIES_THAT_SET_NOTHING).length;
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-fg-muted">
        The {entries.length} policies this position holds — {entries.length - inert} in force,{' '}
        {inert} that set nothing by themselves
      </summary>
      <ul className="flex flex-col gap-0.5 pt-1 font-mono">
        {entries.map(([policy, value]) => {
          const why = POLICIES_THAT_SET_NOTHING[policy];
          return (
            <li key={policy} className="flex flex-wrap items-center gap-2">
              <span>{policy}</span>
              <span className="text-fg-muted">{String(value)}</span>
              {why === undefined ? null : (
                <>
                  <Badge tone="warning">sets nothing</Badge>
                  <span className="font-sans text-fg-muted">{why}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
};

// ── 2. Feature toggles ───────────────────────────────────────────────────────

/**
 * product/18:51 — *"Toggle features, each with a one-sentence value statement, its default and its
 * cost implication"* — with product/19:124's five card fields.
 *
 * A toggle writes `features.<key>.enabled` into the project's configuration document through
 * `PUT /api/projects/:id/config`, which takes the **whole** document plus the hash it was read at:
 * sending a fragment would discard every other key (the defect WP-21's round 2 fixed in the wizard).
 */
export const FeatureToggles = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const commands = useOnboardingCommands();
  // Q100 (WP-94): the level **in force** (the organisation's maximum already applied) is what the
  // scheduler reads, so it is what decides whether the maintenance card says it is paused.
  const autonomy = useProjectAutonomy(projectId);
  const pausedAtObserve = autonomy.data?.level_in_force === 'observe';
  const features =
    (config.data?.config as { features?: Record<string, { enabled?: boolean }> } | undefined)
      ?.features ?? {};

  const toggle = (key: FeatureCard['key'], enabled: boolean): void => {
    if (!config.isSuccess) {
      return;
    }
    const document = config.data.config as Record<string, unknown>;
    const existing = (document.features ?? {}) as Record<string, Record<string, unknown>>;
    commands.writeConfig.mutate({
      projectId,
      config: {
        ...document,
        features: { ...existing, [key]: { ...(existing[key] ?? {}), enabled } },
      },
      base_hash: config.data.hash,
    });
  };

  return (
    <Section title="Features">
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      {config.isError ? (
        <ErrorNotice
          title="This project’s configuration could not be read."
          detail={String(config.error)}
        />
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {FEATURE_CARDS.map((card) => (
          <Card key={card.key} className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                checked={features[card.key]?.enabled === true}
                disabled={!config.isSuccess || commands.writeConfig.isPending}
                onChange={(event) => toggle(card.key, event.target.checked)}
              />
              {card.name}
            </label>
            <p className="text-xs">{card.value}</p>
            <p className="text-xs text-fg-muted">
              Default: {card.defaultState} · Cost: {card.cost} · Touches: {card.touches}
            </p>
            {card.caveat === undefined ? null : (
              <p className="text-xs text-fg-muted">{card.caveat}</p>
            )}
            {card.unbuilt === undefined ? null : (
              <p className="text-xs text-warning">{card.unbuilt}</p>
            )}
            {card.key === 'maintenance' &&
            pausedAtObserve &&
            features.maintenance?.enabled === true ? (
              <p className="text-xs text-warning">
                Paused at Observe: the autonomy dial is at Observe, so the nightly pass creates no
                chore until the dial moves past it. The daily digest says so once when the pause
                begins and once when it ends.
              </p>
            ) : null}
          </Card>
        ))}
      </div>
      {commands.writeConfig.isError ? (
        <ErrorNotice
          title="The feature was not saved."
          detail={String(commands.writeConfig.error)}
        />
      ) : null}
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold">On by default, with nothing to toggle here</p>
        <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {FEATURES_WITHOUT_A_SWITCH.map((feature) => (
            <li key={feature.name}>
              <strong>{feature.name}</strong> — {feature.why}
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
};

// ── 3. Risk classes ──────────────────────────────────────────────────────────

/**
 * product/18:52 — *"Risk classes proposed from the repository structure; reviewer routing from
 * CODEOWNERS if present"* (WP-37).
 *
 * **The proposal is a proposal, in both directions** (standing rule 42). A project's
 * `policies.risk_classes` is empty until somebody accepts here, and accepting writes the
 * configuration document through the same `PUT /api/projects/:id/config` every other control on
 * this screen uses — with its `human_actions` row. The platform ships **no** default classes, which
 * is the point: a set that arrived with a deploy would gate every existing project's migrations
 * without anybody having chosen it.
 *
 * What is proposed comes from the server (`GET …/config`, `risk_class_proposal`), so this screen
 * invents nothing: a Discovery run's suggestion when there is one, and product/19 §14's own table
 * when there is not. The two say different things on the screen, because *"the agent read your
 * repository"* is a different claim from *"here is the standard set"*.
 *
 * Everything rendered here is untrusted (BD-022): the class names are the platform's, and the paths
 * are whatever a repository or an operator wrote, so they go through `UntrustedText` like every
 * other string on this screen.
 */
export const RiskClasses = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const commands = useOnboardingCommands();
  const policiesOf = config.data?.config as
    | {
        policies?: {
          risk_classes?: Record<string, { paths: string[]; require: string[] }>;
          review_checklists?: Record<string, string[]>;
        };
      }
    | undefined;
  const classes = policiesOf?.policies?.risk_classes ?? {};
  const configuredLists = policiesOf?.policies?.review_checklists ?? {};
  const names = Object.keys(classes);
  const proposal = config.data?.risk_class_proposal;
  const proposed = Object.entries(proposal?.classes ?? {});
  // The lists accepting would leave undefined — each needs the operator's own items (Q83: the
  // platform ships none), because the configuration schema refuses a class naming a missing list.
  const toWrite = (proposal?.checklists ?? []).filter((entry) => !entry.defined);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  // `Object.hasOwn`, because a list name is a project-chosen slug and `constructor` is one.
  const draftOf = (name: string): string =>
    Object.hasOwn(drafts, name) ? (drafts[name] ?? '') : '';
  const itemsOf = (name: string): string[] =>
    draftOf(name)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  const unwritten = toWrite.filter((entry) => itemsOf(entry.name).length === 0);

  const accept = (): void => {
    if (!config.isSuccess || proposal === undefined || unwritten.length > 0) {
      return;
    }
    const document = config.data.config as Record<string, unknown>;
    const policies = (document.policies ?? {}) as Record<string, unknown>;
    const written = Object.fromEntries(toWrite.map((entry) => [entry.name, itemsOf(entry.name)]));
    // The **whole** document plus the hash it was read at, like every other write on this screen:
    // a fragment would discard every other key.
    commands.writeConfig.mutate({
      projectId,
      config: {
        ...document,
        policies: {
          ...policies,
          risk_classes: proposal.classes,
          ...(toWrite.length === 0
            ? {}
            : { review_checklists: { ...configuredLists, ...written } }),
        },
      },
      base_hash: config.data.hash,
    });
  };

  return (
    <Section title="Risk classes">
      {names.length === 0 ? (
        <EmptyState
          title="No risk classes configured"
          hint="A risk class is a set of paths (auth, payments, migrations, infra) that forces a plan approval, can route the review to named people and can give the reviewer a checklist of your own when a change touches them."
        />
      ) : (
        <ul className="flex flex-col gap-1 text-xs">
          {names.map((name) => (
            <li key={name} className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">
                <UntrustedText value={name} />
              </Badge>
              <code>
                <UntrustedText value={(classes[name]?.paths ?? []).join(', ')} />
              </code>
              <span className="text-fg-muted">
                requires <UntrustedText value={(classes[name]?.require ?? []).join(', ')} />
              </span>
            </li>
          ))}
        </ul>
      )}

      {Object.keys(configuredLists).length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-semibold">Review checklists</p>
          <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
            {Object.entries(configuredLists).map(([name, items]) => (
              <li key={name}>
                <strong>
                  <UntrustedText value={name} />
                </strong>{' '}
                — {items.length} item(s) the reviewer is given, beside its own default checks, when
                a class that names it matches
              </li>
            ))}
          </ul>
        </div>
      )}

      {proposed.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold">
            {proposal?.source === 'discovery'
              ? 'Proposed by the Discovery agent from this repository’s structure'
              : 'The platform’s suggested set (no discovery run has proposed one)'}
          </p>
          <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
            {proposed.map(([name, declared]) => (
              <li key={name} className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">
                  <UntrustedText value={name} />
                </Badge>
                <code>
                  <UntrustedText value={declared.paths.join(', ')} />
                </code>
                <span>
                  requires <UntrustedText value={declared.require.join(', ')} />
                </span>
              </li>
            ))}
          </ul>
          {(proposal?.checklists ?? []).length === 0 ? null : (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-semibold">Checklists these classes need, in your words</p>
              {(proposal?.checklists ?? []).map((entry) => (
                <div key={entry.name} className="flex flex-col gap-1 text-xs">
                  <span>
                    <code>
                      checklist:
                      <UntrustedText value={entry.name} />
                    </code>{' '}
                    (required by <UntrustedText value={entry.required_by.join(', ')} />) —{' '}
                    <UntrustedText value={entry.purpose} />
                  </span>
                  {entry.defined ? (
                    <span className="text-fg-muted">
                      Already defined in this project’s configuration; accepting keeps it.
                    </span>
                  ) : (
                    <textarea
                      aria-label={`Items for checklist ${entry.name}`}
                      value={draftOf(entry.name)}
                      onChange={(event) => {
                        setDrafts({ ...drafts, [entry.name]: event.target.value });
                      }}
                      placeholder="One review item per line"
                      className="min-h-16 rounded-md border border-line bg-surface px-2 py-1 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <div>
            <Button
              type="button"
              onClick={accept}
              disabled={!config.isSuccess || commands.writeConfig.isPending || unwritten.length > 0}
            >
              {names.length === 0 ? 'Accept these classes' : 'Replace with these classes'}
            </Button>
          </div>
          {unwritten.length === 0 ? null : (
            <p className="text-xs text-fg-muted">
              Write at least one item for{' '}
              <UntrustedText value={unwritten.map((entry) => entry.name).join(', ')} /> first: a
              class that names a checklist the configuration does not define is refused, so that a
              requirement is never accepted and then silently ignored.
            </p>
          )}
          <p className="text-xs text-fg-muted">
            Nothing is applied until you accept. Accepting writes <code>policies.risk_classes</code>{' '}
            (and the checklists you wrote, as <code>policies.review_checklists</code>) into this
            project’s configuration and records who did it; you can edit both afterwards in{' '}
            <code>.agentic/config.yml</code>. The platform ships no checklist items: a checklist is
            added to the reviewer’s own default checks, never instead of them, and the review
            records which lists it was given.
          </p>
        </div>
      )}

      {commands.writeConfig.isError ? (
        <ErrorNotice
          title="The risk classes were not saved."
          detail={String(commands.writeConfig.error)}
        />
      ) : null}

      <p className="text-xs text-fg-muted">
        A class can force a plan approval, add a named reviewer and give the reviewer a checklist.
        Reviewers are routed at the rebase gate: a <code>CODEOWNERS</code> match first, then this
        project’s <code>policies.reviewers</code>, then the human who asked for the task — and a
        handle the git provider does not know is reported rather than assigned to somebody else.
      </p>
    </Section>
  );
};

// ── 4. Budgets ───────────────────────────────────────────────────────────────

/**
 * product/18:53 — *"Budgets, including a separate shadow/maintenance budget"*.
 *
 * The four windows are BD-010's (`day`, `week`, `month`, `total`) and reaching one prevents **new**
 * runs while running runs finish. The shadow and maintenance budgets are a different thing and are
 * shown as such: they are per-feature caps in the configuration document
 * (`features.shadow_mode.budget_usd`, `features.maintenance.budget_usd`), not `budgets` rows.
 *
 * Since WP-34 the **shadow** one has a reader: the stage executor checks it at every shadow run's
 * admission, against this project's shadow spend for the calendar month
 * (`shadowBudgetUsdOf`, `ShadowStore.shadowSpendSince`). The maintenance one still has none, and
 * the copy below says which is which.
 */
export const Budgets = ({
  projectId,
  budgets,
  onSave,
  pending,
  error,
  scopeLabel,
}: {
  readonly projectId: string | null;
  readonly budgets: readonly BudgetRecord[];
  readonly onSave: (window: (typeof BUDGET_WINDOWS)[number], limitUsd: number | null) => void;
  readonly pending: boolean;
  readonly error: unknown;
  readonly scopeLabel: string;
}): ReactElement => {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const owned = budgets.filter((budget) =>
    projectId === null ? budget.scope === 'org' : budget.scope_id === projectId,
  );

  return (
    <Section title={`${scopeLabel} budgets`}>
      <p className="text-xs text-fg-muted">
        Reaching a cap prevents <em>new</em> runs; a run already in flight finishes, because spend
        already made should not be wasted (BD-010). A task then reads <em>Paused: budget</em> and a
        maintainer may raise the cap here.
      </p>
      <ul className="flex flex-col gap-2">
        {BUDGET_WINDOWS.map((window) => {
          const existing = owned.find((budget) => budget.window === window) ?? null;
          const draft = drafts[window] ?? (existing === null ? '' : String(existing.limit_usd));
          return (
            <li key={window} className="flex flex-wrap items-end gap-2">
              <Field
                label={`Per ${window}`}
                hint={
                  existing === null
                    ? 'No cap. Empty means no cap.'
                    : `spent ${formatUsd(existing.spent_usd)} of ${formatUsd(existing.limit_usd)} this window`
                }
                type="number"
                min={0}
                step="0.01"
                value={draft}
                onChange={(event) => setDrafts({ ...drafts, [window]: event.target.value })}
              />
              <Button
                disabled={pending}
                onClick={() => {
                  const trimmed = draft.trim();
                  // An empty field removes the cap. It is not "zero": a zero cap would block every
                  // run for ever, and the table refuses it anyway.
                  onSave(window, trimmed === '' ? null : Number(trimmed));
                }}
              >
                {draft.trim() === '' ? 'Remove cap' : 'Save cap'}
              </Button>
            </li>
          );
        })}
      </ul>
      {error === null || error === undefined ? null : (
        <ErrorNotice title="The budget was not saved." detail={String(error)} />
      )}
    </Section>
  );
};

/** The project half, wired to its own reads and commands. */
export const ProjectBudgets = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const budgets = useProjectBudgets(projectId);
  const config = useProjectConfig(projectId);
  const commands = useSettingsCommands();
  const features =
    (config.data?.config as { features?: Record<string, { budget_usd?: number }> } | undefined)
      ?.features ?? {};

  return (
    <>
      <Budgets
        projectId={projectId}
        budgets={budgets.data?.items ?? []}
        pending={commands.setProjectBudget.isPending}
        error={commands.setProjectBudget.error}
        scopeLabel="Project"
        onSave={(window, limitUsd) => {
          commands.setProjectBudget.mutate({ projectId, window, limit_usd: limitUsd });
        }}
      />
      <Card className="flex flex-col gap-1 text-xs">
        <p className="font-semibold">Separate feature budgets</p>
        <p className="text-fg-muted">
          Shadow mode:{' '}
          {features.shadow_mode?.budget_usd === undefined
            ? 'not set'
            : formatUsd(features.shadow_mode.budget_usd)}{' '}
          · Maintenance:{' '}
          {features.maintenance?.budget_usd === undefined
            ? 'not set'
            : formatUsd(features.maintenance.budget_usd)}
        </p>
        <p className="text-fg-muted">
          These are per-feature caps in <code>.agentic/config.yml</code>, not budget rows. Both are
          enforced the same way and over the same window: a run is refused when this project’s spend
          for the calendar month plus what the stage may spend would pass the cap, and the task
          pauses exactly as it does for an organisation or project budget. The shadow cap counts
          shadow tasks; the maintenance cap counts the chores the scheduler created, and once it is
          spent the scheduler creates no more of them for that month.
        </p>
      </Card>
    </>
  );
};

// ── 5. Notifications ─────────────────────────────────────────────────────────

/**
 * product/18:54 — *"Notifications: channel, quiet hours, digest"*. All three, since WP-32.
 *
 * The **channel** was named as a gap here until the notification band existed, for a reason that
 * belonged to this release rather than to this screen: *"a channel is a property of a
 * `communication` binding, and this build resolves `git` and `task_management` only … the channel
 * would be a field whose value nothing could ever read"*. All three halves of that are now false —
 * the loader resolves a chat binding, `communicationWrites` calls it, and the channel is the key
 * the loader reads (standing rule 83).
 *
 * **Where the value lives is the decision this control implements.** The channel is written to
 * `bindings.config.channel` — the project's overlay on the chat *account's* configuration — and not
 * to `features.digest`: one Slack account serves every project in an organisation, a feature key
 * would be a second place to change one thing, and the two would disagree the first time a project
 * moved workspace. `PUT …/bindings` replaces the whole set, so this sends every binding back with
 * the configuration it already had and this one key changed.
 *
 * A project with no chat binding gets a sentence and a link rather than an input: there is nowhere
 * for a channel to be, and a control that stored one would be storing it against nothing.
 */
export const Notifications = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const bindings = useProjectBindings(projectId);
  const commands = useOnboardingCommands();
  const bound = bindings.data?.items ?? [];
  const chat = bound.find((item) => item.type === 'communication');
  const chatConfig = chat === undefined ? undefined : bindingConfigOf(bound, chat.integration_id);
  const storedChannel = typeof chatConfig?.channel === 'string' ? chatConfig.channel : '';
  const [channel, setChannel] = useState<string | null>(null);
  const digest =
    (
      config.data?.config as
        | {
            features?: {
              digest?: {
                enabled?: boolean;
                at?: string;
                quiet_hours?: { from: string; to: string } | null;
              };
            };
          }
        | undefined
    )?.features?.digest ?? {};
  const [at, setAt] = useState<string | null>(null);
  const [quietFrom, setQuietFrom] = useState<string | null>(null);
  const [quietTo, setQuietTo] = useState<string | null>(null);

  const write = (next: Record<string, unknown>): void => {
    if (!config.isSuccess) {
      return;
    }
    const document = config.data.config as Record<string, unknown>;
    const existing = (document.features ?? {}) as Record<string, unknown>;
    commands.writeConfig.mutate({
      projectId,
      config: {
        ...document,
        features: { ...existing, digest: { ...digest, ...next } },
      },
      base_hash: config.data.hash,
    });
  };

  return (
    <Section title="Notifications">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={digest.enabled === true}
          disabled={!config.isSuccess || commands.writeConfig.isPending}
          onChange={(event) => write({ enabled: event.target.checked })}
        />
        Daily digest
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <Field
          label="Digest at"
          hint="HH:MM in the organisation’s timezone."
          value={at ?? digest.at ?? '09:00'}
          onChange={(event) => setAt(event.target.value)}
        />
        <Field
          label="Quiet from"
          hint="Leave both empty for no quiet hours."
          value={quietFrom ?? digest.quiet_hours?.from ?? ''}
          onChange={(event) => setQuietFrom(event.target.value)}
        />
        <Field
          label="Quiet to"
          hint="HH:MM"
          value={quietTo ?? digest.quiet_hours?.to ?? ''}
          onChange={(event) => setQuietTo(event.target.value)}
        />
        <Button
          disabled={!config.isSuccess || commands.writeConfig.isPending}
          onClick={() => {
            const from = quietFrom ?? digest.quiet_hours?.from ?? '';
            const to = quietTo ?? digest.quiet_hours?.to ?? '';
            write({
              at: at ?? digest.at ?? '09:00',
              quiet_hours: from === '' || to === '' ? null : { from, to },
            });
          }}
        >
          Save notifications
        </Button>
      </div>
      {chat === undefined ? (
        <p className="text-xs text-fg-muted">
          No chat integration is bound to this project, so nothing is posted anywhere. Bind one from
          the project settings page and the channel appears here.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field
            label="Channel"
            hint="Where task threads and notifications are posted, for this project."
            value={channel ?? storedChannel}
            onChange={(event) => setChannel(event.target.value)}
          />
          <Button
            disabled={commands.putBindings.isPending || (channel ?? storedChannel).trim() === ''}
            onClick={() => {
              commands.putBindings.mutate({
                projectId,
                items: bound.map((item) => ({
                  integration_id: item.integration_id,
                  config:
                    item.integration_id === chat.integration_id
                      ? { ...(chatConfig ?? {}), channel: (channel ?? storedChannel).trim() }
                      : bindingConfigOf(bound, item.integration_id),
                })),
              });
            }}
          >
            Save channel
          </Button>
          <p className="w-full text-xs text-fg-muted">
            Posted through <UntrustedText value={chat.provider} />. Urgent classes — an escalation
            and a budget at 100 % — are sent immediately even inside quiet hours.
          </p>
        </div>
      )}
      {commands.putBindings.isError ? (
        <ErrorNotice
          title="The channel was not saved."
          detail={String(commands.putBindings.error)}
        />
      ) : null}
      {commands.writeConfig.isError ? (
        <ErrorNotice
          title="The notification settings were not saved."
          detail={String(commands.writeConfig.error)}
        />
      ) : null}
    </Section>
  );
};

// ── The audit of every toggle (product/18:5, BD-003) ─────────────────────────

/**
 * *"Every toggle records who changed it (audit)"* — and a row nothing reads is not a record anybody
 * can check, which is PROGRESS backlog 52. This is that reader.
 *
 * `params` is client-supplied JSON carrying a client-chosen `Idempotency-Key`, so it renders through
 * the untrusted path like everything else (BD-022).
 */
export const SettingsAudit = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const audit = useProjectAudit(projectId);
  return (
    <Section title="Who changed what">
      {audit.isPending ? <Loading label="Loading the audit…" /> : null}
      {audit.isError ? (
        <ErrorNotice
          title="The settings audit could not be loaded."
          detail="Reading it needs the maintainer role."
        />
      ) : null}
      {audit.isSuccess && audit.data.items.length === 0 ? (
        <EmptyState
          title="No settings changes recorded"
          hint="Every accepted write to this project’s settings leaves one row here."
        />
      ) : null}
      <ul className="flex flex-col gap-1">
        {(audit.data?.items ?? []).map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2 text-xs">
            <Badge>{entry.action}</Badge>
            <UntrustedText value={entry.user_email ?? 'account removed'} />
            <span className="text-fg-muted">{formatDateTime(entry.created_at)}</span>
            <code className="text-fg-muted">
              <UntrustedText value={JSON.stringify(entry.params)} />
            </code>
          </li>
        ))}
      </ul>
    </Section>
  );
};

// ── The whole of step 4, for both screens ────────────────────────────────────

/**
 * product/18:50-54 in one component, so the wizard and the settings page cannot drift.
 *
 * `audit` is off in the wizard: a project being created has no settings history, and an empty panel
 * on the first screen an operator sees would be noise.
 */
export const OperatingMode = ({
  projectId,
  audit = false,
}: {
  readonly projectId: string;
  readonly audit?: boolean;
}): ReactElement => (
  <div className="flex flex-col gap-3">
    <AutonomyDial projectId={projectId} />
    <FeatureToggles projectId={projectId} />
    <RiskClasses projectId={projectId} />
    <ProjectBudgets projectId={projectId} />
    <Notifications projectId={projectId} />
    {audit ? <SettingsAudit projectId={projectId} /> : null}
  </div>
);
