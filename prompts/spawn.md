---
description: Spawn a subagent to handle a task or mission
argument-hint: '<role> <mission>'
---

Spawn a subagent to execute work autonomously:

1. If spawning for an existing task: `pi-messenger-swarm spawn --task-id $1 --role $2 "$3"`
2. If spawning with a standalone mission: `pi-messenger-swarm spawn --role $1 "$2"`
3. If the mission text contains shell-sensitive characters (backticks, ${...}, parentheses), write it to a temp file first and use `--message-file <path>`

After spawning:

- Monitor progress with `pi-messenger-swarm feed --limit 10`
- Check task status with `pi-messenger-swarm task show <id>`
- Do NOT claim the task yourself — the spawned agent will claim it

Optional flags:

- `--persona "<tone>"` — set agent personality/behavior
- `--objective "<goal>"` — set default mission (overridden by positional arg)
- `--agent-file <path>` — use an agent definition file with frontmatter
