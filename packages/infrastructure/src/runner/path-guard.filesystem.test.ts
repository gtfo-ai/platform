/**
 * The path guard's fold, put to a **real volume**.
 *
 * This is the instrument that found the defect twice, and it is the generalisable part: to learn a
 * filesystem's equivalence classes, ask the filesystem — write both names and compare inodes —
 * rather than reasoning about which Unicode operation ought to apply. Round 1 reasoned "case", and
 * `toLowerCase()` (lowercase *mapping*) is narrower than the full case *folding* APFS and HFS+
 * compare with: `conﬁg/app.yaml` (U+FB01) overwrote `config/app.yaml`, same inode, while the
 * guard answered `allow`. Every row below was a protected path that was not protected.
 *
 * **Each case writes the two names for real and asserts both halves**: what the volume did (inode
 * identity, and the overwrite that is the actual harm) and what {@link guardWritePath} answered.
 * They cannot drift apart again without this failing.
 *
 * **A volume has three independent properties, and each row names the probe that tracks it.** Does
 * it fold ASCII case, does it apply the rest of the case table, and does it normalise? Three
 * questions, and volumes answer them in different combinations — measured here by mounting each
 * one and writing the pairs, not by reading about it:
 *
 * | volume                                  | `a`/`A` | `st`/`ﬅ` | `ü` NFC/NFD | rows that collide |
 * | --------------------------------------- | ------- | ------- | -------- | ----------------- |
 * | APFS as macOS formats it                | yes     | yes     | yes      | every non-control |
 * | APFS case-sensitive (`hdiutil -fs …`)   | no      | no      | yes      | `canonical-equivalence` |
 * | ExFAT (a 1:1 upcase table)              | yes     | no      | yes      | `ascii-case`, `canonical-equivalence` |
 * | ext4 (Linux CI)                         | no      | no      | no       | none |
 *
 * All three are measured once, by {@link probeVolume}, on pairs no row uses — a probe that
 * measured a row's own characters would make that row assert itself. Every row is then predicted
 * from the probe it names rather than from a constant, so the branch that ran is asserted rather
 * than assumed (standing rule 10).
 *
 * **Deriving them from one probe was wrong, and it failed in the direction that looks safe: red.**
 * A case-sensitive APFS volume is still normalisation-*insensitive*, so the NFD row collides there
 * while the case probe says `false` — **1 failed, 14 passed** on that volume before this split.
 * ExFAT is the other half of the argument: it folds `.ENV` but not `conﬁg`, because a 1:1
 * upcase table is not full case folding. Linux CI would have seen neither.
 *
 * **A label is the probe a row tracked on every volume measured, not a theory of Unicode.** Where
 * the two disagree the measurement wins: Unicode's case folding maps both U+212A and U+212B to
 * ASCII-and-Latin-1 letters, yet ExFAT folds the first and not the second, so those two rows carry
 * different labels. A volume that answers the three probes in a combination none of the four above
 * did will fail a row's *volume* assertion and not its *verdict* assertion — that is this test
 * reporting a new kind of volume, not a defect in the guard, which stays wider than all of them.
 *
 * The guard's verdict is asserted **the same way on every volume**: `deny`. Where the volume merged
 * the two names that is the safety property; where it kept them apart it is the deliberate false
 * deny that buys it, which is the direction BD-024 asks to err in. What the fold does and does not
 * promise beyond these rows is written down at `foldForMatch` in `path-guard.ts`, with the census
 * behind it.
 *
 * **Every exotic character below is written as an escape, and every row is checked for it.** NFC
 * composes U+212A to `K`, U+212B to `Å` and `café` to `café`, so one normalising pass over
 * this file turns three Unicode rows into plain ASCII case rows — which still pass, because a row
 * comparing `K8s` with `k8s` is a perfectly good ASCII case test. It happened during the change
 * that added this paragraph and nothing caught it. The escapes remove the hazard (they are ASCII,
 * so normalising the file is a no-op) and {@link FoldCase.codePoint} catches a composed character
 * typed back in by hand: mutating any one of those three rows to its NFC spelling now fails that
 * row by name.
 *
 * **On ExFAT the twenty tests pass and `afterAll` then raises ENOTEMPTY**, because macOS keeps an
 * AppleDouble sidecar (`._name`) beside every file on a volume with no native extended attributes
 * and the driver recreates them under a recursive remove. {@link entriesOf} drops those sidecars so
 * that the assertions are about the names this test wrote; the cleanup is left as it was rather
 * than given retries, which did not help. ExFAT is a measured volume, not a supported one.
 *
 * The tier: this file does real I/O in a temp directory, which the unit tier otherwise avoids. It
 * needs no container and no fixture, it runs in milliseconds, and the whole point is that it runs
 * on the developer's and CI's actual filesystems — `scripts/check-ignored.test.ts` is the same
 * exception for the same reason (see `vitest.config.ts`).
 *
 * `os.tmpdir()` is the volume under test. On this machine (macOS 25.6, APFS) it and the repository
 * volume gave identical answers for all 20 probed classes; where a bind-mounted workspace lives on
 * a different volume from `/tmp`, that volume is the one that decides, and it is the operator's to
 * know.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardWritePath } from './path-guard.js';

let root = '';
/** Whether the volume folds ASCII case, measured rather than assumed. */
let volumeFoldsCase = false;
/**
 * Whether it folds the *rest* of the case table too — the part that is not a 1:1 upcase mapping.
 * ExFAT answers `true` above and `false` here, and the ligature rows follow this one.
 */
