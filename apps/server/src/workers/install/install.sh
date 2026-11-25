#!/bin/sh
# Install, repair or remove an Agentic platform worker on this machine (macOS and Linux).
#
# The core serves this file at /api/worker/v1/install.sh with its own address filled in below
# (S-22.20). Run it with:
#
#   curl -fsSL '@@AGENTIC_CORE_URL@@/api/worker/v1/install.sh' | sh
#
# Or read it before running it:
#
#   curl -fsSLo install.sh '@@AGENTIC_CORE_URL@@/api/worker/v1/install.sh' && less install.sh && sh install.sh
#
# What it changes on this machine, and nothing else:
#   - a folder, ~/agentic-worker by default (--dir). It holds compose.yaml, the core's worker bundle,
#     and .agentic-worker-install, this installer's mark (which core it came from);
#   - the Docker containers, volumes and networks of the worker's compose project, created by
#     `docker compose up -d` in that folder: `agentic-worker` for the first worker on this machine.
#     Docker keeps them running across restarts.
#
# One worker per core on this machine (S-29.2, TD-031's 2026-11-24 amendment, decision 9). Every run
# first looks for this core's install: a folder whose mark names this core, in this order: --dir,
# ~/agentic-worker, ~/agentic-worker-<--name>, every ~/agentic-worker-* folder, and every folder an
# `updater` container mounts. The first one found is repaired (a second one is named in a warning).
# None found is a new install: in ~/agentic-worker when that folder and the project `agentic-worker`
# are free (the first worker, as before), else a **named** one in ~/agentic-worker-<name>, where the
# name is --name, else this platform's own (its name as the core served this script). A named
# install gets the project `agentic-worker-<name>`, its own control volume, repository cache, run
# network and the first free page port from 7357, all written into its folder's `.env` (outside the
# updater's block) with COMPOSE_PROJECT_NAME, so a `docker compose up -d` there by hand is the same
# project. A name another core's worker holds is refused. An existing install is never renamed:
# --name on it only sets the label its page shows (APP_WORKER_LABEL).
#
# It does not use sudo, install a system service, or edit your PATH or shell profile.
#
# The worker keeps itself up to date. Its `updater` service follows the core and verifies each build
# before it applies it. Running this script again is a repair, never an upgrade. It never changes the
# images an approved worker runs, never writes inside the block of `.env` the updater manages, and
# never touches a volume (except `--uninstall --purge`, which removes them). A worker that is not set
# up yet (its page waits for a platform, its Claude sign-in or its approval) runs nothing worth
# keeping, so a re-run installs the core's build over it.
#
# A setting the bundle declares with a default (`${VAR:-default}`: APP_WORKER_UI_PORT, LOG_LEVEL, ...)
# that is set in this shell is saved into the folder's `.env`, outside the updater's block, before the
# first `docker compose up`: the updater carries into a new build only values with no default, so one
# given on the shell alone would go back to its default at the next update. Secret-looking names, the
# image and trust variables, and anything the bundle does not declare are never written.
#
# Exit status: 0 done, 1 a prerequisite or a step failed, 2 a usage error, 3 refused (to protect
# something that already exists).

set -eu

CORE_URL='@@AGENTIC_CORE_URL@@'
# This platform's slug, rendered by the core per download (TD-031's 2026-11-24 amendment, decision 9
# item 3): the name of a second worker when no --name is given. Empty when the core has none.
CORE_SLUG='@@AGENTIC_INSTANCE_SLUG@@'
# The first worker's project; a named one is agentic-worker-<name>. Set once the install is resolved.
DEFAULT_PROJECT=agentic-worker
PROJECT=$DEFAULT_PROJECT
MARK=.agentic-worker-install
BUNDLE=compose.yaml
DOWNLOAD=.compose.yaml.download
# The updater's managed block in the project's .env (apps/server/src/updater/env-file.ts).
BLOCK_BEGIN='# >>> agentic-platform updater'
BLOCK_END='# <<< agentic-platform updater'
IMAGE_VARIABLES='PLATFORM_IMAGE PLATFORM_LAUNCHER_IMAGE PLATFORM_RUNTIME_IMAGE PLATFORM_EGRESS_IMAGE'
# The label the updater puts on its one-shot apply container (apps/server/src/updater/updater.ts).
APPLY_LABEL=org.platform.update-apply
# Declared with a default in the bundle but never saved into .env: the four images and the git image
# (the bundle's pins, which a saved line would hold past every update), what the updater trusts, the
# core's address, and the folder the updater mounts (the updater answers it itself). Held to the
# template by install-script.test.ts.
NOT_SAVED='PLATFORM_IMAGE PLATFORM_LAUNCHER_IMAGE PLATFORM_RUNTIME_IMAGE PLATFORM_EGRESS_IMAGE APP_WORKSPACE_GIT_IMAGE APP_TRUSTED_IMAGE_REPOSITORY APP_TRUSTED_BUILDER APP_CORE_URL APP_WORKER_BUNDLE_DIR'
# The label the launcher puts on the volumes it creates: the control volume of the launcher that made
# it (packages/application/src/ports/workspace.ts, WORKSPACE_LABELS.instance).
INSTANCE_LABEL=com.agentic.instance

say() { printf '%s\n' "$*"; }
warn() { printf 'agentic-worker: %s\n' "$*" >&2; }
die() {
  code=$1
  shift
  warn "$*"
  exit "$code"
}

usage() {
  cat <<'USAGE'
Usage: sh install.sh [--name NAME] [--dir DIR] [--core URL] [--no-open]
       sh install.sh --uninstall [--purge] [--name NAME] [--dir DIR]

  --name NAME   a new worker's name: folder ~/agentic-worker-NAME, project agentic-worker-NAME, and
                the label its page shows (a-z, 0-9 and -, at most 24, not dev). On this core's
                existing worker it only sets the label. Without it, a second worker on this machine
                is named after its platform.
  --dir DIR     the worker's folder (default: this core's worker, else ~/agentic-worker)
  --core URL    download the worker bundle from this core instead of the one that served this script
  --no-open     do not open the worker's page in a browser
  --uninstall   stop and remove the worker's containers; keep its volumes and folder
  --purge       with --uninstall: also remove its volumes (its approval, its Claude sign-in) and folder

