#!/usr/bin/env node
/**
 * **Has this push to `main` already been verified on its pull request?** (CI speed, 2026-11-26.)
 *
 * `main` moves only by fast-forwarding to the head of a pull request whose CI is green, so a push to
 * `main` carries a commit that `ci.yml` and `docker-checks.yml` have already run on. The `pull_request`
 * run tested GitHub's merge of that head into `main` as it was then; that base is an ancestor of the
 * old `main`, and the old `main` is an ancestor of the new head on a fast-forward, so the merge's tree
 * **is** the head's tree — the push run tests the same bytes again. It cost the same seventeen and
 * up to ten jobs as a pull request's run, on an organisation that may run twenty at once, and it was
 * a third of all runs: the next pull request waited behind it.
 *
 * So the push run is skipped, but **only on positive proof**. Every rule below must hold, and
 * anything else runs everything: an API error, a missing token, a run still in progress, a
 * cancelled or failed run, a force push, a commit with no pull request into `main`, or a pull
 * request into another branch. A "skipped" check reads as a pass, so the default must be to run:
 *
 *  1. the event is a `push` to `refs/heads/main`, not forced, and its `after` is `GITHUB_SHA`;
 *  2. the **newest** run of **this workflow file**, event `pull_request`, with `head_sha` equal to the
 *     pushed commit, is `completed` with conclusion `success` — a later red run is not outvoted by an
 *     earlier green one;
 *  3. that run **recorded that it tested the head's own tree**: its step {@link TREE_STEP} succeeded.
 *     A pull request's run tests GitHub's merge of the head into the base *as the base was then*,
 *     which is the head's tree only when that base was an ancestor of the head — not after `main`
 *     was rewound, nor for a pull request retargeted after its run (review of #200). The step runs
 *     only when `HEAD^{tree}` equals the head's tree, so a skipped or absent step is no proof;
 *  4. the commit is the head of a pull request whose base is `main`, and none with that head targets
 *     another branch. `GET /repos/{repo}/commits/{sha}/pulls` still named #194 after its merge
 *     (measured; a workflow run's own `pull_requests` list is empty by then). It is a second guard;
 *     rule 3 is the one about the tree.
 *
 *     node scripts/main-push-verified.mjs --workflow .github/workflows/ci.yml [--github-output]
 *
 * Prints the reason and writes `verified=true|false`. It exits 0 whenever it could decide, including
 * "not verified" — the caller runs everything then — and 2 on a usage error.
 *
 * Plain JavaScript (no dependency, no install) so a job can run it right after `setup-node`. Its test
 * tier is `scripts/main-push-verified.test.ts`, which also holds the two workflows that call it.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { isProgram } from './is-program.mjs';

/** The step a pull request run of each workflow has only when it tested the head's own tree. */
export const TREE_STEP = "the tested tree is the head's tree";

/** The newest `pull_request` run of `workflow` at `sha`, or undefined. */
export const newestRun = (runs, sha, workflow) =>
  runs
    .filter(
      (run) => run?.event === 'pull_request' && run?.head_sha === sha && run?.path === workflow,
    )
    .sort((a, b) => (b?.run_number ?? 0) - (a?.run_number ?? 0) || (b?.id ?? 0) - (a?.id ?? 0))[0];

/**
 * The decision, from what the API answered. `runs` is the `workflow_runs` of
 * `GET /actions/runs?event=pull_request&head_sha=<sha>`, `pulls` the answer of
 * `GET /commits/<sha>/pulls`, `jobs` the `jobs` of the newest run's `GET /actions/runs/<id>/jobs`.
 *
 * @param {{
 *   event: string, ref: string, sha: string, forced: boolean, after: string | undefined,
 *   workflow: string, runs: unknown[], pulls: unknown[], jobs: unknown[],
 * }} input
 * @returns {{ verified: boolean, reason: string }}
 */
