/**
 * **"Let low-risk plans go ahead without approval"** — the project's opt-in low-risk rule (S-28.8,
 * the M28 ruling amending BD-006), on the operating-mode screen both the wizard and the settings
 * page render.
 *
 * The switch writes `policies.plan_approval_risk` into the project's configuration document through
 * `PUT /api/projects/:id/config` — the **whole** document plus the hash it was read at, like every
 * other control on this screen. The rule only ever **waives** an ask the plan-approval policy made
 * (TD-037 decision 4): it never makes a plan wait that would not have, so the screen says which
 * policy is in force and what that means together with the rule — a size threshold leaves smaller
 * plans unasked whatever the rule says. The owner's wish (*"low-risk plans go right away; where the
 * agent judges a human should approve, wait"*) is the combination **"Assess every plan"**: one save
 * that sets the plan-approval policy to `always` for the stage that writes the plan (the per-stage
 * `pipeline.template_overrides.<template>.stages.architecture.plan_approval`, the dial's own
 * override mechanism) and switches the rule on. Both are keys of the settings document, so both
 * need the administrator role (`project.settings.write`); a reader without it sees the controls
 * disabled and why. Sensitive areas and the first tasks' extra checks are untouched.
 *
 * Every word is the platform's; the thresholds are said as outcomes (*"only plans the agent calls
 * low-risk"*), never as the key names. Defaults are `PLAN_APPROVAL_RISK_DEFAULT` (contracts), the one
 * spelling the gate reads too, so the screen and the gate cannot disagree about an unset key.
 */