let volumeFoldsFully = false;
/**
 * Whether it treats canonically equivalent spellings as one name. A third question again: macOS's
 * case-sensitive APFS answers `false` to both of the above and `true` to this.
 */
let volumeNormalises = false;

const inodeOf = (file: string): number => fs.statSync(file).ino;

/**
 * The names the test wrote, without the AppleDouble sidecars macOS keeps beside a file on a volume
 * with no native extended attributes: on ExFAT, writing `.env` also creates `._.env`, and counting
 * that as a second file is a fact about the resource fork, not about the fold. No name used here
 * starts with `._`.
 */
const entriesOf = (dir: string): readonly string[] =>
  fs.readdirSync(dir).filter((entry) => !entry.startsWith('._'));

/** Writes two names in a directory of their own and asks the volume whether they are one file. */
const probeVolume = (first: string, second: string): boolean => {
  const dir = fs.mkdtempSync(path.join(root, 'probe-'));
  fs.writeFileSync(path.join(dir, first), 'first');
  fs.writeFileSync(path.join(dir, second), 'second');
  return inodeOf(path.join(dir, first)) === inodeOf(path.join(dir, second));
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'path-guard-fold-'));
  volumeFoldsCase = probeVolume('a', 'A');
  // U+FB05 and U+00FC/NFD: neither appears in a row, so no row asserts itself.
  volumeFoldsFully = probeVolume('st', '\uFB05');
  volumeNormalises = probeVolume('\u00FC', 'u\u0308');
});

