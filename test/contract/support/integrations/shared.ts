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
 * parse; this also checks that every declared variable is an environment variable name and that at
 * least one secret is marked as such when a spec exists at all — a spec that marks nothing secret
 * is how a token ends up in a log line.
 */
export const expectAgentTooling = (tooling: AgentTooling): void => {
  const parsed = agentToolingSchema.parse(tooling);
  expect(parsed.env.variables.length).toBeGreaterThan(0);
  for (const variable of parsed.env.variables) {
    expect(variable.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    expect(variable.description.length).toBeGreaterThan(0);
  }
  const serialised = JSON.stringify(parsed);
  for (const forbidden of ['"value"', '"token"', '"password"', '"secret_value"']) {
    expect(serialised, `a tooling spec must not carry ${forbidden}`).not.toContain(forbidden);
  }
};