import {
  PLAN_APPROVAL_RISK_DEFAULT,
  type PlanApprovalRiskConfig,
  RISK_FACTORS,
  type RiskFactor,
  type Size,
} from '@platform/contracts';
import type { ReactElement } from 'react';
import {
  useOnboardingCommands,
  useProjectAutonomy,
  useProjectConfig,
  useSession,
} from '../app/queries.js';
import { Button, Card, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';
import { Select } from '../ui/select.js';
import { RISK_FACTOR_LABEL } from '../ui/words/plan-risk.js';

/** The rule as the document states it, every silent key at `PLAN_APPROVAL_RISK_DEFAULT`. */
export const lowRiskRuleOf = (stated: PlanApprovalRiskConfig | undefined) => ({
  enabled: stated?.enabled ?? PLAN_APPROVAL_RISK_DEFAULT.enabled,
  maxRisk: stated?.max_risk ?? PLAN_APPROVAL_RISK_DEFAULT.max_risk,
  minConfidence: stated?.min_confidence ?? PLAN_APPROVAL_RISK_DEFAULT.min_confidence,
  maxSize: stated?.max_size ?? PLAN_APPROVAL_RISK_DEFAULT.max_size,
  alwaysAsk: (stated?.always_ask ?? PLAN_APPROVAL_RISK_DEFAULT.always_ask) as readonly RiskFactor[],
});

/** The three thresholds, as choices worded by their outcome. */
export const MAX_RISK_CHOICES = [
  { value: 'low', label: 'Only plans the agent calls low-risk' },
  { value: 'medium', label: 'Plans the agent calls low- or medium-risk' },
] as const satisfies readonly { value: 'low' | 'medium'; label: string }[];

export const MIN_CONFIDENCE_CHOICES = [
  { value: 'high', label: 'Only when the agent is sure (high confidence)' },
  { value: 'medium', label: 'When the agent is fairly sure (medium or high confidence)' },
] as const satisfies readonly { value: 'high' | 'medium'; label: string }[];

export const MAX_SIZE_CHOICES = [
  { value: 'S', label: 'Small (S) only' },
  { value: 'M', label: 'Up to medium (M)' },
  { value: 'L', label: 'Up to large (L)' },
  { value: 'XL', label: 'Any size' },
] as const satisfies readonly { value: Size; label: string }[];

/** The two examples the screen gives, so the rule is read as what happens to a ticket. */
export const LOW_RISK_EXAMPLES = [
  'A one-file text fix the agent is sure of goes ahead.',
  'A plan touching database migrations still waits for you.',
] as const;

/** What the rule leaves alone, said where it is switched on. */
export const LOW_RISK_UNCHANGED =
  'Unchanged either way: a plan that touches a sensitive area, and the plans of this project’s first tasks, always wait for you; a person still merges.';

/** Said in both states: the rule only waives asks (TD-037 decision 4). */
export const LOW_RISK_NEVER_ADDS =
  'This never makes a plan wait that would not have waited without it.';

/** The ticket templates whose `architecture` stage writes the plan (`ImplementationPlan`). */
export const PLAN_TEMPLATES = ['feature', 'bug'] as const;
const PLAN_STAGE = 'architecture';

/** Which plans the plan-approval policy in force asks about, before the rule. */
export type PlanApprovalInForce =
  | { readonly kind: 'every' }
  | { readonly kind: 'size'; readonly threshold: Size }
  | { readonly kind: 'none' };

interface StageOverride {
  readonly plan_approval?: 'never' | 'above_size' | 'always';
  readonly size_threshold?: Size;
}
type TemplateOverrides = Record<string, { stages?: Record<string, StageOverride> } | undefined>;

/**
 * The plan-approval policy in force for a feature's plan, as the gate reads it: the stage override
 * where the settings state one, else the dial's materialised policy, else the never-materialised
 * default (`above_size` at L, the gate's `UNMATERIALISED_PLAN_APPROVAL`).
 */
export const planApprovalInForce = (
  dial: {
    readonly plan_approval: string;
    readonly plan_approval_size_threshold: Size | null;
  } | null,
  overrides: TemplateOverrides | undefined,
): PlanApprovalInForce => {
  const stage = overrides?.feature?.stages?.[PLAN_STAGE];
  const policy = stage?.plan_approval ?? dial?.plan_approval ?? 'above_size';
  const threshold = stage?.size_threshold ?? dial?.plan_approval_size_threshold ?? 'L';
  if (policy === 'always') return { kind: 'every' };
  if (policy === 'never') return { kind: 'none' };
  return { kind: 'size', threshold };
};

/** What the rule and the policy in force mean together, in one sentence. */
export const lowRiskSummary = (enabled: boolean, inForce: PlanApprovalInForce): string => {
  if (!enabled) {
    return 'Off (the default): plans wait for approval as How much agents do alone says.';
  }
  switch (inForce.kind) {
    case 'every':
      return 'Every plan is assessed. Low-risk plans (within the limits below) go ahead; all others wait for your approval, and the task page says why.';
    case 'size':
      return `Now: plans of size ${inForce.threshold} and larger are assessed; smaller plans go ahead without anyone being asked.`;
    case 'none':
      return 'Now: How much agents do alone lets every plan go ahead without approval, so this rule has nothing to waive.';
  }
};

/** The document with every plan assessed and the rule on — the one save "Assess every plan" makes. */
export const assessEveryPlan = (
  whole: Record<string, unknown>,
  stated: PlanApprovalRiskConfig | undefined,
): Record<string, unknown> => {
  const policies = (whole.policies ?? {}) as Record<string, unknown>;
  const pipeline = (whole.pipeline ?? {}) as Record<string, unknown>;
  const overrides = { ...((pipeline.template_overrides ?? {}) as Record<string, unknown>) };
  for (const template of PLAN_TEMPLATES) {
    const existing = (overrides[template] ?? {}) as { stages?: Record<string, unknown> };
    const stages = existing.stages ?? {};
    overrides[template] = {
      ...existing,
      stages: {
        ...stages,
        [PLAN_STAGE]: {
          ...((stages[PLAN_STAGE] ?? {}) as Record<string, unknown>),
          plan_approval: 'always',
        },
      },
    };
  }
  return {
    ...whole,
    pipeline: { ...pipeline, template_overrides: overrides },
    policies: { ...policies, plan_approval_risk: { ...(stated ?? {}), enabled: true } },
  };
};

export const LowRiskPlans = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const autonomy = useProjectAutonomy(projectId);
  const session = useSession();
  const commands = useOnboardingCommands();
  const document = config.data?.config as
    | {
        policies?: { plan_approval_risk?: PlanApprovalRiskConfig };
        pipeline?: { template_overrides?: TemplateOverrides };
      }
    | undefined;
  const stated = document?.policies?.plan_approval_risk;
  const rule = lowRiskRuleOf(stated);
  // Both writes are settings keys, so both need `project.settings.write` — the administrator.
  const mayChange = session.data?.user.role === 'admin';
  const disabled = !config.isSuccess || commands.writeConfig.isPending || !mayChange;
  const inForce = planApprovalInForce(
    autonomy.data?.materialised === true ? autonomy.data.policies : null,
    document?.pipeline?.template_overrides,
  );

  const write = (patch: PlanApprovalRiskConfig): void => {
    if (!config.isSuccess) {
      return;
    }
    const whole = config.data.config as Record<string, unknown>;
    const policies = (whole.policies ?? {}) as Record<string, unknown>;
    commands.writeConfig.mutate({
      projectId,
      config: {
        ...whole,
        policies: { ...policies, plan_approval_risk: { ...(stated ?? {}), ...patch } },
      },
      base_hash: config.data.hash,
    });
  };

  const toggleFactor = (factor: RiskFactor, asks: boolean): void => {
    const next = new Set(rule.alwaysAsk);
    if (asks) {
      next.add(factor);
    } else {
      next.delete(factor);
    }
    write({ always_ask: RISK_FACTORS.filter((entry) => next.has(entry)) });
  };

  return (
    <Card className="flex flex-col gap-3" data-low-risk-plans="">
      <SectionHeading>Low-risk plans</SectionHeading>
      {config.isPending ? <Loading label="Loading configuration…" /> : null}
      {config.isError ? (
        <ErrorNotice title="This project’s configuration could not be read." error={config.error} />
      ) : null}
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input
          type="checkbox"
          checked={rule.enabled}
          disabled={disabled}
          onChange={(event) => write({ enabled: event.target.checked })}
        />
        Let low-risk plans go ahead without approval
      </label>
      <p className="text-xs" data-low-risk-summary="">
        {lowRiskSummary(rule.enabled, inForce)}
      </p>
      <p className="text-xs text-fg-muted" data-low-risk-never-adds="">
        {LOW_RISK_NEVER_ADDS}
      </p>
      {rule.enabled && inForce.kind === 'every' ? null : (
        <div className="flex flex-col gap-1 rounded-md bg-subtle p-3" data-low-risk-every="">
          <p className="text-xs">
            Recommended to approve only what matters: <strong>Assess every plan</strong> asks for
            every plan, switches this rule on, and so lets the low-risk ones go ahead — all others
            wait for you.
            {inForce.kind === 'size'
              ? ` Keeping the size threshold instead leaves plans smaller than ${inForce.threshold} unasked, whatever this rule says.`
              : ''}
          </p>
          <div>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => {
                if (!config.isSuccess) return;
                commands.writeConfig.mutate({
                  projectId,
                  config: assessEveryPlan(config.data.config as Record<string, unknown>, stated),
                  base_hash: config.data.hash,
                });
              }}
            >
              Assess every plan
            </Button>
          </div>
        </div>
      )}
      {mayChange || session.isPending ? null : (
        <p className="text-xs text-fg-muted" data-low-risk-role="">
          Changing this needs the administrator role.
        </p>
      )}
      <ul className="flex flex-col gap-0.5 text-xs text-fg-muted" data-low-risk-examples="">
        {LOW_RISK_EXAMPLES.map((example) => (
          <li key={example}>{example}</li>
        ))}
      </ul>
      <p className="text-xs text-fg-muted" data-low-risk-unchanged="">
        {LOW_RISK_UNCHANGED}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">How risky a plan may be</span>
          <Select
            value={rule.maxRisk}
            disabled={disabled}
            onChange={(event) =>
              write({ max_risk: event.target.value === 'medium' ? 'medium' : 'low' })
            }
          >
            {MAX_RISK_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">How sure the agent must be</span>
          <Select
            value={rule.minConfidence}
            disabled={disabled}
            onChange={(event) =>
              write({ min_confidence: event.target.value === 'medium' ? 'medium' : 'high' })
            }
          >
            {MIN_CONFIDENCE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">How large a plan may be</span>
          <Select
            value={rule.maxSize}
            disabled={disabled}
            onChange={(event) => {
              const size = MAX_SIZE_CHOICES.find((choice) => choice.value === event.target.value);
              write({ max_size: size?.value ?? PLAN_APPROVAL_RISK_DEFAULT.max_size });
            }}
          >
            {MAX_SIZE_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <fieldset className="flex flex-col gap-1" data-low-risk-always-ask="">
        <legend className="text-sm font-medium">
          Never go ahead without approval when the plan touches
        </legend>
        <p className="text-xs text-fg-muted">
          Whether the platform finds it in the plan or the agent names it. Every item is ticked by
          default; untick one only when that kind of change may go ahead on the agent’s word.
        </p>
        <div className="grid gap-1 sm:grid-cols-2">
          {RISK_FACTORS.map((factor) => (
            <label key={factor} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={rule.alwaysAsk.includes(factor)}
                disabled={disabled}
                onChange={(event) => toggleFactor(factor, event.target.checked)}
              />
              {RISK_FACTOR_LABEL[factor]}
            </label>
          ))}
        </div>
      </fieldset>
      {commands.writeConfig.isError ? (
        <ErrorNotice title="The low-risk rule was not saved." error={commands.writeConfig.error} />
      ) : null}
    </Card>
  );
};
