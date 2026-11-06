/**
 * What the New project wizard proposes from a repository URL (S-25.8, product/06 § "Step 1",
 * amended 2026-11-06; research/21 § 2 S19, F11).
 *
 * Step 1 asks for the repository first and proposes the project's **name** and **key** from it,
 * each editable. Pure and client-side: nothing here asks a server, so nothing here can know the
 * repository's **default branch** — a URL does not carry it, and the platform's own fallback
 * (`main`) is the wrong branch for a repository whose default is `develop` (WP-139). The step
 * leaves that field to the person, and the git provider's answer is shown once a git integration is
 * bound (`default-branch.tsx`).
 *
 * | the person types | name | key |
 * |---|---|---|
 * | `https://gitlab.com/autix/autix-core.git` | `autix-core` | `autix_core` |
 * | `git@gitlab.com:autix/autix-core.git` | `autix-core` | `autix_core` |
 * | `file:///srv/git/Billing API.git` | `Billing API` | `billing_api` |
 * | `https://gitlab.com/autix/autix-core/-/tree/main` | `autix-core` | `autix_core` |
 * | `https://gitlab.com` (no path) | — | — |
 *
 * The key is always either empty or a key the server's `createProjectRequestSchema` accepts
 * (`SLUG_PATTERN`, `^[a-z][a-z0-9_]*$`): built to the pattern and then checked against it, so a
 * proposal can never be the reason a create is refused (`repository-proposal.test.ts`, by property).
 * The proposal says nothing about whether the server accepts the **URL** — an SSH remote is still
 * proposed a name and still refused at the create, as the field's hint says.
 */
import { SLUG_PATTERN } from '@platform/contracts';

/** A URL with a scheme and an authority: `https://host/…`, `ssh://git@host:22/…`, `file:///…`. */
const SCHEME_AND_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

/** The path of a repository address — whatever follows the host. */
const pathOf = (address: string): string => {
  const withScheme = SCHEME_AND_AUTHORITY.exec(address);
  if (withScheme !== null) {
    return address.slice(withScheme[0].length);
  }
  // scp-like `git@host:group/repo.git`: a `:` before any `/` ends the host.
  const colon = address.indexOf(':');
  const slash = address.indexOf('/');
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    return address.slice(colon + 1);
  }
  return address;
};

const decoded = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A stray `%` is the person's own text, not an encoding: keep it as typed.
    return segment;
  }
};

/**
 * The repository's own name, as the address spells it: the last path segment, without `.git`.
 * A GitLab page address (`…/repo/-/tree/main`) is cut at its `/-/`, which no group or project name
 * can be. Empty when the address names no path.
 */
export const repositoryNameOf = (url: string): string => {
  const address = url.trim().replace(/[?#].*$/s, '');
  const path = pathOf(address);
  const segments = path.split('/');
  const gitlabPage = segments.indexOf('-');
  const named = (gitlabPage === -1 ? segments : segments.slice(0, gitlabPage)).filter(
    (segment) => segment !== '',
  );
  const last = named.at(-1);
  if (last === undefined) {
    return '';
  }
  return decoded(last)
    .replace(/\.git$/i, '')
    .trim();
};

/**
 * A key proposed from a name: lower case, accents dropped, every run of anything else one `_`,
 * and nothing before the first letter (the key must start with one). Empty when nothing is left.
 */
export const projectKeyOf = (name: string): string => {
  const key = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '');
  return SLUG_PATTERN.test(key) ? key : '';
};

/** The step's proposal for a repository URL: the name and the key, either possibly empty. */
export const proposalFromRepositoryUrl = (
  url: string,
): { readonly name: string; readonly key: string } => {
  const name = repositoryNameOf(url);
  return { name, key: projectKeyOf(name) };
};

/** Step 1's form before the project exists. */
export interface ProjectDraft {
  readonly repoUrl: string;
  readonly name: string;
  readonly key: string;
  readonly defaultBranch: string;
}

/** Which of the proposed fields the person has typed into; a proposal never overwrites one. */
export interface EditedFields {
  readonly name: boolean;
  readonly key: boolean;
}

export const EMPTY_PROJECT_DRAFT: ProjectDraft = {
  repoUrl: '',
  name: '',
  key: '',
  defaultBranch: '',
};

/**
 * The draft after the repository URL changed: the name and the key are proposed again unless the
 * person edited them. The default branch is never touched — nothing here knows it.
 */
export const draftWithRepositoryUrl = (
  draft: ProjectDraft,
  edited: EditedFields,
  repoUrl: string,
): ProjectDraft => {
  const name = edited.name ? draft.name : repositoryNameOf(repoUrl);
  return { ...draft, repoUrl, name, key: edited.key ? draft.key : projectKeyOf(name) };
};

/** The draft after the person typed a name: an unedited key follows it, so its hint stays true. */
export const draftWithName = (
  draft: ProjectDraft,
  edited: EditedFields,
  name: string,
): ProjectDraft => ({ ...draft, name, key: edited.key ? draft.key : projectKeyOf(name) });
