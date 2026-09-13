/**
 * The contract between the skill **files**, the **role table** that hands them out, and the
 * **provider registrations** that name them — WP-14a.
 *
 * It lives here for the same reason `role-prompts.contract.test.ts` does: the three parties are in
 * three rings that may not import each other. `@platform/prompts` holds the files and may name only
 * `@platform/contracts`; `SKILLS_BY_ROLE` is in `@platform/application`, which may not read the
 * files; the registrations are in `@platform/integrations`. Every pair of them is a real binding at
 * run time — the launcher copies the files a role's list names, and a provider's `SkillRef` points
 * at one of the same directories — so standing rule 23 puts the obligation in a shared suite rather
 * than in one side's own tests.
 *
 * **This is the only thing that reads a provider's `skill` ref.** Said plainly, because until
 * WP-14a nothing read it at all (`skillRefSchema` was declared and unused, and GitLab's ref named a
 * directory that did not exist). Provisioning is **role-driven**: a run gets the skills its role's
 * row lists, whether or not the project has a binding for the provider that also names one.
 * Narrowing it to a project's actual bindings is in the ledger's discovered work; until then, a
 * ref's job is to tell an operator reading the provider which recipes an agent has, and this file's
 * job is to keep that statement true.
 *
 * **And what a skill *claims* is tied to what the platform actually does** (review of WP-14a, rules
 * 44 and 86). A skill is prompt material a model acts on, and four of the ten said a CLI was
 * "already authenticated for this run" while `agentRunEnvironment` puts only `ANTHROPIC_API_KEY`
 * into a run and nothing reads `AgentTooling.env` at all (PROGRESS backlog **40**, cause (b)). Two
 * mechanical checks below, each demonstrated in both directions by planting the defect in a copy:
 *
 *  1. **no skill claims a credential unconditionally** — the claim patterns are declared here, and
 *     the rule is flat rather than conditional on tooling, because *no* tooling's `env` reaches a
 *     run today;
 *  2. **a skill that names one of the run image's CLIs is either backed by a provider's
 *     `AgentTooling.cli` or hedged** — it must carry {@link HEDGE_MARKER}, a sentence that tells the
 *     model what to do when the credential is not there;
 *  3. **a skill that sends an agent to a path under `.agentic-run/` says it may not be there**
 *     (nothing in the tree writes that directory); and
 *  4. **a skill that says a server "is mounted" is either backed by a provider's `AgentTooling.mcp`
 *     or is denying it** — `mcpServers: {}` reaches every run today.
 *
 * Rules 3 and 4 exist because rules 1 and 2 covered credentials and binaries only, and the next
 * three false sentences a review found were a **path** and a **server** (round 2).
 *
 * Check 2 is a **deviation from the review's literal wording** ("tied to a non-null
 * `AgentTooling.cli`"), stated rather than quietly taken: `acli`, `jira` and `sentry-cli` are
 * shipped *in the run image* (`docker/runtime.Dockerfile`) while Jira declares no tooling and
 * Sentry declares no CLI, so the literal rule would delete recipes for binaries that are genuinely
 * there and genuinely usable when a project's own binding supplies a credential. The hedge is what
 * makes naming them honest, and the hedge is checked.
 *
 * **What none of the four can do, said plainly: they read prose with regular expressions.** A
 * paraphrase of "the CLI is authenticated" that matches no pattern below passes; a skill naming a
 * binary the image does not ship is invisible, because the binary set is read off the image's own
 * `COPY` line rather than off the prose; a hedge marker can sit in one paragraph while the next
 * contradicts it, since the rules check **presence**, not scope; the path rule sees only
 * `.agentic-run/`, so a claim about `/work`, `~/.claude` or any other path is unguarded; the mount
 * rule reads one sentence at a time and a denial split across two sentences would fail it while an
 * affirmative claim carrying a stray "not" would pass; and **nothing at all checks a claim about a
 * platform tool, an event, a timeout or a pipeline behaviour** — the class round 2's `ask-human`
 * finding belongs to, which was fixed by reading `platform-tools.ts` rather than by a check.
 *
 * What is **not** here: that a model lists or uses a skill (no credential — the blocker brief in
 * PROGRESS under WP-17), and that the files reach a container (a real daemon —
 * `test/e2e/workspace/docker-workspace.e2e.test.ts`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentTooling } from '@platform/application';
import { PLATFORM_TOOLS_BY_ROLE, SKILLS_BY_ROLE } from '@platform/application';
import { agentRoleSchema } from '@platform/contracts';
import {
  gitlabAgentTooling,
  JIRA_CLOUD_AGENT_TOOLING,
  LOKI_AGENT_TOOLING,
  SENTRY_AGENT_TOOLING,
  slackAgentTooling,
} from '@platform/integrations';
import { PLATFORM_SKILL_NAMES, PLATFORM_SKILLS, platformSkillPath } from '@platform/prompts';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The provider directories, read off disk — the same derivation
 * `providers/delivery-key-redaction.test.ts` uses, so a sixth provider fails this file the moment
 * its directory exists rather than joining an untested set (rule 7).
 */
