---
description: Create a task and spawn an agent to handle it in one step
argument-hint: '<title> <role> <mission>'
---

Delegate work end-to-end: create a task, then spawn an agent to execute it.

1. Create the task: `pi-messenger-swarm task create --title "$1"`
2. Note the task ID from the output (e.g., task-5)
3. Spawn an agent for that task: `pi-messenger-swarm spawn --task-id <id> --role $2 "$3"`

After delegation:

- Monitor with `pi-messenger-swarm swarm` or `pi-messenger-swarm feed --limit 10`
- Check detailed progress with `pi-messenger-swarm task show <id>`
- Do NOT claim the task yourself — the spawned agent owns it
- If the agent needs help, message them: `pi-messenger-swarm send <AgentName> "context or clarification"`

When the agent completes the task, review with `pi-messenger-swarm task show <id>` — findings are in the task progress/done messages.
