/** Skeleton and Avatar. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AVATAR_TONES, Avatar, avatarTone, initialsOf } from './avatar.js';
import { Skeleton } from './skeleton.js';

afterEach(() => {
  cleanup();
});

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8');

describe('Skeleton', () => {
  it('announces what is loading once, and its bars are decorative', () => {
    const { container } = render(<Skeleton label="Loading runs…" lines={4} />);
    expect(screen.getByRole('status').textContent).toBe('Loading runs…');
    const bars = container.querySelectorAll('[data-skeleton-bar]');
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
      expect(bar.className).toContain('skeleton-shimmer');
    }
  });

  it('stops shimmering under reduced motion', () => {
    expect(CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.skeleton-shimmer \{\s*animation: none;/,
    );
  });
});

describe('Avatar', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['grace', 'G'],
    ['ada.lovelace@example.test', 'A'],
    ['  ', '?'],
    ['', '?'],
    ['élodie durand', 'ÉD'],
  ])('draws %j as %j', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });

  it('picks the same tone for the same name, and spreads names over the tones', () => {
    expect(avatarTone('Ada Lovelace')).toBe(avatarTone('Ada Lovelace'));
    const names = Array.from({ length: 60 }, (_, index) => `user-${index}@example.test`);
    const used = new Set(names.map(avatarTone));
    expect(used.size).toBe(AVATAR_TONES.length);
  });

  it('is an image named by the person, or decorative beside the name', () => {
    const { container } = render(
      <>
        <Avatar name="Ada Lovelace" />
        <Avatar name="Grace Hopper" decorative />
      </>,
    );
    expect(screen.getByRole('img', { name: 'Ada Lovelace' }).textContent).toBe('AL');
    const decorative = [...container.querySelectorAll('[data-avatar]')][1];
    expect(decorative?.getAttribute('aria-hidden')).toBe('true');
    expect(decorative?.className).toContain(avatarTone('Grace Hopper'));
  });
});
