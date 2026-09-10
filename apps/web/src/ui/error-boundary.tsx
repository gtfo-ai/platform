/**
 * What the application shows when a component throws instead of rendering.
 *
 * **Measured before it was written.** React unmounts the whole tree when a render throws and
 * nothing catches it. Injecting a clock that throws (`createApp({ now })`) and opening `/agents`
 * left the document holding TanStack Router's built-in error component and *nothing else* — no
 * header, no navigation, the raw `Error.message` in a red `<pre>` beside a "Hide Error" button.
 * One throw anywhere below the shell therefore took the entire SPA, including the transcript view,
 * which renders the least trustworthy strings in the system. That is a gap in the foundation
 * rather than a missing screen, so it is closed here.
 *
 * There are two boundaries and they have different jobs:
 *
 * 1. **The route outlet** — `defaultErrorComponent` on the router (`routes/tree.tsx`). The router
 *    installs a catch boundary per route match *only when a match has an error component*, which
 *    is why the failure above escaped all the way to the root: without this option, the nearest
 *    boundary is the root's and it replaces the shell. With it, a screen that throws is contained
 *    inside `<main>` and the navigation stays usable — the difference is asserted in
 *    `app/error-boundary.test.tsx`.
 * 2. **The application** — `ErrorBoundary` around everything in `app/app.tsx`, outside every
 *    provider. It is the backstop for what the router cannot see: a throw in `ThemeProvider`,
 *    `RealtimeProvider` (including from its effects, which React routes to a boundary too),
 *    `ServicesProvider`, or in the router's own render.
 *
 * **The fallback is deliberately poor in dependencies.** It renders plain elements and one pure
 * function, because a fallback that throws is unmounted by the *next* boundary out — and at the
 * application level there is no next one. For the same reason `errorMessage` cannot throw: the
 * message it is handed came from a component that was rendering untrusted data, so it may contain
 * anything, and it is sanitised (BD-022 — a bidi override in an error message reorders the line a
 * human is trying to read) and bounded inside a `try`/`catch`.
 */
import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { sanitiseUntrusted } from './untrusted-text.js';

/** Longer than this is a payload, not a message; the console keeps the whole thing. */
const MESSAGE_LIMIT = 400;

/**
 * The message to show for a caught value, sanitised, bounded, and never throwing.
 *
 * Applied exactly once, at the point of display: a second application would re-cut text that
 * already carries the marker and report a different figure (standing rule 36).
 */
export const errorMessage = (error: unknown): string => {
  try {
    const raw = error instanceof Error ? error.message : String(error);
    const clean = sanitiseUntrusted(raw).trim();
    if (clean === '') {
      return 'No message was attached to the error.';
    }
    return clean.length <= MESSAGE_LIMIT
      ? clean
      : `${clean.slice(0, MESSAGE_LIMIT)}… (${clean.length - MESSAGE_LIMIT} more characters)`;
  } catch {
    // A getter on a thrown object, a `message` that is not a string, a Proxy that refuses.
    return 'The error could not be described.';
  }
};

export type ErrorArea = 'screen' | 'application';

const HEADING: Record<ErrorArea, string> = {
  screen: 'This screen could not be displayed',
  application: 'The interface could not be displayed',
};

/**
 * Neither sentence claims the navigation survived.
 *
 * The first draft of the `screen` copy said "the navigation above still moves you elsewhere",
 * which is true when a *screen* throws and false when the **shell** throws — measured: a throw in
 * `AppShell` is caught by the authenticated match's boundary, so the area is still `screen` and
 * the header is gone with it. An invariant asserted in a message is not evidence that it holds
 * (standing rule 3), so the claim lives in `app/error-boundary.test.tsx`, which checks the
 * navigation is in the document, and the copy says only what is true either way.
 */
const EXPLANATION: Record<ErrorArea, string> = {
  screen:
    'Nothing that was running has stopped — this is one region of the interface failing to draw, not the platform failing to work.',
  application:
    'Nothing that was running has stopped — this is the interface failing to draw, not the platform failing to work. Reloading usually clears it.',
};

export interface ErrorFallbackProps {
  readonly area: ErrorArea;
  readonly error: unknown;
  /** Re-renders what failed. Deterministic failures will simply fail again, which is honest. */
  readonly onRetry: () => void;
  /** Injected so a test does not reload its own runner; the browser's own reload otherwise. */
  readonly onReload?: () => void;
}

const reloadPage = (): void => {
  globalThis.location.reload();
};

export const ErrorFallback = ({
  area,
  error,
  onRetry,
  onReload,
}: ErrorFallbackProps): ReactElement => (
  <section
    role="alert"
    data-testid="error-fallback"
    data-error-area={area}
    className="m-4 flex max-w-2xl flex-col gap-2 rounded-md border border-danger bg-surface p-4"
  >
    <h2 className="text-sm font-semibold">{HEADING[area]}</h2>
    <p className="text-sm text-fg-muted">{EXPLANATION[area]}</p>
    {/* The message is data from a failing component, so it is text in a `<pre>`, never markup. */}
    <pre className="overflow-x-auto rounded-md bg-surface-muted p-3 font-mono text-xs whitespace-pre-wrap">
      <code>{errorMessage(error)}</code>
    </pre>
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium"
      >
        Try again
      </button>
      <button
        type="button"
        onClick={onReload ?? reloadPage}
        className="inline-flex items-center rounded-md border border-line px-3 py-1.5 text-sm font-medium"
      >
        Reload the page
      </button>
    </div>
  </section>
);

export interface ErrorBoundaryProps {
  readonly area: ErrorArea;
  readonly children: ReactNode;
  /**
   * Changing this clears a caught error. The shell passes the current path, so navigating away
   * from a screen that failed is enough to recover without a reload.
   */
  readonly resetKey?: string;
  /** Called with what was caught. Injected in tests; reports to the console otherwise. */
  readonly onError?: (error: unknown, info: ErrorInfo) => void;
  readonly onReload?: () => void;
}

interface ErrorBoundaryState {
  readonly caught: boolean;
  readonly error: unknown;
  readonly resetKey: string | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { caught: false, error: null, resetKey: props.resetKey };
    this.retry = this.retry.bind(this);
  }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { caught: true, error };
  }

  /** A new `resetKey` — a navigation — clears the caught error before the next render. */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { caught: false, error: null, resetKey: props.resetKey };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private retry(): void {
    this.setState({ caught: false, error: null });
  }

  override render(): ReactNode {
    if (!this.state.caught) {
      return this.props.children;
    }
    return (
      <ErrorFallback
        area={this.props.area}
        error={this.state.error}
        onRetry={this.retry}
        {...(this.props.onReload === undefined ? {} : { onReload: this.props.onReload })}
      />
    );
  }
}
