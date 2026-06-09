<div align="center">

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-messenger-swarm/main/banner.png" alt="pi-messenger-swarm" width="1100">
</p>

# Pi Messenger (Swarm Mode)

**File-based multi-agent coordination for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Join a mesh, share channels, spawn subagents — no daemon required._

**⚠️ This is a fork of [monotykamary/pi-messenger-swarm](https://github.com/monotykamary/pi-messenger-swarm) with br beads + pi-vcc integration.**

</div>

[![npm version](https://img.shields.io/npm/v/pi-messenger-swarm?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger-swarm)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

---

## Screenshots

| Swarm Details                              | Swarm Messenger                                |
| ------------------------------------------ | ---------------------------------------------- |
| ![Swarm Details](assets/swarm_details.jpg) | ![Swarm Messenger](assets/swarm_messenger.jpg) |
| Memory Channel                             | Session Channel                                |
| ![Memory Channel](assets/memory.jpg)       | ![Session Channel](assets/session.jpg)         |

## Install

From npm:

```bash
pi install npm:pi-messenger-swarm
```

From git (Pi package settings):

```json
{
  "packages": ["https://github.com/monotykamary/pi-messenger-swarm@main"]
}
```

> Tip: after release tags are published, pin to a version tag instead of `main` (for example `@vX.Y.Z`).

## Quick Start

Join the messenger and start collaborating in your session channel:

```bash
pi-messenger-swarm join
pi-messenger-swarm send #memory "Investigating auth timeout in refresh flow"
pi-messenger-swarm task create --title "Investigate auth timeout" --content "Repro + fix"
pi-messenger-swarm task claim task-1
pi-messenger-swarm task progress task-1 "Found race in refresh flow"
pi-messenger-swarm task done task-1 "Fixed refresh lock + tests"
```

Spawn a specialized subagent:

```bash
pi-messenger-swarm spawn --role "Packaging Gap Analyst" --persona "Skeptical market researcher" "Find productization gaps in idea aggregation tools"
```

## Channel Model

Pi Messenger is now **channel-first**.

### Session channels

Each Pi session gets a dedicated default channel, generated as a human-friendly phrase such as:

- `#quiet-river`
- `#wild-viper`
- `#ember-owl`

The same Pi `sessionId` restores the same session channel when reopened.

### Named channels

By default, a durable named channel is created:

- `#memory` — cross-session knowledge, notes, decisions, and async handoff

You can create additional named channels as needed.

You can also create additional named channels explicitly with `join`.

### Durable channel posting

Channel messages are durable even when nobody is listening.

Posting to a channel means:

1. append to that channel's feed
2. try live inbox delivery to agents currently joined to that channel

That makes channels useful as async coordination logs for later agents to pick up.

### Session switching and resume

If Pi switches or resumes sessions inside the same live messenger instance, messenger rebinds to the resumed Pi session:

- restores the correct session channel
- drops stale old session-channel membership
- restarts watchers on the correct inbox
- keeps named channels like `#memory`

## Core Actions

### Coordination

- `join`
- `status`
- `list`
- `whois`
- `feed`
- `set_status`
- `send`
- `reserve`
- `release`
- `rename`

### Swarm Board

- `swarm` — summary of tasks + spawned agents

### Task Lifecycle

- `task.create`
- `task.list`
- `task.show`
- `task.ready`
- `task.claim` (alias: `task.start`)
- `task.unclaim` (alias: `task.stop`)
- `task.progress`
- `task.done`
- `task.block`
- `task.unblock`
- `task.reset` (`cascade: true` supported)
- `task.delete`
- `task.archive_done` (moves completed tasks to `.pi/messenger/archive/<channel>/...`)

Compatibility aliases:

- `claim` → `task.claim`
- `unclaim` → `task.unclaim`
- `complete` → `task.done`

### Subagent Management

- `spawn`
- `spawn.list`
- `spawn.stop`

## Messaging Semantics

`send` now always requires an explicit `to:` target.

### Direct message an agent

```bash
pi-messenger-swarm send OtherAgent "Need your API shape before I commit"
```

### Post durably to a channel

```bash
pi-messenger-swarm send #memory "Claimed task-4, touching src/auth/session.ts"
pi-messenger-swarm send #memory "Nightly sync complete"
```

### Switch channels explicitly

```bash
pi-messenger-swarm join --channel memory
pi-messenger-swarm join --channel architecture --create
```

### Read a channel feed

```bash
pi-messenger-swarm feed --limit 20
pi-messenger-swarm feed --channel memory --limit 20
```

### Notes

- `to: "#channel"` is the canonical way to post to a channel
- `send` without `to` is invalid
- the old `broadcast` action is removed
- for channel posts, prefer `to: "#channel"` over `channel: "..."`

## Overlay

Run `/messenger` to open the swarm overlay.

Overlay includes:

- live agent presence
- swarm task list/detail
- live feed for the current channel
- DM/current-channel post input
- channel switching

Message input behavior:

- `@name <message>` sends a DM
- plain text posts to the current channel

Planning UI and worker +/- controls were removed in swarm mode.

## Storage Layout

By default, swarm state is **project-scoped** (isolated per project). All channel state uses a unified event-sourced JSONL format:

```text
.pi/messenger/
├── channels/                    # Unified event-sourced channel files
│   ├── memory.jsonl           # Line 1: metadata header, Line 2+: feed events
│   └── quiet-river.jsonl
├── tasks/                       # Per-session task storage
│   ├── session-abc.jsonl      # Task event log (created, claimed, done, etc.)
│   └── session-abc/           # Task specs directory
│       ├── task-1.md
│       └── task-1.progress.md
├── agents/                      # Per-session spawned agent storage
│   ├── session-abc.jsonl      # Agent event log (spawned, completed, failed, stopped)
│   └── session-abc/           # Agent definition files
│       └── AgentName-id.md
├── registry/                    # Agent registrations (joined mesh agents)
│   ├── AgentA.json
│   └── AgentB.json
```

### Unified Channel Format (Event-Sourced)

Each channel file at `channels/<channel>.jsonl` uses an append-only JSONL format:

**Line 1** — Metadata header:

```json
{
  "_meta": true,
  "v": 1,
  "id": "memory",
  "type": "named",
  "createdAt": "2026-04-04T22:00:00.000Z",
  "description": "Cross-session knowledge and insights"
}
```

**Line 2+** — Append-only feed events:

```json
{"ts":"2026-04-04T22:05:00.000Z","agent":"Alpha","type":"join"}
{"ts":"2026-04-04T22:10:00.000Z","agent":"Alpha","type":"message","preview":"Investigating auth timeout"}
{"ts":"2026-04-04T22:15:00.000Z","agent":"Alpha","type":"task.start","target":"task-1"}
```

This design provides:

- **Atomic channel creation** — metadata and first event written together
- **Append-only feeds** — events never modified, only added
- **Natural event sourcing** — full history preserved in file order
- **Efficient tail reads** — recent events at end of file
- **Simple caching** — stat mtime + size for invalidation

## Breaking Changes

This design intentionally breaks older messaging assumptions.

- `broadcast` action was removed
- `send` without `to` was removed
- feed history is now stored per channel at `.pi/messenger/channels/<channel>.jsonl` (unified format: metadata header + events)
- tasks are now stored per session at `.pi/messenger/tasks/<session>.jsonl`
- session channels are phrase-based instead of `session-*` timestamp-like ids

Use these patterns instead:

```bash
pi-messenger-swarm send AgentName "..."
pi-messenger-swarm send #channel "..."
```

## Environment Variables

Override the default project-scoped behavior:

| Variable                        | Effect                                               |
| ------------------------------- | ---------------------------------------------------- |
| `PI_MESSENGER_DIR=/path/to/dir` | Use custom directory for all state                   |
| `PI_MESSENGER_GLOBAL=1`         | Use legacy global mode (`~/.pi/agent/messenger`)     |
| `BR_TASK_STORE=1`               | Use br (beads_rust) as task backend instead of JSONL |

```bash
# Custom location
PI_MESSENGER_DIR=/tmp/swarm-state pi

# Legacy global mode (not recommended)
PI_MESSENGER_GLOBAL=1 pi

# Enable br beads task store
BR_TASK_STORE=1 pi
```

### Global Mode (Legacy)

For backwards compatibility only - agents from ALL projects share state:

- `~/.pi/agent/messenger/registry` - Agent registrations
- `~/.pi/agent/messenger/inbox` - Cross-agent messaging

## br Beads Integration (Phase 1)

This fork adds an optional `br` (beads_rust) backend for task storage, replacing the legacy JSONL event store with SQLite-backed queries, dependency-aware ready/blocked, content hashing, and audit events.

### Setup

1. Install [br](https://github.com/Dicklesworthstone/beads_rust) and initialize in your project:

   ```bash
   # Install br (cargo install beads_rust)
   br init
   ```

2. Enable the br task store:

   ```bash
   export BR_TASK_STORE=1
   ```

3. Start pi — all task operations now route through `br`:

| Swarm Action    | br Command                                  |
| --------------- | ------------------------------------------- |
| `task create`   | `br create`                                 |
| `task claim`    | `br update --status in_progress --assignee` |
| `task done`     | `br close --reason`                         |
| `task list`     | `br list --json`                            |
| `task show`     | `br show --json`                            |
| `task ready`    | `br ready --json`                           |
| `task block`    | `br update --status blocked`                |
| `task unblock`  | `br update --status open`                   |
| `task reset`    | `br update --status open`                   |
| `task progress` | `br comments add`                           |

### What br gives you over JSONL

| Feature               | JSONL (legacy) | br (beads_rust)          |
| --------------------- | -------------- | ------------------------ |
| Query performance     | O(n) replay    | O(log n) SQLite indexes  |
| Causal dependencies   | Implicit       | Explicit `br dep` rods   |
| Integrity             | None           | SHA-256 content hashing  |
| Ready/blocked cache   | No concept     | Precomputed `br ready`   |
| Stale claim detection | Manual         | `br stale` with evidence |
| Audit trail           | Flat JSONL     | SQL-queryable events     |

### ID mapping

Swarm task IDs (`task-1`, `task-2`) are mapped bidirectionally to br issue IDs (`zxc-abc`) via `.pi/messenger/br-task-map.json`. Labels `swarm:task-N` and `channel:xxx` are set on each br issue for scoping.

## pi-vcc Compaction Integration

This fork integrates with [pi-vcc](https://github.com/monotykamary/pi-vcc) for automatic context compaction at 90-95% of the model's context window.

### How it works

1. **pi-vcc** is installed as a global pi extension and hooks into `session_before_compact` / `session_compact` events
2. When a spawned agent's context reaches the configured threshold (default: 95% for 128k models, 94% for 200k models), pi-vcc triggers compaction automatically
3. Compaction is **algorithmic** (no LLM call) — deterministic, zero-cost, 2-64ms latency
4. Full history remains searchable via `vcc_recall` even after compaction
5. Compaction events appear in the swarm feed as `compact.start` / `compact.done`

### New tool: `vcc_recall`

After compaction, spawned agents (and the coordinator) can use the **`vcc_recall`** tool to search their compacted conversation history. This is critical for long-running swarm tasks where context is compacted multiple times — agents don't lose access to earlier decisions, code changes, or user instructions.

```bash
# Search the active lineage (default)
vcc_recall --query "database schema"

# Search ALL lineages (including off-branch compactions)
vcc_recall --query "why did we choose X?" --scope all

# Search within a specific compaction segment
vcc_recall --query "error" --scope compaction:latest
```

| Scope               | What it searches                                |
| ------------------- | ----------------------------------------------- |
| `lineage` (default) | Active conversation branch                      |
| `all`               | All branches, including off-lineage compactions |
| `compaction:N`      | Specific compaction segment by number           |
| `compaction:latest` | Most recent compaction segment                  |

Agents can also expand specific entries for full untruncated content:

```bash
vcc_recall --query "pull request" --expand 3,7
```

### Swarm feed events

Compaction events now appear in the swarm feed:

| Event           | When                                                               |
| --------------- | ------------------------------------------------------------------ |
| `compact.start` | Context compaction begins                                          |
| `compact.done`  | Context compaction complete (includes pi-vcc stats when available) |

Feed entries show the compactor name and token stats:

```
compact.done  SwiftArrow  pi-vcc compaction complete (121k tokens before)
```

### Configuration

Thresholds are configured in `~/.pi/agent/pi-vcc-config.json`:

```json
{
  "overrideDefaultCompaction": true,
  "defaultThreshold": {
    "reserveTokens": 6400,
    "keepRecentTokens": 8000
  },
  "modelThresholds": {
    "GLM-5.1-FP8": { "reserveTokens": 6400, "keepRecentTokens": 8000 },
    "gpt-5.5": { "reserveTokens": 12800, "keepRecentTokens": 16000 }
  }
}
```

`reserveTokens` controls when compaction triggers: `contextTokens > contextWindow - reserveTokens`. Higher = compact earlier. For a 128k model, `reserveTokens=6400` triggers at ~95% (121.6k tokens used).

Spawned agents inherit `PI_VCC_CONFIG_PATH` from the parent process so they use the same compaction settings.

## Legacy Orchestration Actions

Legacy PRD planner/worker/reviewer actions are disabled in swarm mode:

- `plan*`
- `work*`
- `review*`
- `crew.*` (legacy alias namespace)

Use `task.*`, `spawn.*`, and `swarm` instead.

## License

MIT