const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(
  new URL('../../../packages/integrations/src/providers/', import.meta.url),
  { withFileTypes: true },
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * One entry per directory, and the keys are checked against the disk: a provider with no recipe is
 * a failure, never a silent exclusion.
 */
const TOOLING: Readonly<Record<string, AgentTooling | null>> = {
  gitlab: gitlabAgentTooling,
  'jira-cloud': JIRA_CLOUD_AGENT_TOOLING,
  loki: LOKI_AGENT_TOOLING,
  sentry: SENTRY_AGENT_TOOLING,
  slack: slackAgentTooling,
};

describe('the platform skills, the role table and the provider refs', () => {
  it('covers every provider directory on disk', () => {
    expect(Object.keys(TOOLING).sort()).toEqual([...PROVIDER_DIRECTORIES]);
  });

  it.each(PROVIDER_DIRECTORIES)('%s: its skill ref resolves to a shipped skill', (directory) => {
    const skill = TOOLING[directory]?.skill ?? null;
    if (skill === null) {
      // A provider may honestly have no recipes. What it may not do is name one that is not there.
      expect(PLATFORM_SKILL_NAMES).not.toContain(directory);
      return;
    }
    // The id is the skill's **directory** name, which is what the CLI matches on.
    expect(PLATFORM_SKILL_NAMES).toContain(skill.id);
    expect(skill.path).toBe(`packages/prompts/skills/${skill.id}`);
    // Against the filesystem, not against the string this file just built: the defect this closes
    // is a ref naming a path that does not exist.
    const onDisk = `${REPO_ROOT}${skill.path}`;
    expect(existsSync(onDisk), `${skill.path} should exist`).toBe(true);
    expect(statSync(onDisk).isDirectory()).toBe(true);
    expect(existsSync(platformSkillPath(skill.id))).toBe(true);
  });

  it('gives every role a row, and every row only shipped skills', () => {
    expect(Object.keys(SKILLS_BY_ROLE).sort()).toEqual([...agentRoleSchema.options].sort());
    for (const [role, names] of Object.entries(SKILLS_BY_ROLE)) {
      for (const name of names) {
        expect(PLATFORM_SKILLS[name], `${role} names ${name}`).toBeDefined();
      }
    }
  });

  /**
   * No dead file: every shipped skill is handed to at least one role. Ten `SKILL.md` files nobody
   * is provisioned with is exactly the defect PROGRESS backlog 24 exists to have avoided.
   */
  it('provisions every shipped skill for at least one role', () => {
    const used = new Set(Object.values(SKILLS_BY_ROLE).flat());
    expect([...used].sort()).toEqual([...PLATFORM_SKILL_NAMES].sort());
  });
});

/**
 * BD-025's least privilege, read the other way round: a role that is handed a skill must hold the
 * platform tool the skill's own text tells it to use, or the skill is instructions for something
 * the run will refuse.
 */
/**
 * Sentences that assert a credential is present. Deliberately narrow and literal: each one was in a
 * shipped skill when WP-14a was reviewed.
 */
const CREDENTIAL_CLAIMS: readonly RegExp[] = [
  /\bis already authenticated\b/i,
  /\bare already authenticated\b/i,
  /\b(is|are) authenticated for this run\b/i,
  /\breads the run's [a-z ]*credentials\b/i,
  /\bthe credential in the environment is\b/i,
  /\bauthenticated for this run with a\b/i,
];

/** What a skill must say instead, so the model knows what to do when the credential is absent. */
const HEDGE_MARKER = 'stop and say so rather than guessing at credentials';

/**
 * A path under the platform's own run directory — `.agentic-run/context/`, `.agentic-run/out/`.
 *
 * **Nothing writes any of them.** The context pack is inlined in the prompt and no writer exists in
 * the tree (WP-17's notes), which is why `assemblePrompt` hedges the same sentence; a skill that
 * sends an agent to `ls` a directory that is not there spends a turn to learn nothing.
 */
const RUN_DIRECTORY_PATH = /\.agentic-run\/[a-z][a-z-]*/;
const PROVISIONED_HEDGE = 'when the platform provisioned one';

/** "the MCP server is mounted": true of no provider today — `mcpServers: {}` reaches every run. */
const MOUNT_CLAIM = /\bis mounted\b/i;

const sentencesOf = (text: string): readonly string[] => text.split(/(?<=[.!?])\s+/);

/** MCP servers some provider's tooling declares. Empty today; the rule below follows the tree. */
const declaredMcpServers = (): readonly string[] =>
  Object.values(TOOLING)
    .map((tooling) => tooling?.mcp?.name ?? null)
    .filter((name): name is string => name !== null);

/**
 * The CLIs the run image ships, read off its own `COPY` line rather than listed here (rule 7): a
 * seventh binary joins this check the moment the image gains one.
 */
const IMAGE_CLIS: readonly string[] = (() => {
  const dockerfile = readFileSync(`${REPO_ROOT}docker/runtime.Dockerfile`, 'utf8');
  const line = dockerfile.split('\n').find((entry) => entry.startsWith('COPY --from=tools /out/'));
  if (line === undefined) {
    throw new Error('docker/runtime.Dockerfile no longer copies the agent CLIs from /out');
  }
  return [...line.matchAll(/\/out\/([a-z0-9-]+)/g)].map((match) => match[1] as string);
})();

/** The binaries some provider's tooling actually declares — `glab`, `logcli` today. */
const declaredClis = (): readonly string[] =>
  Object.values(TOOLING)
    .map((tooling) => tooling?.cli?.command ?? null)
    .filter((command): command is string => command !== null);

const credentialClaimsIn = (text: string): readonly string[] =>
  CREDENTIAL_CLAIMS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);