Piped from curl, pass options after `sh -s --`, for example: curl -fsSL URL | sh -s -- --uninstall
AGENTIC_INSTALL_WAIT_SECONDS (default 300) bounds the wait for the worker to start.
USAGE
}

dir=''
name=''
core=$CORE_URL
action=install
purge=0
want_open=1
while [ $# -gt 0 ]; do
  case $1 in
    --dir)
      [ $# -ge 2 ] || die 2 '--dir needs a folder'
      dir=$2
      shift 2
      ;;
    --dir=*)
      dir=${1#--dir=}
      shift
      ;;
    --name)
      [ $# -ge 2 ] || die 2 '--name needs a name'
      name=$2
      shift 2
      ;;
    --name=*)
      name=${1#--name=}
      shift
      ;;
    --core)
      [ $# -ge 2 ] || die 2 '--core needs a URL'
      core=$2
      shift 2
      ;;
    --core=*)
      core=${1#--core=}
      shift
      ;;
    --no-open)
      want_open=0
      shift
      ;;
    --uninstall)
      action=uninstall
      shift
      ;;
    --purge)
      purge=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die 2 "unknown option: $1 (see --help)" ;;
  esac
done
[ "$purge" -eq 0 ] || [ "$action" = uninstall ] || die 2 '--purge goes with --uninstall'

case $core in
  @@*) die 2 'this copy of the script was not served by a core; pass --core https://<your core>' ;;
esac
while :; do
  case $core in
    */) core=${core%/} ;;
    *) break ;;
  esac
done
case $core in
  http://?* | https://?*) ;;
  *) die 2 "the core's address must start with https:// (or http://): $core" ;;
esac
case $core in
  *[!-A-Za-z0-9.:/_~%]*) die 2 "the core's address has a character this installer does not accept: $core" ;;
esac

# A worker's name (decision 9 item 1): ^[a-z0-9][a-z0-9-]{0,23}$, and not `dev`, which
# `pnpm worker:dev` uses (its project is agentic-worker-dev). The letters are spelled out: a range such
# as [a-z] follows the locale, and a UTF-8 shell (macOS bash 3.2) can let an uppercase letter through.
valid_name() {
  case $1 in
    '' | dev | -* | *[!abcdefghijklmnopqrstuvwxyz0123456789-]*) return 1 ;;
  esac
  [ ${#1} -le 24 ]
}
if [ -n "$name" ] && ! valid_name "$name"; then
  case $name in
    dev) die 2 '--name dev is refused: pnpm worker:dev uses the project agentic-worker-dev. Pick another name.' ;;
    *) die 2 "--name must be 1 to 24 characters of a-z, 0-9 and -, starting with a letter or a digit (and not dev): $name" ;;
  esac
fi
# The platform's slug names a second worker only for the core that rendered it: another core given
# with --core has none here, so its second worker needs --name.
slug=$CORE_SLUG
[ "$core" = "$CORE_URL" ] || slug=''
valid_name "$slug" || slug=''

home=${HOME:-}
[ -n "$home" ] || [ -n "$dir" ] || die 2 'HOME is not set; pass --dir'
# --dir as given, made absolute. `dir` is the folder this run works in once the install is resolved.
dir_given=''
if [ -n "$dir" ]; then
  case $dir in
    /*) ;;
    *) dir=$PWD/$dir ;;
  esac
  while :; do
    case $dir in
      ?*/) dir=${dir%/} ;;
      *) break ;;
    esac
  done
  dir_given=$dir
fi

wait_limit=${AGENTIC_INSTALL_WAIT_SECONDS:-300}
case $wait_limit in
  '' | *[!0-9]*) die 2 'AGENTIC_INSTALL_WAIT_SECONDS must be a whole number of seconds' ;;
esac

# --- Prerequisites ---

os=$(uname -s 2>/dev/null || echo unknown)

need_docker() {
  case $os in
    Darwin) hint='install Docker Desktop for Mac: https://docs.docker.com/desktop/setup/install/mac-install/' ;;
    Linux) hint='install Docker Engine: https://docs.docker.com/engine/install/ (or Docker Desktop for Linux: https://docs.docker.com/desktop/setup/install/linux/)' ;;
    *) hint='install Docker: https://docs.docker.com/get-started/get-docker/' ;;
  esac
  command -v docker >/dev/null 2>&1 || die 1 "Docker is not installed. To run a worker, $hint and then run this again."
  if ! docker info >/dev/null 2>&1; then
    case $os in
      Darwin) die 1 'Docker is installed but not running. Start Docker Desktop, wait until it is running, and run this again.' ;;
      *) die 1 'Docker is installed but this user cannot reach it (docker info failed). Start it, let this user run docker without sudo (https://docs.docker.com/engine/install/linux-postinstall/), and run this again.' ;;
    esac
  fi
  docker compose version >/dev/null 2>&1 || die 1 'Docker Compose v2 is missing (docker compose version failed). Install it (https://docs.docker.com/compose/install/) and run this again.'
  command -v curl >/dev/null 2>&1 || die 1 'curl is needed to download the worker bundle. Install it and run this again.'
}

# --- Docker, scoped to this project ---

# `docker compose` in the worker's folder, as the worker's project (`agentic-worker`, or the
# COMPOSE_PROJECT_NAME a named install wrote into its folder's .env). Variables from this shell
# that would change which images run, where the bundle comes from or what the updater trusts are
# removed first. They are the updater's to set, or the bundle's defaults (S-22.20: autoupdate always).
compose() {
  (
    cd "$dir"
    unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES APP_CORE_URL \
      PLATFORM_IMAGE PLATFORM_LAUNCHER_IMAGE PLATFORM_RUNTIME_IMAGE PLATFORM_EGRESS_IMAGE \
      APP_TRUSTED_IMAGE_REPOSITORY APP_TRUSTED_BUILDER
    docker compose --project-name "$PROJECT" "$@"
  )
}

# The containers of the project, any state, one id per line.
project_containers() {
  docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT"
}

