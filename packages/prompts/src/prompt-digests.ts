/**
 * The prompt-version census: a change to a role's `prompt.md` must come with a new
 * `ROLE_PROMPT_VERSIONS` entry (WP-176 criterion (2), CLAUDE.md: *"changing a prompt requires eval
 * cases and bumps `ROLE_PROMPT_VERSIONS`"*).
 *
 * `promptVersionOf` in `@platform/domain` already appends a digest of the assembled system prompt
 * to `runs.prompt_version`, so a forgotten bump is **visible** in the audit after the fact. This is
 * the check before the fact: {@link ROLE_PROMPT_DIGESTS} records, per role, the SHA-256 of the
 * `prompt.md` each declared version shipped, and {@link promptVersionCensus} refuses a tree where
 * the file no longer matches its declared version's digest. So editing a prompt fails the build
 * until somebody bumps the version **and** records the new digest under it — two lines a reviewer
 * reads beside the prompt's diff.
 *
 * ## What it cannot see
 *
 * Overwriting the current version's recorded digest in place, instead of adding a new version,
 * passes. The table is append-only by review, not by mechanism: the earlier versions' files are no
 * longer on disk, so nothing here can recompute their digests. The census narrows a forgotten bump
 * to a deliberate rewrite of a line labelled with an old version number, which is what a reviewer
 * sees in the diff.
 *
 * The history starts at WP-176. A version shipped before it has no row; each role's row begins with
 * the version it had at `9661c230`, digested from that tree.
 */
import { createHash } from 'node:crypto';
import type { AgentRole } from '@platform/contracts';

/**
 * SHA-256 of a prompt file's text, hex. Line endings are normalised first, so a checkout with
 * `core.autocrlf` does not read as an edit.
 */
export const promptFileDigest = (text: string): string =>
  createHash('sha256').update(text.replaceAll('\r\n', '\n'), 'utf8').digest('hex');

/** Per role, version → digest of the `prompt.md` that version shipped. Append a row; never rewrite one. */
export const ROLE_PROMPT_DIGESTS = {
  triager: {
    '2': '70e21ad97c1707ef323ab562ea38501941c2a9ff71d718cb5e9718389f082bb1',
    '3': 'db457d10176360deaa85ceb296f267123d1dab4b92e2cfde997cd8474e8b03ad',
    '4': 'f3b96d5acabdadaac6745f87656f237952a242be51675bcf4dbc0ae3f4819b5a',
  },
  product_manager: {
    '3': '9e695f0fb571a8f5534bb12d3d415e0476051a55712bcda6ad66e7dfeefeb330',
    '4': 'f2a28358bfeb0ac68b494fde8cad45d67dca184a71f65cbd4d686c92c2af3630',
    '5': '101818b5510da737226e00e04aea2fd3f372296cb32f5954094bea3008c3c784',
  },
  investigator: {
    '2': 'da33815907aa3023c97a7c5e4e7ab1d322568a96181e6bba02e6448f805c556a',
    '3': '84b3f1192f66ab351dad79edf9e496532c4cd9d19192295d1385a471d8c49eb1',
    '4': '98e97b5642c1875b3a5164f87fdfe2b10d6275be790a144dc9563be635e908df',
  },
  architect: {
    '5': '5410469388f8a8790ebcffcd464fd436f3dd3cbb046d0509ed3c85158096d052',
    '6': '3ed48266e3ce4b19290c04e792be567fdebe1e6b3ca772b8a3a2ac6636ccf682',
    '7': '401a6e261ffd76ac116d9e02e08c1ee2809c9cd7ed2ba955615e6794cd74ed4d',
  },
  developer: {
    '6': '2fb8c7327217fe080b4255b4f45e8fe9b9bbbf11b275aaa2cffd66cf1c7d8994',
    '7': 'ff00c9782153b35580d87557383c826d7a680a5a5c00fdfbedca442c9c571b72',
    '8': 'fbded4316218ae25a07626762f2d1e16a9f7eb23a928a5c6c6999c5b0890a891',
  },
  reviewer: {
    '4': 'dfeab32f0cc79abc01ee1a3e255a2c31f9c29bbb22777cd56e9a67703d8aebcd',
    '5': '2f1ca8473ddbb2b0bc8c2ce2aca2ac71cb0f31c4f6ec393ab8d5b167ab143cf6',
    '6': 'f0ccc9eb927e6188296724f18e3a5826f33d08eb7af456c168376b2b4b783a2a',
  },
  acceptance_tester: {
    '1': 'd6d761759c67667e2c091a6fd8207bab0877cea17687d641135f065554541f20',
    '2': 'b128e088c108aad21eff97def85dd57121f08ba8d7e95adfdfaa67a685bf1014',
    '3': '42a767abbd6ce1f7162bb9b7cb9e95236f38c9aac355e141df97053967dddcad',
  },
  facilitator: {
    '1': '64172a18088f055d08afb0e20c2aacf42bbbaf574a1c24eeae064992fa7a7390',
    '2': 'c39c148c6a18997d38fa780d5710b889db1dcfd00cece3b1ab13dcb514c7c8e7',
    '3': 'e0b6225d92d38fb03ae375a5cebb914800fe9d135b786a99472e38e9c2ddc60b',
  },
  librarian: {
    '2': 'fbbdadbd653e8ecaf3a30bbe234eafdbcf4524c2cd911b9d1391b8706663a908',
    '3': 'b9d2ad0b2fb430c9b307d4ca846a55b0ca5d0eed1c23522f093e70b189d3e13e',
    '4': 'd36db191d642d7c399b69b5a29f602558c60bf43d14fb59f4d88384864beebcf',
  },
  discovery: {
    '6': '8e152d1834529a1a6a3dbc42906bc6d92925ab4a8cff24b9cdb11b0c9a34ffc2',
    '7': 'c57031de48514cf8d484fb5acfc356af69bc73105e87a3cd1c447d041c13070c',
    '8': '2cf5868695b7db67c8c1b5ca7ddca641e644fb9bceb6799ac699ab56f3f50fcf',
  },
  ask: {
    '1': '96614f76e4c0a537735a98140eeff73f83e6515d0670531b23f28f599fbbdb56',
    '2': 'e838b99068c0f4f12adfc260cb382ec53fee29d38cb3cfb9fc9c1bbddd09b12a',
    '3': '8281516dea0cafc3d3974297ee2f3d80fab461d06ff2c9a0b23a715a0f883b50',
  },
  historian: {
    '1': '8fd962ad1c6362ac9d0a602065351c9c3a6594cbbd7262e0a444794969c31047',
    '2': '9a9498ca22ba7a8228a156599fabe655baeebfeaf825dea11726815c61111345',
    '3': 'ad045386cd1ff58469399e09d98c9ff2d5acd6baff2cf788250cb7fcfb9f8328',
  },
} as const satisfies Record<AgentRole, Readonly<Record<string, string>>>;

