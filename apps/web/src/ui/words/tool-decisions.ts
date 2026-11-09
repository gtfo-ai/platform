/**
 * **What the permission check decided about a tool call**, in words (S-25.22, BACKLOG 1373): the
 * transcript's hook row printed `deny` and `ask` as a badge. Keyed by the contract's
 * `toolDecisionSchema`, so a decision added there fails the build here until it is worded.
 */
import type { ToolDecision } from '@platform/contracts';

export const TOOL_DECISION_LABEL: Readonly<Record<ToolDecision, string>> = {
  allow: 'Allowed',
  ask: 'Asked a person',
  deny: 'Refused',
};

/** The words for a recorded decision; one this build does not know reads *Decided*. */
export const toolDecisionLabel = (decision: string): string =>
  Object.hasOwn(TOOL_DECISION_LABEL, decision)
    ? TOOL_DECISION_LABEL[decision as ToolDecision]
    : 'Decided';
