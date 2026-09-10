import { describe, expect, it } from 'vitest';
import { connectionLabel } from './shell.js';

/**
 * The connection badge is the only thing on screen that says whether the "live updates everywhere"
 * promise of product/10 is being kept — this app never polls, so a dead stream is a screen that has
 * silently stopped changing. Every status the realtime client can report therefore has to produce a
 * label a human can act on.
 */
describe('connectionLabel', () => {
  it.each([
    ['open', 'Live', 'success'],
    ['connecting', 'Connecting', 'neutral'],
    ['reconnecting', 'Reconnecting', 'warning'],
    ['server_shutdown', 'Server restarting', 'warning'],
    ['closed', 'Disconnected', 'danger'],
    ['idle', 'Idle', 'neutral'],
  ])('reports %s as %j', (status, text, tone) => {
    expect(connectionLabel(status)).toEqual({ text, tone });
  });

  it('never leaves a status without a label', () => {
    expect(connectionLabel('something-new')).toEqual({ text: 'Idle', tone: 'neutral' });
  });
});