const imageClisNamedIn = (text: string): readonly string[] =>
  IMAGE_CLIS.filter((binary) => new RegExp(`\\b${binary}\\b`).test(text));

/** The rules, as one function, so the cases below can run them over a **planted** copy as well. */
const unbackedClaimsIn = (
  text: string,
): {
  readonly claims: readonly string[];
  readonly unhedgedClis: readonly string[];
  readonly unhedgedPaths: readonly string[];
  readonly mountClaims: readonly string[];
} => {
  const backed = declaredClis();
  const named = imageClisNamedIn(text);
  const unhedged = text.includes(HEDGE_MARKER)
    ? []
    : named.filter((binary) => !backed.includes(binary));
  const path = RUN_DIRECTORY_PATH.exec(text)?.[0] ?? null;
  return {
    claims: credentialClaimsIn(text),
    unhedgedClis: unhedged,
    unhedgedPaths: path === null || text.includes(PROVISIONED_HEDGE) ? [] : [path],
    // A claim that a server is mounted is allowed only if some provider declares one, or if the
    // sentence making it is a denial ("**No** … is mounted today").
    mountClaims:
      declaredMcpServers().length > 0
        ? []
        : sentencesOf(text).filter(
            (sentence) => MOUNT_CLAIM.test(sentence) && !/\bno\b|\bnot\b/i.test(sentence),
          ),
  };
};

