import { describe, expect, it } from 'vitest';
import { packageId } from './index.js';

describe('@platform/infrastructure', () => {
  it('is wired into the workspace', () => {
    expect(packageId).toBe('@platform/infrastructure');
  });
});
