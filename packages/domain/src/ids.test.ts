import { idSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { idsFrom, sequentialIds } from './ids.js';

describe('sequentialIds', () => {
  it('produces well-formed, distinct, deterministic uuids', () => {
    const first = sequentialIds();
    const second = sequentialIds();
    const produced = [first.next(), first.next(), first.next()];
    expect(produced).toEqual([second.next(), second.next(), second.next()]);
    expect(new Set(produced).size).toBe(3);
    for (const id of produced) {
      expect(() => idSchema.parse(id)).not.toThrow();
    }
  });

  it('starts where it is told', () => {
    expect(sequentialIds(255).next()).toBe('00000000-0000-4000-8000-0000000000ff');
  });
});

describe('idsFrom', () => {
  it('hands out the given ids in order', () => {
    const source = idsFrom(['00000000-0000-4000-8000-00000000000a']);
    expect(source.next()).toBe('00000000-0000-4000-8000-00000000000a');
    expect(() => source.next()).toThrow(RangeError);
  });
});
