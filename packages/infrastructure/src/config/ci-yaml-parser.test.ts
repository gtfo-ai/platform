import {
  CI_REFERENCE_KEY,
  CI_RULES_NOTE_CODE,
  CI_RULES_SAMPLE_BRANCH,
  CI_RULES_WARNING_CODE,
  ciRulesNotice,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { yamlCiParser } from './ci-yaml-parser.js';

/**
 * Autix's shape as YAML (`/Users/janmikes/www/autix/.gitlab-ci.yml`, read 2026-10-04 — its
 * variables, images and scripts left out, and none of its values copied): anchors merged into jobs
 * with `<<`, a WIP and `Draft:` skip, the Composer build and the tests only for `^(feature|bugfix)/`
 * merge-request source branches, `develop` manual, `release/*` always.
 */
const AUTIX_SHAPE = (admit: string, rulesOf = ''): string => `
stages:
    - build-deps
    - test
    - deploy

.cache-composer: &cache-composer
    key: composer
    paths: [vendor/]

.php_job: &php_job
    stage: test
    cache:
        -   <<: *cache-composer
            policy: pull

.default_rules:
    rules:
        -   if: '$CI_COMMIT_MESSAGE =~ /^WIP/'
            when: manual
        -   if: '$CI_MERGE_REQUEST_TITLE =~ /^Draft:/'
            when: manual

build_composer:
    stage: build-deps
    script: [composer install]
    rules:
        -   if: '$CI_COMMIT_BRANCH == "develop"'
            when: manual
        -   if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(${admit})\\//'
            when: always

codeception:
    <<: *php_job
    needs: [build_composer]
    script: [vendor/bin/codecept run]
    rules:
${rulesOf}        -   if: '$CI_MERGE_REQUEST_TITLE =~ /^Draft:/'
            when: manual
        -   if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(${admit})\\//'
        -   if: '$CI_COMMIT_BRANCH == "develop"'
            when: manual
        -   if: '$CI_COMMIT_BRANCH =~ /^release\\//'
            when: always

deploy:
    stage: deploy
    script: [./deploy]
    only: [develop]
`;

const noticeOf = (text: string) => {
  const parsed = yamlCiParser.parse(text);
  return ciRulesNotice({
    reading: { kind: 'file', path: '.gitlab-ci.yml', parsed },
    branch: CI_RULES_SAMPLE_BRANCH,
    defaultBranch: 'develop',
  });
};

describe('yamlCiParser (WP-143)', () => {
  it('merges a << template into the job, so its stage is read', () => {
    const parsed = yamlCiParser.parse(AUTIX_SHAPE('feature|bugfix'));
    expect(parsed.ok).toBe(true);
    const value = (parsed as { value: Record<string, Record<string, unknown>> }).value;
    expect(value.codeception?.stage).toBe('test');
  });

  it('keeps a !reference as the marker the evaluator reads as unknown, never resolved', () => {
    const parsed = yamlCiParser.parse('job:\n  rules:\n    - !reference [.default_rules, rules]\n');
    expect(parsed).toEqual({
      ok: true,
      value: { job: { rules: [{ [CI_REFERENCE_KEY]: ['.default_rules', 'rules'] }] } },
    });
  });

  it('refuses any other tag, and an unparseable document, with a position and no source line', () => {
    const tagged = yamlCiParser.parse('job: !custom secret-looking-value\n');
    expect(tagged.ok).toBe(false);
    const broken = yamlCiParser.parse('job:\n  rules: [\n');
    expect(broken.ok).toBe(false);
    expect(broken.ok ? '' : broken.reason).toMatch(/line \d+/);
  });

  it('refuses a document that expands past the alias ceiling', () => {
    const anchors = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let level = 1; level < 8; level += 1) {
      anchors.push(
        `${String.fromCharCode(97 + level)}: &${String.fromCharCode(97 + level)} [${Array(10)
          .fill(`*${String.fromCharCode(96 + level)}`)
          .join(', ')}]`,
      );
    }
    expect(yamlCiParser.parse(`${anchors.join('\n')}\n`).ok).toBe(false);
  });
});

describe('yamlCiParser against an expanding document (WP-143 review round 1)', () => {
  /** Level i is a mapping merging nine copies of level i-1: 9^levels nodes in a few hundred bytes. */
  const chain = (levels: number): string => {
    const lines = ['l0: &l0 {k: v}'];
    for (let level = 1; level <= levels; level += 1) {
      lines.push(
        `l${level}: &l${level}\n  <<: [${Array(9)
          .fill(`*l${level - 1}`)
          .join(', ')}]\n  k${level}: v`,
      );
    }
    return `${lines.join('\n')}\n`;
  };

  it('refuses a <<-over-aliases chain by its expanded size, quickly, and the notice is a note', () => {
    const started = performance.now();
    const parsed = yamlCiParser.parse(chain(20));
    expect(performance.now() - started).toBeLessThan(500);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.reason).toContain('expands to more than');
    const notice = ciRulesNotice({
      reading: { kind: 'file', path: '.gitlab-ci.yml', parsed },
      branch: CI_RULES_SAMPLE_BRANCH,
      defaultBranch: 'main',
    });
    expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
  });

  it('still reads a short chain of the same shape', () => {
    expect(yamlCiParser.parse(chain(2)).ok).toBe(true);
  });
});

describe('the CI-rules notice over Autix’s shape, parsed (WP-143)', () => {
  it('warns: the tests run only for feature|bugfix source branches, and names that rule', () => {
    const notice = noticeOf(AUTIX_SHAPE('feature|bugfix'));
    expect(notice?.code).toBe(CI_RULES_WARNING_CODE);
    expect(notice?.message).toContain('"codeception" rules[1]');
    expect(notice?.message).toContain('feature|bugfix');
    expect(notice?.message).toContain('admit agentic/');
  });

  /**
   * Backlog 486: the platform's merge request is a draft until Ready, so admitting `agentic/` means
   * admitting an `agentic/` **draft** too — here an exemption ahead of the `Draft:` rule, the change
   * the product owner is making to Autix.
   */
  const AGENTIC_DRAFTS =
    "        -   if: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^agentic\\//'\n            when: always\n";

  it('says nothing once agentic/ is admitted', () => {
    expect(noticeOf(AUTIX_SHAPE('feature|bugfix|agentic', AGENTIC_DRAFTS))).toBeNull();
  });

  it('warns while an agentic/ draft is still held at manual by the Draft: rule (backlog 486)', () => {
    const held = noticeOf(AUTIX_SHAPE('feature|bugfix|agentic'));
    expect(held?.code).toBe(CI_RULES_WARNING_CODE);
    expect(held?.message).toContain(
      'a draft merge-request pipeline runs no test job (stage test) — first, "codeception" rules[0] if: "$CI_MERGE_REQUEST_TITLE =~ /^Draft:/" (when: manual)',
    );
  });

  it('gives only a note when the rules come through !reference, as Autix’s real file does', () => {
    const notice = noticeOf(
      AUTIX_SHAPE('feature|bugfix', '        - !reference [ .default_rules, rules ]\n'),
    );
    expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(notice?.message).toContain('!reference');
  });

  it('gives a note for an include:, naming it', () => {
    const notice = noticeOf(`include:\n  - local: ci/tests.yml\n${AUTIX_SHAPE('feature|bugfix')}`);
    expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(notice?.message).toContain('ci/tests.yml');
  });

  it('gives a note, never a throw, for an unparseable file', () => {
    const notice = noticeOf('stages: [build\n');
    expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(notice?.message).toContain('could not be parsed');
  });
});
