/**
 * StatusIcon and StateLabel (TD-033; WCAG 1.4.1): **icon + colour + word, never colour alone**, for
 * every status in the vocabulary — asserted over `STATUSES` itself, so a status added to the list is
 * held to it the moment it exists.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { STATUS_LOOK, STATUSES, StateLabel, StatusIcon } from './status.js';

afterEach(() => {
  cleanup();
});

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

describe('the status vocabulary', () => {
  it('has the ten statuses TD-033 names', () => {
    expect([...STATUSES]).toEqual([
      'queued',
      'running',
      'success',
      'failure',
      'cancelled',
      'skipped',
      'needs_you',
      'waiting',
      'paused',
      'idle',
    ]);
  });

  it('gives every status its own glyph and its own word', () => {
    const icons = new Set(STATUSES.map((status) => STATUS_LOOK[status].icon));
    const words = new Set(STATUSES.map((status) => STATUS_LOOK[status].word));
    expect(icons.size).toBe(STATUSES.length);
    expect(words.size).toBe(STATUSES.length);
  });

  it('draws running and needs-you in the beacon, failure in danger, success in success', () => {
    expect(STATUS_LOOK.running.fg).toBe('text-running');
    expect(STATUS_LOOK.needs_you.fg).toBe('text-running');
    expect(STATUS_LOOK.failure.fg).toBe('text-danger');
    expect(STATUS_LOOK.success.fg).toBe('text-success');
  });
});

describe('StatusIcon', () => {
  it.each(STATUSES)('names %s by its word when it stands alone', (status) => {
    render(<StatusIcon status={status} />);
    const icon = screen.getByRole('img', { name: STATUS_LOOK[status].word });
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon.className).toContain(STATUS_LOOK[status].fg);
  });

  it('takes a more precise name, and hides itself when it is decorative', () => {
    const { container } = render(
      <>
        <StatusIcon status="failure" label="CI failed" />
        <StatusIcon status="success" decorative />
      </>,
    );
    expect(screen.getByRole('img', { name: 'CI failed' })).toBeTruthy();
    expect(container.querySelector('[data-status="success"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('animates running only, and reduced motion stops it', () => {
    const { container } = render(
      <>
        <StatusIcon status="running" />
        <StatusIcon status="queued" />
      </>,
    );
    expect(container.querySelector('[data-status="running"]')?.className).toContain(
      'status-running',
    );
    expect(container.querySelector('[data-status="queued"]')?.className).not.toContain(
      'status-running',
    );
    expect(CSS).toMatch(/\.status-running \{\s*animation: status-running-pulse/);
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.status-running,[\s\S]*?animation: none;/,
    );
  });
});

describe('StateLabel', () => {
  it.each(STATUSES)('shows %s as icon and word, the word read once', (status) => {
    const { container } = render(<StateLabel status={status} />);
    const label = container.querySelector(`[data-state-label="${status}"]`);
    expect(label?.textContent).toBe(STATUS_LOOK[status].word);
    expect(label?.querySelector('svg')).not.toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('takes the screen’s own word', () => {
    render(<StateLabel status="running">Review 2</StateLabel>);
    expect(screen.getByText('Review 2')).toBeTruthy();
  });
});
