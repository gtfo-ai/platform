/**
 * The `agentic-runlet` codec: length-prefixed JSON headers with raw byte payloads (TD-025).
 *
 * ```
 *   0            4            8              8+H              8+H+P
 *   +------------+------------+---------------+----------------+
 *   | u32be   H  | u32be   P  | header (JSON) | payload (raw)  |
 *   +------------+------------+---------------+----------------+
 * ```
 *
 * Both ends of the socket are untrusted producers as far as this file is concerned (BD-022): the
 * shim's peer is a binary the platform ships and does not control, and the credential socket's peer
 * is the agent. So the decoder never trusts a declared length — it checks it against a cap **before
 * allocating anything**, and it refuses the two shapes that would otherwise be silently accepted:
 *
 *  - a byte frame (`stdin`/`stdout`/`stderr`) with an empty payload — nothing emits one, so it is
 *    either a bug or a probe, and letting it through would put a zero-length write on a stream
 *    where `Readable.push('')` means something else entirely;
 *  - any other frame with a payload — bytes nobody will read are bytes somebody meant to hide.
 *
 * There is no "length" field to omit here (standing rule 16): the prefix is fixed-width binary, so
 * a truncated prefix is *not enough bytes yet* rather than a zero. The fields that can be omitted
 * live in the JSON header and are the schema's problem, in `@platform/contracts`.
 */
import {
  isRunletByteFrameType,
  type RunletFatalReason,
  type RunletFrame,
  runletFrameSchema,
} from '@platform/contracts';

/** Largest JSON header accepted. The biggest legitimate one is a `spawn` carrying the run's env. */
export const MAX_FRAME_HEADER_BYTES = 256 * 1024;

/**
 * Largest byte payload per frame. Chunking above this is the sender's job; the SDK's own stdio
 * chunks are far below it, and a 64 KiB cap would only mean more frames for the same bytes.
 */
export const MAX_FRAME_PAYLOAD_BYTES = 4 * 1024 * 1024;

const PREFIX_BYTES = 8;

/** A protocol violation. Carries the reason both endpoints report on the wire as `fatal`. */
export class RunletProtocolError extends Error {
  readonly reason: RunletFatalReason;

  constructor(message: string, reason: RunletFatalReason = 'protocol_error') {
    super(message);
    this.name = 'RunletProtocolError';
    this.reason = reason;
  }
}

export interface DecodedFrame {
  readonly frame: RunletFrame;
  /** The raw bytes of a `stdin`/`stdout`/`stderr` frame; `null` for every other type. */
  readonly payload: Buffer | null;
}

/** Serialises one frame. `payload` is required for a byte frame and rejected for anything else. */
export const encodeFrame = (frame: RunletFrame, payload?: Buffer): Buffer => {
  const carriesBytes = isRunletByteFrameType(frame.type);
  if (carriesBytes && (payload === undefined || payload.length === 0)) {
    throw new RunletProtocolError(`a ${frame.type} frame must carry at least one byte`);
  }
  if (!carriesBytes && payload !== undefined && payload.length > 0) {
    throw new RunletProtocolError(`a ${frame.type} frame must not carry a payload`);
  }
  const header = Buffer.from(JSON.stringify(frame), 'utf8');
  if (header.length > MAX_FRAME_HEADER_BYTES) {
    throw new RunletProtocolError(`header of ${header.length} bytes exceeds the cap`);
  }
  const bytes = carriesBytes ? (payload as Buffer) : Buffer.alloc(0);
  if (bytes.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new RunletProtocolError(`payload of ${bytes.length} bytes exceeds the cap`);
  }
  const prefix = Buffer.allocUnsafe(PREFIX_BYTES);
  prefix.writeUInt32BE(header.length, 0);
  prefix.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([prefix, header, bytes]);
};

export interface FrameDecoder {
  /** Feeds one socket chunk in and returns every whole frame it completed. Throws on a violation. */
  push(chunk: Buffer): DecodedFrame[];
  /** Bytes held back waiting for the rest of their frame. */
  readonly buffered: number;
}

/**
 * A decoder over a byte stream that arrives in arbitrary chunks.
 *
 * Chunk boundaries are the classic source of a codec bug that only shows up under load, so the
 * property test in `framing.test.ts` re-splits the same byte stream at random offsets and asserts
 * the same frames come out.
 */
export const createFrameDecoder = (): FrameDecoder => {
  let buffer: Buffer = Buffer.alloc(0);

  const decodeOne = (): DecodedFrame | null => {
    if (buffer.length < PREFIX_BYTES) {
      return null;
    }
    const headerLength = buffer.readUInt32BE(0);
    const payloadLength = buffer.readUInt32BE(4);
    if (headerLength === 0) {
      throw new RunletProtocolError('a frame declared an empty header');
    }
    if (headerLength > MAX_FRAME_HEADER_BYTES) {
      throw new RunletProtocolError(`a frame declared a ${headerLength}-byte header`);
    }
    if (payloadLength > MAX_FRAME_PAYLOAD_BYTES) {
      throw new RunletProtocolError(`a frame declared a ${payloadLength}-byte payload`);
    }
    const total = PREFIX_BYTES + headerLength + payloadLength;
    if (buffer.length < total) {
      return null;
    }
    const headerText = buffer.toString('utf8', PREFIX_BYTES, PREFIX_BYTES + headerLength);
    const payload =
      payloadLength === 0 ? null : Buffer.from(buffer.subarray(PREFIX_BYTES + headerLength, total));
    buffer = Buffer.from(buffer.subarray(total));

    let json: unknown;
    try {
      json = JSON.parse(headerText);
    } catch {
      throw new RunletProtocolError('a frame header was not JSON');
    }
    const parsed = runletFrameSchema.safeParse(json);
    if (!parsed.success) {
      // The header text never reaches the message: it is attacker-controlled and on its way to a
      // log (BD-022). The issue paths are ours.
      const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
      throw new RunletProtocolError(`a frame header did not validate at: ${where}`);
    }
    const frame = parsed.data;
    if (isRunletByteFrameType(frame.type)) {
      if (payload === null) {
        throw new RunletProtocolError(`a ${frame.type} frame carried no bytes`);
      }
    } else if (payload !== null) {
      throw new RunletProtocolError(`a ${frame.type} frame carried ${payload.length} bytes`);
    }
    return { frame, payload };
  };

  return {
    get buffered() {
      return buffer.length;
    },
    push: (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const frames: DecodedFrame[] = [];
      for (;;) {
        const decoded = decodeOne();
        if (decoded === null) {
          return frames;
        }
        frames.push(decoded);
      }
    },
  };
};
