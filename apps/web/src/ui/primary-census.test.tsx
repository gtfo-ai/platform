/**
 * The census's own calibration (S-23.23, checklist item 3): it fires on two beacons, names both,
 * ignores a dialog's, and does not take a quiet button, a counter or a toggle for one. The screens
 * that call it render the real application: `run-page`, `dead-letters` and `onboarding`. The
 * task-page and integrations tests count the same marker class with their own older helpers, and
 * `platform-updated` checks the banner's Reload for it directly.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, buttonClassName } from './button.js';
import { Counter } from './counter.js';
import { assertOnePrimaryAtMost, primaryLabels } from './primary-census.js';

afterEach(() => {
  cleanup();
});

describe('the primary-button census', () => {
  it('counts a primary button and a primary-styled link, and fires on the second', () => {
    render(
      <main>
        <Button tone="primary">Save</Button>
        <a href="/x" className={buttonClassName('primary')}>
          Continue
        </a>
      </main>,
    );
    expect(primaryLabels()).toEqual(['Save', 'Continue']);
    expect(() => {
      assertOnePrimaryAtMost(document, 'the planted view');
    }).toThrow('the planted view draws 2 primary actions ("Save", "Continue")');
  });

  it('passes one beacon, and ignores a dialog’s own, a toggle, a counter and the quiet tones', () => {
    render(
      <main>
        <Button tone="primary">Save</Button>
        <Button aria-pressed>Following</Button>
        <Button tone="danger">Cancel run</Button>
        <Button tone="invisible">More</Button>
        <Counter count={3} tone="primary" />
        <div role="dialog">
          <Button tone="primary">Confirm</Button>
        </div>
      </main>,
    );
    expect(primaryLabels()).toEqual(['Save']);
    expect(() => {
      assertOnePrimaryAtMost();
    }).not.toThrow();
  });
});
