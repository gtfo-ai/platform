import type { SseFrame } from '@platform/contracts';
import type { EventStream } from './client.js';

/**
 * A fake `EventSource` for screen tests, which behaves like a browser's in the one way the
 * realtime client depends on: **it fires `open` by itself, asynchronously, once, after
 * construction.** The real hub writes the response headers only after it has registered the
 * stream, and the client sends `POST /events/subscriptions` only for a stream that has fired
 * `open` (S-23.16, `client.ts`'s module note). A fake that never opened would hold every topic
 * change forever, and one that opened synchronously would open before the client had installed
 * its listeners — neither is what a browser does.
 *
 * `open()` is idempotent, so a test may still open a stream itself before the fake does.
 */
export interface FakeEventStream {
  readonly url: string;
  /** The topics the stream's URL carried when it was opened. */
  readonly topics: readonly string[];
  readonly emit: (frame: SseFrame, id: string) => void;
  readonly open: () => void;
  readonly closed: () => boolean;
}

export const fakeEventStreams = () => {
  const streams: FakeEventStream[] = [];
  const openStream = (url: string): EventStream => {
    const listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    let opened = false;
    let closed = false;
    const open = (): void => {
      if (opened || closed) {
        return;
      }
      opened = true;
      for (const listener of listeners.get('open') ?? []) {
        listener(new MessageEvent<string>('open', { data: '' }));
      }
    };
    streams.push({
      url,
      topics: (new URL(url, 'http://localhost').searchParams.get('topics') ?? '')
        .split(',')
        .filter(Boolean),
      emit: (frame, id) => {
        const message = new MessageEvent<string>('message', {
          data: JSON.stringify(frame),
          lastEventId: id,
        });
        for (const listener of listeners.get('message') ?? []) listener(message);
      },
      open,
      closed: () => closed,
    });
    // A macrotask, as the browser's: the client installs its listeners synchronously after
    // `openStream` returns, and the response headers arrive later.
    globalThis.setTimeout(open, 0);
    return {
      addEventListener: (type, listener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close: () => {
        closed = true;
      },
    };
  };
  return { streams, openStream };
};