# Where the updater mounts this folder; after its first update Compose's working_dir label names it.
UPDATER_FOLDER=/var/lib/platform/host-bundle

# The host folder each given container mounts at the updater's path, one per line (Docker reports a
# bind mount's source; Compose's labels do not, TD-032 decision 4).
mounted_folders() {
  [ $# -gt 0 ] || return 0
  docker inspect --format '{{range .Mounts}}{{.Destination}}|{{.Source}}{{println}}{{end}}' "$@" \
    2>/dev/null | sed -n "s#^$UPDATER_FOLDER|##p"
}

# The folders the project's updater containers (any state) mount, one per line.
project_updater_folders() {
  ids=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$PROJECT" \
    --filter label=com.docker.compose.service=updater) || die 1 'docker ps failed'
  # shellcheck disable=SC2086 # one container id per word
  mounted_folders $ids
}

# The folders other than this one that the project was brought up from, read off Compose's
# working_dir label and its updater's mount only to spot another install: the updater's own mount
# path is ours. A mounted folder that is not a folder here (Docker named it another way) is skipped.
foreign_folders() {
  if [ -d "$dir" ]; then
    logical=$(cd "$dir" && pwd -L)
    physical=$(cd "$dir" && pwd -P)
  else
    logical=$dir
    physical=$dir
  fi
  folders=$(docker ps --all --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.Label "com.docker.compose.project.working_dir"}}') ||
    die 1 'docker ps failed'
  mounts=$(project_updater_folders)
  {
    printf '%s\n' "$folders"
    printf '%s\n' "$mounts" | while IFS= read -r folder; do
      if [ -n "$folder" ] && [ -d "$folder" ]; then (cd "$folder" && pwd -P); fi
    done
  } | sort -u | while IFS= read -r folder; do
    if [ -n "$folder" ] && [ "$folder" != "$logical" ] && [ "$folder" != "$physical" ] &&
      [ "$folder" != "$UPDATER_FOLDER" ]; then
      printf '%s\n' "$folder"
    fi
  done
}

# This installer's install is the folder with its mark (TD-032's 2026-11-05 decision-4 amendment),
# never what a label says: a folder without the mark is a new install, so any project of the name on
# this machine is someone else's; a marked folder's project is ours, unless the label names another
# host folder outright.
refuse_foreign_and_busy() {
  foreign=$(foreign_folders)
  if [ -n "$foreign" ]; then
    die 3 "a worker bundle named $PROJECT already runs from $foreign. This installer will not take it over: stop it there first (docker compose down, in that folder), or keep using it."
  fi
  if [ ! -f "$dir/$MARK" ]; then
    others=$(project_containers) || die 1 'docker ps failed'
    if [ -n "$others" ]; then
      die 3 "a worker bundle named $PROJECT already exists on this machine, and $dir is not this installer's (it has no $MARK). This installer will not take it over: run it with --dir pointing at that bundle's folder, or remove that bundle first."
    fi
  fi
  refuse_applying
}

# The updater's one-shot apply container is running: it rewrites this folder's files.
refuse_applying() {
  applying=$(docker ps --quiet --filter "label=$APPLY_LABEL=$PROJECT") || die 1 'docker ps failed'
  if [ -n "$applying" ]; then
    die 3 "this worker is applying an update right now. Run this again when it has finished (cd '$dir' && docker compose logs updater)."
  fi
}

# One service's state: ready, starting, unhealthy, missing, or Docker's own word (exited, ...).
# A healthcheck is honoured when the service has one; a running service without one is ready.
service_state() {
  line=$(docker ps --all --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=$1" --format '{{.State}}|{{.Status}}' 2>/dev/null |
    head -n 1) || line=''
  state=${line%%|*}
  status=${line#*|}
  case $state in
    '') say missing ;;
    running)
      case $status in
        *'(unhealthy)'*) say unhealthy ;;
        *'(health: starting)'*) say starting ;;
        *) say ready ;;
      esac
      ;;
    *) say "$state" ;;
  esac
}

# --- The bundle and its pins ---

# The image a bundle file pins for one variable: the default of its `${VAR:-<image>}`.
default_pin() {
  sed -n "s/.*\${$2:-\([^}]*\)}.*/\1/p" "$1" | head -n 1
}

# The four images a bundle file pins, as one line; empty when it is not there.
pins_of_bundle() {
  [ -f "$1" ] || return 0
  pins=''
  for variable in $IMAGE_VARIABLES; do
    pins="$pins $variable=$(default_pin "$1" "$variable")"
  done
  printf '%s\n' "$pins"
}

# The four images the updater's managed block of an env file pins, as one line; empty when the file
# has no complete block (the updater has not applied an update yet).
pins_of_block() {
  [ -f "$1" ] || return 0
  pins=''
  for variable in $IMAGE_VARIABLES; do
    pin=$(sed -n "/^$BLOCK_BEGIN/,/^$BLOCK_END/p" "$1" | sed -n "s/^$variable=//p" | head -n 1)
    [ -n "$pin" ] || return 0
    pins="$pins $variable=$pin"
  done
  printf '%s\n' "$pins"
}

download_bundle() {
  url=$core/api/worker/v1/compose.yml
  rm -f "$dir/$DOWNLOAD"
  # An https core is fetched over https only, redirects included; an http one (a local core) as given.
  case $core in
    https://*) protocols='=https' ;;
    *) protocols='=https,http' ;;
  esac
  if ! curl -fsSL --proto "$protocols" --max-time 120 -o "$dir/$DOWNLOAD" "$url"; then
    rm -f "$dir/$DOWNLOAD"
    die 1 "could not download the worker bundle from $url. Is the core reachable from this machine? Open that address in a browser to see its answer: a 503 means the core cannot name its images yet, so try again in a minute."
  fi
  problem=''
  grep -q '^  updater:$' "$dir/$DOWNLOAD" || problem='it has no updater service, and this installer installs only workers that keep themselves up to date'
  if grep -q '^ *profiles:' "$dir/$DOWNLOAD"; then
    problem='it declares compose profiles, which could leave the updater switched off'
  fi
  for variable in $IMAGE_VARIABLES; do
    case $(default_pin "$dir/$DOWNLOAD" "$variable") in
      *@sha256:*) ;;
      *) problem="it does not pin $variable by digest" ;;
    esac
  done
  if [ -n "$problem" ]; then
    rm -f "$dir/$DOWNLOAD"
    die 1 "the bundle $url cannot be installed: $problem."
  fi
}