afterAll(() => {
  if (root !== '') {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Which probe a row tracks, and therefore what the volume must do with it.
 *
 * `ascii-case` is the 1:1 upcase table every case-insensitive volume has (`a`/`A`).
 * `full-case-folding` is the rest of that table (`st`/`ﬅ`), which ExFAT does not have.
 * `canonical-equivalence` is normalisation (`ü` composed against decomposed), which a
 * case-*sensitive* APFS volume still applies. `nothing` is a control: no volume measured folds it.
 */
type VolumeProbe = 'ascii-case' | 'full-case-folding' | 'canonical-equivalence' | 'nothing';

interface FoldCase {
  /** The class, named by the code point that carries it. */
  readonly name: string;
  /** The protected path, as an operator would write it in `protected_paths` (technical/12). */
  readonly pattern: string;
  /** The file the operator means to protect. */
  readonly canonical: string;
  /** The name the agent writes instead. */
  readonly variant: string;
  /**
   * The code point the row is about, asserted to still be inside `variant`. Omitted for the two
   * rows that are pure ASCII. This is what stops an editor's NFC pass from quietly turning a
   * Unicode row into an ASCII one.
   */
  readonly codePoint?: number;
  /** The probe that predicts this row on every volume measured. */
  readonly tracksProbe: VolumeProbe;
  /** What the guard must answer for `variant` against `pattern`, on every volume. */
  readonly verdict: 'deny' | 'allow';
}

/**
 * The four the reviewer wrote on APFS, the classes around them, and the controls that prove this
 * test can tell the two verdicts apart.
 */
const CASES: readonly FoldCase[] = [
  {
    name: 'ASCII case',
    pattern: '.env',
    canonical: '.env',
    variant: '.ENV',
    tracksProbe: 'ascii-case',
    verdict: 'deny',
  },
  {
    name: 'U+FB01 LATIN SMALL LIGATURE FI',
    pattern: 'config/**',
    canonical: 'config',
    variant: 'con\uFB01g',
    codePoint: 0xfb01,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+FB02 LATIN SMALL LIGATURE FL',
    pattern: 'conflict/**',
    canonical: 'conflict',
    variant: 'con\uFB02ict',
    codePoint: 0xfb02,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+017F LATIN SMALL LETTER LONG S',
    pattern: 'secrets/**',
    canonical: 'secrets',
    variant: '\u017Fecrets',
    codePoint: 0x017f,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+017F against src',
    pattern: 'src/**',
    canonical: 'src',
    variant: '\u017Frc',
    codePoint: 0x017f,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+00DF LATIN SMALL LETTER SHARP S',
    pattern: 'assets/**',
    canonical: 'assets',
    variant: 'a\u00DFets',
    codePoint: 0x00df,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+00DF in a word (strasse)',
    pattern: 'strasse/**',
    canonical: 'strasse',
    variant: 'stra\u00DFe',
    codePoint: 0x00df,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+1E9E LATIN CAPITAL LETTER SHARP S',
    pattern: 'strasse/**',
    canonical: 'strasse',
    variant: 'stra\u1E9Ee',
    codePoint: 0x1e9e,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  {
    name: 'U+212B ANGSTROM SIGN',
    pattern: '\u00E5ngstrom/**',
    canonical: '\u00E5ngstrom',
    variant: '\u212Bngstrom',
    codePoint: 0x212b,
    tracksProbe: 'full-case-folding',
    verdict: 'deny',
  },
  // U+212A is the row that proves the labels are measured. Unicode folds it exactly as it folds
  // U+212B above, but it decomposes to an *ASCII* `K`, and ExFAT collides on this one while
  // keeping the Angstrom sign apart. So it tracks the ASCII probe, and the two rows differ.
  {
    name: 'U+212A KELVIN SIGN',
    pattern: 'k8s/**',
    canonical: 'k8s',
    variant: '\u212A8s',
    codePoint: 0x212a,
    tracksProbe: 'ascii-case',
    verdict: 'deny',
  },
  // Canonical equivalence, which is not case at all: a case-sensitive APFS volume folds this row
  // and no other. Predicting it from the case probe is what went red there.
  {
    name: 'NFD vs NFC',
    pattern: 'caf\u00E9/**',
    canonical: 'caf\u00E9',
    variant: 'cafe\u0301',
    codePoint: 0x0301,
    tracksProbe: 'canonical-equivalence',
    verdict: 'deny',
  },
  // --- the controls ------------------------------------------------------------
  // Unicode keeps these two apart from `i` and so does every volume measured; a guard that denied
  // them would be folding by superstition rather than by the filesystem, and these rows catch it.
  {
    name: 'U+0131 DOTLESS I (kept apart)',
    pattern: 'infra/**',
    canonical: 'infra',
    variant: '\u0131nfra',
    codePoint: 0x0131,
    tracksProbe: 'nothing',
    verdict: 'allow',
  },
  {
    name: 'U+0130 DOTTED CAPITAL I (kept apart)',
    pattern: 'infra/**',
    canonical: 'infra',
    variant: '\u0130nfra',
    codePoint: 0x0130,
    tracksProbe: 'nothing',
    verdict: 'allow',
  },
  {
    name: 'a plainly different name (kept apart)',
    pattern: 'infra/**',
    canonical: 'infra',
    variant: 'infrastructure',
    tracksProbe: 'nothing',
    verdict: 'allow',
  },
];

/** The prediction: what the volume must do with a row, given what the three probes said. */
const volumeMerges = (probe: VolumeProbe): boolean => {
  if (probe === 'ascii-case') {
    return volumeFoldsCase;
  }
  if (probe === 'full-case-folding') {
    return volumeFoldsFully;
  }
  if (probe === 'canonical-equivalence') {
    return volumeNormalises;
  }
  return false;
};

describe('the fold against the volume it is folding for', () => {
  it.each(CASES)(
    '$name: $canonical vs $variant',
    ({ pattern, canonical, variant, codePoint, tracksProbe, verdict }) => {
      // A row is only a row if the two names differ and the variant still carries the code point
      // the row is named after: see the note on NFC above.
      expect(variant).not.toBe(canonical);
      if (codePoint !== undefined) {
        expect([...variant].map((character) => character.codePointAt(0))).toContain(codePoint);
      }

      const workspace = fs.mkdtempSync(path.join(root, 'ws-'));
      fs.writeFileSync(path.join(workspace, canonical), 'canonical');
      fs.writeFileSync(path.join(workspace, variant), 'PWNED');

      const collided =
        inodeOf(path.join(workspace, canonical)) === inodeOf(path.join(workspace, variant));
      // What the volume did, tied to the probe this row tracks. This is the assertion that says
      // which branch ran.
      expect(collided).toBe(volumeMerges(tracksProbe));
      if (collided) {
        // The harm itself: the protected file now holds the agent's bytes.
        expect(fs.readFileSync(path.join(workspace, canonical), 'utf8')).toBe('PWNED');
        expect(entriesOf(workspace)).toHaveLength(1);
      } else {
        expect(fs.readFileSync(path.join(workspace, canonical), 'utf8')).toBe('canonical');
      }

      // And what the guard answers — the same on every volume. Where the volume merged the two
      // names this is the safety property; where it kept them apart it is the false deny that buys
      // it, and the agent gets a reason string it can act on.
      const decision = guardWritePath(variant, {
        workspacePath: workspace,
        protectedPaths: [pattern],
        plannedProtectedPaths: [],
      });
      expect(decision.decision).toBe(verdict);
      if (verdict === 'deny') {
        expect(decision.reason).toContain(`matches the protected path "${pattern}"`);
      }
    },
  );

  /**
   * The characters that made the fold per segment, and it is a **class, not a character**: five
   * code points in the whole of Unicode fold to something containing `/`. U+FF0F FULLWIDTH SOLIDUS
   * is the one the review found; U+2100, U+2101, U+2105 and U+2106 are the four compatibility
   * abbreviations that do the same (`a/c`, `a/s`, `c/o`, `c/u`), and each of them was a whole-string
   * ALLOW before the pin. The volume folds none of them: every one is an ordinary entry inside its
   * directory with its name intact in `readdir`. A whole-string NFKC would have split such a name
   * into two segments, and `*.ts` — which may not cross a separator — would then answer `allow`
   * for a file the operator's glob covers. That is the only direction in which a wider fold can
   * fail open at all.
   */
  it.each([
    ['U+FF0F FULLWIDTH SOLIDUS', '\uFF0F'],
    ['U+2100 ACCOUNT OF', '\u2100'],
    ['U+2101 ADDRESSED TO THE SUBJECT', '\u2101'],
    ['U+2105 CARE OF', '\u2105'],
    ['U+2106 CADA UNA', '\u2106'],
  ])('%s stays inside one name, as the volume keeps it', (_name, character) => {
    const workspace = fs.mkdtempSync(path.join(root, 'ws-'));
    const name = `a${character}b.ts`;
    // The name a whole-string fold would have produced: a path, with a directory in it.
    const split = `a${character.normalize('NFKC').toLowerCase()}b.ts`;
    expect(split).toContain('/');
    fs.writeFileSync(path.join(workspace, name), 'PWNED');
    expect(entriesOf(workspace)).toEqual([name]);
    expect(fs.existsSync(path.join(workspace, split))).toBe(false);

    const config = { workspacePath: workspace, plannedProtectedPaths: [] as string[] };
    // It is a `.ts` file directly in the protected directory, so `*.ts` covers it.
    expect(guardWritePath(name, { ...config, protectedPaths: ['*.ts'] }).decision).toBe('deny');
    // And it is not the same file as the split spelling, which the guard does not pretend either.
    expect(guardWritePath(name, { ...config, protectedPaths: [split] }).decision).toBe('allow');
  });

  it('does not confuse a fullwidth solidus with the name it would split into', () => {
    const workspace = fs.mkdtempSync(path.join(root, 'ws-'));
    fs.writeFileSync(path.join(workspace, 'ab.ts'), 'canonical');
    fs.writeFileSync(path.join(workspace, 'a\uFF0Fb.ts'), 'PWNED');

    expect(inodeOf(path.join(workspace, 'ab.ts'))).not.toBe(
      inodeOf(path.join(workspace, 'a\uFF0Fb.ts')),
    );
    expect([...entriesOf(workspace)].sort()).toEqual(['a\uFF0Fb.ts', 'ab.ts'].sort());
    expect(fs.readFileSync(path.join(workspace, 'ab.ts'), 'utf8')).toBe('canonical');

    const config = { workspacePath: workspace, plannedProtectedPaths: [] as string[] };
    expect(guardWritePath('a\uFF0Fb.ts', { ...config, protectedPaths: ['ab.ts'] }).decision).toBe(
      'allow',
    );
  });
});
