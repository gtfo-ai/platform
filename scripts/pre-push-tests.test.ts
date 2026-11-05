import { describe, expect, it } from 'vitest';
import { MAIN_REF, pushNeedsTests } from './pre-push-tests.mjs';

const line = (remoteRef: string) =>
  `refs/heads/topic ${'a'.repeat(40)} ${remoteRef} ${'b'.repeat(40)}`;

describe('the pre-push test tier runs for a push to main only', () => {
  it('runs for a push that updates main', () => {
    expect(pushNeedsTests(`${line(MAIN_REF)}\n`)).toBe(true);
  });

  it('runs when any of several refs is main', () => {
    expect(pushNeedsTests(`${line('refs/heads/slice/22.9')}\n${line(MAIN_REF)}\n`)).toBe(true);
  });

  it('skips a push to a pull request branch, which CI tests before any merge', () => {
    expect(pushNeedsTests(`${line('refs/heads/slice/22.9')}\n`)).toBe(false);
  });

  it('runs when stdin names no ref (the safe side)', () => {
    expect(pushNeedsTests('')).toBe(true);
    expect(pushNeedsTests('garbage\n')).toBe(true);
  });

  it('does not mistake a branch merely containing "main" for main', () => {
    expect(pushNeedsTests(`${line('refs/heads/main-fix')}\n`)).toBe(false);
    expect(pushNeedsTests(`${line('refs/heads/feature/main')}\n`)).toBe(false);
  });
});
