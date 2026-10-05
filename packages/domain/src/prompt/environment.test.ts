/**
 * The workspace statement is a transcription of two Dockerfiles, and these tests are what keep it
 * one (PROGRESS backlog 475): a package added to the image, or removed from it, fails here until
 * {@link RUN_IMAGE_CONTENTS} and the prompt text say so — in both directions, because a prompt that
 * claims a tool the image lacks costs a run exactly what the missing sentence did.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ENVIRONMENT_PROMPT,
  RUN_IMAGE_ABSENT_TOOLCHAINS,
  RUN_IMAGE_CONTENTS,
} from './environment.js';

const dockerfile = (name: string): string =>
  readFileSync(new URL(`../../../../docker/${name}`, import.meta.url), 'utf8');

/** A Dockerfile's logical lines: `\` continuations joined, comments dropped. */
const logicalLines = (text: string): readonly string[] =>
  text
    .replaceAll(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

/** `docker/base.Dockerfile`'s `apt-get install` packages, in order. */
const basePackages = (text = dockerfile('base.Dockerfile')): readonly string[] => {
  const install = logicalLines(text).find((line) => line.includes('apt-get install'));
  const words = (install ?? '').split(/\s+/);
  const from = words.indexOf('--no-install-recommends') + 1;
  const to = words.indexOf('&&', from);
  return words.slice(from, to === -1 ? undefined : to);
};

/** The Node major the base image's `NODE_IMAGE` argument names (`node:24-…@sha256:…`). */
const nodeMajor = (): number | null => {
  const match = /ARG NODE_IMAGE=node:(\d+)-/.exec(dockerfile('base.Dockerfile'));
  return match === null ? null : Number(match[1]);
};

/** The binaries the final stage of `docker/runtime.Dockerfile` copies out of `tools`. */
const runtimeClis = (text = dockerfile('runtime.Dockerfile')): readonly string[] => {
  const copy = logicalLines(text).find((line) => line.startsWith('COPY --from=tools'));
  return (copy ?? '')
    .split(/\s+/)
    .filter((word) => word.startsWith('/out/'))
    .map((word) => word.slice('/out/'.length));
};

/** `npm install -g` packages in `docker/runtime.Dockerfile`, without their version. */
const runtimeNpmGlobals = (): readonly string[] =>
  logicalLines(dockerfile('runtime.Dockerfile'))
    .filter((line) => line.includes('npm install -g'))
    .flatMap((line) => [...line.matchAll(/"(@?[^@"\s]+)@\$\{[A-Z_]+\}"/g)].map((m) => m[1] ?? ''));

describe('the run image the prompt describes (backlog 475)', () => {
  it('is the image the two Dockerfiles build — both directions', () => {
    expect(basePackages()).toEqual(RUN_IMAGE_CONTENTS.osPackages);
    expect(nodeMajor()).toBe(RUN_IMAGE_CONTENTS.nodeMajor);
    expect(runtimeClis()).toEqual(RUN_IMAGE_CONTENTS.clis);
    expect(runtimeNpmGlobals()).toEqual(RUN_IMAGE_CONTENTS.npmGlobals);
    expect(dockerfile('runtime.Dockerfile')).toContain(
      `org.opencontainers.image.title="${RUN_IMAGE_CONTENTS.image}"`,
    );
  });

  it('sees a package or a CLI added to the image, so the first test cannot pass vacuously', () => {
    const base = dockerfile('base.Dockerfile');
    const withPhp = base.replace('      jq \\\n', '      jq \\\n      php \\\n');
    expect(withPhp).not.toBe(base);
    expect(basePackages(withPhp)).toContain('php');
    expect(basePackages(withPhp)).not.toEqual(RUN_IMAGE_CONTENTS.osPackages);
    const runtime = dockerfile('runtime.Dockerfile');
    const withComposer = runtime.replace(
      '/out/acli /usr/local/bin/',
      '/out/acli /out/composer /usr/local/bin/',
    );
    expect(withComposer).not.toBe(runtime);
    expect(runtimeClis(withComposer)).toContain('composer');
  });

  it.each(Object.entries(ENVIRONMENT_PROMPT))('%s: names every tool the image has', (_, text) => {
    expect(text).toContain(`Node.js ${String(RUN_IMAGE_CONTENTS.nodeMajor)}`);
    expect(text).toContain(`\`${RUN_IMAGE_CONTENTS.image}\``);
    for (const name of [
      ...RUN_IMAGE_CONTENTS.osPackages,
      ...RUN_IMAGE_CONTENTS.clis,
      ...RUN_IMAGE_CONTENTS.npmGlobals,
    ]) {
      expect(text, name).toContain(`\`${name}\``);
    }
  });

  it.each(Object.entries(ENVIRONMENT_PROMPT))(
    '%s: names the toolchains it lacks and says not to reverse-engineer them',
    (_, text) => {
      const flat = text.replaceAll(/\s+/g, ' ');
      for (const absent of RUN_IMAGE_ABSENT_TOOLCHAINS) {
        expect(flat, absent).toContain(`no ${absent.replace(/^a /, '')}`);
      }
      expect(flat).toContain('Nothing else is installed');
      expect(flat).toContain('do not reverse-engineer');
    },
  );

  it('differs by mode only in what the missing toolchain means', () => {
    expect(ENVIRONMENT_PROMPT.local.replaceAll(/\s+/g, ' ')).toContain(
      "the project's CI pipeline on the merge request",
    );
    expect(ENVIRONMENT_PROMPT.ci).toContain('(see *Verification*)');
    expect(ENVIRONMENT_PROMPT.ci).toContain('written by hand');
    expect(ENVIRONMENT_PROMPT.local.split('\n2.')[0]).toBe(ENVIRONMENT_PROMPT.ci.split('\n2.')[0]);
  });
});