write_mark() {
  {
    say '# Written by the Agentic platform worker installer (install.sh, S-22.20). Do not edit.'
    say "core=$core"
  } >"$dir/$MARK"
}

marked_core() {
  core_of "$dir"
}

# The core a folder's mark names, or nothing (no mark).
core_of() {
  [ -f "$1/$MARK" ] || return 0
  sed -n 's/^core=//p' "$1/$MARK" | head -n 1
}

# --- Settings given on the shell (BACKLOG 1055) ---

# Every variable a bundle file declares with a non-empty default (`${VAR:-x}`), one per line.
defaulted_variables() {
  grep -v '^[[:space:]]*#' "$1" | grep -o '[$][{][A-Z][A-Z0-9_]*:-[^}]' |
    sed 's/^[$][{]\([A-Z0-9_]*\):-.*/\1/' | sort -u
}

# The value .env sets for a variable outside the updater's block (the last line wins), or nothing:
# `NAME=value`, `export NAME=value`, with the value bare, 'single' or "double" quoted.
env_value() {
  [ -f "$dir/.env" ] || return 0
  sed "/^$BLOCK_BEGIN/,/^$BLOCK_END/d" "$dir/.env" |
    sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" |
    tail -n 1 | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}

# The name a variable resolves to for Compose: this shell, else what this installer writes for a
# named install, else .env, else the downloaded bundle's default.
resolved_value() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || value=$(installer_value "$1")
  [ -n "$value" ] || value=$(env_value "$1")
  [ -n "$value" ] || value=$(default_pin "$dir/$DOWNLOAD" "$1")
  say "$value"
}

# The variable a line of an env file assigns (`NAME=...`, `export NAME=...`), or nothing.
assigned_name() {
  printf '%s\n' "$1" |
    sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p'
}

# What this installer itself writes into .env (S-29.2), never taken from the shell: a named install's
# COMPOSE_PROJECT_NAME, its three names and page port where the shell gave none, and a person's
# --name as APP_WORKER_LABEL. Names in INSTALLER_NAMES, values in installer_value_<NAME>.
INSTALLER_NAMES=''
installer_set() {
  INSTALLER_NAMES="$INSTALLER_NAMES $1"
  eval "installer_value_$1=\$2"
}
installer_value() {
  case " $INSTALLER_NAMES " in
    *" $1 "*) eval "say \"\${installer_value_$1}\"" ;;
  esac
}

# `NAME=value` for a setting this installer writes, else one of this shell.
setting_line() {
  case " $INSTALLER_NAMES " in
    *" $1 "*) eval "value=\${installer_value_$1}" ;;
    *) eval "value=\${$1:-}" ;;
  esac
  printf '%s=%s\n' "$1" "$value"
}

# The settings to save: each variable the downloaded bundle declares with a default, set (non-empty)
# in this shell, that is not in NOT_SAVED and does not look like a secret, one name per line. A value
# with a character a plain .env line cannot hold is named and left out.
settings_to_save() {
  for variable in $(defaulted_variables "$dir/$DOWNLOAD"); do
    case " $NOT_SAVED " in *" $variable "*) continue ;; esac
    case $variable in
      *TOKEN* | *SECRET* | *PASSWORD* | *PASSWD* | *KEY* | *DSN* | *CREDENTIAL* | *PRIVATE*) continue ;;
    esac
    eval "value=\${$variable:-}"
    [ -n "$value" ] || continue
    case $value in
      *[!A-Za-z0-9_.:/@%+,=-]*)
        warn "did not save $variable: its value has a character this installer does not write into .env; add it to $dir/.env yourself, or it goes back to its default at the next update."
        continue
        ;;
    esac
    say "$variable"
  done
}

# Writes the settings of this shell into .env (BACKLOG 1055), before the first `docker compose up`:
# an earlier line of the same name outside the updater's block is replaced where it stands (a later
# duplicate dropped), a new one appended; the updater's block is copied byte for byte. A new file is
# private (0600); an existing one keeps its mode. Says in one line what it saved.
#
# The updater rewrites .env when it applies an update, so the file is read only now, with no apply
# running, and the write is refused when the file changed (or an apply started) while it was being
# built: a rename of a stale copy would put back the managed block it had just replaced. What is
# left is the moment between that last check and the rename.
save_settings() {
  names=$(settings_to_save | tr '\n' ' ')
  names="${INSTALLER_NAMES# } $names"
  names=${names# }
  names=${names% }
  [ -n "$names" ] || return 0
  refuse_applying
  file=$dir/.env
  next=$dir/.env.installer-$$
  read_copy=$dir/.env.installer-read-$$
  rm -f "$next" "$read_copy"
  if [ -f "$file" ]; then
    cp -p "$file" "$read_copy"
    cp -p "$file" "$next"
  else
    (umask 077 && : >"$next")
  fi
  {
    inside=0
    written=' '
    if [ -f "$read_copy" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        if [ "$inside" -eq 1 ]; then
          case $line in "$BLOCK_END"*) inside=0 ;; esac
          printf '%s\n' "$line"
          continue
        fi
        case $line in
          "$BLOCK_BEGIN"*)
            inside=1
            printf '%s\n' "$line"
            continue
            ;;
        esac
        setting=$(assigned_name "$line")
        case " $names " in
          *" ${setting:-.} "*)
            case $written in
              *" $setting "*) ;;
              *)
                setting_line "$setting"
                written="$written$setting "
                ;;
            esac
            continue
            ;;
        esac
        printf '%s\n' "$line"
      done <"$read_copy"
    fi
    for setting in $names; do
      case $written in *" $setting "*) continue ;; esac
      setting_line "$setting"
    done
  } >"$next"
  unchanged=1
  if [ -f "$read_copy" ]; then
    cmp -s "$file" "$read_copy" || unchanged=0
  elif [ -e "$file" ]; then
    unchanged=0
  fi
  rm -f "$read_copy"
  if [ "$unchanged" -eq 0 ]; then
    rm -f "$next"
    die 3 "$file changed while this installer was saving settings into it (the updater applying an update?). Run this again."
  fi
  if ! (refuse_applying); then
    rm -f "$next"
    exit 3
  fi
  mv -f "$next" "$file"
  note=''
  if [ -n "$(project_containers)" ]; then
    note=" (a worker already running takes a changed one at its next update)"
  fi
  say "Saved in $dir/.env, so its updates keep them: $names$note"
}

