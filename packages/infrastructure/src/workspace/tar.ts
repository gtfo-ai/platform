/**
 * A tar reader, filter and writer, for the take-over export (technical/05 §6).
 *
 * Three reasons this is here rather than a dependency:
 *
 *  1. The launcher reads a tar stream out of the Docker Engine (`GET /containers/{id}/archive`)
 *     and must look at what is in it before writing it anywhere.
 *  2. The exclusion technical/05 asks for (`.git`, `node_modules`) is done by the helper's `tar`,
 *     but the **link** filtering cannot be: an archive is extracted somewhere else, and a symlink
 *     inside the workspace whose target escapes it (`evil -> /etc/passwd`, or `../../../etc`) turns
 *     "here is a copy of the agent's work" into a write outside the workspace on whatever machine
 *     unpacks it. Those entries are dropped and counted.
 *  3. The fake provider builds an archive from its in-memory tree with {@link writeTar} and then
 *     runs it through the *same* {@link filterTar}, so `droppedLinks` means the same thing in both
 *     implementations rather than being two behaviours that happen to share a field name.
 *
 * ## Formats
 *
 * USTAR, plus the PAX extended headers Go's `archive/tar` emits — which is what the Docker daemon
 * writes — for a long path, a long link target or a non-ASCII name. A `pax_global_header` and a
 * per-file `x` header are read for their `path` and `linkpath` records and then dropped from the
 * output together with the entry they describe, when that entry is dropped. GNU's `L`/`K` long
 * name extensions are read too; an archive using anything else is refused rather than
 * misinterpreted, because a name this module cannot read is a name it cannot check.
 */
import { WorkspaceError } from '@platform/application';

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other';
  readonly size: number;
  readonly linkname: string;
  readonly mode: number;
  /** Offset of the first header block of this entry (including any PAX/GNU prefix headers). */
  readonly offset: number;
  /**
   * Offset of the entry's **data**, which is not `offset + 512` when a PAX or GNU long-name header
   * precedes it. Unwrapping a one-file archive from `offset + 512` reads the extended header's own
   * bytes as the file's, which decodes as "not a tar at all" if you are lucky and as a corrupt
   * archive if you are not.
   */
  readonly dataOffset: number;
  /** Total bytes this entry occupies, headers and padded data included. */
  readonly length: number;
}

const readString = (block: Buffer, start: number, length: number): string => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
};

const readOctal = (block: Buffer, start: number, length: number): number => {
  const text = readString(block, start, length).trim();
  if (text.length === 0) {
    return 0;
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new WorkspaceError('workspace_failed', 'tar header holds a malformed octal field');
  }
  return value;
};

const isZeroBlock = (block: Buffer): boolean => block.every((byte) => byte === 0);

const TYPES: Readonly<Record<string, TarEntry['type']>> = {
  '0': 'file',
  '\0': 'file',
  '7': 'file',
  '1': 'hardlink',
  '2': 'symlink',
  '5': 'directory',
};

/** PAX records are `"<len> <key>=<value>\n"`, the length counting itself. */
const parsePaxRecords = (data: Buffer): Map<string, string> => {
  const records = new Map<string, string>();
  let cursor = 0;
  while (cursor < data.length) {
    const space = data.indexOf(0x20, cursor);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(data.subarray(cursor, space).toString('ascii'), 10);
    if (!Number.isFinite(length) || length <= 0 || cursor + length > data.length) {
      throw new WorkspaceError('workspace_failed', 'tar PAX header holds a malformed record');
    }
    const record = data.subarray(space + 1, cursor + length).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1).replace(/\n$/, ''));
    }
    cursor += length;
  }
  return records;
};

/**
 * Reads every entry. Throws `workspace_failed` on an archive it cannot read — a truncated one, a
 * header type it does not know, or a name that escapes the archive root.
 *
 * The last of those is not paranoia about the daemon: it is the property that makes the result
 * safe to hand to anything that extracts it, and it costs one comparison.
 */
export const parseTar = (buffer: Buffer): readonly TarEntry[] => {
  const entries: TarEntry[] = [];
  let cursor = 0;
  let pending: { path?: string; linkpath?: string; size?: number } = {};
  let entryStart = 0;

  while (cursor + BLOCK <= buffer.length) {
    const header = buffer.subarray(cursor, cursor + BLOCK);
    if (isZeroBlock(header)) {
      break;
    }
    // Two spellings, both real, and the difference cost a first e2e run: POSIX writes
    // `"ustar\0" "00"` and GNU writes `"ustar  \0"` — which is what busybox's `tar` in the helper
    // image produces. Reading a fixed six bytes matched neither. The field is eight bytes and
    // `readString` stops at the NUL, so both answer `ustar…`.
    const magic = readString(header, 257, 8);
    if (!magic.startsWith('ustar')) {
      throw new WorkspaceError('workspace_failed', 'tar header is not ustar', {
        detail: `magic ${JSON.stringify(magic)} at ${cursor}`,
      });
    }
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = readOctal(header, 124, 12);
    const dataBlocks = Math.ceil(size / BLOCK) * BLOCK;
    if (cursor + BLOCK + dataBlocks > buffer.length) {
      throw new WorkspaceError('workspace_failed', 'tar archive is truncated');
    }
    const data = buffer.subarray(cursor + BLOCK, cursor + BLOCK + size);

    if (typeflag === 'x' || typeflag === 'g') {
      const records = parsePaxRecords(data);
      const path = records.get('path');
      const linkpath = records.get('linkpath');
      const paxSize = records.get('size');
      if (typeflag === 'x') {
        pending = {
          ...(path === undefined ? {} : { path }),
          ...(linkpath === undefined ? {} : { linkpath }),
          ...(paxSize === undefined ? {} : { size: Number.parseInt(paxSize, 10) }),
        };
      }
      cursor += BLOCK + dataBlocks;
      continue;
    }
    if (typeflag === 'L' || typeflag === 'K') {
      const value = data.toString('utf8').replace(/\0+$/, '');
      pending = typeflag === 'L' ? { ...pending, path: value } : { ...pending, linkpath: value };
      cursor += BLOCK + dataBlocks;
      continue;
    }

    const type = TYPES[typeflag] ?? 'other';
    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const name = pending.path ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
    const linkname = pending.linkpath ?? readString(header, 157, 100);
    assertContainedName(name);
    entries.push({
      name,
      type,
      size: pending.size ?? size,
      linkname,
      mode: readOctal(header, 100, 8),
      offset: entryStart,
      dataOffset: cursor + BLOCK,
      length: cursor + BLOCK + dataBlocks - entryStart,
    });
    cursor += BLOCK + dataBlocks;
    entryStart = cursor;
    pending = {};
  }
  return entries;
};

