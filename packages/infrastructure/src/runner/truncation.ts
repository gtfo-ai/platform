/**
 * `PostToolUse` output truncation — technical/04: "truncate outputs head/tail (default 10 k chars)".
 *
 * Head **and** tail, not head: a failing test run puts the command echo at the top and the failure
 * at the bottom, and a head-only cut is the one that reliably throws away the answer. The marker in
 * the middle says how much is gone so the model can ask for the rest with a narrower command
 * instead of assuming it saw everything.
 *
 * This runs before redaction, not after: truncation is about context budget, redaction is about
 * what may be persisted, and a secret in the discarded middle is discarded either way — but a
 * secret in the *kept* half must still be redacted, which is why the two are separate passes and
 * the transcript writer applies both.
 */

export interface TruncationResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

/** Shortest cap that can still show something of both ends around the marker. */
export const MIN_TRUNCATION_LIMIT = 64;

export const truncateHeadTail = (text: string, maxChars: number): TruncationResult => {
  const limit = Math.max(MIN_TRUNCATION_LIMIT, Math.trunc(maxChars));
  if (text.length <= limit) {
    return { text, truncated: false, originalLength: text.length };
  }
  const removed = text.length - limit;
  const marker = `\n… [${removed} characters truncated by the platform] …\n`;
  const keep = Math.max(0, limit - marker.length);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const tailText = tail === 0 ? '' : text.slice(-tail);
  return {
    text: `${text.slice(0, head)}${marker}${tailText}`,
    truncated: true,
    originalLength: text.length,
  };
};

/**
 * Renders whatever a tool returned as the string the transcript and the model see.
 *
 * `tool_response` is `unknown` in `PostToolUseHookInput`: a built-in tool returns a string, MCP
 * tools return an object, and some return `{ content: [{ type: 'text', text }] }`. All three are
 * flattened to text here so the truncation cap means the same thing for all of them.
 */
export const renderToolResponse = (response: unknown): string => {
  if (typeof response === 'string') {
    return response;
  }
  if (response === null || response === undefined) {
    return '';
  }
  if (typeof response === 'object') {
    const record = response as Record<string, unknown>;
    const content = record['content'];
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          const text = (item as Record<string, unknown> | null)?.['text'];
          return typeof text === 'string' ? text : JSON.stringify(item);
        })
        .join('\n');
    }
  }
  return JSON.stringify(response);
};