# --- Another worker's names (BACKLOG 1056) ---

# One label of a Docker volume or network, read off `{{json .Labels}}`; nothing when the object does
# not exist (or Docker does not answer) or has no such label.
label_of() {
  [ -n "$2" ] || return 0
  labels=$(docker "$1" inspect --format '{{json .Labels}}' "$2" 2>/dev/null) || return 0
  key=$(printf '%s' "$3" | sed 's/[.]/[.]/g')
  printf '%s\n' "$labels" | sed -n "s/.*\"$key\":\"\([^\"]*\)\".*/\1/p"
}

# Refuses, before anything is created, a worker whose control volume, run network or repository cache
# resolves to a name another worker on this machine already holds: Compose labels the volume and the
# network with the project that created them, and the launcher labels the cache with its own control
# volume. What it cannot see: an object of that name nobody labelled, and a cache another worker is
# configured with but has not created yet (no run yet).
refuse_shared_names() {
  control=$(resolved_value APP_WORKER_CONTROL_VOLUME)
  network=$(resolved_value APP_WORKER_RUN_NETWORK)
  cache=$(resolved_value APP_WORKER_CACHE_VOLUME)
  shared=''
  owner=$(label_of volume "$control" com.docker.compose.project)
  if [ -n "$owner" ] && [ "$owner" != "$PROJECT" ]; then
    shared="the compose project $owner already uses the volume $control, so set APP_WORKER_CONTROL_VOLUME"
  fi
  owner=$(label_of network "$network" com.docker.compose.project)
  if [ -z "$shared" ] && [ -n "$owner" ] && [ "$owner" != "$PROJECT" ]; then
    shared="the compose project $owner already uses the network $network, so set APP_WORKER_RUN_NETWORK"
  fi
  maker=$(label_of volume "$cache" "$INSTANCE_LABEL")
  if [ -z "$shared" ] && [ -n "$maker" ] && [ "$maker" != "$control" ]; then
    shared="the worker whose control volume is $maker already uses the repository cache $cache, so set APP_WORKER_CACHE_VOLUME"
  fi
  [ -n "$shared" ] || return 0
  rm -f "$dir/$DOWNLOAD"
  [ "$made_dir" -eq 0 ] || rmdir "$dir" 2>/dev/null || :
  die 3 "another worker runs on this machine: $shared to a name of its own in this shell (the installer saves it in .env) and run this again."
}

# --- Waiting for the worker ---

# The host port the running remote-worker publishes its page on, or nothing (not running yet). A
# setting saved into .env by a re-run reaches the container only at its next update, so this, not
# the setting, is where the page is.
published_port() {
  id=$(docker ps --quiet --filter "label=com.docker.compose.project=$PROJECT" \
    --filter "label=com.docker.compose.service=remote-worker" 2>/dev/null | head -n 1) || id=''
  [ -n "$id" ] || return 0
  line=$(docker port "$id" 7357/tcp 2>/dev/null | head -n 1) || line=''
  port=${line##*:}
  case $port in '' | *[!0-9]*) return 0 ;; esac
  say "$port"
}

# The page's port: what the running worker publishes, else this shell, else .env, else the default.
page_port() {
  port=$(published_port)
  [ -n "$port" ] || port=${APP_WORKER_UI_PORT:-}
  [ -n "$port" ] || port=$(env_value APP_WORKER_UI_PORT)
  case $port in
    '' | *[!0-9]*) port=7357 ;;
  esac
  say "$port"
}

# Whether the worker holds a credential yet, read off its page's state. `not_set_up`: its
# `connection` waits for a platform, its Claude sign-in or its device approval. `unknown`: the page
# does not answer at all (a stopped worker). `set_up`: anything else, an HTTP refusal included (a
# token, APP_WORKER_UI_AUTH=token), so the caller keeps the cautious path. Only that one word is
# read, and nothing of the answer is printed.
setup_state() {
  answer=$(curl -fsS --max-time 3 "http://127.0.0.1:$(page_port)/api/local/state" 2>/dev/null) &&
    code=0 || code=$?
  # curl's 22 is an HTTP error: the page answered and refused.
  case $code in
    0) ;;
    22) say set_up && return 0 ;;
    *) say unknown && return 0 ;;
  esac
  connection=$(printf '%s\n' "$answer" | grep -o '"connection":"[a-z_]*"' | head -n 1)
  case $connection in
    '"connection":"needs_platform"' | '"connection":"needs_claude"' | '"connection":"logging_in"') say not_set_up ;;
    *) say set_up ;;
  esac
}

# The served bundle over a worker that is not set up yet: it runs nothing worth keeping.
install_served() {
  mv -f "$dir/$DOWNLOAD" "$dir/$BUNDLE"
  say "This worker runs another build than the core serves now and is not set up yet, so updating it loses nothing: installing the core's build in $dir ..."
  compose up -d || die 1 "docker compose up failed (see above). Fix what it names and run this again."
}

page_answers() {
  curl -fsS -o /dev/null --max-time 3 "$page" >/dev/null 2>&1
}

wait_for_worker() {
  say "Waiting for the worker, its updater and its page (up to $wait_limit s) ..."
  waited=0
  while :; do
    worker=$(service_state remote-worker)
    updater=$(service_state updater)
    page_state=waiting
    if page_answers; then page_state=ready; fi
    if [ "$worker" = ready ] && [ "$updater" = ready ] && [ "$page_state" = ready ]; then
      return 0
    fi
    if [ "$waited" -ge "$wait_limit" ]; then
      die 1 "the worker did not come up within $wait_limit s (worker: $worker, updater: $updater, page $page: $page_state). See what it says: cd '$dir' && docker compose logs --tail 50"
    fi
    sleep 2
    waited=$((waited + 2))
  done
}

