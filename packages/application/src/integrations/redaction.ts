/**
 * Step 1 of TD-012's redaction pipeline: exact match of every secret the platform itself injected.
 *
 * > Before any write to `run_messages`, `integration_actions`, `events.payload`, `config_audit`,
 * > artifacts and KB commits: (1) replace every secret value the platform injected into the
 * > run/environment (`[REDACTED:integration:<name>]`), (2) apply a curated subset of gitleaks'
 * > rule set …, (3) optional entropy heuristic in key-like contexts.
 *
 * Only (1) lives here, because only (1) is knowable without a pattern corpus: the platform knows
 * exactly which strings it handed to a provider or a run. (2) and (3) are the run-transcript
 * redactor's job (WP-12) and are noted as discovered work; a caller that needs all three composes
 * them, which is why `SecretRedactor` is an interface rather than a function.
 *
 * The redactor is a pure function of its secret set: no I/O, no clock, no state. It is *only* safe
 * because it is applied at the write, never at the read — an append-only row cannot be fixed
 * afterwards (BD-003).
 */
import type { JsonObject, JsonValue } from '@platform/contracts';
import type { RedactionOutcome, SecretRedactor } from '../ports/integrations/audit.js';

/** A value the platform injected somewhere, and the name it is known by in the settings. */
export interface InjectedSecret {
  /** Stable name for the placeholder: the integration's name, `gitlab_token`, `slack_app`. */
  readonly name: string;
  readonly value: string;
}

/**
 * Shortest value that may be treated as a secret.
 *
 * A three-character "secret" would turn most of the audit log into placeholders while looking like
 * it worked, so it is a loud configuration error rather than a silent one.
 */
export const MIN_SECRET_LENGTH = 8;

export const secretPlaceholder = (name: string): string => `[REDACTED:integration:${name}]`;

/**
 * Builds a redactor over a fixed set of injected secrets.
 *
 * Longest value first: when one secret is a prefix of another (a token and the same token with a
 * suffix), replacing the longer one first is the only order that leaves no fragment behind.
 *
 * @throws {TypeError} when a secret is shorter than {@link MIN_SECRET_LENGTH} or unnamed.
 */
export const exactSecretRedactor = (secrets: Iterable<InjectedSecret>): SecretRedactor => {
  const prepared = [...secrets]
    .map((secret) => {
      if (secret.name.length === 0) {
        throw new TypeError('an injected secret needs a name for its placeholder (TD-012)');
      }
      if (secret.value.length < MIN_SECRET_LENGTH) {
        throw new TypeError(
          `injected secret "${secret.name}" is shorter than ${MIN_SECRET_LENGTH} characters; ` +
            'redacting it would erase ordinary text',
        );
      }
      return secret;
    })
    .sort((left, right) => right.value.length - left.value.length);

  const redactText = (text: string): RedactionOutcome<string> => {
    let value = text;
    let count = 0;
    for (const secret of prepared) {
      if (!value.includes(secret.value)) {
        continue;
      }
      const parts = value.split(secret.value);
      count += parts.length - 1;
      value = parts.join(secretPlaceholder(secret.name));
    }
    return { value, count };
  };

  /**
   * Walks a JSON document, redacting string leaves.
   *
   * Object **keys** are left alone: the platform never builds a key out of secret material, and
   * rewriting keys could collide two fields into one. A provider that put a token in a key would
   * therefore leak it — recorded here rather than assumed away.
   *
   * That is a statement about the *platform's* keys, and one provider's keys are not the
   * platform's: a Loki stream is `{"<label name>": "<value>"}`, so a label name is provider text
   * in key position. Loki redacts its own keys where it emits them (`loki/provider.ts`,
   * `capLabelSet`, divergence 9) and resolves the collision this docblock predicts by keeping the
   * first entry and marking the set. Any later port whose keys come from the provider owes the
   * same, and the check is "who chooses the key", not "who wrote the schema".
   *
   * The pattern generalises: *the emitting site redacts the key, because only it knows what a
   * collision costs there.* Widening this walk to rewrite keys would take that judgement away —
   * Loki counts a collision into its truncation marker, and a shared walk has nowhere to report
   * one.
   *
   * **Which sites owe it is not maintainable from here.** This docblock said "two sites owe it
   * today" and named Loki's label names and Jira's `ErrorCollection.errors`; the *same commit that
   * wrote the sentence* added a third — `gitlab/http.ts` redacts response header **names**, which
   * are provider-chosen keys of exactly this class — and the sentence survived the change that
   * falsified it (standing rule 63). A count of other files cannot be checked from inside one of
   * them, and nothing mechanical can decide which object keys come from a provider, so the list
   * lives in **`docs/technical/06-integrations-architecture.md` § "Redact at the transport"**,
   * rule 4, which is where a reviewer of a *new* provider is already reading. This ring states the
   * obligation; the doc holds the roll.
   */
  const redactValue = (input: JsonValue): RedactionOutcome<JsonValue> => {
    if (typeof input === 'string') {
      return redactText(input);
    }
    if (Array.isArray(input)) {
      let count = 0;
      const value = input.map((item) => {
        const redacted = redactValue(item as JsonValue);
        count += redacted.count;
        return redacted.value;
      });
      return { value, count };
    }
    if (input !== null && typeof input === 'object') {
      let count = 0;
      const value: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(input)) {
        const redacted = redactValue(item as JsonValue);
        count += redacted.count;
        value[key] = redacted.value;
      }
      return { value, count };
    }
    return { value: input, count: 0 };
  };

  return {
    redactText,
    redactJson: (value: JsonObject): RedactionOutcome<JsonObject> => {
      const redacted = redactValue(value as JsonValue);
      return { value: redacted.value as JsonObject, count: redacted.count };
    },
  };
};

