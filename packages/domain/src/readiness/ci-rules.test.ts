import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CI_REFERENCE_KEY,
  CI_RULES_NOTE_CODE,
  CI_RULES_SAMPLE_BRANCH,
  CI_RULES_WARNING_CODE,
  type CiRulesReading,
  ciRulesNotice,
  compileSafeCiRegex,
  evaluateCiExpression,
  evaluateCiRules,
  mergeRequestContextFor,
  pushContextFor,
} from './ci-rules.js';

const BRANCH = CI_RULES_SAMPLE_BRANCH;
const file = (value: unknown, path = '.gitlab-ci.yml'): CiRulesReading => ({
  kind: 'file',
  path,
  parsed: { ok: true, value },
});
const noticeFor = (value: unknown) =>
  ciRulesNotice({ reading: file(value), branch: BRANCH, defaultBranch: 'develop' });

/**
 * Autix's shape (`/Users/janmikes/www/autix/.gitlab-ci.yml`, read 2026-10-04), reduced to the rules
 * that decide and with `.default_rules` written out where the real file uses `!reference`: a WIP
 * and `Draft:` skip, the Composer build only for `^(feature|bugfix)/` source branches, the test jobs
 * on merge requests from those branches, on `develop` (manual) and `release/*`.
 */
const autixShape = (admit = 'feature|bugfix') => ({
  stages: ['build-deps', 'test', 'deploy'],
  variables: { APP_HOST: 'localhost:8083' },
  '.cache': { key: 'composer' },
  build_composer: {
    stage: 'build-deps',
    script: ['composer install'],
    rules: [
      { if: '$CI_COMMIT_MESSAGE =~ /^WIP/', when: 'manual' },
      { if: '$CI_MERGE_REQUEST_TITLE =~ /^Draft:/', when: 'manual' },
      { if: '$CI_COMMIT_BRANCH == "develop"', when: 'manual' },
      {
        if: `$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(${admit})\\//`,
        when: 'always',
      },
      { if: '$CI_COMMIT_TAG', when: 'always' },
    ],
  },
  codeception: {
    stage: 'test',
    needs: ['build_composer'],
    script: ['vendor/bin/codecept run'],
    rules: [
      { if: '$CI_COMMIT_MESSAGE =~ /^WIP/', when: 'manual' },
      { if: '$CI_MERGE_REQUEST_TITLE =~ /^Draft:/', when: 'manual' },
      {
        if: `$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(${admit})\\//`,
      },
      { if: '$CI_COMMIT_BRANCH == "develop"', when: 'manual' },
      { if: '$CI_COMMIT_BRANCH =~ /^release\\//', when: 'always' },
    ],
  },
  phpstan: {
    stage: 'test',
    script: ['vendor/bin/phpstan'],
    rules: [
      { if: `$CI_COMMIT_BRANCH =~ /^(${admit})\\//` },
      { if: '$CI_COMMIT_BRANCH =~ /^release\\//', when: 'always' },
    ],
  },
  deploy: {
    stage: 'deploy',
    script: ['./deploy'],
    only: ['develop', '/^release\\/.*$/'],
  },
});

