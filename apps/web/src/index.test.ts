import { describe, expect, it } from 'vitest';
import { packageId } from './index.js';

describe('@platform/web', () => {
  it('is wired into the workspace', () => {
    expect(packageId).toBe('@platform/web');
  });

  it('runs in a DOM environment', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    expect(document.getElementById('root')).toBe(root);
  });
});