describe('what a skill claims about credentials and CLIs', () => {
  it.each(PLATFORM_SKILL_NAMES)('%s: claims no credential the platform does not inject', (name) => {
    // Flat rather than conditional on tooling: `agentRunEnvironment` injects only
    // `ANTHROPIC_API_KEY`, and nothing in the tree reads `AgentTooling.env` (backlog 40).
    expect(credentialClaimsIn(PLATFORM_SKILLS[name]?.text ?? '')).toEqual([]);
  });

  it.each(PLATFORM_SKILL_NAMES)('%s: names no unbacked CLI without the hedge', (name) => {
    expect(unbackedClaimsIn(PLATFORM_SKILLS[name]?.text ?? '').unhedgedClis).toEqual([]);
  });

  it.each(PLATFORM_SKILL_NAMES)('%s: sends nobody to a run directory unconditionally', (name) => {
    expect(unbackedClaimsIn(PLATFORM_SKILLS[name]?.text ?? '').unhedgedPaths).toEqual([]);
  });

  it.each(PLATFORM_SKILL_NAMES)('%s: claims no mounted server the platform has none of', (name) => {
    expect(unbackedClaimsIn(PLATFORM_SKILLS[name]?.text ?? '').mountClaims).toEqual([]);
  });

  /**
   * The other direction (rule 12): the checks above are worth having only if they can fail, so the
   * defect they were written for is planted in a **copy** of a shipped skill and both fire.
   */
  it('fails a copy that claims a credential, and one that names a CLI with no hedge', () => {
    const honest = PLATFORM_SKILLS['jira-ticket']?.text ?? '';
    expect(unbackedClaimsIn(honest)).toEqual({
      claims: [],
      unhedgedClis: [],
      unhedgedPaths: [],
      mountClaims: [],
    });

    const claiming = `${honest}\n\nBoth CLIs are already authenticated for this run.\n`;
    expect(unbackedClaimsIn(claiming).claims.length).toBeGreaterThan(0);

    const unhedged = honest.replaceAll(HEDGE_MARKER, 'carry on');
    expect(unbackedClaimsIn(unhedged).unhedgedClis).toEqual(expect.arrayContaining(['acli']));

    // And a skill that names only a **backed** CLI needs no hedge: `glab` is declared by GitLab's
    // tooling, so removing the hedge from that one is not a failure of this rule.
    expect(declaredClis()).toContain('glab');
    expect(
      unbackedClaimsIn('Use `glab mr view 1` to read the merge request.').unhedgedClis,
    ).toEqual([]);
  });

  it('fails a copy that sends an agent to a run directory, and one that mounts a server', () => {
    const kb = PLATFORM_SKILLS['kb']?.text ?? '';
    expect(unbackedClaimsIn(kb).unhedgedPaths).toEqual([]);
    expect(unbackedClaimsIn(kb.replaceAll(PROVISIONED_HEDGE, 'always')).unhedgedPaths).toEqual([
      '.agentic-run/context',
    ]);

    const sentry = PLATFORM_SKILLS['sentry-issue']?.text ?? '';
    expect(declaredMcpServers()).toEqual([]);
    expect(unbackedClaimsIn(sentry).mountClaims).toEqual([]);
    // The sentence this skill used to carry, verbatim.
    const mounting = `${sentry}\n\nThe Sentry MCP server is mounted for stages whose tool policy includes it.\n`;
    expect(unbackedClaimsIn(mounting).mountClaims.length).toBe(1);
  });

  it('reads the CLI set off the image rather than from a list here', () => {
    expect(IMAGE_CLIS).toEqual(expect.arrayContaining(['glab', 'logcli', 'acli', 'sentry-cli']));
  });
});

describe('the role table, continued', () => {
  it.each([...agentRoleSchema.options])('%s: is handed no skill it cannot act on', (role) => {
    const names = SKILLS_BY_ROLE[role];
    const tools: readonly string[] = PLATFORM_TOOLS_BY_ROLE[role];
    const required: Readonly<Record<string, string>> = {
      'ask-human': 'ask_human',
      kb: 'kb_search',
      'gitlab-mr': 'open_mr',
      'mr-description': 'update_mr_description',
      'file-followup-ticket': 'create_followup_ticket',
    };
    for (const name of names) {
      const tool = required[name];
      if (tool !== undefined) {
        expect(tools, `${role} has ${name} but not ${tool}`).toContain(tool);
      }
    }
  });
});
