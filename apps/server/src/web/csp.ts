/**
 * The Content-Security-Policy every bundle response carries (WP-15j review round 3).
 *
 * ## The policy is a measurement of this bundle, not a wish
 *
 * Round 2 shipped `frame-ancestors 'none'` alone and said a fuller policy was impossible because
 * "the shell carries an inline theme script and the component library writes inline styles".
 * **Both halves were false**, and the review that found it is the reason this file exists. What is
 * below was measured on the built bundle of 2026-09-13 (`apps/web/dist`: `index.html` 721 B,
 * `assets/index-CGIKj9Xt.js` 533 215 B, `assets/index-B3jozLGE.css` 17 852 B,
 * `assets/run-route-CNxnzU3C.js` 15 040 B — Vite 8, React 19, Tailwind 4; the chunk hashes move with
 * every source change, so re-take them rather than trust them):
 *
 * | question                                   | measured answer                                                                                 |
 * |--------------------------------------------|-------------------------------------------------------------------------------------------------|
 * | an inline `<script>` in the shell?         | **none** — one `<script type="module" crossorigin src="/assets/…">` and one `<link rel=stylesheet>`; `apps/web/index.html` says the theme is applied in `main.tsx` *on purpose*, and it is: `document.documentElement.dataset.theme` |
 * | a `<style>` element or a `style=` attribute? | **none** — Tailwind 4 emits one stylesheet at build time; `style=` and `<style` appear **0** times in `apps/web/src` |
 * | styles written at runtime?                  | CSSOM only — the chunk's only style writes are React's `element.style[name] = …` / `setProperty`, and **no** `cssText`, `setAttribute('style', …)`, `insertRule` or `adoptedStyleSheets` |
 * | `eval`, `new Function`, WebAssembly, workers?| **one** `Function(\`\`)` in the main chunk — zod's JIT probe, which `script-src 'self'` refuses with an `eval` violation; `apps/web/src/zod-jitless.ts` disables the JIT before any other import in `main.tsx`, which is the only reason the probe never runs (measured: with that import removed, `test/web-e2e/csp.spec.ts` fails on `blocked: "eval"`). No `eval`, WebAssembly or worker otherwise |
 * | anything fetched from another origin?       | **none** — the CSS has no `url(…)`, no `@font-face` and no `@import`; the absolute URLs in the chunk are XML namespaces, JSON-Schema `$id`s and React's error link, none of which is fetched |
 * | where does the app talk?                    | its own origin — `fetch('/api/…')` with an empty base URL (`api/http.ts`) and `new EventSource('/events')` |
 *
 * So `'unsafe-inline'` buys this bundle nothing, and neither does a nonce — which is what made the
 * round-2 sentence worth correcting rather than softening. The React answer is not an accident of
 * this build either: `style-src` governs `<style>` elements, `style` attributes, `cssText` and
 * `setAttribute('style', …)`, and **not** a direct CSSOM property write
 * (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src),
 * which is the only way React applies a `style` prop.
 *
 * ## What it does not cover, stated rather than implied (rule 86)
 *
 * - **It is not the no-markup rule.** `apps/web/src/ui/untrusted.tsx` is what keeps external text
 *   out of markup (BD-022); this header is the second line, for the day a dependency gets one
 *   past it.
 * - **`script-src 'self'` is what governs a CSSOM style write**, not `style-src` — an attacker who
 *   is already running script in this origin is past every directive here.
 * - **A library that writes a `style` attribute or injects a `<style>` element will be blocked.**
 *   technical/09's planned stack (`@base-ui/react`, CodeMirror 6, Recharts, shiki in a worker) is
 *   not in this bundle; the React `style` prop stays fine, the other spellings do not, and a
 *   worker would need `worker-src`. That fails in the browser with a console violation the day it
 *   is added — loudly, in development, which is the direction this project chooses.
 * - **`require-trusted-types-for 'script'` is deliberately absent.** react-dom writes `innerHTML`
 *   itself (two sites in the chunk, one of them its `<script>`-element workaround), so the
 *   directive would need a Trusted Types policy the application does not have; shipping it would
 *   break the product's only screen (rule 20's direction: fail closed is for a request, not for
 *   the whole application).
 * - **It is a header on the bundle's responses only.** `/api/*` answers carry no policy; JSON is
 *   not a document, and the framing of a browsing context is what this guards.
 *
 * ## Where the policy is asserted, and the one copy of it that exists
 *
 * `web-serving.test.ts` (unit, three paths) and `test/e2e/server/web-bundle.e2e.test.ts` (a whole
 * process) spell the expected value out rather than importing it, because a test that reads the
 * constant it is checking asserts nothing (rule 44). `test/web-e2e/csp.spec.ts` is the **browser**
 * proof: the Playwright fake backend serves the built bundle under this exact header — imported,
 * so the fake cannot be kinder than the server (rule 1) — and the suite fails on a single
 * `securitypolicyviolation`, with a probe first to show the header is being enforced at all.
 * `scripts/web-compose-check.mjs` keeps a **literal copy**: it is plain Node run on the image
 * workflow's own interpreter, so importing a `.ts` module would make that job depend on type
 * stripping; `csp.test.ts` reads the script off disk and fails when the two differ.
 */

/**
 * The directives, in the order they are serialised, each with the measurement that chose it.
 *
 * `default-src 'self'` is the backstop for everything not named (`media-src`, `manifest-src`,
 * `worker-src`, `frame-src`): this bundle uses none of them, and naming the ones it does use makes
 * each one a decision a reader can check against the table above.
 */
const DIRECTIVES: readonly string[] = [
  // Nothing loads from anywhere but this origin.
  "default-src 'self'",
  // The one module script and the route chunk it imports; no inline script exists to allow.
  "script-src 'self'",
  // The one stylesheet Tailwind emits. React's `style` prop is a CSSOM write and is unaffected.
  "style-src 'self'",
  // The bundle ships no image and the app renders no remote one; a favicon request is same-origin.
  "img-src 'self'",
  // No `@font-face`, no font file in the bundle: nothing to allow beyond the origin.
  "font-src 'self'",
  // `fetch('/api/…')` and `new EventSource('/events')`, both with an empty base URL.
  "connect-src 'self'",
  // `<object>`/`<embed>` are a plugin surface no part of this application uses.
  "object-src 'none'",
  // A `<base href>` an injection could add would repoint every relative URL on the page.
  "base-uri 'self'",
  // Nothing in the SPA submits a form to the network; React handles its submits in the page.
  "form-action 'self'",
  // Round 2's directive, kept: this origin also serves WP-15i's authenticated command surface.
  "frame-ancestors 'none'",
];

/** The header value served with every file the SPA fallback answers. */
export const CONTENT_SECURITY_POLICY: string = DIRECTIVES.join('; ');
