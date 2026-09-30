/**
 * The components that render untrusted text (BD-022). See `untrusted-text.ts` for the reasoning.
 *
 * Every one of these turns *data* into React elements. None of them takes markup, produces markup,
 * or hands a string to the DOM as HTML. `no-html.test.ts` walks this whole package's sources and
 * fails if `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `srcdoc` or
 * `document.write` appears anywhere in it, so the property is enforced by the build rather than by
 * this comment.
 *
 * The same walk allows the `href=` and `src=` attributes **in this file only**, so every URL the
 * application renders passes through `safeHref` here (`UntrustedText` for a link found in text,
 * `ExternalLink` for a link a DTO carried).
 */
import { type ReactElement, useState } from 'react';
import {
  safeHref,
  sanitiseUntrusted,
  segmentBlocks,
  segmentInline,
  stripAnsi,
} from './untrusted-text.js';

export interface UntrustedProps {
  readonly value: string;
  readonly className?: string;
}

/**
 * A link to a URL some integration produced: the *only* way a screen may render one.
 *
 * A DTO field typed `urlSchema` is **not** a safe href. `z.url()` accepts `javascript:`,
 * `data:text/html,…`, `vbscript:` and `file:` — measured, not assumed — so five call sites on the
 * board and the task screen put a provider-supplied string straight into `href` and were saved
 * only by React 19.3, which rewrites a `javascript:` URL to `javascript:throw new Error('React has
 * blocked…')`. That defence is accidental, unasserted, and **partial**: the same probe shows React
 * passes `data:text/html,<script>…</script>`, `vbscript:` and `file:` through **verbatim**. Nothing
 * outside this module may therefore write the attribute at all — `no-html.test.ts` fails the build
 * when `href=` or `src=` appears in any other source file, which is what turns the sentence in
 * `untrusted-text.ts` into a check.
 *
 * A refused URL is not hidden: the label stays on screen as plain text with the reason in its
 * `title`, because "the provider sent something that is not a web link" is information an operator
 * needs, and a silently missing link is indistinguishable from a rendering bug.
 */
export const ExternalLink = ({
  url,
  label,
  className,
}: {
  readonly url: string;
  readonly label: string;
  readonly className?: string;
}): ReactElement => {
  const resolved = safeHref(url);
  if (resolved === null) {
    return (
      <span
        className={`text-fg-muted line-through ${className ?? ''}`}
        title={`Not shown as a link: ${sanitiseUntrusted(url)} is not an http(s) URL.`}
        data-link-refused="true"
      >
        {label}
      </span>
    );
  }
  return (
    <a href={resolved} target="_blank" rel="noopener noreferrer nofollow" className={className}>
      {label}
    </a>
  );
};

/**
 * A URL a person has to **copy somewhere else** — the webhook URL an operator pastes into GitLab or
 * Jira (WP-95, PROGRESS backlog 272) — rendered as text with a copy control, never as a link.
 *
 * Not a link, because following it would be wrong: the webhook route answers a signed `POST` from a
 * provider, and a click would send the browser's `GET` at it. Still through {@link safeHref}, for
 * the reason every URL in this application is: `setupGuideResponseSchema.webhook_url` is
 * `urlSchema`, which accepts `javascript:` and `data:` (Q49). The server builds this one from
 * `APP_BASE_URL`, so it is platform text — but the rule is one path for every URL rather than a
 * judgement per field, and a refused URL is shown as refused (the `ExternalLink` shape) rather than
 * copied. What is shown **and** what is copied is the parser's normalised string, so the two cannot
 * differ.
 *
 * `copy` is injected for the tests; the default is the Clipboard API, which a browser offers only in
 * a secure context — so on a plain-`http` instance the control says it could not copy and the text
 * stays selectable, rather than the button silently doing nothing.
 */
export const CopyableUrl = ({
  url,
  label,
  copy,
}: {
  readonly url: string;
  readonly label: string;
  readonly copy?: (text: string) => Promise<void>;
}): ReactElement => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resolved = safeHref(url);
  if (resolved === null) {
    return (
      <span className="text-xs text-fg-muted" data-link-refused="true">
        {`${label}: not shown, because ${sanitiseUntrusted(url)} is not an http(s) URL.`}
      </span>
    );
  }
  const write =
    copy ??
    (async (text: string): Promise<void> => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) {
        throw new Error('the Clipboard API is not available here');
      }
      await navigator.clipboard.writeText(text);
    });
  return (
    <span className="flex flex-col gap-1">
      <span className="text-xs font-semibold">{label}</span>
      <span className="flex flex-wrap items-center gap-2">
        <code
          className="rounded-md bg-surface-muted px-2 py-1 font-mono text-xs break-all select-all"
          data-copyable-url="true"
        >
          {resolved}
        </code>
        <button
          type="button"
          className="rounded-md border border-line px-2 py-1 text-xs"
          aria-label={`Copy ${label}`}
          onClick={() => {
            write(resolved).then(
              () => {
                setState('copied');
              },
              () => {
                setState('failed');
              },
            );
          }}
        >
          Copy
        </button>
        <span role="status" className="text-xs text-fg-muted">
          {state === 'copied'
            ? 'Copied.'
            : state === 'failed'
              ? 'Could not copy here — select the text and copy it by hand.'
              : ''}
        </span>
      </span>
    </span>
  );
};

