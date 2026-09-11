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
 * **A placeholder name is an identity, so two secrets may not share one.** Redaction is already a
 * many-to-one map from values to placeholders; a duplicate name widens it past the point where a
 * reader can recover anything — two *different* secrets both named `jira` render as the same
 * `[REDACTED:integration:jira]`, so an audit row cannot say which credential leaked, and anything
 * downstream that compares redacted strings sees two distinct inputs as one. Nothing enforced it
 * before: the shipped bindings merely *happen* to name every secret distinctly (`gitlab_token` /
 * `gitlab_webhook_secret_token` / `gitlab_webhook_signing_token`, `jira_api_token` /
 * `jira_basic_auth` / `jira_webhook_secret`, `slack_bot_token` / `slack_app_token` /
 * `slack_signing_secret`), and a property nothing checks is a property that holds until the next
 * binding. That is rule 18's shape — a configuration whose duplicate case silently produces a
 * *permissive* result — so it is refused here, at construction, which is the one place the whole
 * set is visible.
 *
 * **Nothing survives the collision** (rule 38): the constructor throws rather than keeping the
 * first or the last, because keeping either would leave the other value unredacted, which is
 * strictly worse than failing to build. Rule 20 allows it: constructing a redactor is not an
 * inbound notification, and a binding that cannot name its secrets apart is a deployment defect
 * an operator must see.
 *
 * The guarantee is **per redactor**; {@link composeSecretRedactors} cannot extend it across two,
 * and says there what that costs.
 *
 * @throws {TypeError} when a secret is unnamed, shares its name with another, or is shorter than
 *   {@link MIN_SECRET_LENGTH}.
 */
export const exactSecretRedactor = (secrets: Iterable<InjectedSecret>): SecretRedactor => {
  const names = new Set<string>();
  const prepared = [...secrets]
    .map((secret) => {
      if (secret.name.length === 0) {
        throw new TypeError('an injected secret needs a name for its placeholder (TD-012)');
      }
      if (names.has(secret.name)) {
        throw new TypeError(
          `two injected secrets are both named "${secret.name}"; a placeholder name is an ` +
            'identity, and one shared by two values renders them as the same string (TD-012)',
        );
      }
      names.add(secret.name);
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
 *
 * **The name-uniqueness {@link exactSecretRedactor} enforces stops at its own set, and this
 * function cannot extend it.** `SecretRedactor` is two methods and no inventory — that is what
 * lets a pattern redactor (`infrastructure/src/redaction/pattern-redaction.ts`) and a test double
 * satisfy it — so composing two redactors that each name a secret `jira_api_token` is accepted,
 * and two different values then render identically. It is measured, not assumed: a named case in
 * `redaction.test.ts` asserts exactly that, so the limit is visible rather than implied by the
 * neighbouring refusal (rule 12).
 *
 * What it costs is bounded, and the bound is the reason this is documented rather than enforced.
 * A shared name is a **fidelity** loss in an audit row or a log line — the same trade the row
 * already makes — and an **identity** loss wherever something downstream compares a redacted
 * string for equality.
 *
 * This docblock used to end "and it is no longer an identity loss **anywhere**", naming the
 * executor's idempotency scope as the one such place. It was false when it was written, and rule
 * 63 says why it could not have been checked from here: an exclusivity claim is a statement about
 * every *other* file. There are at least **two** such places on disk and they answer differently,
 * on purpose — `IntegrationActionExecutor`'s outbound idempotency scope **refuses** a key
 * redaction would change, while every provider's inbound `InboundNormaliser.deliveryKey`
 * **redacts** one on its way to `inbox(provider, delivery_id)`. Rule 20 points them apart
 * (`idempotencyScopeFor` and the port's `deliveryKey` each carry the argument, and the port also
 * states the residual redaction leaves behind). The maintained enumeration is the redacted-state
 * census in `docs/technical/PROGRESS.md`, not a sentence in this file.
 *
 * A composition root that wants the stronger property gives each binding's secrets a name
 * carrying the binding (`<provider>_<id>_…`) rather than hoping two adapters disagree.
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
 *
 * A **duplicate name is not skipped** the same way — it reaches `exactSecretRedactor` and throws.
 * The two cases look alike and are not: dropping a too-short value loses nothing (a four-character
 * password is visible in the text either way), while dropping one of two differently-valued
 * secrets sharing a name would leave that secret unredacted in every row this binding writes. A
 * binding that cannot name its own credentials apart is a deployment defect, and failing to build
 * is the direction that makes an operator fix it.
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
