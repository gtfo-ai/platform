/**
 * TD-012 step 2: the gitleaks-derived pattern rules, and the composition that puts the three steps
 * of the decision in order.
 *
 * > (1) replace every secret value the platform injected into the run/environment
 * > (`[REDACTED:integration:<name>]`), (2) apply a curated subset of gitleaks' rule set compiled
 * > for JS (generic API keys, private keys, cloud/provider tokens incl. Anthropic/OpenAI, JWTs,
 * > connection strings) with `[REDACTED sha256:<6>]` placeholders, (3) optional entropy heuristic
 * > in key-like contexts.
 *
 * **Step 1 is not here.** It is `exactSecretRedactor` in
 * `packages/application/src/integrations/redaction.ts` (WP-07), and this module composes with it
 * rather than reimplementing it through the `SecretRedactor` port in
 * `packages/application/src/ports/integrations/audit.ts`. Step 3 is **deliberately not implemented**: TD-012 calls it optional, and an entropy
 * heuristic over a *transcript* fires on the things a coding agent legitimately prints — git object
 * names, base64 fixtures, minified bundles, uuids — so it would trade a hypothetical leak for a
 * transcript full of holes. It is recorded as discovered work rather than guessed at.
 *
 * Where this runs: the run transcript, before anything is appended to `run_messages`, broadcast to
 * SSE or written to a log (TD-007, technical/08). Originals are never stored — an append-only row
 * cannot be fixed afterwards (BD-003), which is the whole reason TD-012 redacts at the write.
 *
 * The rules are *shapes*, not a corpus: matching one means "this looks like a credential", and the
 * cost of a false positive is a placeholder in a transcript. That asymmetry is why the generic rule
 * exists at all and why it is tuned to fire rather than to be precise.
 */
import { createHash } from 'node:crypto';
import type { RedactionOutcome, SecretRedactor } from '@platform/application';
import type { JsonObject, JsonValue } from '@platform/contracts';

/**
 * One rule of the curated set.
 *
 * `group` names the capture group holding the secret when the pattern must match its *context* to
 * be sure — `api_key = "…"` is only a credential because of the `api_key =` in front of it, and
 * replacing the whole match would erase the field name a reader needs.
 */
export interface RedactionRule {
  /** Stable id; goes into `redaction_log.rule_id` (technical/03). */
  readonly id: string;
  readonly pattern: RegExp;
  readonly group?: number;
}

/** `[REDACTED sha256:ab12cd]` — the placeholder TD-012 specifies. */
export const redactionPlaceholder = (secret: string): string =>
  `[REDACTED sha256:${createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 6)}]`;

/**
 * The curated subset. Order matters twice over: a specific provider rule must run before the
 * generic one so its id lands in `redaction_log`, and every rule sees the text the earlier rules
 * already rewrote, so a placeholder must not itself look like a secret to a later rule (none of
 * them match `[REDACTED sha256:…]`, which is asserted in the tests).
 *
 * Every pattern is `g`-flagged, and the engine never uses the rule's own `RegExp` object: it
 * compiles a fresh one with the `d` flag for every call. Two reasons, both mistakes a redactor
 * makes exactly once. A shared global regex keeps `lastIndex` between calls and silently skips
 * matches on its second input; and replacing a capture group by *string* search inside the match
 * rewrites the first occurrence of that text rather than the group — which, on
 * `postgres://hunter2:hunter2@db`, redacts the username and leaves the password.
 */
export const GITLEAKS_DERIVED_RULES: readonly RedactionRule[] = [
  {
    // `sk-ant-api03-…`, `sk-ant-admin01-…` and the `sk-ant-oat01-…` OAuth token of BD-004.
    id: 'anthropic-api-key',
    pattern: /sk-ant-[A-Za-z0-9]{3,10}-[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'openai-api-key',
    pattern: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'github-token',
    pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g,
  },
  {
    id: 'gitlab-token',
    pattern: /gl(?:pat|dt|oat|rt|soat|ptt|cbt|ft)-[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'slack-token',
    pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'slack-webhook',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+/]{20,}/g,
  },
  {
    id: 'atlassian-api-token',
    pattern: /ATATT3[A-Za-z0-9_\-=]{20,}/g,
  },
  {
    id: 'sentry-auth-token',
    pattern: /sntry[su]_[A-Za-z0-9]{32,}/g,
  },
  {
    id: 'aws-access-key-id',
    pattern: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
  },
  {
    // The whole PEM block, not just its header: the key material is what matters.
    id: 'private-key',
    pattern: /-----BEGIN[ A-Z]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z]*-----/g,
  },
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    // A URL with a password in its userinfo: `postgres://app:hunter2@db:5432/app`. Only the
    // password is replaced, so the host and database a reader needs stay legible.
    id: 'connection-string',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:([^\s/@]{4,})@[^\s]+/g,
    group: 1,
  },
  {
    // The generic rule, last: `api_key = "…"`, `"authorization": "Bearer …"`, `PASSWORD=…`.
    // Deliberately loose about the assignment and strict about the value, because the cost of a
    // false positive is a placeholder and the cost of a miss is a credential in an append-only row.
    id: 'generic-api-key',
    pattern:
      /(?:api[_-]?key|secret|token|password|passwd|credential|authorization|bearer)["']?\s*[:=]\s*["']?(?:Bearer\s+)?([A-Za-z0-9/+=_.-]{20,})/gi,
    group: 1,
  },
];