open_page() {
  [ "$want_open" -eq 1 ] || return 1
  case $os in
    Darwin)
      command -v open >/dev/null 2>&1 && open "$page" >/dev/null 2>&1 && return 0
      ;;
    *)
      if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$page" >/dev/null 2>&1 && return 0
      fi
      ;;
  esac
  return 1
}

# --- Which install: this core's, or a new one (S-29.2, decision 9 item 2) ---

# Every folder an `updater` container of any project, in any state, mounts, one per line.
updater_folders() {
  ids=$(docker ps --all --quiet --filter label=com.docker.compose.service=updater) ||
    die 1 'docker ps failed'
  # shellcheck disable=SC2086 # one container id per word
  mounted_folders $ids
}

# The folders to look in, in the decision's order: --dir, ~/agentic-worker, the --name folder, every
# ~/agentic-worker-* folder, and the folders the updaters mount (read first, into UPDATER_MOUNTS).
candidate_folders() {
  if [ -n "$dir_given" ]; then say "$dir_given"; fi
  if [ -n "$home" ]; then
    say "$home/agentic-worker"
    if [ -n "$name" ]; then say "$home/agentic-worker-$name"; fi
    for folder in "$home"/agentic-worker-*; do
      if [ -d "$folder" ]; then say "$folder"; fi
    done
  fi
  printf '%s\n' "$UPDATER_MOUNTS"
}

# This core's installs: each candidate folder whose mark names this core, once, in order.
this_core_installs() {
  candidate_folders | {
    seen=''
    while IFS= read -r folder; do
      [ -n "$folder" ] && [ -d "$folder" ] || continue
      [ "$(core_of "$folder")" = "$core" ] || continue
      real=$(cd "$folder" && pwd -P) || continue
      case $seen in *"<$real>"*) continue ;; esac
      seen="$seen<$real>"
      say "$folder"
    done
  }
}

# The project of the folder in $dir: the COMPOSE_PROJECT_NAME a named install wrote into its .env,
# else agentic-worker (the first worker, and every install made before S-29.2).
project_of_folder() {
  value=$(env_value COMPOSE_PROJECT_NAME)
  if [ -z "$value" ]; then
    say "$DEFAULT_PROJECT"
    return 0
  fi
  case $value in
    [abcdefghijklmnopqrstuvwxyz0123456789]*)
      case $value in
        *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*) ;;
        *)
          say "$value"
          return 0
          ;;
      esac
      ;;
  esac
  die 3 "$dir/.env names the compose project '$value', which this installer does not accept. Fix that line (agentic-worker-<name>) and run this again."
}

# A folder a new install may take: absent, or an empty folder.
folder_free() {
  [ ! -e "$1" ] || { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }
}

# The platform's slug, for a second worker that was given no --name; refused when there is none.
need_slug() {
  [ -n "$slug" ] || die 3 "another worker (the project $DEFAULT_PROJECT, or a folder ~/agentic-worker this installer did not make for this core) is already on this machine, and this script knows no name for a second one. Run it again with --name <a name for this worker> (a-z, 0-9 and -)."
}

# Where a new install goes, and under which name (decision 9 item 2): sets dir, PROJECT and
# install_name ('' for the first worker's project, agentic-worker).
plan_new_install() {
  install_name=''
  default_taken=$(docker ps --all --quiet --filter "label=com.docker.compose.project=$DEFAULT_PROJECT") ||
    die 1 'docker ps failed'
  if [ -n "$dir_given" ]; then
    dir=$dir_given
    if [ -n "$name" ]; then
      install_name=$name
    elif [ -n "$default_taken" ]; then
      need_slug
      install_name=$slug
    fi
  elif [ -n "$name" ]; then
    install_name=$name
    dir=$home/agentic-worker-$name
  elif folder_free "$home/agentic-worker" && [ -z "$default_taken" ]; then
    dir=$home/agentic-worker
  else
    need_slug
    install_name=$slug
    dir=$home/agentic-worker-$slug
  fi
  if [ -n "$install_name" ]; then PROJECT=$DEFAULT_PROJECT-$install_name; fi
}

# Refuses a new named install whose name another worker holds: its folder marked by another core,
# or its compose project already on this machine.
refuse_taken_name() {
  [ -n "$install_name" ] || return 0
  previous=$(core_of "$dir")
  # A --dir folder another core's install holds is refused below, as before (it was installed from).
  if [ -z "$dir_given" ] && [ -n "$previous" ] && [ "$previous" != "$core" ]; then
    die 3 "the name $install_name is taken on this machine: $dir holds the worker of $previous. Run this again with --name <another name>."
  fi
  taken=$(project_containers) || die 1 'docker ps failed'
  if [ -n "$taken" ]; then
    die 3 "the name $install_name is taken on this machine: the compose project $PROJECT already exists (another core's worker, or one made by hand). Run this again with --name <another name>."
  fi
}

# The page ports Docker's containers bind, in any state (a stopped worker keeps its port), one per
# line.
bound_ports() {
  ids=$(docker ps --all --quiet) || die 1 'docker ps failed'
  [ -n "$ids" ] || return 0
  # shellcheck disable=SC2086 # one container id per word
  docker inspect --format '{{range .HostConfig.PortBindings}}{{range .}}{{.HostPort}} {{end}}{{end}}' $ids \
    2>/dev/null | tr ' ' '\n' | grep '^[0-9][0-9]*$' || :
}

# Whether something listens on a port of 127.0.0.1: anything but curl's "could not connect" (7).
listening() {
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$1/" >/dev/null 2>&1 && code=0 || code=$?
  [ "$code" -ne 7 ]
}

# The first page port from 7357 that nothing listens on and no container binds.
first_free_port() {
  bound=$(bound_ports)
  port=7357
  while [ "$port" -le 7456 ]; do
    if ! printf '%s\n' "$bound" | grep -qx "$port" && ! listening "$port"; then
      say "$port"
      return 0
    fi
    port=$((port + 1))
  done
  die 1 'no page port from 7357 to 7456 is free on this machine. Set APP_WORKER_UI_PORT to a free one in this shell and run this again.'
}

