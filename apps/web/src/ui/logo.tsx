/**
 * The platform's wordmark: "agentic." in pixel letters, its i-dot and full stop in beacon amber.
 *
 * Inlined rather than loaded from a file, for two reasons. The letters take `currentColor`, so one
 * mark reads on the always-dark sign-in page and on the shell's header in either theme; and an
 * `<img src>` would be a URL attribute, which `no-html.test.ts` admits only through `untrusted.tsx`.
 * The paths are the designer's SVG unchanged (a 5-unit grid, like the sign-in page's pixels); the
 * amber is the `--signin-beacon` token rather than the file's `#F6BB60`, a hair away.
 *
 * `role="img"` with a name, so a link wrapped around it is announced by that name.
 */
import type { ReactElement } from 'react';

const LETTERS: readonly (readonly [x: number, d: string])[] = [
  [0, 'M20 0H80V10H90V20H100V100H90V110H10V100H0V60H10V50H65V40H0V20H10V10H20Z M35 70V80H65V70Z'],
  [
    115,
    'M20 0H80V10H90V20H100V130H90V140H80V150H10V140H0V120H65V110H20V100H10V90H0V20H10V10H20Z M35 35V70H65V35Z',
  ],
  [
    230,
    'M20 0H80V10H90V20H100V60H90V70H35V80H100V100H90V110H20V100H10V90H0V20H10V10H20Z M35 30V45H65V30Z',
  ],
  [345, 'M0 0H75V10H90V20H100V110H65V40H35V110H0Z'],
  [460, 'M15 -20H50V0H75V35H50V75H75V110H30V100H15V35H0V0H15Z'],
  [550, 'M0 0H35V110H0Z'],
  [
    600,
    'M20 0H80V10H90V20H100V45H65V35H35V75H65V65H100V90H90V100H80V110H20V100H10V90H0V20H10V10H20Z',
  ],
];

export const Logo = ({
  label,
  className = '',
}: {
  /** The accessible name: what a screen reader says for the mark (and for a link around it). */
  readonly label: string;
  readonly className?: string;
}): ReactElement => (
  <svg
    viewBox="30 25 755 195"
    role="img"
    aria-label={label}
    className={`block h-auto ${className}`}
  >
    <g fill="currentColor" fillRule="evenodd" transform="translate(30 70)">
      {LETTERS.map(([x, d]) => (
        <path key={x} transform={x === 0 ? undefined : `translate(${x})`} d={d} />
      ))}
    </g>
    <g className="fill-signin-beacon">
      <path d="M580 25H615V60H580Z" />
      <path d="M745 140H785V180H745Z" />
    </g>
  </svg>
);
