# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub's private vulnerability reporting: open the repository's **Security** tab → **Report a vulnerability**. Do not open a public issue, and do not include real credentials or customer data in the report.

You should get an acknowledgement within a few working days. We will keep you updated while we investigate, agree a disclosure date with you, and credit you in the release notes unless you prefer otherwise.

## Scope

In scope: the platform code in this repository, its container images, the agent workspace isolation model, and the handling of integration credentials.

Out of scope: vulnerabilities in Anthropic's Claude Code CLI or SDK (report those to Anthropic), and in the third-party services this platform integrates with (report those to the vendor).

## Secrets

No secret, token or customer data ever enters this repository (BD-002). If you find one, treat it as a vulnerability and report it privately so it can be revoked before it is removed from history.

Secrets reach a running instance only through environment variables or mounted files (`<NAME>_FILE`); see `.env.example` and [`docs/technical/12-configuration-and-schemas.md`](docs/technical/12-configuration-and-schemas.md).
