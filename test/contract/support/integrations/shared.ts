/**
 * Assertions shared by the five integration contract suites (technical/10 § contract tier).
 *
 * Two habits are enforced here rather than left to each suite.
 *
 *  - **Errors are asserted by code, not by message.** `expectIntegrationError` fails with the
 *    error it actually got, so a suite can never pass because *something* threw — a
 *    `rejects.toThrow()` would accept a `TypeError` from a typo in the test itself.
 *  - **Normalised events are validated against the catalogue.** A provider that invents a payload
 *    field, or omits `project_id`, fails here rather than at the first append to `events`
 *    (technical/02, BD-022).
 */
import {
  type AgentTooling,
  agentToolingSchema,
  IntegrationError,
  type IntegrationErrorCode,
  type NormalisedEvent,
} from '@platform/application';
import { type DomainEventType, domainEventSchemasByType } from '@platform/contracts';
import { expect } from 'vitest';

/** Awaits `run` and asserts it rejected with an `IntegrationError` carrying `code`. */
export const expectIntegrationError = async (
  run: () => Promise<unknown>,
  code: IntegrationErrorCode,
): Promise<IntegrationError> => {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected an IntegrationError(${code}), nothing was thrown`).toBeInstanceOf(
    IntegrationError,
  );
  const error = caught as IntegrationError;
  expect(error.code, `wrong code; the error was: ${error.message}`).toBe(code);
  return error;
};

/**
 * Parses a normalised event's payload against its catalogue schema and returns it.
 *
 * The schemas are strict, so an unknown key fails here — which is the whole point: a normaliser
 * that carries a provider field through into a payload is a bug the event store would only find
 * in the integration tier.
 */
export const expectCatalogueEvent = <TType extends DomainEventType>(
  event: NormalisedEvent<DomainEventType>,
  type: TType,
): { readonly type: TType; readonly payload: Record<string, unknown> } => {
  expect(event.type).toBe(type);
  const schema = domainEventSchemasByType[type];
  const payload = schema.shape.payload.parse(event.payload) as Record<string, unknown>;
  // The actor belongs to the envelope (technical/02) and must also be legal.
  schema.shape.actor.parse(event.actor);
  return { type, payload };
};

/**
 * An agent tooling spec declares **names**, never values (BD-002, BD-025).
 *
 * `agentToolingSchema` is strict, so a provider that adds a `value` or `token` field fails the
 * parse; this also checks that every declared variable is an environment variable name with a
 * description.
 *
 * ## The obligation WP-11 added, and why it is here rather than in one provider's file
 *
 * Standing rule 23: a new port obligation lands in the **shared** suite in the same change, or it
 * is a provider-local promise. WP-11 found that a provider can honestly have nothing to mount —
 * Sentry's hosted MCP server authenticates by OAuth, which a spec carrying only *names* cannot
 * express, and the classic `sentry-cli` documents no issue commands at all — so a spec with no
 * `cli` and no `mcp` had to become legal. The previous rule ("at least one variable, always") made
 * that impossible, and would have pushed that adapter into declaring `SENTRY_AUTH_TOKEN` for a
 * tool that is not there.
 *
 * Relaxing it alone would have been a weakening, so the two halves are asserted together:
 *
 *  - a spec that **mounts** something (a CLI or an MCP server) must declare at least one variable,
 *    because a tool with no environment is a tool the runner cannot configure; and
 *  - a spec that mounts **nothing** must declare **no secret variable at all** — a credential
 *    injected into a run container for a tool that does not exist is a secret handed out for no
 *    reason (BD-025). That is a *positive* assertion (rule 12), not a comment.
 *
 * Both halves run for every provider and every fake, so a GitHub or a Datadog adapter is held to
 * them the moment it exists, without anything in the pipeline changing (BD-017).
 */
export const expectAgentTooling = (tooling: AgentTooling): void => {
  const parsed = agentToolingSchema.parse(tooling);
  const mountsATool = (parsed.cli ?? null) !== null || (parsed.mcp ?? null) !== null;
  if (mountsATool) {
    expect(
      parsed.env.variables.length,
      'a spec that mounts a CLI or an MCP server must name the variables the runner injects',
    ).toBeGreaterThan(0);
  } else {
    expect(
      parsed.env.variables.filter((variable) => variable.secret).map((variable) => variable.name),
      'a spec that mounts nothing must not ask the runner to inject a credential (BD-025)',
    ).toEqual([]);
  }
  for (const variable of parsed.env.variables) {
    expect(variable.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(variable.description.length).toBeGreaterThan(0);
  }
  const serialised = JSON.stringify(parsed);
  for (const forbidden of ['"value"', '"token"', '"password"', '"secret_value"']) {
    expect(serialised, `a tooling spec must not carry ${forbidden}`).not.toContain(forbidden);
  }
};
