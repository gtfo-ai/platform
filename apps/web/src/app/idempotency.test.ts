/**
 * One `Idempotency-Key` per intent — PROGRESS backlog 53.
 *
 * The property is asserted from **both** sides throughout (standing rule 42): a register that
 * returned one constant would pass every "same key" case and fail every "different key" one, and a
 * register that minted per call — which is the defect — would pass the second half alone.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, createIntentKeys } from './idempotency.js';

/** A deterministic mint, so the assertions are about *which* key, not about "a key was made". */
const counting = () => {
  let n = 0;
  return () => {
    n += 1;
    return `key-${n}`;
  };
};

describe('an intent holds one key', () => {
  it('gives two sends of the same intent one key', () => {
    const keys = createIntentKeys(counting());
    const first = keys.keyFor(['project.create', { key: 'acme' }]);
    const second = keys.keyFor(['project.create', { key: 'acme' }]);
    expect(first).toBe('key-1');
    expect(second).toBe('key-1');
  });

  it('gives two different intents two keys', () => {
    const keys = createIntentKeys(counting());
    expect(keys.keyFor(['project.create', { key: 'acme' }])).toBe('key-1');
    // A corrected form is a **new** intent: the same key with a different body is refused
    // `409 idempotency_key_reused`, which would be exactly the wrong answer for an edit.
    expect(keys.keyFor(['project.create', { key: 'acme-api' }])).toBe('key-2');
    // …and so is a different command with the same arguments.
    expect(keys.keyFor(['integration.create', { key: 'acme' }])).toBe('key-3');
  });

  it('keeps the key across a failed attempt and releases it on success', () => {
    const keys = createIntentKeys(counting());
    const intent = ['budget.write', { window: 'day' }];
    expect(keys.keyFor(intent)).toBe('key-1');
    // A retry of the same intent — the case the header exists for.
    expect(keys.keyFor(intent)).toBe('key-1');
    keys.release(intent);
    // A deliberate second identical command after a success is a new intent, not a replay of the
    // first: a register that never released would answer the server's "already performed".
    expect(keys.keyFor(intent)).toBe('key-2');
  });

  it('does not care what order an intent’s keys were written in', () => {
    const keys = createIntentKeys(counting());
    expect(keys.keyFor({ a: 1, b: 2 })).toBe(keys.keyFor({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    // `undefined` is dropped the way the server's own canonical JSON drops it, so a field that is
    // absent and one that is explicitly undefined are one intent (`routes/idempotency.ts`).
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('is per register, so two screens do not share an intent', () => {
    const mint = counting();
    expect(createIntentKeys(mint).keyFor('x')).toBe('key-1');
    expect(createIntentKeys(mint).keyFor('x')).toBe('key-2');
  });
});
