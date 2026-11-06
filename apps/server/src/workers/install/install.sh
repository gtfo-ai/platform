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
#   - the Docker containers, volumes and networks of the compose project `agentic-worker`, created by
#     `docker compose up -d` in that folder. Docker keeps them running across restarts.
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
PROJECT=agentic-worker
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
Usage: sh install.sh [--dir DIR] [--core URL] [--no-open]
       sh install.sh --uninstall [--purge] [--dir DIR]

  --dir DIR     the worker's folder (default: ~/agentic-worker)
  --core URL    download the worker bundle from this core instead of the one that served this script
  --no-open     do not open the worker's page in a browser
  --uninstall   stop and remove the worker's containers; keep its volumes and folder
  --purge       with --uninstall: also remove its volumes (its approval, its Claude sign-in) and folder

Piped from curl, pass options after `sh -s --`, for example: curl -fsSL URL | sh -s -- --uninstall
AGENTIC_INSTALL_WAIT_SECONDS (default 300) bounds the wait for the worker to start.
USAGE
}

dir=''
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

[ -n "${HOME:-}" ] || die 2 'HOME is not set; pass --dir'
[ -n "$dir" ] || dir=$HOME/agentic-worker
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

# `docker compose` in the worker's folder, as the project `agentic-worker`. Variables from this shell
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

# The folders other than this one that the project `agentic-worker` was brought up from, read off
# Compose's working_dir label only to spot another install: the updater's own mount path is ours.
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
  printf '%s\n' "$folders" | sort -u | while IFS= read -r folder; do
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
  sed -n 's/^core=//p' "$dir/$MARK" | head -n 1
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

# The name a variable resolves to for Compose: this shell, else .env, else the downloaded bundle's
# default.
resolved_value() {
  eval "value=\${$1:-}"
  [ -n "$value" ] || value=$(env_value "$1")
  [ -n "$value" ] || value=$(default_pin "$dir/$DOWNLOAD" "$1")
  say "$value"
}

# The variable a line of an env file assigns (`NAME=...`, `export NAME=...`), or nothing.
assigned_name() {
  printf '%s\n' "$1" |
    sed -n 's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p'
}

# `NAME=value` for a setting of this shell.
setting_line() {
  eval "value=\${$1:-}"
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
        name=$(assigned_name "$line")
        case " $names " in
          *" ${name:-.} "*)
            case $written in
              *" $name "*) ;;
              *)
                setting_line "$name"
                written="$written$name "
                ;;
            esac
            continue
            ;;
        esac
        printf '%s\n' "$line"
      done <"$read_copy"
    fi
    for name in $names; do
      case $written in *" $name "*) continue ;; esac
      setting_line "$name"
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

# --- Install (or repair) ---

install_worker() {
  need_docker
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    die 3 "$dir exists and is not a folder; pass another with --dir"
  fi
  if [ -d "$dir" ] && [ ! -f "$dir/$MARK" ] && [ -n "$(ls -A "$dir")" ]; then
    die 3 "$dir exists and was not made by this installer (it has no $MARK). Pass another folder with --dir. A worker you set up there by hand keeps itself up to date; keep running it with docker compose in that folder."
  fi
  if [ -f "$dir/$MARK" ]; then
    previous=$(marked_core)
    if [ -n "$previous" ] && [ "$previous" != "$core" ]; then
      die 3 "this worker was installed from $previous, not $core. To move it, remove it first (--uninstall --purge) and install again."
    fi
  fi
  refuse_foreign_and_busy

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
  say "  Updates:    automatic. Its updater follows $core; you never run this again to update."
  say '  Remove it:  run this script again with --uninstall (add --purge to remove its data too)'
}

# --- Uninstall ---

# The launcher's repository cache volume: APP_WORKER_CACHE_VOLUME (this shell, else .env), or the
# bundle's default.
cache_volume() {
  volume=${APP_WORKER_CACHE_VOLUME:-}
  [ -n "$volume" ] || volume=$(env_value APP_WORKER_CACHE_VOLUME)
  case $volume in
    '' | *[!A-Za-z0-9_.-]*) volume=agentic-worker-repo-cache ;;
  esac
  say "$volume"
}

uninstall_worker() {
  need_docker
  [ -d "$dir" ] || die 3 "nothing to remove: $dir does not exist"
  [ -f "$dir/$MARK" ] || die 3 "$dir was not made by this installer (it has no $MARK); remove that worker yourself (docker compose down, in that folder)."
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
