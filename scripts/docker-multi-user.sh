#!/usr/bin/env bash
if [ -z "${BASH_VERSION:-}" ]; then
  exec bash "$0" "$@"
fi

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"
DEFAULT_BASE_DIR="${OPENCLAW_MULTI_USER_ROOT:-$HOME/.openclaw-multi-user}"
DEFAULT_IMAGE="${OPENCLAW_IMAGE:-openclaw:local}"
DEFAULT_BIND="${OPENCLAW_GATEWAY_BIND:-loopback}"
DEFAULT_SHARED_SKILLS_MOUNT="/shared-skills"
BASE_DIR="$DEFAULT_BASE_DIR"

usage() {
  cat <<'EOF'
Usage:
  scripts/docker-multi-user.sh [--base-dir <path>] init [<instance>] [options]
  scripts/docker-multi-user.sh [--base-dir <path>] start <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] stop <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] restart <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] status <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] logs <instance> [docker compose logs args...]
  scripts/docker-multi-user.sh [--base-dir <path>] run <instance> [openclaw args...]
  scripts/docker-multi-user.sh [--base-dir <path>] auth <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] dashboard <instance>
  scripts/docker-multi-user.sh [--base-dir <path>] list
  scripts/docker-multi-user.sh [--base-dir <path>] print-env <instance>

Commands:
  init       Create per-instance directories and a .env file. Prompts when values are omitted.
  start      Start the instance with docker compose.
  stop       Stop the instance.
  restart    Restart the instance.
  status     Show compose status and configured ports.
  logs       Tail logs for the instance.
  run        Run a one-off openclaw CLI command in the instance network namespace.
  auth       Run OpenClaw onboarding for the saved auth choice of an instance.
  dashboard  Print the dashboard URL and token hint.
  list       List instances under the base directory.
  print-env  Print the generated env file path and contents.

Options for init:
  --base-dir <path>       Root directory for all instances (default: ~/.openclaw-multi-user)
  --gateway-port <port>   Gateway port (default: 18789)
  --bridge-port <port>    Bridge port (default: gateway port + 1)
  --bind <mode>           gateway.bind value: lan or loopback (default: loopback)
  --image <ref>           Container image (default: openclaw:local)
  --token <token>         Pre-set gateway token (default: random 64-hex)
  --config-dir <path>     Override per-instance config directory
  --workspace-dir <path>  Override per-instance workspace directory
  --project-name <name>   Override docker compose project name
  --shared-skills-dir <path>
                          Host directory to mount as a shared, read-only skills pack
  --shared-skills-mount <path>
                          Container path for the shared skills mount (default: /shared-skills)
  --auth-choice <choice>  Auth choice to save for the instance
  --force                 Overwrite an existing .env file

Notes:
  - Put per-instance plugins under <config-dir>/extensions so the container can see them.
  - Avoid host-only plugins.load.paths such as /Users/... unless that path is bind-mounted.
  - You can also set OPENCLAW_MULTI_USER_ROOT to change the default base dir.
  - Default bind mode is loopback for safer multi-user local deployments.
  - Supported init auth choices: skip, openai-api-key, apiKey, openai-codex, token
EOF
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing dependency: $1"
  fi
}

is_interactive_shell() {
  [[ -t 0 && -t 1 ]]
}

prompt_with_default() {
  local label="$1"
  local default_value="${2:-}"
  local answer=""

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " answer
    printf '%s\n' "${answer:-$default_value}"
    return
  fi

  while true; do
    read -r -p "$label: " answer
    if [[ -n "$answer" ]]; then
      printf '%s\n' "$answer"
      return
    fi
    echo "This value is required."
  done
}

prompt_optional() {
  local label="$1"
  local answer=""
  read -r -p "$label: " answer
  printf '%s\n' "$answer"
}

prompt_yes_no() {
  local label="$1"
  local default_value="${2:-y}"
  local answer=""
  local hint="y/N"

  if [[ "$default_value" == "y" ]]; then
    hint="Y/n"
  fi

  while true; do
    read -r -p "$label [$hint]: " answer
    answer="${answer:-$default_value}"
    case "$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
    esac
    echo "Enter y or n."
  done
}

ensure_dir() {
  local dir="$1"
  mkdir -p "$dir" 2>/dev/null || fail "Cannot create directory: $dir"
}

