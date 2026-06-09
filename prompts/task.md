---
description: Create a new swarm task and optionally claim it
argument-hint: '<title>'
---

Create a new task in the swarm:

1. Run `pi-messenger-swarm task create --title "$@"` to create the task
2. Note the task ID from the output
3. Decide whether to claim it yourself or delegate it:
   - If you will implement it: `pi-messenger-swarm task claim <id>`
   - If delegating: `pi-messenger-swarm spawn --task-id <id> --role <role> "<mission>"`

After claiming, reserve any files you'll edit with `pi-messenger-swarm reserve <path> --reason <id>`.

When done, mark progress with `pi-messenger-swarm task progress <id> "update"` and complete with `pi-messenger-swarm task done <id> "summary"`.
