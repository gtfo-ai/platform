/**
 * The run's input: an async queue the SDK consumes and the platform pushes to.
 *
 * technical/04 § "Streaming and steering": "the run's input is an async queue; a `run.steered`
 * command pushes an `SDKUserMessage`". `query()` in streaming-input mode consumes an
 * `AsyncIterable<SDKUserMessage>` and keeps the session open for as long as that iterable has not
 * finished, so the queue is also what ends the session: closing it is how the platform says "no
 * more turns".
 *
 * Deliberately unbounded. The only producers are the platform itself — one prompt, plus one message
 * per human steer — so a bound would be a limit on how often a person may type, and the failure
 * mode it guards against does not exist here.
 */

export interface AsyncQueue<T> {
  push(value: T): void;
  /** Ends the iterable after everything already pushed has been read. */
  close(): void;
  readonly closed: boolean;
  readonly iterable: AsyncIterable<T>;
}

export const createAsyncQueue = <T>(): AsyncQueue<T> => {
  const buffered: T[] = [];
  const waiting: ((result: IteratorResult<T>) => void)[] = [];
  let closed = false;

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      next: (): Promise<IteratorResult<T>> => {
        const value = buffered.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          waiting.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<T>> => {
        closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    }),
  };

  return {
    iterable,
    get closed() {
      return closed;
    },
    push: (value) => {
      if (closed) {
        return;
      }
      const next = waiting.shift();
      if (next === undefined) {
        buffered.push(value);
      } else {
        next({ value, done: false });
      }
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      // Everyone already waiting is finished now; anything buffered has already been handed out,
      // because a consumer only waits when the buffer is empty.
      while (waiting.length > 0) {
        waiting.shift()?.({ value: undefined, done: true });
      }
    },
  };
};

/** A promise plus the handle to settle it, for racing a stream against a watchdog. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};
