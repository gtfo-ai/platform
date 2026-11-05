/**
 * Tooltip, on Base UI (TD-033 § 5): opens on hover **and on keyboard focus**, closes on Escape,
 * positioned by Floating UI through CSSOM writes — which `script-src 'self'` governs and the
 * production `style-src 'self'` does not (`test/web-e2e/csp.spec.ts` opens one under the policy).
 *
 * A tooltip is supplementary: Base UI does not tie the popup to its trigger for assistive tech, so a
 * caller whose tooltip carries information (Metric's definition) also gives the trigger an
 * `aria-describedby` of its own. The trigger is the caller's element, which must accept a ref and
 * spread props (a `<button>`, or a component that forwards both).
 */
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import type { ReactElement, ReactNode } from 'react';

export const Tooltip = ({
  content,
  children,
  side = 'top',
  delay = 300,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
  readonly side?: 'top' | 'bottom' | 'left' | 'right';
  /** Milliseconds before a hover opens it; focus opens it at once. */
  readonly delay?: number;
}): ReactElement => (
  <BaseTooltip.Root>
    <BaseTooltip.Trigger delay={delay} render={children} />
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner side={side} sideOffset={6} className="z-50">
        <BaseTooltip.Popup
          data-tooltip=""
          className="max-w-xs rounded-md bg-fg px-2 py-1 text-xs leading-snug text-canvas shadow-overlay transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0"
        >
          {content}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  </BaseTooltip.Root>
);
