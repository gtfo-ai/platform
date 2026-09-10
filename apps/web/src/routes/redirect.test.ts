import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './redirect.js';

describe('safeRedirectPath', () => {
  it('keeps a same-document path, so a refused deep link is returned to', () => {
    expect(safeRedirectPath('/projects/demo_service')).toBe('/projects/demo_service');
    expect(safeRedirectPath('/runs/abc?tab=prompt')).toBe('/runs/abc?tab=prompt');
  });

  it.each([
    ['//evil.example/steal', 'protocol-relative: a browser resolves it to another origin'],
    ['///evil.example', 'three slashes resolve the same way'],
    ['https://evil.example', 'an absolute URL'],
    ['http://evil.example', 'an absolute URL'],
    ['javascript:alert(1)', 'a scheme that executes'],
    ['projects/demo', 'a relative path, which resolves against whatever page is showing'],
    [undefined, 'nothing at all'],
  ])(
    'refuses %j (%s) and falls back to the dashboard',
    (value: string | undefined, _why: string) => {
      expect(safeRedirectPath(value)).toBe('/');
    },
  );
});
