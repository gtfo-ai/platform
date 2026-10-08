/**
 * SHA-256 (FIPS 180-4) over a string's UTF-8 bytes, as lowercase hex — pure, synchronous, no import.
 *
 * **Why it is written out here.** TD-029 decision 11's WP-175 amendment names SHA-256 for a
 * conversation's `author_ref`/`path_ref` digests, and the domain ring imports no `node:` module in
 * its production sources: it has no I/O, and the two hashes it already computes (`focusHash`,
 * `promptVersionOf`) are FNV-1a for that reason. Behind a port, a ref would depend on the adapter
 * that computed it; a pure function keeps the prompt deterministic from its inputs. The test checks
 * it against `node:crypto` (`sha256.test.ts`), which a test may import.
 *
 * **What it is for.** It names a value the marker cannot print. A collision would put two names
 * behind one ref in one prompt, which needs a 64-bit prefix collision inside one conversation. It is
 * not used to prove anything.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));

/** The message padded to a multiple of 64 bytes, with its bit length in the last 8 (big-endian). */
const padded = (bytes: Uint8Array): DataView => {
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(length);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  const bits = bytes.length * 8;
  view.setUint32(length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(length - 4, bits >>> 0);
  return view;
};

const compress = (state: number[], view: DataView, offset: number, words: Uint32Array): void => {
  for (let t = 0; t < 16; t += 1) words[t] = view.getUint32(offset + t * 4);
  for (let t = 16; t < 64; t += 1) {
    const w15 = words[t - 15] as number;
    const w2 = words[t - 2] as number;
    const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
    const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
    words[t] = ((words[t - 16] as number) + s0 + (words[t - 7] as number) + s1) >>> 0;
  }
  let [a, b, c, d, e, f, g, h] = state as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  for (let t = 0; t < 64; t += 1) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const choice = (e & f) ^ (~e & g);
    const temp1 = (h + s1 + choice + (ROUND_CONSTANTS[t] as number) + (words[t] as number)) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const temp2 = (s0 + majority) >>> 0;
    h = g;
    g = f;
    f = e;
    e = (d + temp1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) >>> 0;
  }
  const next = [a, b, c, d, e, f, g, h];
  for (let i = 0; i < 8; i += 1) state[i] = ((state[i] as number) + (next[i] as number)) >>> 0;
};

/** The SHA-256 of `text`'s UTF-8 encoding, as 64 lowercase hex characters. */
export const sha256Hex = (text: string): string => {
  const view = padded(new TextEncoder().encode(text));
  const state = [...INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    compress(state, view, offset, words);
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
};
