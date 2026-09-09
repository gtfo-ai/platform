/** Conventional commits, enforced by lefthook (commit-msg) and CI (TD-019). */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Work packages are referenced in the subject: "feat(scope): WP-nn title".
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
};