const byVersion = (left: string, right: string): number =>
  left.localeCompare(right, 'en', { numeric: true });

/**
 * Every way the shipped prompts disagree with their declared versions, one sentence each; empty
 * when they agree. Pure, so that each refusal is asserted against a planted tree rather than only
 * written (PROGRESS backlog 254).
 */
export const promptVersionCensus = (
  versions: Readonly<Record<string, string>>,
  texts: Readonly<Record<string, string>>,
  history: Readonly<Record<string, Readonly<Record<string, string>>>>,
): readonly string[] => {
  const problems: string[] = [];
  for (const role of Object.keys(texts).sort()) {
    const version = versions[role];
    const recorded = history[role] ?? {};
    const text = texts[role] ?? '';
    if (version === undefined) {
      problems.push(`${role} has a prompt and no declared version`);
      continue;
    }
    const digest = promptFileDigest(text);
    const expected = recorded[version];
    if (expected === undefined) {
      problems.push(
        `${role}@${version} has no recorded digest: add '${version}': '${digest}' to ROLE_PROMPT_DIGESTS.${role}`,
      );
    } else if (expected !== digest) {
      const older = Object.keys(recorded).find((key) => recorded[key] === digest);
      problems.push(
        older === undefined
          ? `${role}'s prompt.md changed since ${role}@${version} was recorded: bump ROLE_PROMPT_VERSIONS.${role} and record '${digest}' under the new version`
          : `${role}'s prompt.md is ${role}@${older}'s text, but the declared version is ${version}`,
      );
    }
    const newest = Object.keys(recorded).sort(byVersion).at(-1);
    if (newest !== undefined && newest !== version) {
      problems.push(`${role}@${version} is not the newest recorded version (${newest} is)`);
    }
    const digests = Object.values(recorded);
    if (new Set(digests).size !== digests.length) {
      problems.push(`${role} records one digest under two versions`);
    }
  }
  return problems;
};
