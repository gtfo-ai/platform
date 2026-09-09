/**
 * The shared fake machinery: the signed webhook envelope, scripted failures and the call log.
 *
 * The signature test is the one that matters. Every provider fake's `verify` is built on
 * `verifyFakeDelivery`, so a contract suite's "rejects a tampered body" assertion is only worth
 * anything if this really compares an HMAC rather than, say, checking that a header exists.
 */
import { IntegrationError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  buildFakeDelivery,
  createFailureScript,
  createFakeCore,
  FAKE_DELIVERY_HEADER,
  FAKE_SIGNATURE_HEADER,
  FAKE_WEBHOOK_SECRET,
  fakeDeliveryKey,
  signFakeBody,
  snapshot,
  verifyFakeDelivery,
} from './fake-support.js';

const REF = {
  integrationId: '00000000-0000-4000-8000-000000000001',
  provider: 'fake',
  type: 'task_management',
} as const;

describe('the fake webhook envelope', () => {
  const delivery = buildFakeDelivery({
    secret: FAKE_WEBHOOK_SECRET,
    event: 'comment.added',
    deliveryId: 'd-1',
    payload: { event: 'comment.added', ticket_key: 'FAKE-1' },
  });

  it('accepts its own signature', () => {
    expect(verifyFakeDelivery(FAKE_WEBHOOK_SECRET, delivery)).toBe(true);
  });

  it('rejects a changed body, a changed secret and a missing signature', () => {
    expect(verifyFakeDelivery(FAKE_WEBHOOK_SECRET, { headers: delivery.headers, body: '{}' })).toBe(
      false,
    );
    expect(verifyFakeDelivery('another-fake-secret', delivery)).toBe(false);
    expect(verifyFakeDelivery(FAKE_WEBHOOK_SECRET, { headers: {}, body: delivery.body })).toBe(
      false,
    );
  });

  it('rejects a signature of the wrong length without throwing', () => {
    expect(
      verifyFakeDelivery(FAKE_WEBHOOK_SECRET, {
        headers: { ...delivery.headers, [FAKE_SIGNATURE_HEADER]: 'abc' },
        body: delivery.body,
      }),
    ).toBe(false);
  });

  it('signs the raw body, so re-serialising changes the signature', () => {
    const reserialised = JSON.stringify(JSON.parse(delivery.body), null, 2);
    expect(signFakeBody(FAKE_WEBHOOK_SECRET, reserialised)).not.toBe(
      delivery.headers[FAKE_SIGNATURE_HEADER],
    );
  });

  it('keys a delivery by its id header and refuses one without', () => {
    expect(fakeDeliveryKey('fake', delivery)).toBe('fake:d-1');
    let caught: unknown;
    try {
      fakeDeliveryKey('fake', { headers: {}, body: delivery.body });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    expect((caught as IntegrationError).code).toBe('invalid_request');
    expect(delivery.headers[FAKE_DELIVERY_HEADER]).toBe('d-1');
  });
});

describe('createFailureScript', () => {
  it('is empty until a test arms it, and then fires once per armed call', () => {
    const script = createFailureScript();
    expect(script.take('add_comment')).toBeNull();

    const failure = new Error('boom');
    script.failNext('add_comment', failure);
    expect(script.take('add_comment')).toBe(failure);
    expect(script.take('add_comment')).toBeNull();
  });

  it('arms several calls and reports what was never consumed', () => {
    const script = createFailureScript();
    script.failNextTimes('transition', new Error('429'), 2);
    script.failNext('add_comment', new Error('500'));

    expect(script.take('transition')).not.toBeNull();
    expect(script.unconsumed()).toEqual(['add_comment', 'transition']);
    expect(() => script.failNextTimes('x', new Error('y'), 0)).toThrow(TypeError);

    script.reset();
    expect(script.unconsumed()).toEqual([]);
  });
});

describe('createFakeCore', () => {
  it('records every call with a deterministic, advancing timestamp', () => {
    const core = createFakeCore({ ref: REF });
    core.enter('read_ticket');
    core.enter('add_comment');

    expect(core.calls.map((call) => call.action)).toEqual(['read_ticket', 'add_comment']);
    expect(core.calls[0]?.at).not.toBe(core.calls[1]?.at);
    core.resetCalls();
    expect(core.calls).toEqual([]);
  });

  it('throws whatever a test scripted for the action it is entering', () => {
    const core = createFakeCore({ ref: REF });
    core.script.failNext('transition', new Error('scripted'));
    expect(() => core.enter('transition')).toThrow('scripted');
    // The call is still recorded: the audit of what was attempted must not depend on the outcome.
    expect(core.calls.map((call) => call.action)).toEqual(['transition']);
  });
});

describe('snapshot', () => {
  it('cuts every reference into the fake state', () => {
    const original = { nested: { list: [1, 2] } };
    const copy = snapshot(original);
    copy.nested.list.push(3);
    expect(original.nested.list).toEqual([1, 2]);
  });
});