/** One replacement the engine made. */
export interface RedactionHit {
  readonly ruleId: string;
  readonly value: string;
}

/** A fresh, index-reporting copy of the rule's pattern; see the note on `GITLEAKS_DERIVED_RULES`. */
const compile = (pattern: RegExp): RegExp => {
  const flags = new Set([...pattern.flags, 'g', 'd']);
  return new RegExp(pattern.source, [...flags].join(''));
};

const applyRule = (text: string, rule: RedactionRule, hits: RedactionHit[]): string => {
  const pattern = compile(rule.pattern);
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const matchStart = match.index;
    const span =
      rule.group === undefined
        ? ([matchStart, matchStart + match[0].length] as const)
        : match.indices?.[rule.group];
    const secret = rule.group === undefined ? match[0] : match[rule.group];
    if (span === undefined || secret === undefined || secret.length === 0) {
      continue;
    }
    hits.push({ ruleId: rule.id, value: secret });
    out += text.slice(cursor, span[0]) + redactionPlaceholder(secret);
    cursor = span[1];
  }
  return out + text.slice(cursor);
};

/**
 * Which rules fire on this text, without rewriting it.
 *
 * The path guard uses it to refuse a write whose *content* is secret-shaped (technical/04:
 * "secrets patterns in content denied"), where the answer needed is "is there one" rather than
 * "give me a clean copy".
 */
export const detectSecrets = (
  text: string,
  rules: readonly RedactionRule[] = GITLEAKS_DERIVED_RULES,
): readonly RedactionHit[] => {
  const hits: RedactionHit[] = [];
  let current = text;
  for (const rule of rules) {
    current = applyRule(current, rule, hits);
  }
  return hits;
};

/**
 * A {@link SecretRedactor} over the pattern rules — TD-012 step 2.
 *
 * Object **keys** are left alone, matching WP-07's step-1 redactor: the platform never builds a key
 * out of secret material, and rewriting keys could collide two fields into one. Recorded here
 * rather than assumed away.
 */
export const patternRedactor = (
  rules: readonly RedactionRule[] = GITLEAKS_DERIVED_RULES,
): SecretRedactor => {
  const redactText = (text: string): RedactionOutcome<string> => {
    const hits: RedactionHit[] = [];
    let value = text;
    for (const rule of rules) {
      value = applyRule(value, rule, hits);
    }
    return { value, count: hits.length };
  };

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
 * Runs redactors in order and sums their counts — "a caller that needs all three composes them",
 * as WP-07's step-1 module puts it.
 *
 * Order is TD-012's own: injected secrets first (the platform knows those values exactly, and its
 * placeholder names the integration), patterns second. Reversing it would let a pattern rule
 * swallow an injected token into an anonymous `[REDACTED sha256:…]` and lose which integration
 * leaked it.
 */
export const composeRedactors = (...redactors: readonly SecretRedactor[]): SecretRedactor => ({
  redactText: (text) =>
    redactors.reduce<RedactionOutcome<string>>(
      (carry, redactor) => {
        const next = redactor.redactText(carry.value);
        return { value: next.value, count: carry.count + next.count };
      },
      { value: text, count: 0 },
    ),
  redactJson: (value) =>
    redactors.reduce<RedactionOutcome<JsonObject>>(
      (carry, redactor) => {
        const next = redactor.redactJson(carry.value);
        return { value: next.value, count: carry.count + next.count };
      },
      { value, count: 0 },
    ),
});
