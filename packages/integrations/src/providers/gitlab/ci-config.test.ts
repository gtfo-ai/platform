import { describe, expect, it } from 'vitest';
import { ciConfigLocationOf, GITLAB_DEFAULT_CI_CONFIG_PATH } from './ci-config.js';

describe('GitLab ci_config_path → where the CI configuration lives (WP-139)', () => {
  it('reads an empty or null path as the default file, and an absent key as unknown', () => {
    expect(ciConfigLocationOf('')).toEqual({ kind: 'repository', path: '.gitlab-ci.yml' });
    expect(ciConfigLocationOf(null)).toEqual({ kind: 'repository', path: '.gitlab-ci.yml' });
    expect(ciConfigLocationOf('   ')).toEqual({
      kind: 'repository',
      path: GITLAB_DEFAULT_CI_CONFIG_PATH,
    });
    // Absent is the entity's answer to a token that may not read the code: never "the default".
    expect(ciConfigLocationOf(undefined)).toMatchObject({ kind: 'unknown' });
  });

  it('keeps a repository-relative custom path as given', () => {
    expect(ciConfigLocationOf('deploy/.gitlab-ci.yml')).toEqual({
      kind: 'repository',
      path: 'deploy/.gitlab-ci.yml',
    });
    expect(ciConfigLocationOf('my/path/.my-custom-file.yml')).toEqual({
      kind: 'repository',
      path: 'my/path/.my-custom-file.yml',
    });
  });

  it('counts another project’s file and a URL as external — GitLab’s documented forms', () => {
    for (const external of [
      '.gitlab-ci.yml@namespace/another-project',
      'my/path/.my-custom-file.yml@namespace/subgroup/another-project',
      'my/path/.my-custom-file.yml@namespace/subgroup1/subgroup2/another-project:refname',
      'http://example.com/generate/ci/config.yml',
      'https://ci.example.test/config.yml',
    ]) {
      expect(ciConfigLocationOf(external), external).toEqual({
        kind: 'external',
        location: external,
      });
    }
  });

  it('refuses a path it would not hand the mirror, as unknown rather than as no CI', () => {
    for (const bad of [
      '/etc/passwd',
      '../outside.yml',
      'a/../../b.yml',
      './ci.yml',
      'a//b.yml',
      'deploy/',
      'x'.repeat(256),
      'ci\u0000.yml',
      'ci\n.yml',
    ]) {
      expect(ciConfigLocationOf(bad).kind, JSON.stringify(bad)).toBe('unknown');
    }
  });
});