describe('evaluateCiExpression (WP-143)', () => {
  const push = pushContextFor(BRANCH, 'main').variables;
  const mr = mergeRequestContextFor(BRANCH, 'main').variables;

  it.each([
    ['$CI_PIPELINE_SOURCE == "push"', push, true],
    ['$CI_PIPELINE_SOURCE == "merge_request_event"', push, false],
    ['$CI_PIPELINE_SOURCE != "push"', mr, true],
    ['$CI_COMMIT_BRANCH', push, true],
    ['$CI_COMMIT_BRANCH', mr, false],
    ['$CI_COMMIT_BRANCH == null', mr, true],
    ['$CI_COMMIT_TAG', push, false],
    ['$CI_COMMIT_BRANCH =~ /^agentic\\//', push, true],
    ['$CI_COMMIT_BRANCH !~ /^agentic\\//', push, false],
    ['$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(feature|bugfix)\\//', mr, false],
    // Backlog 486: the platform's merge request is a draft until Ready, so the context's title is.
    ['$CI_MERGE_REQUEST_TITLE =~ /^Draft:/', mr, true],
    [
      '$CI_MERGE_REQUEST_IID && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == $CI_DEFAULT_BRANCH',
      mr,
      true,
    ],
    ['$CI_COMMIT_BRANCH == "develop" || $CI_COMMIT_BRANCH =~ /^agentic/', push, true],
    [
      '($CI_COMMIT_BRANCH == "develop" || $CI_PIPELINE_SOURCE == "push") && $CI_COMMIT_TAG == null',
      push,
      true,
    ],
    ['$CI_COMMIT_REF_NAME =~ /AGENTIC/i', mr, true],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitLab's `${VAR}` spelling, as text.
    ['${CI_COMMIT_REF_SLUG} == "agentic-x-1"', push, true],
  ] as const)('%s → %s', (expression, variables, expected) => {
    expect(evaluateCiExpression(expression, variables).value).toBe(expected);
  });

  it.each([
    ['$DEPLOY_ENABLED == "true"', 'the variable $DEPLOY_ENABLED'],
    ['$CI_OPEN_MERGE_REQUESTS', 'the variable $CI_OPEN_MERGE_REQUESTS'],
    ['$CI_COMMIT_BRANCH =~ /(?<=a)b(?/', 'cannot compile'],
    ['$CI_COMMIT_BRANCH ==', 'cannot read'],
    ['$CI_COMMIT_BRANCH == "a" &&', 'cannot read'],
    ['$CI_COMMIT_BRANCH =~ "agentic"', 'not a /regular expression/'],
  ])('%s → unknown, naming %s', (expression, reason) => {
    const result = evaluateCiExpression(expression, push);
    expect(result.value).toBe('unknown');
    expect(result.why).toContain(reason);
  });

  it('decides an unknown operand away when the other side of && is false, and of || is true', () => {
    expect(evaluateCiExpression('$UNSET == "x" && $CI_COMMIT_TAG', push).value).toBe(false);
    expect(evaluateCiExpression('$UNSET == "x" || $CI_COMMIT_BRANCH', push).value).toBe(true);
  });

  it('never throws, whatever the text (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        const result = evaluateCiExpression(text, push);
        expect([true, false, 'unknown']).toContain(result.value);
      }),
    );
  });
});

describe('compileSafeCiRegex (WP-143 review round 1)', () => {
  it.each([
    '^(feature|bugfix)\\/',
    '^release\\/',
    '^WIP',
    '^Draft:',
    'AGENTIC',
    '^[a-z0-9-]+$',
    '^v\\d+\\.\\d+(\\.\\d+)?$',
    '.*-hotfix$',
    '^(?:main|master)$',
  ])('compiles the ordinary rule pattern %s', (source) => {
    expect(compileSafeCiRegex(source, '')).not.toBeNull();
  });

  it.each([
    ['nested quantified group', '^(.*)*z$'],
    ['quantified group', '^(a|aa)+$'],
    ['quantified group with a bound', '(ab){2,}'],
    ['double quantifier', 'a**'],
    ['lazy quantifier', 'a+?'],
    ['backreference', '(a)\\1'],
    ['lookahead', '^(?=a)'],
    ['named group', '(?<x>a)'],
    ['too long', 'a'.repeat(201)],
    ['unknown flag', 'a'],
  ])('refuses a %s', (_name, source) => {
    expect(compileSafeCiRegex(source, _name === 'unknown flag' ? 'g' : '')).toBeNull();
  });

  it('answers a catastrophic pattern as unknown, quickly, and the notice is a note', () => {
    const evil = `^${'(.*)*'.repeat(12)}z$`;
    const started = performance.now();
    const expression = evaluateCiExpression(`$CI_DEFAULT_BRANCH =~ /${evil}/`, {
      CI_DEFAULT_BRANCH: 'a'.repeat(60),
    });
    const notice = noticeFor({
      test: { script: ['x'], rules: [{ if: `$CI_COMMIT_BRANCH =~ /${evil}/` }] },
    });
    const ref = noticeFor({ test: { script: ['x'], only: [`/${evil}/`] } });
    expect(performance.now() - started).toBeLessThan(200);
    expect(expression.value).toBe('unknown');
    expect(expression.why).toContain('outside the safe subset');
    expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
    expect(ref?.code).toBe(CI_RULES_NOTE_CODE);
  });
});

