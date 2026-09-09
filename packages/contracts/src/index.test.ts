import { describe, expect, it } from 'vitest';
import { packageId } from './index.js';

describe('@platform/contracts', () => {
  it('is wired into the workspace', () => {
    expect(packageId).toBe('@platform/contracts');
  });
});
