#!/bin/bash
#
# A stub `gh`, used by `scripts/release.test.ts` to execute the shell of `release.yml`'s last two
# steps offline. It is the only way any part of that workflow can be run from a checkout (standing
# rule 71), and the logic it exercises is the one that decides which run the release watches —
# where watching the *wrong* run reports a finished build's verdict and turns a release green
# without its images (the defect this stub was written for).
#
# It answers three commands and refuses everything else, so a call this test did not anticipate
# fails loudly instead of being swallowed:
#
#   gh run list --workflow image.yml [--event E] --limit N --json <fields> --jq <expr>
#       Prints the scenario's runs, newest first, tab-separated in the order `--json` names them —
#       which is what the real `--jq '… | @tsv'` produces. `--event` is honoured because the real
#       list filters it server-side; the `--jq` expression itself is **not** evaluated (there is no
#       jq here), which is why the workflow keeps that expression to a bare projection and does its
#       filtering in shell where it can be executed.
#   gh workflow run image.yml --ref <tag>    — recorded, exit 0.
#   gh run watch <id> --exit-status          — recorded, exits `STUB_WATCH_EXIT` (default 0).
#
# Environment: `STUB_LOG` (one line per call), `STUB_DIR` (holds the call counter), `STUB_RUNS` (the
# scenario: `id<TAB>headSha<TAB>headBranch<TAB>event<TAB>first call it is visible on`, newest
# first — the last column is how "the new run has not appeared yet" is expressed).
set -uo pipefail

printf '%s\n' "$*" >> "$STUB_LOG"

if [ "${1:-}" = 'run' ] && [ "${2:-}" = 'watch' ]; then exit "${STUB_WATCH_EXIT:-0}"; fi
if [ "${1:-}" = 'workflow' ] && [ "${2:-}" = 'run' ]; then exit 0; fi
if [ "${1:-}" != 'run' ] || [ "${2:-}" != 'list' ]; then
  echo "stub gh: unexpected command: $*" >&2
  exit 64
fi

calls="${STUB_DIR}/calls"
n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$calls"

event=''
fields=''
while [ $# -gt 0 ]; do
  case "$1" in
    --event) event="${2:-}"; shift 2;;
    --json) fields="${2:-}"; shift 2;;
    *) shift;;
  esac
done

while IFS=$'\t' read -r id sha branch ev from; do
  [ -n "${id:-}" ] || continue
  if [ -n "$event" ] && [ "$ev" != "$event" ]; then continue; fi
  [ "$n" -ge "${from:-1}" ] || continue
  if [ "$fields" = 'databaseId,headSha' ]; then
    printf '%s\t%s\n' "$id" "$sha"
  else
    printf '%s\t%s\t%s\n' "$id" "$sha" "$branch"
  fi
done < "$STUB_RUNS"
