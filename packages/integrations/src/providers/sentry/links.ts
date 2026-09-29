/**
 * Which Sentry issues a piece of text links to — `ObservabilityErrorsPort.linkedIssues` (WP-89).
 *
 * The bug pre-fetch has to answer *"which issue is this ticket about?"* before it can read an
 * event, and the ticket is the only thing that says. Sentry's own "Create Jira issue" action and a
 * human pasting a link both leave the issue's **URL** in the ticket text, so that is what is read.
 * A short id (`ACME-1AB`) is not: resolving one is an organisation-wide lookup this adapter has no
 * documented endpoint for (`SOURCES.md` lists the 21 it read), and a bare word that looks like a
 * short id is also a Jira key.
 *
 * ## What is recognised, and why no more
 *
 * The text is untrusted (BD-022). What comes out is a **numeric issue id**, never a URL, and an id
 * is taken only from a link to **this binding's instance**:
 *
 *  - the host is the binding's `base_url` host, and a segment of the path before `issues` is the
 *    binding's organisation slug — `https://sentry.example.test/organizations/acme/issues/42/` and
 *    the older permalink form `https://sentry.example.test/acme/api/issues/42/`;
 *  - or the host is the organisation's own subdomain of it — `https://acme.sentry.io/issues/42/` —
 *    which for sentry.io and its regional hosts (`us.sentry.io`) is `<org>.sentry.io`, and a path
 *    that names a *different* organisation (`/organizations/other/…`) is refused even there.
 *
 * Every other link is ignored. So a ticket can choose **which issue of the bound organisation** is
 * read — which the binding's token can read anyway — and cannot choose where the platform connects,
 * whose credential it uses or which organisation it reads (the residual is restated where the
 * pre-fetch consumes it). The id is digits only and at most twenty of them, so it is spliced into a
 * request path by `provider.ts`'s own bounded identifier rule and nothing here can widen it.
 *
 * Pure, synchronous and total: no input throws, and the scan is one linear pass over a text the
 * caller has already bounded (a ticket snapshot is at most 45 632 characters).
 */
import { MAX_LINKED_ISSUES } from '@platform/application';

/** A URL-ish run of characters: stops at whitespace and at the delimiters wiki and Markdown use. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'()[\]{}|\\^`]+/gi;
/** `…/issues/<digits>` with a path boundary on both sides. */
const ISSUE_PATH = /(^|\/)issues\/(\d{1,20})(?=\/|$)/;
/** `…/organizations/<slug>/…` — the one path form that names an organisation explicitly. */
const ORGANIZATION_PATH = /(?:^|\/)organizations\/([^/]+)\//;

export interface SentryLinkScope {
  /** The binding's `base_url`, already validated by `sentryConfigSchema`. */
  readonly baseUrl: string;
  /** The binding's organisation slug. */
  readonly organization: string;
}

const parse = (candidate: string): URL | null => {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
};

/** The hosts on which `<org>` is implied by the host itself. */
const organizationHosts = (baseHost: string, baseHostname: string, org: string): Set<string> => {
  const hosts = new Set([`${org}.${baseHost}`]);
  // sentry.io's regional API hosts (`us.sentry.io`, `de.sentry.io`) serve the UI at `<org>.sentry.io`.
  if (baseHostname === 'sentry.io' || baseHostname.endsWith('.sentry.io')) {
    hosts.add(`${org}.sentry.io`);
  }
  return hosts;
};

const issueIdOf = (url: URL, scope: SentryLinkScope, baseHost: string, orgHosts: Set<string>) => {
  const path = url.pathname;
  const issue = ISSUE_PATH.exec(path);
  if (issue === null) {
    return null;
  }
  const org = scope.organization.toLowerCase();
  const named = ORGANIZATION_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
  if (named !== null && named !== org) {
    return null;
  }
  const host = url.host.toLowerCase();
  if (orgHosts.has(host)) {
    return issue[2] as string;
  }
  if (host !== baseHost) {
    return null;
  }
  const before = path
    .slice(0, issue.index + (issue[1] as string).length)
    .split('/')
    .map((segment) => segment.toLowerCase());
  return before.includes(org) ? (issue[2] as string) : null;
};

export const sentryLinkedIssues = (
  text: string,
  scope: SentryLinkScope,
): readonly { readonly id: string }[] => {
  const base = parse(scope.baseUrl);
  if (base === null) {
    return [];
  }
  const baseHost = base.host.toLowerCase();
  const orgHosts = organizationHosts(
    baseHost,
    base.hostname.toLowerCase(),
    scope.organization.toLowerCase(),
  );
  const ids: string[] = [];
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const url = parse(match[0]);
    if (url === null) {
      continue;
    }
    const id = issueIdOf(url, scope, baseHost, orgHosts);
    if (id !== null && !ids.includes(id)) {
      ids.push(id);
      if (ids.length >= MAX_LINKED_ISSUES) {
        break;
      }
    }
  }
  return ids.map((id) => ({ id }));
};
