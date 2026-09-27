#!/bin/bash
#
# A stub `docker`, used by `scripts/release.test.ts` beside `gh-stub.sh` to execute `image.yml`'s
# release step offline (WP-71). It pushes nothing: the step's copies are recorded, not made.
#
#   docker buildx imagetools create -t <ref>… <source>
#       Recorded; exits `STUB_CREATE_EXIT` (default 0).
#   docker buildx imagetools inspect <ref> --format '{{ json .Manifest.Digest }}'
#       Prints the digest as JSON (quoted): `STUB_SOURCE_DIGEST` for a `:sha-` ref, and
#       `STUB_COPY_DIGEST` (default: the source digest — a carbon copy) for any other, so a test can
#       make the copy differ from its source.
#
# Anything else exits 64 with the command named.
set -uo pipefail

printf 'docker %s\n' "$*" >> "$STUB_LOG"

if [ "${1:-}" != 'buildx' ] || [ "${2:-}" != 'imagetools' ]; then
  echo "stub docker: unexpected command: $*" >&2
  exit 64
fi

case "${3:-}" in
  create) exit "${STUB_CREATE_EXIT:-0}" ;;
  inspect)
    source_digest="${STUB_SOURCE_DIGEST:-sha256:1111111111111111111111111111111111111111111111111111111111111111}"
    case "${4:-}" in
      *:sha-*) printf '"%s"\n' "$source_digest" ;;
      *) printf '"%s"\n' "${STUB_COPY_DIGEST:-$source_digest}" ;;
    esac
    ;;
  *)
    echo "stub docker: unexpected command: $*" >&2
    exit 64
    ;;
esac