# What a new named install writes into its .env besides the shell's settings (decision 9 item 1):
# COMPOSE_PROJECT_NAME, and its control volume, repository cache, run network and page port where
# this shell set none; a person's --name also as APP_WORKER_LABEL (a platform's name never is, so a
# later rename still reaches the page).
plan_named_settings() {
  installer_set COMPOSE_PROJECT_NAME "$PROJECT"
  [ -n "${APP_WORKER_CONTROL_VOLUME:-}" ] || installer_set APP_WORKER_CONTROL_VOLUME "$PROJECT-ctl"
  [ -n "${APP_WORKER_CACHE_VOLUME:-}" ] || installer_set APP_WORKER_CACHE_VOLUME "$PROJECT-repo-cache"
  [ -n "${APP_WORKER_RUN_NETWORK:-}" ] || installer_set APP_WORKER_RUN_NETWORK "$PROJECT-run-egress"
  if [ -z "${APP_WORKER_UI_PORT:-}" ]; then
    free_port=$(first_free_port)
    installer_set APP_WORKER_UI_PORT "$free_port"
  fi
  if [ -n "$name" ]; then installer_set APP_WORKER_LABEL "$name"; fi
}

# Finds this core's install (repaired), or plans a new one. Sets dir, PROJECT and install_name.
resolve_install() {
  UPDATER_MOUNTS=$(updater_folders)
  found=$(this_core_installs)
  install_name=''
  if [ -z "$found" ]; then
    plan_new_install
    return 0
  fi
  dir=$(printf '%s\n' "$found" | head -n 1)
  others=$(printf '%s\n' "$found" | sed '1d' | tr '\n' ' ')
  if [ -n "$others" ]; then
    warn "this core has another worker on this machine too, in ${others% }. This run takes care of $dir only; remove the other with --uninstall --dir <its folder>."
  fi
  if [ -n "$dir_given" ] && [ "$dir" != "$dir_given" ]; then
    warn "$dir_given holds no worker of $core; this core's worker is in $dir (one worker per core on a machine), so this run repairs that one."
  fi
  PROJECT=$(project_of_folder)
}

# --- Install (or repair) ---

install_worker() {
  need_docker
  resolve_install
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    die 3 "$dir exists and is not a folder; pass another with --dir"
  fi
  if [ -d "$dir" ] && [ ! -f "$dir/$MARK" ] && [ -n "$(ls -A "$dir")" ]; then
    die 3 "$dir exists and was not made by this installer (it has no $MARK). Pass another folder with --dir. A worker you set up there by hand keeps itself up to date; keep running it with docker compose in that folder."
  fi
  refuse_taken_name
  if [ -f "$dir/$MARK" ]; then
    previous=$(marked_core)
    if [ -n "$previous" ] && [ "$previous" != "$core" ]; then
      die 3 "this worker was installed from $previous, not $core. To move it, remove it first (--uninstall --purge) and install again."
    fi
  fi
  refuse_foreign_and_busy

  if [ -n "$install_name" ]; then
    plan_named_settings
    if [ -n "$name" ]; then
      say "Installing a worker named $install_name in $dir (compose project $PROJECT) ..."
    else
      say "Another worker already has ~/agentic-worker or the project $DEFAULT_PROJECT on this machine, so this core's worker is named after its platform: $install_name, in $dir (compose project $PROJECT). Pass --name to choose another name."
    fi
  elif [ -n "$name" ]; then
    # An existing install is never renamed (its volumes hold its approval and its sign-in).
    installer_set APP_WORKER_LABEL "$name"
    say "This core's worker is already installed in $dir (compose project $PROJECT); it keeps its folder and project, and --name sets only the label its page shows."
  fi
  # A first worker on a machine where a named one (of another core) already binds 7357: it takes
  # the first free port instead, written into .env like a named install's. With 7357 free nothing
  # is probed beyond Docker's bindings and nothing is written: the first install is today's.
  if [ -z "$found" ] && [ -z "$install_name" ] && [ -z "${APP_WORKER_UI_PORT:-}" ]; then
    bound=$(bound_ports)
    if printf '%s\n' "$bound" | grep -qx 7357; then
      free_port=$(first_free_port)
      installer_set APP_WORKER_UI_PORT "$free_port"
      say "Another worker on this machine has the page port 7357, so this one's page is on $free_port."
    fi
  fi

  made_dir=0
  [ -d "$dir" ] || made_dir=1
  mkdir -p "$dir"
  download_bundle
  refuse_shared_names
  write_mark
  save_settings
  served=$(pins_of_bundle "$dir/$DOWNLOAD")
  current=$(pins_of_block "$dir/.env")
  [ -n "$current" ] || current=$(pins_of_bundle "$dir/$BUNDLE")
  existing=$(project_containers) || die 1 'docker ps failed'
  # Asked only of a worker on another build that the updater never moved (no managed block).
  setup=set_up
  if [ -n "$existing" ] && [ "$current" != "$served" ] && [ -z "$(pins_of_block "$dir/.env")" ]; then
    setup=$(setup_state)
  fi

  if [ -z "$existing" ] && { [ -z "$current" ] || [ "$current" = "$served" ]; }; then
    mv -f "$dir/$DOWNLOAD" "$dir/$BUNDLE"
    say "Starting the worker in $dir ..."
    compose up -d || die 1 "docker compose up failed (see above). Fix what it names and run this again."
  elif [ -n "$existing" ] && [ "$current" = "$served" ]; then
    # The same build: create what is missing (a removed updater too), start what is stopped, and
    # recreate nothing.
    mv -f "$dir/$DOWNLOAD" "$dir/$BUNDLE"
    say "The worker is already installed in $dir; starting what is stopped and adding what is missing (nothing is recreated) ..."
    compose up -d --no-recreate || die 1 "docker compose up failed (see above)."
  elif [ "$setup" = not_set_up ]; then
    install_served
  elif [ -n "$existing" ]; then
    started=0
    if [ "$setup" = unknown ] && [ -f "$dir/$BUNDLE" ]; then
      # A stopped worker's page answers nothing: start it, and ask again once the page answers.
      say "Starting whatever of it is stopped (nothing is recreated) ..."
      compose start || {
        rm -f "$dir/$DOWNLOAD"
        die 1 "docker compose start failed (see above)."
      }
      started=1
      waited=0
      while :; do
        setup=$(setup_state)
        if [ "$setup" != unknown ] || [ "$waited" -ge "$wait_limit" ]; then break; fi
        sleep 2
        waited=$((waited + 2))
      done
    fi
    if [ "$setup" = not_set_up ]; then
      install_served
    else
      rm -f "$dir/$DOWNLOAD"
      say 'This worker runs another build than the core serves now. Its updater moves it there after verifying the build;'
      say 'this installer never changes the images a worker runs.'
      if [ "$started" -eq 0 ]; then
        [ -f "$dir/$BUNDLE" ] || die 3 "$dir/$BUNDLE is missing, so this installer cannot restart the worker; see: docker ps --all --filter label=com.docker.compose.project=$PROJECT"
        say "Starting whatever of it is stopped (nothing is recreated) ..."
        compose start || die 1 "docker compose start failed (see above)."
      fi
    fi
  else
    rm -f "$dir/$DOWNLOAD"
    die 3 "nothing of this worker is in Docker, and its folder pins another build than the core serves now. Installing the core's would bypass the updater's checks. Start it as it was (cd '$dir' && docker compose up -d) and its updater moves it forward, or remove it (--uninstall --purge) and install again."
  fi

  page=http://127.0.0.1:$(page_port)
  wait_for_worker
  say ''
  say 'The worker is running.'
  if open_page; then
    say "  Its page:   $page (opened in your browser)"
  else
    say "  Its page:   $page (open it in a browser)"
  fi
  say '              Sign in to Claude and approve this machine there. If the page asks for a token:'
  say "              cd '$dir' && docker compose logs remote-worker | grep token="
  say "  Its folder: $dir"
  if [ "$PROJECT" != "$DEFAULT_PROJECT" ]; then
    say "  Its name:   compose project $PROJECT (in $dir/.env, so docker compose there finds it)"
  fi
  say "  Updates:    automatic. Its updater follows $core; you never run this again to update."
  say '  Remove it:  run this script again with --uninstall (add --purge to remove its data too)'
}

