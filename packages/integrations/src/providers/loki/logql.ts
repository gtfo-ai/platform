/**
 * The only LogQL this adapter writes, and the only LogQL it accepts.
 *
 * ## Why a query language needs a boundary at all
 *
 * `LogRangeQuery.filter` is described by the port as "substring or provider filter expression".
 * This adapter reads it as a **literal substring, always** — never as an expression — and escapes
 * it into a `|= "…"` line filter. The reason is BD-022 rather than taste: a filter reaching the
 * platform from a ticket, a Sentry tag or an agent is untrusted text, and LogQL concatenated from
 * untrusted text is injection with a query language instead of a shell. A filter of
 * `x" | json | line_format "{{.password}}` changes what the query *does* if it is pasted in; it
 * matches nothing if it is escaped, which is the correct answer to "does this substring appear".
 *
 * `selector` is the other half and cannot be escaped, because a stream selector *is* an expression
 * and the platform's own recipes write it. So it is **validated** instead: the grammar below is
 * the stream-selector grammar and nothing else, which means a `selector` carrying a line filter, a
 * parser stage or an aggregation is refused rather than executed. An operator who needs one of
 * those has `logcli` (technical/06 § "Agent tooling exposure"); the port's `queryRange` is
 * deliberately the narrow door.
 *
 * ## What the grammar is
 *
 * `{name="value", other=~"re.*"}` — one or more matchers, each an identifier, one of Loki's four
 * documented operators (`=`, `!=`, `=~`, `!~`) and a quoted string. Both quoting forms Loki
 * documents are accepted: a double-quoted string with Go escapes, and a backtick raw string.
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://grafana.com/docs/loki/latest/query/log_queries/> — "The stream selector is comprised
 *    of one or more key-value pairs", the four label matching operators, the four line filter
 *    operators (`|=`, `!=`, `|~`, `!~`), and "To avoid escaping special characters you can use the
 *    ` (backtick) instead of " when quoting strings".
 */
import { IntegrationError } from '@platform/application';

export const LOKI_PROVIDER_ID = 'loki';

const invalid = (action: string, detail: string): IntegrationError =>
  new IntegrationError('invalid_request', LOKI_PROVIDER_ID, detail, { action });

/** `name`, `name!=`, `name=~` … one matcher, with either quoting form. */
const MATCHER =
  /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`)\s*$/;

export interface StreamMatcher {
  readonly name: string;
  readonly operator: '=' | '!=' | '=~' | '!~';
  readonly value: string;
}

/**
 * Splits the inside of `{…}` on commas that are **not inside a quoted string**.
 *
 * A naive `split(',')` breaks `{app="a,b"}` into two unparseable halves and reports a syntax error
 * for a selector Loki accepts. Commas inside label values are not exotic: a `path` label carrying
 * a query string has them.
 */
const splitMatchers = (inner: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | '`' | null = null;
  let escaped = false;
  for (const character of inner) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }
    if (character === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
};

/**
 * Validates a stream selector and returns its matchers.
 *
 * @throws {IntegrationError} `invalid_request` — with the offending *matcher*, never the whole
 * selector, so an error message stays short and a label value cannot smuggle a page of text into a
 * log line.
 */
export const parseStreamSelector = (selector: string, action: string): StreamMatcher[] => {
  const trimmed = selector.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw invalid(action, 'selector must be a stream selector of the form {label="value", …}');
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') {
    throw invalid(action, 'selector must constrain at least one label');
  }
  const matchers: StreamMatcher[] = [];
  for (const part of splitMatchers(inner)) {
    const match = MATCHER.exec(part);
    if (match === null) {
      throw invalid(
        action,
        `matcher ${part.trim().slice(0, 80)} is not label(=|!=|=~|!~)"value"; a line filter, a parser or an aggregation belongs in logcli, not in this port`,
      );
    }
    matchers.push({
      name: match[1] as string,
      operator: match[2] as StreamMatcher['operator'],
      value: match[3] ?? match[4] ?? '',
    });
  }
  return matchers;
};

/**
 * Quotes a literal for a LogQL double-quoted string (Go escaping).
 *
 * Backslash and quote are escaped; the four control characters Go spells with a letter get their
 * spelling, and every other C0 character becomes `\xNN`. A raw control byte inside a quoted string
 * is accepted by some parsers and rejected by others, and neither outcome is one this adapter
 * should leave to chance.
 */
export const escapeLogQLString = (value: string): string => {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '\\') {
      out += '\\\\';
    } else if (character === '"') {
      out += '\\"';
    } else if (character === '\n') {
      out += '\\n';
    } else if (character === '\r') {
      out += '\\r';
    } else if (character === '\t') {
      out += '\\t';
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      out += character;
    }
  }
  return out;
};

/**
 * `{app="api"} |= "trace-abc"` — the selector, plus at most one literal line filter.
 *
 * The filter is validated by the caller against `max_filter_length` before it reaches here; this
 * function's only job is that the result is a query whose *shape* the caller chose and whose
 * *literal* the caller did not.
 */
export const buildRangeQuery = (selector: string, filter: string | null): string =>
  filter === null || filter === '' ? selector : `${selector} |= "${escapeLogQLString(filter)}"`;