/**
 * A same-origin download of a file **this platform** serves — the take-over's transcript and
 * tarball (WP-44). The only other URL attribute this application writes, and it is here for the
 * reason `ExternalLink` is: `no-html.test.ts` allows `href=` in this file and nowhere else.
 *
 * It takes a **path the client composed** (`api/endpoints.ts`' `transcriptDownloadPath` and
 * `exportDownloadPath`, each segment `encodeURIComponent`-ed), never a DTO string, and it still
 * refuses anything that is not a plain `/api/…` path on this origin: a path that would resolve
 * elsewhere (`//host`, a backslash, a scheme) is rendered as text, the refusal `ExternalLink`
 * gives. A link rather than a `fetch` because the browser then carries the session cookie and
 * streams the file to disk, and a transcript can be larger than anything worth holding in memory.
 */
export const DownloadLink = ({
  path,
  label,
  className,
}: {
  readonly path: string;
  readonly label: string;
  readonly className?: string;
}): ReactElement => {
  // A regular expression rather than a quoted prefix: the client census reads every quoted
  // `/api/…` literal in the app as a path it calls (`routes/client-census.test.ts`).
  const safe =
    /^\/api\/[\w.%-]+(?:\/[\w.%-]+)*$/.test(path) &&
    !path.includes('..') &&
    new URL(path, 'http://platform.invalid').pathname === path;
  if (!safe) {
    return (
      <span className={`text-fg-muted ${className ?? ''}`} data-link-refused="true">
        {label}
      </span>
    );
  }
  return (
    <a href={path} download className={className}>
      {label}
    </a>
  );
};

/**
 * One line or paragraph of untrusted text, with bare `http(s)` URLs turned into links.
 *
 * `rel="noopener noreferrer nofollow"`: `noopener` stops the opened page reaching back through
 * `window.opener`, `noreferrer` keeps the platform's own URLs (which contain task and run ids) out
 * of a third party's referrer log, and `nofollow` is the honest label for a link the platform did
 * not author.
 */
export const UntrustedText = ({ value, className }: UntrustedProps): ReactElement => (
  <span className={className}>
    {segmentInline(value).map((segment, index) =>
      segment.kind === 'text' ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered.
        <span key={index}>{segment.value}</span>
      ) : (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reordered.
          key={index}
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-accent underline underline-offset-2"
        >
          {segment.label}
        </a>
      ),
    )}
  </span>
);

/**
 * Verbatim text in a monospace block: no linkification, no highlighting, no re-parsing.
 *
 * **Sanitised, like everything else.** "Verbatim" means the *structure* is not interpreted, not
 * that the characters are unfiltered: a `Read` of a file containing U+202E would otherwise render
 * a line that a reviewer reads backwards (CVE-2021-42574), and that is worse in a code block than
 * in prose. `segmentInline` and `segmentBlocks` sanitise on the way in, so before this call these
 * three renderers were the one path that did not — the shape of the WP-10 defect, one path
 * escaping and another not. Found by `test/web-e2e/xss.spec.ts` against the real DOM.
 */
export const CodeText = ({ value, className }: UntrustedProps): ReactElement => (
  <pre
    className={`overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap ${className ?? ''}`}
  >
    <code>{sanitiseUntrusted(value)}</code>
  </pre>
);

/** Shell output. ANSI sequences are stripped rather than coloured — see `untrusted-text.ts`. */
export const TerminalText = ({ value, className }: UntrustedProps): ReactElement => (
  <pre
    data-testid="terminal-block"
    className={`overflow-x-auto rounded-md bg-[oklch(0.18_0.01_260)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-[oklch(0.92_0.01_150)] ${className ?? ''}`}
  >
    {/* ANSI first, then the character filter: the ESC that starts a sequence is itself a
        control character, so filtering first would leave `[31m` on screen as text. */}
    <code>{sanitiseUntrusted(stripAnsi(value))}</code>
  </pre>
);

/** File content with line numbers (`Read`, `Grep`, `Glob`). */
export const NumberedCode = ({ value, className }: UntrustedProps): ReactElement => {
  const lines = sanitiseUntrusted(value).split('\n');
  return (
    <pre
      className={`overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-xs leading-relaxed ${className ?? ''}`}
    >
      <code>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the line number *is* the index.
          <span key={index} className="grid grid-cols-[3rem_1fr] gap-2">
            <span className="select-none text-right text-fg-muted">{index + 1}</span>
            <span className="whitespace-pre-wrap">{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
};

/**
 * Untrusted prose: paragraphs and fenced code blocks, nothing else.
 *
 * This is what assistant text, artifact bodies, ticket descriptions and MR comments render as.
 * TD-013's title names `streamdown`, and technical/09 offers react-markdown + rehype-sanitize as
 * the alternative; both convert to HTML, and the conversion is the risk. **The deviation is
 * recorded where the decision is** — see the WP-20 amendment in
 * `docs/decisions/technical/TD-013-ui-stack.md`, which also states what would reopen it (a
 * renderer that emits React elements from an AST without ever producing HTML).
 */
export const UntrustedProse = ({ value, className }: UntrustedProps): ReactElement => (
  <div className={`flex flex-col gap-2 ${className ?? ''}`}>
    {segmentBlocks(value).map((block, index) =>
      block.kind === 'paragraph' ? (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reordered.
          key={index}
          className="whitespace-pre-wrap text-sm leading-relaxed"
        >
          <UntrustedText value={block.value} />
        </p>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reordered.
        <figure key={index} className="m-0">
          {block.language === null ? null : (
            <figcaption className="pb-1 font-mono text-[11px] text-fg-muted">
              {block.language}
            </figcaption>
          )}
          <CodeText value={block.value} />
        </figure>
      ),
    )}
  </div>
);

/** A JSON value rendered as text. Used for tool inputs and MCP payloads. */
export const JsonView = ({ value }: { readonly value: unknown }): ReactElement => {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // A cycle or a BigInt: the value is still worth showing, just not as JSON.
    text = String(value);
  }
  return <CodeText value={text} />;
};
