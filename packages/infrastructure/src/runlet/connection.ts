/**
 * One socket, framed — the piece both ends of the control channel share.
 *
 * It owns three things that are easy to get subtly wrong twice if each endpoint writes its own:
 * decoding across chunk boundaries, **backpressure** (`send` reports the socket's own answer, and
 * `onDrain` fires when it can take more, which is what lets the shim pause the child's stdout
 * rather than buffer a gigabyte of tool output), and turning a protocol violation into a `fatal`
 * frame followed by a close rather than an unhandled throw inside a `data` listener.
 */
import type { Socket } from 'node:net';
import type { RunletFatalReason, RunletFrame } from '@platform/contracts';
import {
  createFrameDecoder,
  type DecodedFrame,
  encodeFrame,
  RunletProtocolError,
} from './framing.js';

export interface FrameConnectionHandlers {
  onFrame: (decoded: DecodedFrame) => void;
  /** A protocol violation, a socket error, or a throw out of `onFrame`. Fires at most once. */
  onError: (error: RunletProtocolError | Error) => void;
  /** The socket is gone. Fires exactly once, after `onError` when both apply. */
  onClose: () => void;
  /** The socket's write buffer has drained; `send` will return `true` again. */
  onDrain?: () => void;
}

export interface FrameConnection {
  /** Writes one frame. `false` means the kernel buffer is full — wait for `onDrain`. */
  send(frame: RunletFrame, payload?: Buffer): boolean;
  /** Sends `fatal` (best effort) and closes. Idempotent. */
  fail(reason: RunletFatalReason, message: string): void;
  /** Closes without a `fatal`. Idempotent. */
  close(): void;
  /** Stops reading the socket — the peer's kernel buffer then fills and it feels the backpressure. */
  pause(): void;
  resume(): void;
  readonly closed: boolean;
}

export const createFrameConnection = (
  socket: Socket,
  handlers: FrameConnectionHandlers,
): FrameConnection => {
  const decoder = createFrameDecoder();
  let closed = false;
  let errored = false;

  const raise = (error: Error): void => {
    if (errored) {
      return;
    }
    errored = true;
    handlers.onError(error);
  };

  const connection: FrameConnection = {
    get closed() {
      return closed;
    },
    send: (frame, payload) => {
      if (closed || socket.destroyed) {
        return false;
      }
      try {
        return socket.write(encodeFrame(frame, payload));
      } catch (error) {
        raise(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
    },
    fail: (reason, message) => {
      if (!closed && !socket.destroyed) {
        // Best effort: the peer may already be gone, and `end()` flushes what it can.
        socket.write(encodeFrame({ type: 'fatal', reason, message }));
      }
      connection.close();
    },
    pause: () => {
      socket.pause();
    },
    resume: () => {
      socket.resume();
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      socket.end();
      socket.destroySoon();
    },
  };

  socket.on('data', (chunk: Buffer) => {
    let frames: DecodedFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      raise(error instanceof Error ? error : new RunletProtocolError(String(error)));
      return;
    }
    for (const decoded of frames) {
      if (closed) {
        return;
      }
      try {
        handlers.onFrame(decoded);
      } catch (error) {
        raise(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  });
  socket.on('drain', () => handlers.onDrain?.());
  socket.on('error', (error) => raise(error));
  socket.on('close', () => {
    closed = true;
    handlers.onClose();
  });

  return connection;
};
