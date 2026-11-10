/**
 * **"Let low-risk plans go ahead without approval"** — the project's opt-in low-risk rule (S-28.8,
 * the M28 ruling amending BD-006), on the operating-mode screen both the wizard and the settings
 * page render.
 *
 * The switch writes `policies.plan_approval_risk` into the project's configuration document through
 * `PUT /api/projects/:id/config` — the **whole** document plus the hash it was read at, like every
 * other control on this screen. Off, nothing changes. On, a plan goes ahead with nobody asked when
 * the platform finds none of the ticked risks in it **and** the agent's own assessment is inside the
 * three thresholds; anything else waits, with the reasons on the card. What it does not change is
 * said here too: sensitive areas (risk classes) and the first tasks' extra checks still wait.
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
import { useOnboardingCommands, useProjectConfig } from '../app/queries.js';
import { Card, ErrorNotice, Loading, SectionHeading } from '../ui/kit.js';
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
  'Anything touching database migrations waits for you.',
] as const;

/** What the rule leaves alone, said where it is switched on. */
export const LOW_RISK_UNCHANGED =
  'Unchanged either way: a plan that touches a sensitive area, and the plans of this project’s first tasks, always wait for you; a person still merges.';

export const LowRiskPlans = ({ projectId }: { readonly projectId: string }): ReactElement => {
  const config = useProjectConfig(projectId);
  const commands = useOnboardingCommands();
  const document = config.data?.config as
    | { policies?: { plan_approval_risk?: PlanApprovalRiskConfig } }
    | undefined;
  const stated = document?.policies?.plan_approval_risk;
  const rule = lowRiskRuleOf(stated);
  const disabled = !config.isSuccess || commands.writeConfig.isPending;

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
      <p className="text-xs">
        {rule.enabled
          ? 'On: a plan that would wait only because of its size or because every plan is approved goes ahead with nobody asked, when the platform finds none of the risks below in it and the agent judges it inside the limits below. Otherwise it waits for you as before, and the card says why. This never makes a plan wait that would not have.'
          : 'Off (the default): plans wait for approval as How much agents do alone says.'}
      </p>
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
        <legend className="text-sm font-medium">Always wait for you when the plan touches</legend>
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