# --- Uninstall ---

# The launcher's repository cache volume: APP_WORKER_CACHE_VOLUME (this shell, else .env), or the
# project's own default (`agentic-worker-repo-cache` for the first worker), never another worker's.
cache_volume() {
  volume=${APP_WORKER_CACHE_VOLUME:-}
  [ -n "$volume" ] || volume=$(env_value APP_WORKER_CACHE_VOLUME)
  case $volume in
    '' | *[!A-Za-z0-9_.-]*) volume=$PROJECT-repo-cache ;;
  esac
  say "$volume"
}

# Which install to remove: --name's folder (~/agentic-worker-NAME, or --dir), else --dir, else this
# core's install as a re-run finds it. Each must be this core's: removing another core's worker is
# that core's script's to do (or --core's).
resolve_uninstall() {
  if [ -n "$name" ] && [ -z "$dir_given" ]; then
    dir=$home/agentic-worker-$name
  elif [ -n "$dir_given" ]; then
    dir=$dir_given
  else
    UPDATER_MOUNTS=$(updater_folders)
    found=$(this_core_installs)
    [ -n "$found" ] || die 3 "nothing to remove: no worker of $core is installed on this machine (looked in ~/agentic-worker, ~/agentic-worker-* and the folders Docker's updaters mount). Pass --dir to name its folder."
    dir=$(printf '%s\n' "$found" | head -n 1)
    others=$(printf '%s\n' "$found" | sed '1d' | tr '\n' ' ')
    if [ -n "$others" ]; then
      warn "this core has another worker on this machine too, in ${others% }. This run removes $dir only; remove the other with --uninstall --dir <its folder>."
    fi
  fi
  [ -d "$dir" ] || die 3 "nothing to remove: $dir does not exist"
  [ -f "$dir/$MARK" ] || die 3 "$dir was not made by this installer (it has no $MARK); remove that worker yourself (docker compose down, in that folder)."
  previous=$(marked_core)
  if [ -n "$previous" ] && [ "$previous" != "$core" ]; then
    die 3 "$dir holds the worker of $previous, not of $core; remove it with that core's script (or add --core $previous)."
  fi
  PROJECT=$(project_of_folder)
}

uninstall_worker() {
  need_docker
  resolve_uninstall
  refuse_foreign_and_busy
  [ -f "$dir/$BUNDLE" ] || die 3 "$dir/$BUNDLE is missing, so this installer cannot tell Compose what to remove."
  if [ "$purge" -eq 1 ]; then
    cache=$(cache_volume)
    compose down --volumes --remove-orphans || die 1 'docker compose down failed (see above).'
    # The launcher's repository cache (cloned source) is the launcher's volume, not Compose's.
    if docker volume inspect "$cache" >/dev/null 2>&1; then
      docker volume rm "$cache" >/dev/null ||
        warn "kept the volume $cache (still in use?); remove it with: docker volume rm $cache"
    fi
    rm -f "$dir/$BUNDLE" "$dir/$DOWNLOAD" "$dir/.env" "$dir/.env.previous" "$dir/$MARK"
    if rmdir "$dir" 2>/dev/null; then
      say "Removed the worker, its volumes, its repository cache and $dir."
    else
      say "Removed the worker, its volumes and its repository cache. Kept $dir: it holds files this installer did not write."
    fi
  else
    compose down --remove-orphans || die 1 'docker compose down failed (see above).'
    say "Removed the worker's containers. Kept its volumes (its approval, its Claude sign-in) and $dir."
    say "To start it again as it was: cd '$dir' && docker compose up -d (its updater then follows the core)."
    say 'To remove the rest: run this script again with --uninstall --purge.'
  fi
  say 'Its images stay in Docker; docker image prune -a removes the ones nothing uses.'
}

case $action in
  install) install_worker ;;
  uninstall) uninstall_worker ;;
esac