export const decide = ({ event, ref, sha, forced, after, workflow, runs, pulls, jobs }) => {
  const no = (reason) => ({ verified: false, reason });
  if (event !== 'push') return no(`event is ${event}, not a push`);
  if (ref !== 'refs/heads/main') return no(`ref is ${ref}, not refs/heads/main`);
  if (forced) return no('a force push: its pull request did not test what main now holds');
  if (!/^[0-9a-f]{40}$/.test(sha)) return no(`'${sha}' is not a commit sha`);
  if (after !== sha) return no(`the payload's after (${after}) is not GITHUB_SHA (${sha})`);

  const intoMain = [];
  for (const pull of pulls) {
    const head = pull?.head?.sha;
    const base = pull?.base?.ref;
    if (head !== sha) continue;
    if (base !== 'main') {
      return no(`pull request #${pull?.number} has this head and targets ${base}, not main`);
    }
    intoMain.push(pull?.number);
  }
  if (intoMain.length === 0) return no('no pull request into main has this commit as its head');

  const green = newestRun(runs, sha, workflow);
  if (green === undefined) return no(`no pull_request run of ${workflow} for ${sha}`);
  if (green.status !== 'completed' || green.conclusion !== 'success') {
    return no(`the newest pull_request run ${green.id} is ${green.status}/${green.conclusion}`);
  }
  const proof = jobs
    .filter((job) => job?.run_id === undefined || job?.run_id === green.id)
    .flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
    .find((step) => step?.name === TREE_STEP);
  if (proof?.conclusion !== 'success') {
    return no(
      `run ${green.id} did not record that it tested this head's own tree (step '${TREE_STEP}': ${proof?.conclusion ?? 'absent'})`,
    );
  }
  return {
    verified: true,
    reason: `${workflow} passed on pull request #${intoMain.join(', #')} at ${sha} (run ${green.id})`,
  };
};

const api = async (path) => {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('no GH_TOKEN or GITHUB_TOKEN');
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GET ${path}: HTTP ${response.status}`);
  return response.json();
};

const main = async (args) => {
  const at = args.indexOf('--workflow');
  const workflow = at === -1 ? undefined : args[at + 1];
  if (workflow === undefined || !workflow.startsWith('.github/workflows/')) {
    process.stderr.write(
      'usage: main-push-verified.mjs --workflow .github/workflows/<file>.yml [--github-output]\n',
    );
    return 2;
  }
  let result;
  try {
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_REPOSITORY is not set');
    const sha = process.env.GITHUB_SHA ?? '';
    const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf8'));
    const facts = {
      event: process.env.GITHUB_EVENT_NAME ?? '',
      ref: process.env.GITHUB_REF ?? '',
      sha,
      forced: payload?.forced !== false,
      after: payload?.after,
      workflow,
    };
    const early = decide({ ...facts, runs: [], pulls: [], jobs: [] });
    if (!early.verified && !early.reason.startsWith('no pull request')) {
      result = early;
    } else {
      const listed = await api(
        `/repos/${repository}/actions/runs?event=pull_request&head_sha=${sha}&per_page=100`,
      );
      const runs = Array.isArray(listed?.workflow_runs) ? listed.workflow_runs : [];
      const pulls = await api(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
      const newest = newestRun(runs, sha, workflow);
      const jobs =
        newest === undefined
          ? []
          : ((await api(`/repos/${repository}/actions/runs/${newest.id}/jobs?per_page=100`))
              ?.jobs ?? []);
      result = decide({
        ...facts,
        runs,
        pulls: Array.isArray(pulls) ? pulls : [],
        jobs: Array.isArray(jobs) ? jobs : [],
      });
    }
  } catch (error) {
    result = { verified: false, reason: `could not decide, so everything runs: ${error.message}` };
  }
  process.stderr.write(`${result.verified ? 'verified' : 'not verified'}: ${result.reason}\n`);
  const line = `verified=${result.verified}\n`;
  if (args.includes('--github-output')) {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) {
      process.stderr.write('--github-output: GITHUB_OUTPUT is not set\n');
      return 2;
    }
    appendFileSync(output, line);
  } else {
    process.stdout.write(line);
  }
  return 0;
};

if (isProgram(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
