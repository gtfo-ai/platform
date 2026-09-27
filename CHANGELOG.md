# Changelog

Every release's notes — what changed, **whether upgrading needs a migration** and the steps to take
before you upgrade, and what has not been measured — are its
[GitHub Release](https://github.com/gtfo-ai/platform/releases). Each version is cut from the
conventional commits on `main` and its notes are written by the same run that publishes its images,
so they are never out of date.

This file lists no versions on purpose: under continuous deployment a list kept here would be stale
after nearly every push (PROGRESS backlog 257, Q105). To preview what the next release would say,
run `pnpm changelog` in a full clone; it prints the preview and writes nothing.
