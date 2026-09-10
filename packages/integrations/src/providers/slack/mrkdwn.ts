/**
 * Markdown → Slack `mrkdwn`, and the escaping that makes it safe.
 *
 * technical/06 puts the "markdown → provider format converter" in the provider module, and Slack
 * needs one: `mrkdwn` is not CommonMark. Bold is `*one star*`, links are `<url|text>`, and a
 * literal `**bold**` renders as four visible asterisks.
 *
 * ## Escaping is the security half, not a cosmetic one (BD-022)
 *
 * A question's text, a task title and a digest line are all written by an agent from untrusted
 * ticket text. Slack's documentation:
 *
 * > Slack uses `&`, `<`, and `>` as control characters for special parsing in text objects, so
 * > they must be converted to HTML entities if they're not going to be used for their parsing
 * > purpose.
 *
 * Those three characters are how `<!channel>` — "notifies all members of a channel, active or
 * not" — and `<@U012AB3CD>` are written. Escaping first means a ticket description that contains
 * `<!channel>` is *displayed*, not *fired*, and it is the reason every transform below runs after
 * the escape rather than before it.
 *
 * ## Escaping first is not enough: the link converter puts the brackets back
 *
 * Found at WP-10 review round 1, and it is the whole reason `LINK` carries a scheme allow-list.
 * `[urgent](!channel)` survives the escape unharmed — it contains no control character — and the
 * markdown-link rule then rebuilds `<!channel|urgent>` around an attacker-controlled "URL",
 * re-introducing exactly the two characters that were escaped. Slack's parser then:
 *
 * > Detect all sub-strings matching `<(.*?)>` … Format content starting with `@U` or `@W` as a
 * > user mention … content starting with `!subteam` as a user group mention … content starting
 * > with `!` according to the rules for special mentions … For any other content within those
 * > sub-strings, format as a URL link.
 *
 * So ticket text could `@channel` a workspace, fake a mention of a named person, or ping a
 * subteam. The fix is to only ever hand Slack a bracketed link whose content **starts with a
 * scheme this module allows** (`https:`, `http:`, `mailto:`) — which no `#C`, `@U`, `@W` or `!`
 * form can do — and to leave every other `[text](target)` as the plain, escaped markdown source
 * it arrived as. That is the same "do less, visibly" rule the rest of this module follows.
 *
 * ## What it deliberately does not do
 *
 * Tables, images, block quotes, nested lists and reference links pass through as their markdown
 * source. Slack has no equivalent for the first three, and a converter that guesses at them
 * produces mangled text where the untransformed source is merely plain. The rule for this module
 * is the same as everywhere else in the adapter: do less, visibly.
 *
 * Source: <https://docs.slack.dev/messaging/formatting-message-text>, retrieved 2026-09-10.
 */

/** `&`, `<`, `>` → HTML entities. `&` first, or the entities introduced below get double-escaped. */
export const escapeSlackText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const FENCE = '```';

const LINK = /\[([^\]]*)\]\(([^\s)]+)\)/g;

/**
 * The only schemes this module will wrap in `<…>`.
 *
 * Everything Slack parses as a mention — `#C…`, `@U…`, `@W…`, `!here`, `!channel`, `!subteam^…` —
 * is unreachable from a string that starts with one of these, so the allow-list is a complete
 * defence against the injection above rather than a filter that has to enumerate the attacks.
 */
const LINKABLE_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

/** RFC 3986 §3.1: `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`, ASCII only. */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Whether Slack may be handed this target inside `<…>`.
 *
 * Refuses a scheme-relative `//host`, a bare `!channel`, a `javascript:` URL and anything else
 * without an allowed scheme. Case-insensitive, because RFC 3986 says scheme names are — and the
 * `toLowerCase()` here is exact rather than approximate (standing rule 26) only because `SCHEME`
 * has already restricted the string to ASCII letters, digits, `+`, `-` and `.`.
 */
export const isLinkableUrl = (url: string): boolean => {
  const scheme = SCHEME.exec(url)?.[0];
  return scheme !== undefined && LINKABLE_SCHEMES.has(scheme.toLowerCase());
};

/** `<url|label>`, or the untouched markdown source when the target is not one Slack may parse. */
const linkOrSource = (source: string, label: string, url: string): string => {
  if (!isLinkableUrl(url)) {
    return source;
  }
  return label.trim() === '' ? `<${url}>` : `<${url}|${label}>`;
};
const BOLD_STARS = /\*\*([^*\n]+)\*\*/g;
const BOLD_UNDERSCORES = /__([^_\n]+)__/g;
const STRIKE = /~~([^~\n]+)~~/g;
const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*$/gm;
const BULLET = /^(\s*)[-*+]\s+/gm;

/** One segment outside a fenced code block. Inside a fence, Slack renders the source verbatim. */
const convertSegment = (segment: string): string =>
  segment
    // `[text](url)` → `<url|text>`, but only for a scheme this module allows: the escape above
    // does not survive this rule, so the allow-list is what keeps `[x](!channel)` inert.
    .replace(LINK, (match: string, label: string, url: string) => linkOrSource(match, label, url))
    .replace(BOLD_STARS, '*$1*')
    .replace(BOLD_UNDERSCORES, '*$1*')
    .replace(STRIKE, '~$1~')
    .replace(HEADING, '*$1*')
    .replace(BULLET, '$1• ');

/**
 * Converts markdown to `mrkdwn`, escaping Slack's control characters first.
 *
 * Fenced blocks are passed through unchanged (after escaping) because ``` is `mrkdwn`'s own code
 * fence: transforming inside one would rewrite the code somebody asked to see literally.
 */
export const toMrkdwn = (markdown: string): string => {
  const escaped = escapeSlackText(markdown);
  return escaped
    .split(FENCE)
    .map((segment, index) => (index % 2 === 0 ? convertSegment(segment) : segment))
    .join(FENCE);
};

/**
 * Shortens to at most `limit` characters, marking the cut.
 *
 * Slack rejects a section over 3,000 characters with `invalid_blocks` and a message over 4,000
 * with `msg_too_long`; a notification that fails to post because a ticket description was long is
 * a lost notification. The ellipsis is one character, so the result is never longer than `limit`.
 */
export const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