is_supported_init_auth_choice() {
  case "${1:-}" in
    ""|skip|openai-api-key|apiKey|openai-codex|token) return 0 ;;
    *) return 1 ;;
  esac
}

abs_path() {
  local target="$1"
  if [[ "$target" == /* ]]; then
    printf '%s\n' "$target"
    return
  fi
  local dir
  dir="$(dirname "$target")"
  local base
  base="$(cd "$dir" && pwd)"
  printf '%s/%s\n' "$base" "$(basename "$target")"
}

sanitize_name() {
  local raw="$1"
  local sanitized
  sanitized="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._-' '-')"
  sanitized="${sanitized#-}"
  sanitized="${sanitized%-}"
  [[ -n "$sanitized" ]] || fail "Instance name must contain at least one letter or number."
  printf '%s\n' "$sanitized"
}

random_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return
  fi
  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

instance_dir_for() {
  local base_dir="$1"
  local instance="$2"
  printf '%s/%s\n' "$base_dir" "$instance"
}

env_file_for() {
  local base_dir="$1"
  local instance="$2"
  printf '%s/.env\n' "$(instance_dir_for "$base_dir" "$instance")"
}

project_name_for() {
  local instance="$1"
  printf 'openclaw-%s\n' "$instance"
}

extra_compose_file_for() {
  local base_dir="$1"
  local instance="$2"
  printf '%s/docker-compose.extra.yml\n' "$(instance_dir_for "$base_dir" "$instance")"
}

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || fail "Missing env file: $env_file. Run init first."

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -n "$line" ]] || continue
    [[ "$line" != \#* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    export "$key=$value"
  done <"$env_file"
}

compose() {
  local env_file="$1"
  local project_name="$2"
  local extra_compose_file="$3"
  shift 3
  local args=(
    --project-name "$project_name"
    --env-file "$env_file"
    -f "$COMPOSE_FILE"
  )
  if [[ -n "$extra_compose_file" && -f "$extra_compose_file" ]]; then
    args+=(-f "$extra_compose_file")
  fi
  docker compose "${args[@]}" "$@"
}

write_instance_extra_compose() {
  local file="$1"
  local shared_skills_dir="$2"
  local shared_skills_mount="$3"

  cat >"$file" <<EOF
services:
  openclaw-gateway:
    volumes:
      - ${shared_skills_dir}:${shared_skills_mount}:ro
  openclaw-cli:
    volumes:
      - ${shared_skills_dir}:${shared_skills_mount}:ro
EOF
}

update_config_shared_skills() {
  local config_path="$1"
  local shared_skills_mount="$2"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$config_path" "$shared_skills_mount" <<'PY'
import json
import os
import sys

config_path = sys.argv[1]
shared_mount = sys.argv[2]

cfg = {}
if os.path.exists(config_path):
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}

skills = cfg.get("skills")
if not isinstance(skills, dict):
    skills = {}
load = skills.get("load")
if not isinstance(load, dict):
    load = {}
extra_dirs = load.get("extraDirs")
if not isinstance(extra_dirs, list):
    extra_dirs = []
if shared_mount not in extra_dirs:
    extra_dirs.append(shared_mount)
load["extraDirs"] = extra_dirs
skills["load"] = load
cfg["skills"] = skills

os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
    return
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$config_path" "$shared_skills_mount" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = process.argv[2];
const sharedMount = process.argv[3];

let cfg = {};
if (fs.existsSync(configPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    cfg = {};
  }
}

const skills = typeof cfg.skills === "object" && cfg.skills ? cfg.skills : {};
const load = typeof skills.load === "object" && skills.load ? skills.load : {};
const extraDirs = Array.isArray(load.extraDirs) ? load.extraDirs : [];
if (!extraDirs.includes(sharedMount)) {
  extraDirs.push(sharedMount);
}
load.extraDirs = extraDirs;
skills.load = load;
cfg.skills = skills;

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
NODE
    return
  fi

  fail "Updating shared skills config requires python3 or node."
}

cmd_init() {
  require_cmd docker
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is not available."

  local instance="${1:-}"
  if [[ -n "$instance" && "$instance" != --* ]]; then
    shift || true
    instance="$(sanitize_name "$instance")"
  else
    instance=""
  fi

  local base_dir="$BASE_DIR"
  local gateway_port="18789"
  local bridge_port=""
  local bind="$DEFAULT_BIND"
  local image="$DEFAULT_IMAGE"
  local token=""
  local config_dir=""
  local workspace_dir=""
  local project_name=""
  local shared_skills_dir=""
  local shared_skills_mount="$DEFAULT_SHARED_SKILLS_MOUNT"
  local auth_choice=""
  local auth_secret=""
  local force="0"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base-dir)
        base_dir="$2"
        shift 2
        ;;
      --gateway-port)
        gateway_port="$2"
        shift 2
        ;;
      --bridge-port)
        bridge_port="$2"
        shift 2
        ;;
      --bind)
        bind="$2"
        shift 2
        ;;
      --image)
        image="$2"
        shift 2
        ;;
      --token)
        token="$2"
        shift 2
        ;;
      --config-dir)
        config_dir="$2"
        shift 2
        ;;
      --workspace-dir)
        workspace_dir="$2"
        shift 2
        ;;
      --project-name)
        project_name="$2"
        shift 2
        ;;
      --shared-skills-dir)
        shared_skills_dir="$2"
        shift 2
        ;;
      --shared-skills-mount)
        shared_skills_mount="$2"
        shift 2
        ;;
      --auth-choice)
        auth_choice="$2"
        shift 2
        ;;
      --force)
        force="1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown option for init: $1"
        ;;
    esac
  done

  if [[ -z "$instance" ]]; then
    if ! is_interactive_shell; then
      fail "init requires <instance> in non-interactive mode."
    fi

    echo "OpenClaw Docker multi-user init"
    echo

    instance="$(sanitize_name "$(prompt_with_default "Instance name")")"
    base_dir="$(prompt_with_default "Base directory" "$base_dir")"
    gateway_port="$(prompt_with_default "Gateway port" "$gateway_port")"
    [[ "$gateway_port" =~ ^[0-9]+$ ]] || fail "Gateway port must be numeric."

    local suggested_bridge_port="$((gateway_port + 1))"
    bridge_port="$(prompt_with_default "Bridge port" "${bridge_port:-$suggested_bridge_port}")"
    bind="$(prompt_with_default "Bind mode (lan or loopback)" "$bind")"
    image="$(prompt_with_default "Docker image" "$image")"

    base_dir="$(abs_path "$base_dir")"
    local prompted_instance_dir
    prompted_instance_dir="$(instance_dir_for "$base_dir" "$instance")"
    local prompted_default_config_dir="$prompted_instance_dir/.openclaw"
    local prompted_default_workspace_dir="$prompted_instance_dir/workspace"
    local prompted_default_project_name
    prompted_default_project_name="$(project_name_for "$instance")"

    config_dir="$(prompt_with_default "Config directory" "${config_dir:-$prompted_default_config_dir}")"
    workspace_dir="$(prompt_with_default "Workspace directory" "${workspace_dir:-$prompted_default_workspace_dir}")"
    project_name="$(prompt_with_default "Compose project name" "${project_name:-$prompted_default_project_name}")"
    shared_skills_dir="$(prompt_optional "Shared skills host directory (optional)")"
    if [[ -n "$shared_skills_dir" ]]; then
      shared_skills_mount="$(prompt_with_default "Shared skills mount path" "$shared_skills_mount")"
    fi
    auth_choice="$(prompt_with_default "Auth choice (skip/openai-api-key/apiKey/openai-codex/token)" "${auth_choice:-skip}")"
    if [[ "$auth_choice" == "openai-api-key" ]]; then
      auth_secret="$(prompt_optional "OpenAI API key (optional; leave blank to configure later)")"
    elif [[ "$auth_choice" == "apiKey" ]]; then
      auth_secret="$(prompt_optional "Anthropic API key (optional; leave blank to configure later)")"
    elif [[ "$auth_choice" == "token" ]]; then
      auth_secret="$(prompt_optional "Anthropic setup-token (optional; leave blank to configure later)")"
    fi

    if [[ -z "$token" ]]; then
      token="$(prompt_optional "Gateway token (leave blank to auto-generate)")"
    fi
  fi

  [[ "$gateway_port" =~ ^[0-9]+$ ]] || fail "--gateway-port must be numeric."
  if [[ -z "$bridge_port" ]]; then
    bridge_port="$((gateway_port + 1))"
  fi
  [[ "$bridge_port" =~ ^[0-9]+$ ]] || fail "--bridge-port must be numeric."
  [[ "$bind" == "lan" || "$bind" == "loopback" ]] || fail "--bind must be lan or loopback."
  is_supported_init_auth_choice "$auth_choice" || fail "Unsupported --auth-choice: $auth_choice"

  base_dir="$(abs_path "$base_dir")"
  local instance_dir
  instance_dir="$(instance_dir_for "$base_dir" "$instance")"
  local default_config_dir="$instance_dir/.openclaw"
  local default_workspace_dir="$instance_dir/workspace"
  config_dir="$(abs_path "${config_dir:-$default_config_dir}")"
  workspace_dir="$(abs_path "${workspace_dir:-$default_workspace_dir}")"
  project_name="${project_name:-$(project_name_for "$instance")}"
  if [[ -n "$shared_skills_dir" ]]; then
    shared_skills_dir="$(abs_path "$shared_skills_dir")"
  fi
  token="${token:-$(random_token)}"

  ensure_dir "$instance_dir"
  ensure_dir "$config_dir"
  ensure_dir "$workspace_dir"
  ensure_dir "$config_dir/extensions"
  ensure_dir "$config_dir/identity"
  ensure_dir "$config_dir/agents/main/agent"
  ensure_dir "$config_dir/agents/main/sessions"

  local env_file
  env_file="$(env_file_for "$base_dir" "$instance")"
  if [[ -f "$env_file" && "$force" != "1" ]]; then
    if is_interactive_shell && prompt_yes_no "$env_file already exists. Overwrite it?" "n"; then
      force="1"
    else
      fail "$env_file already exists. Re-run with --force to overwrite it."
    fi
  fi

  cat >"$env_file" <<EOF
OPENCLAW_CONFIG_DIR=$config_dir
OPENCLAW_WORKSPACE_DIR=$workspace_dir
OPENCLAW_GATEWAY_PORT=$gateway_port
OPENCLAW_BRIDGE_PORT=$bridge_port
OPENCLAW_GATEWAY_BIND=$bind
OPENCLAW_GATEWAY_TOKEN=$token
OPENCLAW_IMAGE=$image
OPENCLAW_INSTANCE_NAME=$instance
OPENCLAW_PROJECT_NAME=$project_name
OPENCLAW_SHARED_SKILLS_DIR=$shared_skills_dir
OPENCLAW_SHARED_SKILLS_MOUNT=$shared_skills_mount
OPENCLAW_INIT_AUTH_CHOICE=${auth_choice:-skip}
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENCLAW_SETUP_TOKEN=
EOF

  if [[ "$auth_choice" == "openai-api-key" && -n "$auth_secret" ]]; then
    printf 'OPENAI_API_KEY=%s\n' "$auth_secret" >>"$env_file"
  elif [[ "$auth_choice" == "apiKey" && -n "$auth_secret" ]]; then
    printf 'ANTHROPIC_API_KEY=%s\n' "$auth_secret" >>"$env_file"
  elif [[ "$auth_choice" == "token" && -n "$auth_secret" ]]; then
    printf 'OPENCLAW_SETUP_TOKEN=%s\n' "$auth_secret" >>"$env_file"
  fi

  local extra_compose_file=""
  extra_compose_file="$(extra_compose_file_for "$base_dir" "$instance")"
  if [[ -n "$shared_skills_dir" ]]; then
    ensure_dir "$shared_skills_dir"
    write_instance_extra_compose "$extra_compose_file" "$shared_skills_dir" "$shared_skills_mount"
    update_config_shared_skills "$config_dir/openclaw.json" "$shared_skills_mount"
  elif [[ -f "$extra_compose_file" ]]; then
    rm -f "$extra_compose_file"
  fi

  echo "Initialized instance: $instance"
  echo "  project: $project_name"
  echo "  env: $env_file"
  echo "  config: $config_dir"
  echo "  workspace: $workspace_dir"
  echo "  plugins: $config_dir/extensions"
  echo "  gateway: http://127.0.0.1:$gateway_port/"
  if [[ -n "$shared_skills_dir" ]]; then
    echo "  shared skills: $shared_skills_dir -> $shared_skills_mount"
  fi
  if [[ -n "$auth_choice" && "$auth_choice" != "skip" ]]; then
    echo "  auth choice: $auth_choice"
  fi
  echo
  echo "Next steps:"
  echo "  1. scripts/docker-multi-user.sh start $instance"
  echo "  2. scripts/docker-multi-user.sh auth $instance"
  echo "  3. scripts/docker-multi-user.sh run $instance doctor"
  echo "  4. scripts/docker-multi-user.sh run $instance config set gateway.bind $bind"
}

cmd_start_stop_restart() {
  require_cmd docker
  local action="$1"
  local instance="${2:-}"
  [[ -n "$instance" ]] || fail "$action requires <instance>"
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  local project_name="${OPENCLAW_PROJECT_NAME:-$(project_name_for "$instance")}"
  local extra_compose_file
  extra_compose_file="$(extra_compose_file_for "$(abs_path "$BASE_DIR")" "$instance")"

  case "$action" in
    start)
      compose "$env_file" "$project_name" "$extra_compose_file" up -d
      ;;
    stop)
      compose "$env_file" "$project_name" "$extra_compose_file" down
      ;;
    restart)
      compose "$env_file" "$project_name" "$extra_compose_file" down
      compose "$env_file" "$project_name" "$extra_compose_file" up -d
      ;;
  esac
}

cmd_status() {
  require_cmd docker
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "status requires <instance>"
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  local project_name="${OPENCLAW_PROJECT_NAME:-$(project_name_for "$instance")}"
  local extra_compose_file
  extra_compose_file="$(extra_compose_file_for "$(abs_path "$BASE_DIR")" "$instance")"

  echo "instance: $instance"
  echo "project: $project_name"
  echo "config: $OPENCLAW_CONFIG_DIR"
  echo "workspace: $OPENCLAW_WORKSPACE_DIR"
  echo "gateway: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/"
  echo "bridge:  http://127.0.0.1:${OPENCLAW_BRIDGE_PORT}/"
  if [[ -n "${OPENCLAW_SHARED_SKILLS_DIR:-}" ]]; then
    echo "shared skills: ${OPENCLAW_SHARED_SKILLS_DIR} -> ${OPENCLAW_SHARED_SKILLS_MOUNT}"
  fi
  echo
  compose "$env_file" "$project_name" "$extra_compose_file" ps
}

cmd_logs() {
  require_cmd docker
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "logs requires <instance>"
  shift || true
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  local project_name="${OPENCLAW_PROJECT_NAME:-$(project_name_for "$instance")}"
  local extra_compose_file
  extra_compose_file="$(extra_compose_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  if [[ $# -eq 0 ]]; then
    compose "$env_file" "$project_name" "$extra_compose_file" logs -f openclaw-gateway
    return
  fi
  compose "$env_file" "$project_name" "$extra_compose_file" logs "$@"
}

cmd_run() {
  require_cmd docker
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "run requires <instance>"
  shift || true
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  local project_name="${OPENCLAW_PROJECT_NAME:-$(project_name_for "$instance")}"
  local extra_compose_file
  extra_compose_file="$(extra_compose_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  if [[ $# -eq 0 ]]; then
    fail "run requires at least one openclaw CLI argument"
  fi
  compose "$env_file" "$project_name" "$extra_compose_file" run --rm openclaw-cli "$@"
}

cmd_dashboard() {
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "dashboard requires <instance>"
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  echo "Dashboard: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/"
  echo "Token: $OPENCLAW_GATEWAY_TOKEN"
  if [[ -n "${OPENCLAW_SHARED_SKILLS_DIR:-}" ]]; then
    echo "Shared skills: ${OPENCLAW_SHARED_SKILLS_DIR} -> ${OPENCLAW_SHARED_SKILLS_MOUNT}"
  fi
  if [[ -n "${OPENCLAW_INIT_AUTH_CHOICE:-}" && "${OPENCLAW_INIT_AUTH_CHOICE}" != "skip" ]]; then
    echo "Auth choice: ${OPENCLAW_INIT_AUTH_CHOICE}"
  fi
}

cmd_auth() {
  require_cmd docker
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "auth requires <instance>"
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  load_env_file "$env_file"
  local project_name="${OPENCLAW_PROJECT_NAME:-$(project_name_for "$instance")}"
  local extra_compose_file
  extra_compose_file="$(extra_compose_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  local auth_choice="${OPENCLAW_INIT_AUTH_CHOICE:-skip}"

  if [[ "$auth_choice" == "skip" || -z "$auth_choice" ]]; then
    fail "No auth choice saved for $instance. Re-run init with --auth-choice or edit $env_file."
  fi

  case "$auth_choice" in
    openai-api-key)
      [[ -n "${OPENAI_API_KEY:-}" ]] || fail "OPENAI_API_KEY is empty. Re-run init or edit $env_file."
      compose "$env_file" "$project_name" "$extra_compose_file" run --rm \
        -e OPENAI_API_KEY="${OPENAI_API_KEY:-}" \
        openclaw-cli onboard --non-interactive --accept-risk --auth-choice openai-api-key \
        --openai-api-key "${OPENAI_API_KEY:-}" --secret-input-mode plaintext \
        --skip-channels --skip-skills --skip-search --skip-ui
      ;;
    apiKey)
      [[ -n "${ANTHROPIC_API_KEY:-}" ]] || fail "ANTHROPIC_API_KEY is empty. Re-run init or edit $env_file."
      compose "$env_file" "$project_name" "$extra_compose_file" run --rm \
        -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        openclaw-cli onboard --non-interactive --accept-risk --auth-choice apiKey \
        --anthropic-api-key "${ANTHROPIC_API_KEY:-}" --secret-input-mode plaintext \
        --skip-channels --skip-skills --skip-search --skip-ui
      ;;
    token)
      compose "$env_file" "$project_name" "$extra_compose_file" run --rm \
        openclaw-cli onboard --auth-choice token
      ;;
    openai-codex)
      compose "$env_file" "$project_name" "$extra_compose_file" run --rm \
        openclaw-cli onboard --auth-choice openai-codex
      ;;
    *)
      fail "Unsupported saved auth choice: $auth_choice"
      ;;
  esac
}

cmd_list() {
  local base_dir
  base_dir="$(abs_path "$BASE_DIR")"
  [[ -d "$base_dir" ]] || {
    echo "No instances under $base_dir"
    return
  }
  local found="0"
  local env_file
  local list_file
  list_file="$(mktemp)"
  find "$base_dir" -mindepth 2 -maxdepth 2 -name .env -type f | sort >"$list_file"
  while IFS= read -r env_file; do
    found="1"
    local instance_dir
    instance_dir="$(dirname "$env_file")"
    printf '%s\n' "$(basename "$instance_dir")"
  done <"$list_file"
  rm -f "$list_file"
  [[ "$found" == "1" ]] || echo "No instances under $base_dir"
}

cmd_print_env() {
  local instance="${1:-}"
  [[ -n "$instance" ]] || fail "print-env requires <instance>"
  instance="$(sanitize_name "$instance")"
  local env_file
  env_file="$(env_file_for "$(abs_path "$BASE_DIR")" "$instance")"
  [[ -f "$env_file" ]] || fail "Missing env file: $env_file"
  echo "$env_file"
  echo
  cat "$env_file"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base-dir)
        [[ $# -ge 2 ]] || fail "--base-dir requires a value"
        BASE_DIR="$2"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        break
        ;;
    esac
  done

  local command="${1:-}"
  if [[ -z "$command" ]]; then
    if is_interactive_shell; then
      cmd_init
      return
    fi
    usage
    return
  fi
  case "$command" in
    init)
      shift
      cmd_init "$@"
      ;;
    start|stop|restart)
      cmd_start_stop_restart "$@"
      ;;
    status)
      shift
      cmd_status "$@"
      ;;
    logs)
      shift
      cmd_logs "$@"
      ;;
    run)
      shift
      cmd_run "$@"
      ;;
    auth)
      shift
      cmd_auth "$@"
      ;;
    dashboard)
      shift
      cmd_dashboard "$@"
      ;;
    list)
      cmd_list
      ;;
    print-env)
      shift
      cmd_print_env "$@"
      ;;
    -h|--help)
      usage
      ;;
    *)
      fail "Unknown command: $command"
      ;;
  esac
}

main "$@"
