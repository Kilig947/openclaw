---
summary: "Run multiple OpenClaw Gateways on one host (isolation, ports, and profiles)"
read_when:
  - Running more than one Gateway on the same machine
  - You need isolated config/state/ports per Gateway
title: "Multiple Gateways"
---

# Multiple Gateways (same host)

Most setups should use one Gateway because a single Gateway can handle multiple messaging connections and agents. If you need stronger isolation or redundancy (e.g., a rescue bot), run separate Gateways with isolated profiles/ports.

## Isolation checklist (required)

- `OPENCLAW_CONFIG_PATH` — per-instance config file
- `OPENCLAW_STATE_DIR` — per-instance sessions, creds, caches
- `agents.defaults.workspace` — per-instance workspace root
- `gateway.port` (or `--port`) — unique per instance
- Derived ports (browser/canvas) must not overlap

If these are shared, you will hit config races and port conflicts.

## Recommended: profiles (`--profile`)

Profiles auto-scope `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` and suffix service names.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Per-profile services:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Rescue-bot guide

Run a second Gateway on the same host with its own:

- profile/config
- state dir
- workspace
- base port (plus derived ports)

This keeps the rescue bot isolated from the main bot so it can debug or apply config changes if the primary bot is down.

Port spacing: leave at least 20 ports between base ports so the derived browser/canvas/CDP ports never collide.

### How to install (rescue bot)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Port mapping (derived)

Base port = `gateway.port` (or `OPENCLAW_GATEWAY_PORT` / `--port`).

- browser control service port = base + 2 (loopback only)
- canvas host is served on the Gateway HTTP server (same port as `gateway.port`)
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108`

If you override any of these in config or env, you must keep them unique per instance.

## Browser/CDP notes (common footgun)

- Do **not** pin `browser.cdpUrl` to the same values on multiple instances.
- Each instance needs its own browser control port and CDP range (derived from its gateway port).
- If you need explicit CDP ports, set `browser.profiles.<name>.cdpPort` per instance.
- Remote Chrome: use `browser.profiles.<name>.cdpUrl` (per profile, per instance).

## Manual env example

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Quick checks

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```

## Docker per-user instances

If you want one Dockerized Gateway per user, isolate each instance with its own:

- config dir
- workspace dir
- ports
- gateway token
- Compose project name

The simplest path in this repo is `pnpm docker:mu -- ...`.

Initialize one instance per user:

```bash
pnpm docker:mu -- init
pnpm docker:mu -- init alice --gateway-port 18789 --bind lan
pnpm docker:mu -- init bob --gateway-port 18889 --bind lan
```

Running `init` without arguments starts an interactive prompt for instance name,
ports, directories, image, and token.

If you want one shared skill pack for every user, point each instance at the
same host directory:

```bash
pnpm docker:mu -- init alice \
  --gateway-port 18789 \
  --shared-skills-dir /srv/openclaw/shared-skills

pnpm docker:mu -- init bob \
  --gateway-port 18889 \
  --shared-skills-dir /srv/openclaw/shared-skills
```

The helper will:

- mount `/srv/openclaw/shared-skills` into each container read-only
- add that container path to `skills.load.extraDirs`
- keep user-specific `workspace/skills` and `~/.openclaw/skills` isolated

This creates:

- `/srv/openclaw/instances/alice/.openclaw`
- `/srv/openclaw/instances/alice/workspace`
- `/srv/openclaw/instances/alice/.env`

and the same layout for `bob`.

Start the instances:

```bash
pnpm docker:mu -- start alice
pnpm docker:mu -- start bob
```

Run per-instance CLI commands through the matching container network namespace:

```bash
pnpm docker:mu -- run alice doctor
pnpm docker:mu -- run alice config get gateway.bind
pnpm docker:mu -- run bob plugins list
```

Check status or logs:

```bash
pnpm docker:mu -- status alice
pnpm docker:mu -- logs alice
pnpm docker:mu -- start bob
```

### Docker layout

Each instance keeps its own state under one base directory:

```text
/srv/openclaw/
  instances/
    alice/
      .env
      .openclaw/
        extensions/
        openclaw.json
      workspace/
    bob/
      .env
      .openclaw/
        extensions/
        openclaw.json
      workspace/
```

### Plugin path rule

For Docker instances, do not point `plugins.load.paths` at host-only development paths such as `/Users/.../openclaw/extensions/feishu` unless you also bind-mount that host path into the container.

Prefer one of these instead:

- copy/install the plugin into the instance config dir under `.openclaw/extensions`
- use bundled plugins already present in the image
- add an explicit bind mount and then reference the container-visible path

### Shared skills rule

Shared skills are safe to centralize because OpenClaw already supports shared
skill directories via `skills.load.extraDirs`. Keep the shared directory
read-only in Docker so one user cannot mutate the skill pack for all other
users.
