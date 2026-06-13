<div align="center">

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-messenger-swarm/main/banner.png" alt="pi-messenger-swarm" width="1100">
</p>

# Pi Messenger (Swarm Mode)

**Channel-first multi-agent coordination for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_Auto-started local harness, durable channels, spawnable agents, and Beads/`br` task orchestration._

> This repo is a fork of [monotykamary/pi-messenger-swarm](https://github.com/monotykamary/pi-messenger-swarm). In this fork, **Beads/`br` is the preferred task backend**: if `.beads/` exists and `br` is available, swarm task commands route to Beads automatically.

</div>

[![npm version](https://img.shields.io/npm/v/pi-messenger-swarm?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger-swarm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

---

## What this fork adds

- **Beads/`br` task backend with auto-detection**
- **Channel-scoped task views** on top of Beads labels
- **Artifact directories** under `.beads/artifacts/<bead-id>/`
- **`spawn --model provider/model`**
- **Per-provider concurrency limits**
- **`team` command** for wave-based multi-agent runs
- **Spawn preservation across harness restart**
- **`pi-vcc`-friendly compaction/feed integration**

## Install

### From npm

```bash
pi install npm:pi-messenger-swarm
```

### From this fork

```json
{
  "packages": ["https://github.com/ryan-brosas/pi-messenger-swarm@main"]
}
```

> Note: the published npm release may lag behind this fork. Features like `team`, `spawn --model`, and newer Beads behavior may exist here before they are released.

## Quick start

Join the messenger in your current Pi session:

```bash
pi-messenger-swarm join
pi-messenger-swarm status
pi-messenger-swarm feed --limit 20
```

Post a durable note to a named channel:

```bash
pi-messenger-swarm send #memory "Investigating auth timeout in refresh flow"
```

Create and work a task:

```bash
pi-messenger-swarm task create --title "Investigate auth timeout" --content "Repro, isolate, and fix"
pi-messenger-swarm task claim task-1
pi-messenger-swarm task progress task-1 "Found race in refresh flow"
pi-messenger-swarm task show task-1
pi-messenger-swarm task done task-1 "Fixed refresh lock and verified behavior"
```

Spawn a specialist onto a task:

```bash
pi-messenger-swarm spawn \
  --task-id task-1 \
  --role Debugger \
  --model openai-codex/gpt-5.5 \
  "Trace the auth timeout and propose a fix"
```

Run a predefined multi-agent team:

```bash
pi-messenger-swarm team run \
  --agent-file ~/.pi/teams/plan-implement-audit.yaml \
  "Fix the auth timeout"
```

## Beads / `br` task backend

This fork is **Beads-first**.

If both of these are true:

- `.beads/` exists in the project
- `br` is installed and on `PATH`

...then task commands automatically use the Beads backend.

Initialize Beads in a project:

```bash
br init
```

No `BR_TASK_STORE=1` flag is required in this fork.

### How swarm maps onto Beads

| Swarm concept   | Beads / `br` mapping                            |
| --------------- | ----------------------------------------------- |
| `task create`   | `br create`                                     |
| `task claim`    | `br update --status in_progress --assignee ...` |
| `task done`     | `br close --reason ...`                         |
| `task block`    | `br update --status blocked`                    |
| `task progress` | `br comment add`                                |
| dependencies    | `br dep ...`                                    |
| current channel | label: `swarm:channel:<name>`                   |
| swarm task id   | label: `swarm:task:task-N`                      |

Important details:

- The swarm CLI still exposes **swarm ids** like `task-1`.
- Those ids are mapped to native Beads ids in `.pi/messenger/br-task-map.json`.
- Channel scoping is implemented with Beads labels like `swarm:channel:memory`.
- Artifact files live under `.beads/artifacts/<bead-id>/`.

### Artifact files

When using Beads, the adapter can create or use files like:

- `prd.md`
- `prd.json`
- `progress.txt`
- `context-capsule.md`
- `completion-evidence.json`

These live under:

```text
.beads/artifacts/<bead-id>/
```

### Fallback behavior

If `.beads/` is missing or `br` is unavailable, swarm falls back to the legacy JSONL task store in:

```text
.pi/messenger/tasks/
```

## Channels

Pi Messenger is **channel-first**.

### Session channels

Each Pi session gets a default session channel, restored when the session is resumed.

### Named channels

Named channels are durable and cross-session. Common example:

- `#memory` — durable notes, handoffs, decisions

Examples:

```bash
pi-messenger-swarm join --channel architecture --create
pi-messenger-swarm send #architecture "Need API shape before refactor"
pi-messenger-swarm feed --channel architecture --limit 20
```

### Messaging rules

`send` always requires an explicit target:

```bash
pi-messenger-swarm send OtherAgent "Need your review"
pi-messenger-swarm send #memory "Remember this decision"
```

There is no implicit broadcast.

## Spawn and team workflows

### Spawn a single agent

```bash
pi-messenger-swarm spawn --role Researcher "Analyze the protocol"
```

Useful flags:

- `--task-id <id>`
- `--role <label>`
- `--persona <text>`
- `--agent-file <path>`
- `--objective <text>`
- `--context <text>`
- `--message-file <path>`
- `--model provider/model`
- `--force`

### Team command

The `team` command runs a YAML-defined wave plan.

```bash
pi-messenger-swarm team list
pi-messenger-swarm team show ~/.pi/teams/scan-fix-verify.yaml
pi-messenger-swarm team run --agent-file ~/.pi/teams/scan-fix-verify.yaml "Fix the bug"
```

Current behavior:

- creates tasks for all steps
- applies dependencies
- spawns wave 0 immediately
- auto-advances later waves when dependencies complete
- respects global and per-provider concurrency limits

Default team definitions are loaded from:

```text
~/.pi/teams/
```

## Core commands

### Coordination

- `join`
- `status`
- `list`
- `whois`
- `feed`
- `send`
- `reserve`
- `release`
- `set-status`
- `rename`
- `channels`

### Task lifecycle

- `task list`
- `task ready`
- `task show <id>`
- `task create --title ...`
- `task claim <id>`
- `task unclaim <id>`
- `task progress <id> <message>`
- `task done <id> <summary>`
- `task block <id>`
- `task unblock <id>`
- `task reset <id> [--cascade]`
- `task archive-done`
- `task delete <id>`

### Spawn

- `spawn ...`
- `spawn list`
- `spawn history`
- `spawn stop <id>`

### Teams

- `team list`
- `team show <file>`
- `team run --agent-file <file> "mission"`

### Harness management

The CLI talks to a local harness server and auto-starts it when needed.

- `--status`
- `--start`
- `--stop`
- `--restart`
- `--logs`

## Configuration

Config priority is:

1. project: `.pi/pi-messenger.json`
2. user/global: `~/.pi/agent/pi-messenger.json`
3. `messenger` key in `~/.pi/agent/settings.json`
4. built-in defaults

Example:

```json
{
  "autoRegister": true,
  "maxConcurrentSpawns": 10,
  "providerConcurrency": {
    "makora": 6,
    "lilac": 4,
    "openai-codex": 4,
    "xiaomi-token-plan-sgp": 4
  }
}
```

### Provider concurrency

If a spawn or team step uses a model like:

```text
openai-codex/gpt-5.5
```

...the provider is parsed as `openai-codex`, and that provider's concurrency limit is enforced if configured.

## Storage layout

Messenger state is project-scoped by default.

### Always under `.pi/messenger/`

```text
.pi/messenger/
├── channels/      # channel feed JSONL
├── agents/        # spawned agent state/history
├── registry/      # live agent registrations
└── br-task-map.json
```

### Tasks in Beads mode

```text
.beads/
└── artifacts/
    └── <bead-id>/
```

Task metadata, status, dependencies, and comments are stored through `br`.

### Tasks in JSONL fallback mode

```text
.pi/messenger/tasks/
├── <session>.jsonl
└── <session>/
```

## Overlay

Run `/messenger` in Pi to open the swarm overlay.

The overlay includes:

- current channel feed
- agent presence
- swarm task summary
- task detail
- DM/channel posting

## `pi-vcc` compaction integration

This fork is commonly used with [`pi-vcc`](https://github.com/monotykamary/pi-vcc).

When compaction is configured in Pi, swarm can surface compaction events such as:

- `compact.start`
- `compact.done`

Spawned agents can inherit the same compaction environment/config.

## Legacy / compatibility notes

- `send` without a target is invalid
- `broadcast` is removed
- legacy planner/worker/reviewer flows are not the primary model here
- the preferred model is: **channels + tasks + spawn + teams**

## License

MIT
