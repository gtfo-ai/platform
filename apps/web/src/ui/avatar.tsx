/**
 * Avatar: a person's initials on a pastel of the brand family (TD-033), never an image — an
 * `<img src>` would be a URL attribute (`no-html.test.ts`) and a request to somebody's server.
 *
 * The hue is **deterministic**: the same name always gets the same of six tokens (`--avatar-1…6`,
 * initials in night, held to 4.5:1 by `contrast.test.ts`), so a person is recognisable across the
 * audit log, the activity feed and the user menu.
 */
import type { ReactElement } from 'react';
import { cx } from './cx.js';

export const AVATAR_TONES = [
  'bg-avatar-1',
  'bg-avatar-2',
  'bg-avatar-3',
  'bg-avatar-4',
  'bg-avatar-5',
  'bg-avatar-6',
] as const;

/** FNV-1a over the UTF-16 code units: stable, cheap, and spread enough over six buckets. */
export const avatarTone = (name: string): (typeof AVATAR_TONES)[number] => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? AVATAR_TONES[0];
};

/** "Ada Lovelace" → "AL", "ada@example.test" → "A", "" → "?". */
export const initialsOf = (name: string): string => {
  const local = name.includes('@') ? (name.split('@')[0] ?? '') : name;
  const words = local
    .split(/[\s._-]+/u)
    .map((word) => word.trim())
    .filter((word) => word !== '');
  const letters = (name.includes('@') ? words.slice(0, 1) : words.slice(0, 2))
    .map((word) => [...word][0] ?? '')
    .join('');
  return letters === '' ? '?' : letters.toLocaleUpperCase('en');
};

const SIZES = {
  20: 'size-5 text-[0.5625rem]',
  24: 'size-6 text-[0.625rem]',
  32: 'size-8 text-xs',
  40: 'size-10 text-sm',
} as const;

export const Avatar = ({
  name,
  size = 24,
  decorative = false,
  className,
}: {
  readonly name: string;
  readonly size?: keyof typeof SIZES;
  /** Beside the name in text: hidden, so the name is not read twice. */
  readonly decorative?: boolean;
  readonly className?: string;
}): ReactElement => (
  <span
    data-avatar=""
    className={cx(
      'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-avatar-fg select-none',
      SIZES[size],
      avatarTone(name),
      className,
    )}
    {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}
  >
    {initialsOf(name)}
  </span>
);
