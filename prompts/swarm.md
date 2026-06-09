---
description: Show swarm status and agent activity overview
argument-hint: '[--channel <name>]'
---

Run `pi-messenger-swarm swarm` to see the current swarm status. Then run `pi-messenger-swarm feed --limit 10` to check recent activity.

Based on what you find:

- If there are unclaimed tasks, consider claiming one you can implement yourself or spawning an agent to handle it
- If there are stalled tasks, investigate and unblock them
- If agents are idle, delegate new work via `pi-messenger-swarm spawn`

Key principle: when you spawn agents for tasks, delegate — do NOT claim those tasks yourself. Only claim tasks you will implement personally.