/** Refuses an entry name that is absolute or walks out of the archive. */
const assertContainedName = (name: string): void => {
  const normalised = name.replaceAll('\\', '/');
  if (normalised.startsWith('/') || /^[A-Za-z]:/.test(normalised)) {
    throw new WorkspaceError('workspace_failed', 'tar entry name is absolute', {
      detail: normalised.slice(0, 120),
    });
  }
  if (normalised.split('/').includes('..')) {
    throw new WorkspaceError('workspace_failed', 'tar entry name escapes the archive', {
      detail: normalised.slice(0, 120),
    });
  }
};

/**
 * Whether a link target stays inside the archive.
 *
 * Relative targets are resolved against the entry's own directory, so `a/b/link -> ../c` is inside
 * and `a/link -> ../../etc/passwd` is not. An absolute target is never inside: the archive has no
 * root to be absolute against.
 */
export const linkStaysInside = (entryName: string, linkname: string): boolean => {
  if (linkname.length === 0) {
    return true;
  }
  if (linkname.startsWith('/')) {
    return false;
  }
  const segments = entryName.split('/').slice(0, -1);
  for (const segment of linkname.split('/')) {
    if (segment === '..') {
      if (segments.length === 0) {
        return false;
      }
      segments.pop();
    } else if (segment !== '.' && segment !== '') {
      segments.push(segment);
    }
  }
  return true;
};

export interface FilterResult {
  readonly bytes: Buffer;
  /** Link entries dropped because their target escaped the archive. */
  readonly droppedLinks: number;
  readonly kept: number;
}

/**
 * Copies an archive, dropping every symlink or hardlink whose target escapes it.
 *
 * Byte-for-byte copy of the entries it keeps, headers included: no re-encoding, so a PAX-headed
 * entry survives exactly as the daemon wrote it and nothing this module might get wrong about
 * checksums can corrupt a kept file.
 */
export const filterTar = (buffer: Buffer): FilterResult => {
  const entries = parseTar(buffer);
  const kept: Buffer[] = [];
  let droppedLinks = 0;
  for (const entry of entries) {
    const isLink = entry.type === 'symlink' || entry.type === 'hardlink';
    if (isLink && !linkStaysInside(entry.name, entry.linkname)) {
      droppedLinks += 1;
      continue;
    }
    kept.push(buffer.subarray(entry.offset, entry.offset + entry.length));
  }
  kept.push(Buffer.alloc(BLOCK * 2));
  return {
    bytes: Buffer.concat(kept),
    droppedLinks,
    kept: entries.length - droppedLinks,
  };
};

export interface TarInput {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly content?: string;
  readonly linkname?: string;
  readonly mode?: number;
}

const writeOctal = (block: Buffer, start: number, length: number, value: number): void => {
  const text = value.toString(8).padStart(length - 1, '0');
  block.write(`${text}\0`, start, length, 'ascii');
};

/** Builds a USTAR archive. Used by the fake provider, and by the tests that feed {@link filterTar}. */
export const writeTar = (inputs: readonly TarInput[]): Buffer => {
  const blocks: Buffer[] = [];
  for (const input of inputs) {
    if (Buffer.byteLength(input.name, 'utf8') > 100) {
      throw new WorkspaceError(
        'workspace_failed',
        'tar writer got a name longer than ustar allows',
      );
    }
    const header = Buffer.alloc(BLOCK);
    const content = Buffer.from(input.content ?? '', 'utf8');
    const size = input.type === 'file' ? content.length : 0;
    header.write(input.name, 0, 100, 'utf8');
    writeOctal(header, 100, 8, input.mode ?? (input.type === 'directory' ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, size);
    writeOctal(header, 136, 12, 0);
    header.write(input.type === 'file' ? '0' : input.type === 'directory' ? '5' : '2', 156, 1);
    header.write(input.linkname ?? '', 157, 100, 'utf8');
    header.write('ustar\0' + '00', 257, 8, 'ascii');
    // The checksum is computed with its own field read as spaces, then written back over it.
    header.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const byte of header) {
      sum += byte;
    }
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header);
    if (size > 0) {
      blocks.push(content, Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK));
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(blocks);
};