describe('ciRulesNotice (WP-143)', () => {
  it('warns on Autix’s shape: feature|bugfix branches only, and names the rule and the fix', () => {
    const notice = noticeFor(autixShape());
    expect(notice?.code).toBe(CI_RULES_WARNING_CODE);
    expect(notice?.severity).toBe('warning');
    expect(notice?.message).toContain('a push pipeline runs no test job (stage test)');
    // Backlog 486: the merge-request pipeline is a draft's, and Autix's `Draft:` rule decides it.
    expect(notice?.message).toContain(
      'a draft merge-request pipeline runs no test job (stage test) — first, "codeception" rules[1] if: "$CI_MERGE_REQUEST_TITLE =~ /^Draft:/" (when: manual)',
    );
    expect(notice?.message).toContain('including a draft');
    // The rule that kept the branch out, quoted, and the fix.
    expect(notice?.message).toContain('"codeception" rules[2]');
    expect(notice?.message).toContain('(feature|bugfix)');
    expect(notice?.message).toContain('admit agentic/');
  });

  it('says nothing once agentic/ is admitted', () => {
    expect(noticeFor(autixShape('feature|bugfix|agentic'))).toBeNull();
  });

  it('says nothing for a job with no rules, which a branch pipeline runs', () => {
    expect(noticeFor({ test: { script: ['make test'] } })).toBeNull();
    const evaluation = evaluateCiRules({
      document: { unit: { stage: 'test', script: ['x'] } },
      branch: BRANCH,
      defaultBranch: 'main',
    });
    expect(evaluation.kind === 'evaluated' && evaluation.contexts[0].jobs[0]?.result.verdict).toBe(
      'runs',
    );
    expect(evaluation.kind === 'evaluated' && evaluation.contexts[1].jobs[0]?.result.verdict).toBe(
      'skipped',
    );
  });

  it('warns when workflow:rules creates no pipeline for the branch in either context', () => {
    const notice = noticeFor({
      workflow: {
        rules: [
          { if: '$CI_COMMIT_BRANCH =~ /^(feature|bugfix)\\//' },
          { if: '$CI_MERGE_REQUEST_SOURCE_BRANCH_NAME =~ /^(feature|bugfix)\\//' },
          { when: 'never' },
        ],
      },
      test: { script: ['make test'] },
    });
    expect(notice?.code).toBe(CI_RULES_WARNING_CODE);
    expect(notice?.message).toContain('a push pipeline is not created');
  });

  it('counts every job when the file has none in stage test, and warns only when none runs', () => {
    expect(noticeFor({ lint: { stage: 'check', script: ['x'], only: ['main'] } })?.code).toBe(
      CI_RULES_WARNING_CODE,
    );
    expect(noticeFor({ lint: { stage: 'check', script: ['x'] } })).toBeNull();
  });

  it('reads only/except: merge_requests runs in the merge-request pipeline, except: branches skips', () => {
    expect(noticeFor({ test: { script: ['x'], only: ['merge_requests'] } })).toBeNull();
    expect(noticeFor({ test: { script: ['x'], except: ['branches'] } })?.code).toBe(
      CI_RULES_WARNING_CODE,
    );
  });

  it('treats when: manual as not running a test', () => {
    expect(noticeFor({ test: { script: ['x'], when: 'manual' } })?.code).toBe(
      CI_RULES_WARNING_CODE,
    );
  });

  it('decides a job whose unknown rule could only skip it as well', () => {
    const notice = noticeFor({
      test: {
        script: ['x'],
        rules: [{ if: '$NIGHTLY == "1"', when: 'never' }, { if: '$CI_COMMIT_BRANCH == "develop"' }],
      },
    });
    expect(notice?.code).toBe(CI_RULES_WARNING_CODE);
  });

  describe('canaries: what it cannot see is a note, never a warning', () => {
    it('an include: anywhere → no warning, a note naming the include', () => {
      const notice = noticeFor({ ...autixShape(), include: [{ local: 'ci/tests.yml' }] });
      expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
      expect(notice?.severity).toBe('note');
      expect(notice?.message).toContain('include:');
      expect(notice?.message).toContain('ci/tests.yml');
    });

    it.each([
      ['extends', { extends: '.base' }, 'uses extends'],
      [
        '!reference',
        { rules: [{ [CI_REFERENCE_KEY]: ['.default_rules', 'rules'] }] },
        '!reference',
      ],
      [
        'changes:',
        { rules: [{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"', changes: ['**/*.php'] }] },
        'changes:',
      ],
      ['exists:', { rules: [{ exists: ['composer.json'] }] }, 'exists:'],
      ['an unset variable', { rules: [{ if: '$RUN_TESTS == "1"' }] }, '$RUN_TESTS'],
      ['trigger:', { trigger: { project: 'a/b' } }, 'trigger job'],
    ])('%s on the only test job → a note, not a warning', (_name, job, reason) => {
      const notice = noticeFor({ test: { script: ['x'], ...job } });
      expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
      expect(notice?.message).toContain(reason);
    });

    it('an external CI path → not read', () => {
      const notice = ciRulesNotice({
        reading: { kind: 'external', location: 'ci/config.yml@group/ci' },
        branch: BRANCH,
        defaultBranch: 'main',
      });
      expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
      expect(notice?.message).toContain('were not read');
      expect(notice?.message).toContain('ci/config.yml@group/ci');
    });

    it('an unparseable YAML → a note, never a throw', () => {
      const notice = ciRulesNotice({
        reading: {
          kind: 'file',
          path: '.gitlab-ci.yml',
          parsed: { ok: false, reason: 'bad indentation at line 3' },
        },
        branch: BRANCH,
        defaultBranch: 'main',
      });
      expect(notice?.code).toBe(CI_RULES_NOTE_CODE);
      expect(notice?.message).toContain('could not be parsed');
    });

    it('a document of any shape never throws and never warns on an unknown counted job (property)', () => {
      const leaf = fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.constant('$CI_COMMIT_BRANCH == "main"'),
        fc.constant('$UNKNOWN'),
        fc.integer(),
        fc.constant(null),
      );
      const value = fc.letrec((tie) => ({
        node: fc.oneof(
          { depthSize: 'small' },
          leaf,
          fc.array(tie('node'), { maxLength: 3 }),
          fc.dictionary(
            fc.constantFrom(
              'rules',
              'if',
              'when',
              'only',
              'except',
              'stage',
              'changes',
              'refs',
              'x',
            ),
            tie('node'),
            { maxKeys: 3 },
          ),
        ),
      })).node;
      fc.assert(
        fc.property(
          fc.dictionary(fc.string({ maxLength: 8 }), value, { maxKeys: 4 }),
          (document) => {
            const notice = noticeFor(document);
            if (notice?.code !== CI_RULES_WARNING_CODE) return;
            const evaluation = evaluateCiRules({
              document,
              branch: BRANCH,
              defaultBranch: 'develop',
            });
            if (evaluation.kind !== 'evaluated') throw new Error('a warning without an evaluation');
            for (const context of evaluation.contexts) {
              expect(context.workflow?.verdict).not.toBe('unknown');
              for (const job of context.jobs) {
                if (!evaluation.countsTestStage || job.stage === 'test') {
                  expect(job.result.verdict).toBe('skipped');
                }
              }
            }
          },
        ),
      );
    });
  });

  it('bounds a quoted job name and the whole message', () => {
    const name = 'x'.repeat(5_000);
    const notice = noticeFor({ [name]: { script: ['x'], extends: '.a' } });
    expect(notice?.message.length).toBeLessThanOrEqual(1_200);
    expect(notice?.message).not.toContain('x'.repeat(200));
  });

  it('says nothing when the repository has no CI file', () => {
    expect(
      ciRulesNotice({ reading: { kind: 'absent' }, branch: BRANCH, defaultBranch: 'main' }),
    ).toBeNull();
  });
});
