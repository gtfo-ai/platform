import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { filterTar, linkStaysInside, parseTar, writeTar } from './tar.js';

const names = (buffer: Buffer): readonly string[] => parseTar(buffer).map((entry) => entry.name);

describe('tar reader', () => {
  it('reads files, directories and symlinks written by the writer', () => {
    const archive = writeTar([
      { name: 'repo/', type: 'directory' },
      { name: 'repo/README.md', type: 'file', content: '# hello\n' },
      { name: 'repo/link', type: 'symlink', linkname: 'README.md' },
    ]);
    expect(parseTar(archive)).toEqual([
      expect.objectContaining({ name: 'repo/', type: 'directory' }),
      expect.objectContaining({ name: 'repo/README.md', type: 'file', size: 8 }),
      expect.objectContaining({ name: 'repo/link', type: 'symlink', linkname: 'README.md' }),
    ]);
  });

  it('refuses an entry whose name is absolute', () => {
    const archive = writeTar([{ name: '/etc/passwd', type: 'file', content: 'x' }]);
    expect(() => parseTar(archive)).toThrow(/absolute/);
  });

  it('refuses an entry whose name escapes the archive', () => {
    const archive = writeTar([{ name: '../../etc/cron.d/x', type: 'file', content: 'x' }]);
    expect(() => parseTar(archive)).toThrow(/escapes the archive/);
  });

  it('refuses an archive it cannot read rather than guessing', () => {
    expect(() => parseTar(Buffer.alloc(512, 0x41))).toThrow(WorkspaceError);
    const truncated = writeTar([{ name: 'a', type: 'file', content: 'x'.repeat(1000) }]).subarray(
      0,
      700,
    );
    expect(() => parseTar(truncated)).toThrow(/truncated/);
  });

  it('reads a PAX long path, which is what the daemon writes for a deep name', () => {
    const long = `repo/${'d/'.repeat(60)}file.txt`;
    const record = `${String(`path=${long}\n`.length + 4).padStart(3, '0')} path=${long}\n`;
    const pax = writeTar([{ name: 'PaxHeaders/0', type: 'file', content: record }]);
    // Retype the PAX entry's header: `x`, the type the writer does not emit.
    pax.write('x', 156, 1);
    const body = writeTar([{ name: 'placeholder', type: 'file', content: 'hi\n' }]);
    const archive = Buffer.concat([pax.subarray(0, pax.length - 1024), body]);
    expect(names(archive)).toEqual([long]);
  });
});

describe('link containment', () => {
  it.each([
    ['a sibling', 'repo/a/link', 'b', true],
    ['a parent that stays inside', 'repo/a/b/link', '../c', true],
    ['a walk back to the root', 'repo/a/link', '../README.md', true],
    ['an escape by one level', 'repo/link', '../../etc/passwd', false],
    ['an absolute target', 'repo/link', '/etc/passwd', false],
    ['an absolute target with a benign prefix', 'repo/link', '/work/repo/README.md', false],
    ['a deep escape', 'repo/a/b/link', '../../../../root/.ssh/authorized_keys', false],
    ['no target at all', 'repo/file', '', true],
  ])('%s', (_label, entry, target, expected) => {
    expect(linkStaysInside(entry, target)).toBe(expected);
  });
});

describe('tar filter', () => {
  const archive = () =>
    writeTar([
      { name: 'repo/', type: 'directory' },
      { name: 'repo/README.md', type: 'file', content: '# fixture\n' },
      { name: 'repo/inside', type: 'symlink', linkname: 'README.md' },
      { name: 'repo/escape', type: 'symlink', linkname: '../../etc/passwd' },
      { name: 'repo/absolute', type: 'symlink', linkname: '/etc/shadow' },
    ]);

  it('drops the links that escape and keeps everything else', () => {
    const filtered = filterTar(archive());
    expect(filtered.droppedLinks).toBe(2);
    expect(names(filtered.bytes)).toEqual(['repo/', 'repo/README.md', 'repo/inside']);
  });

  it('copies kept entries byte for byte', () => {
    // No re-encoding: whatever the daemon wrote for an entry survives exactly, so nothing this
    // module might get wrong about checksums or PAX headers can corrupt a file that is kept.
    const source = archive();
    const kept = parseTar(source).find((entry) => entry.name === 'repo/README.md');
    const filtered = filterTar(source);
    const after = parseTar(filtered.bytes).find((entry) => entry.name === 'repo/README.md');
    expect(after).toBeDefined();
    expect(
      filtered.bytes.subarray(after?.offset ?? 0, (after?.offset ?? 0) + (after?.length ?? 0)),
    ).toEqual(source.subarray(kept?.offset ?? 0, (kept?.offset ?? 0) + (kept?.length ?? 0)));
  });

  it('ends the archive with two zero blocks, so tar reads it as complete', () => {
    const filtered = filterTar(archive());
    expect(filtered.bytes.subarray(filtered.bytes.length - 1024).every((byte) => byte === 0)).toBe(
      true,
    );
  });

  it('leaves an archive with nothing to drop unchanged in content', () => {
    const clean = writeTar([{ name: 'repo/a', type: 'file', content: 'x' }]);
    const filtered = filterTar(clean);
    expect(filtered.droppedLinks).toBe(0);
    expect(filtered.kept).toBe(1);
    expect(names(filtered.bytes)).toEqual(['repo/a']);
  });
});

describe('tar writer', () => {
  it('writes a checksum the reader accepts and GNU tar would', () => {
    const archive = writeTar([{ name: 'a', type: 'file', content: 'hi' }]);
    const header = archive.subarray(0, 512);
    const stored = Number.parseInt(header.subarray(148, 154).toString('ascii'), 8);
    const withSpaces = Buffer.from(header);
    withSpaces.write('        ', 148, 8, 'ascii');
    let sum = 0;
    for (const byte of withSpaces) {
      sum += byte;
    }
    expect(stored).toBe(sum);
  });

  it('refuses a name longer than ustar can hold rather than truncating it', () => {
    expect(() => writeTar([{ name: 'a'.repeat(101), type: 'file' }])).toThrow(/longer than ustar/);
  });
});