/**
 * A redactor for a binding that injected nothing at all.
 *
 * It exists so that "there are no secrets in this context" is written down explicitly at the
 * composition root instead of being expressed by passing a hand-rolled no-op — and so that a
 * search for it finds every place that claims it.
 */
export const noSecretsRedactor = (): SecretRedactor => exactSecretRedactor([]);

/**
 * Applies several redactors in order, summing their counts.
 *
 * It exists because of the shape rule 31 was earned in. An adapter is *handed* a redactor — that is
 * the only way a secret the platform injected somewhere else (a run-scoped token, another
 * binding's credential) can be known to it — and it also knows **its own** binding's credential,
 * which nobody else has to remember to tell it. Requiring the injected one in the type discharges
 * "an optional security dependency is an absent one"; composing its own on top is what stops a
 * caller that passes {@link noSecretsRedactor} from silently disarming the adapter.
 *
 * Order is left to right and only matters for the placeholder name a value ends up carrying: once
 * a redactor has replaced a value, the later ones see a placeholder rather than the secret, so a
 * secret known to two of them is counted once.
 */
export const composeSecretRedactors = (
  ...redactors: readonly SecretRedactor[]
): SecretRedactor => ({
  redactText: (text: string): RedactionOutcome<string> =>
    redactors.reduce<RedactionOutcome<string>>(
      (outcome, redactor) => {
        const next = redactor.redactText(outcome.value);
        return { value: next.value, count: outcome.count + next.count };
      },
      { value: text, count: 0 },
    ),
  redactJson: (value: JsonObject): RedactionOutcome<JsonObject> =>
    redactors.reduce<RedactionOutcome<JsonObject>>(
      (outcome, redactor) => {
        const next = redactor.redactJson(outcome.value);
        return { value: next.value, count: outcome.count + next.count };
      },
      { value, count: 0 },
    ),
});

/**
 * A redactor over the values a binding's own configuration carries, skipping the ones too short to
 * redact safely.
 *
 * Every provider adapter builds one of these from the credentials it resolved — the *effective*
 * ones, which include a value an operator put straight into `config` rather than into the secret
 * store — and composes it with the redactor it was handed. A value shorter than
 * {@link MIN_SECRET_LENGTH} is skipped rather than thrown on: `exactSecretRedactor` refuses it
 * (redacting `abc` would erase ordinary text), and a binding whose password happens to be four
 * characters must still be able to answer a query.
 */
export const bindingSecretRedactor = (
  secrets: Iterable<InjectedSecret | null | undefined>,
): SecretRedactor =>
  exactSecretRedactor(
    [...secrets].filter(
      (secret): secret is InjectedSecret =>
        secret !== null &&
        secret !== undefined &&
        secret.name.length > 0 &&
        secret.value.length >= MIN_SECRET_LENGTH,
    ),
  );
