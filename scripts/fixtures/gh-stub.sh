#!/bin/bash
#
# A stub `gh`, used by `scripts/release.test.ts` to execute the shell of `image.yml`'s release step
# offline (WP-71). No part of a workflow can be run from a checkout (standing rule 71); this is how
# the one step that creates a tag and a GitHub Release is run anyway — against a stub, so that
# running the test creates nothing on any repository.
#
# It answers one command and refuses everything else, so a call the test did not anticipate fails
# loudly instead of being swallowed:
#
#   gh release create <tag> --target <sha> --title <title> --notes-file <file>
#       Recorded (one line per call in `STUB_LOG`), the notes file copied to `${STUB_DIR}/notes.md`
#       so the test can read what the release would have said; exits `STUB_GH_EXIT` (default 0).
set -uo pipefail

printf 'gh %s\n' "$*" >> "$STUB_LOG"

if [ "${1:-}" != 'release' ] || [ "${2:-}" != 'create' ]; then
  echo "stub gh: unexpected command: $*" >&2
  exit 64
fi

while [ $# -gt 0 ]; do
  if [ "$1" = '--notes-file' ]; then cp "${2:-/dev/null}" "${STUB_DIR}/notes.md"; fi
  shift
done
exit "${STUB_GH_EXIT:-0}"
