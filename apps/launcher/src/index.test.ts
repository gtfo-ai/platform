import { describe, expect, it } from 'vitest';
import { packageId } from './index.js';

describe('@platform/launcher', () => {
  it('is wired into the workspace', () => {
    expect(packageId).toBe('@platform/launcher');
  });
});
