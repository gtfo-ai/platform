/**
 * A minimal SSE reader for the e2e tier.
 *
 * `EventSource` is not in Node, and it would not help here anyway: these tests have to read the
 * raw frames — the `id:`, the `retry:`, the `: ping` comments — and to cut the connection at a
 * chosen moment, which is what proves replay works. So the wire format is parsed directly, the way
 * a browser would.
 */

export interface SseEvent {
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
  readonly retry: number | null;
}

export interface SseComment {
  readonly comment: string;
}

export type SseLine = SseEvent | SseComment;

export const isEvent = (line: SseLine): line is SseEvent => 'event' in line;

/** One open stream: the frames received so far, and a way to wait for more. */
export class SseStream {
  readonly received: SseLine[] = [];
  readonly response: Response;
  readonly #controller: AbortController;
  readonly #done: Promise<void>;
  #ended = false;
  #error: unknown;

  private constructor(response: Response, controller: AbortController) {
    this.response = response;
    this.#controller = controller;
    this.#done = this.#pump();
  }

  static async open(
    url: string,
    options: { readonly headers?: Record<string, string> } = {},
  ): Promise<SseStream> {
    const controller = new AbortController();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...options.headers },
      signal: controller.signal,
    });
    return new SseStream(response, controller);
  }

  get ended(): boolean {
    return this.#ended;
  }

  get error(): unknown {
    return this.#error;
  }

  events(): SseEvent[] {
    return this.received.filter(isEvent);
  }

  comments(): string[] {
    return this.received
      .filter((line): line is SseComment => !isEvent(line))
      .map((line) => line.comment);
  }

  /** Resolves when `predicate` holds, or throws after `timeoutMs`. */
  async waitFor(predicate: () => boolean, what = 'condition', timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; received ${JSON.stringify(this.received)} (ended=${this.#ended})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Resolves when the server closed the stream. */
  async waitForEnd(timeoutMs = 15_000): Promise<void> {
    await this.waitFor(() => this.#ended, 'the stream to end', timeoutMs);
  }

  /** Cuts the connection from the client side, the way a closed tab does. */
  async disconnect(): Promise<void> {
    this.#controller.abort();
    await this.#done.catch(() => {});
  }

  async #pump(): Promise<void> {
    const body = this.response.body;
    if (body === null) {
      this.#ended = true;
      return;
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          this.#consume(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      this.#error = error;
    } finally {
      this.#ended = true;
    }
  }

  #consume(block: string): void {
    if (block.trim() === '') {
      return;
    }
    let id: string | null = null;
    let event = 'message';
    let retry: number | null = null;
    const data: string[] = [];
    let sawField = false;

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        this.received.push({ comment: line.slice(1).trim() });
        continue;
      }
      const separator = line.indexOf(':');
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'id') {
        id = value;
        sawField = true;
      } else if (field === 'event') {
        event = value;
        sawField = true;
      } else if (field === 'data') {
        data.push(value);
        sawField = true;
      } else if (field === 'retry') {
        retry = Number.parseInt(value, 10);
        sawField = true;
      }
    }

    if (sawField) {
      this.received.push({ id, event, data: data.join('\n'), retry });
    }
  }
}
