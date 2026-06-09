/**
 * br (beads_rust) adapter for task storage.
 *
 * Phase 1: Replaces the JSONL task-store with br CLI calls.
 * Task operations map to br commands:
 *   task create  → br create
 *   task claim   → br update --status in_progress --assignee <agent>
 *   task done    → br close --reason <summary>
 *   task list    → br list --json
 *   task show    → br show <id> --json
 *   task ready   → br ready --json
 *   task block   → br update --status blocked
 *   task unblock → br update --status open
 *   task reset   → br update --status open
 *   task dep     → br dep add
 *
 * br issues are labeled with the session channel to scope tasks per session.
 * The mapping: task-N → br-<hash> (br-generated IDs).
 * We maintain a bidirectional ID map in .pi/messenger/br-task-map.json.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  SwarmTask,
  SwarmTaskCreateInput,
  SwarmTaskEvidence,
  SwarmTaskStatus,
} from './types.js';

/** Path to the br-task-id map file */
function mapFilePath(cwd: string): string {
  return path.join(cwd, '.pi', 'messenger', 'br-task-map.json');
}

/** Bidirectional map: swarm task IDs ↔ br issue IDs */
type TaskIdMap = Record<string, string>;

function loadMap(cwd: string): TaskIdMap {
  const p = mapFilePath(cwd);
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  return {};
}

function saveMap(cwd: string, map: TaskIdMap): void {
  const p = mapFilePath(cwd);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map, null, 2), 'utf-8');
}

/** Run a br command and return stdout. Throws on non-zero exit. */
function br(cwd: string, args: string, json = false): string {
  const env = { ...process.env };
  if (json) args += ' --json';
  const result = execSync(`br ${args}`, {
    cwd,
    env,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return result;
}

/** Run a br command, returning null on failure instead of throwing. */
function brSafe(cwd: string, args: string, json = false): string | null {
  try {
    return br(cwd, args, json);
  } catch {
    return null;
  }
}

/** Map swarm status to br status. */
function toBrStatus(status: SwarmTaskStatus): string {
  switch (status) {
    case 'todo':
      return 'open';
    case 'in_progress':
      return 'in_progress';
    case 'done':
      return 'closed';
    case 'blocked':
      return 'blocked';
    case 'archived':
      return 'closed'; // br doesn't have archived; use closed
  }
}

/** Map br status back to swarm status. */
function fromBrStatus(status: string): SwarmTaskStatus {
  switch (status) {
    case 'open':
      return 'todo';
    case 'in_progress':
      return 'in_progress';
    case 'closed':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'deferred':
      return 'todo';
    default:
      return 'todo';
  }
}

/** Convert a br issue JSON object to a SwarmTask. */
function brIssueToTask(issue: Record<string, unknown>, idMap: TaskIdMap): SwarmTask {
  const brId = issue.id as string;

  // Reverse-lookup swarm task ID from br ID
  let swarmId = idMap[brId] as string | undefined;
  if (!swarmId) {
    // Try to extract from labels (we store "swarm:task-N" as a label)
    const labels = (issue.labels as string[]) ?? [];
    const swarmLabel = labels.find((l) => l.startsWith('swarm:'));
    swarmId = swarmLabel ? swarmLabel.slice(6) : brId;
  }

  const deps =
    ((issue as Record<string, unknown>).dependencies as Array<{ depends_on_id: string }>) ?? [];
  const dependsOn: string[] = [];
  for (const dep of deps) {
    const depBrId = dep.depends_on_id;
    const depSwarmId = idMap[depBrId] ?? depBrId;
    dependsOn.push(depSwarmId);
  }

  const status = fromBrStatus(issue.status as string);

  return {
    id: swarmId,
    title: issue.title as string,
    status,
    depends_on: dependsOn,
    created_at: issue.created_at as string,
    updated_at: issue.updated_at as string,
    created_by: (issue.created_by as string) || undefined,
    claimed_by: (issue.assignee as string) || undefined,
    claimed_at: status === 'in_progress' ? (issue.updated_at as string) : undefined,
    completed_by:
      status === 'done' ? ((issue.closed_by as string) ?? (issue.assignee as string)) : undefined,
    completed_at: status === 'done' ? ((issue.closed_at as string) ?? undefined) : undefined,
    summary: status === 'done' ? (issue.close_reason as string) || undefined : undefined,
    blocked_reason: status === 'blocked' ? (issue.description as string) || undefined : undefined,
    attempt_count: 0,
    channel: (issue as Record<string, unknown>).channel as string | undefined,
    progress_log: [], // br doesn't have progress_log; we'd need comments for this
  };
}

// ========== Public API (same shape as task-store/commands.js) ==========

export function createTask(
  cwd: string,
  _sessionId: string,
  input: SwarmTaskCreateInput,
  channelId: string
): SwarmTask {
  // Allocate a swarm-style task ID first
  const existing = getTasks(cwd, _sessionId);
  const maxId = existing.reduce((max, t) => {
    const match = t.id.match(/(\d+)$/);
    const num = match ? Number.parseInt(match[1], 10) : 0;
    return Math.max(max, num);
  }, 0);
  const swarmId = `task-${maxId + 1}`;

  // Create the br issue
  const args = [
    'create',
    `"${input.title.replace(/"/g, '\\"')}"`,
    input.content ? `--description "${input.content.replace(/"/g, '\\"')}"` : '',
    '--type task',
    `--priority 1`,
    `--labels "swarm:${swarmId},channel:${channelId}"`,
    `--actor "${input.createdBy ?? 'swarm'}"`,
  ]
    .filter(Boolean)
    .join(' ');

  const output = br(cwd, args);
  const match = output.match(/Created\s+([a-z]+-[a-z0-9]+)/i);
  if (!match) throw new Error(`Failed to parse br create output: ${output}`);
  const brId = match[1];

  // Store the mapping
  const map = loadMap(cwd);
  map[swarmId] = brId;
  map[brId] = swarmId;
  saveMap(cwd, map);

  // Add dependencies
  if (input.dependsOn && input.dependsOn.length > 0) {
    for (const depSwarmId of input.dependsOn) {
      const depBrId = map[depSwarmId];
      if (depBrId) {
        brSafe(
          cwd,
          `dep add ${brId} ${depBrId} --type blocks --actor "${input.createdBy ?? 'swarm'}"`
        );
      }
    }
  }

  return getTask(cwd, _sessionId, swarmId)!;
}

export function claimTask(
  cwd: string,
  _sessionId: string,
  taskId: string,
  agentName: string,
  _reason?: string
): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  // Check dependencies via br ready
  const readyOutput = brSafe(cwd, `ready --json`);
  if (readyOutput) {
    try {
      const ready = JSON.parse(readyOutput);
      const readyIds = (ready.issues as Array<{ id: string }>).map((i) => {
        const swarmId = map[i.id];
        return swarmId ?? i.id;
      });
      if (!readyIds.includes(taskId)) {
        return null; // Not ready — dependencies not met
      }
    } catch {
      // Fall through — try claiming anyway
    }
  }

  const result = brSafe(
    cwd,
    `update ${brId} --status in_progress --assignee "${agentName}" --actor "${agentName}"`
  );
  if (!result) return null;

  return getTask(cwd, _sessionId, taskId);
}

export function unclaimTask(
  cwd: string,
  _sessionId: string,
  taskId: string,
  agentName: string
): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  const result = brSafe(cwd, `update ${brId} --status open --assignee "" --actor "${agentName}"`);
  if (!result) return null;

  return getTask(cwd, _sessionId, taskId);
}

export function completeTask(
  cwd: string,
  _sessionId: string,
  taskId: string,
  agentName: string,
  summary: string,
  _evidence?: SwarmTaskEvidence
): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  const result = brSafe(
    cwd,
    `close ${brId} --reason "${summary.replace(/"/g, '\\"')}" --actor "${agentName}"`
  );
  if (!result) return null;

  return getTask(cwd, _sessionId, taskId);
}

export function blockTask(
  cwd: string,
  _sessionId: string,
  taskId: string,
  agentName: string,
  reason: string
): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  const result = brSafe(
    cwd,
    `update ${brId} --status blocked --actor "${agentName}" --description "${reason.replace(/"/g, '\\"')}"`
  );
  if (!result) return null;

  return getTask(cwd, _sessionId, taskId);
}

export function unblockTask(cwd: string, _sessionId: string, taskId: string): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  const result = brSafe(cwd, `update ${brId} --status open`);
  if (!result) return null;

  return getTask(cwd, _sessionId, taskId);
}

export function resetTask(
  cwd: string,
  _sessionId: string,
  taskId: string,
  _cascade = false
): SwarmTask[] {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return [];

  const result = brSafe(cwd, `update ${brId} --status open --assignee ""`);
  if (!result) return [];

  const task = getTask(cwd, _sessionId, taskId);
  return task ? [task] : [];
}

export function archiveTask(cwd: string, _sessionId: string, taskId: string): SwarmTask | null {
  // br doesn't have archive; we close with a label
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  brSafe(cwd, `close ${brId} --reason "archived" --add-label "archived"`);
  return getTask(cwd, _sessionId, taskId);
}

export function archiveDoneTasks(cwd: string, _sessionId: string): number {
  const tasks = getTasks(cwd, _sessionId);
  const done = tasks.filter((t) => t.status === 'done');
  for (const task of done) {
    archiveTask(cwd, _sessionId, task.id);
  }
  return done.length;
}

export function deleteTask(cwd: string, _sessionId: string, taskId: string): boolean {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return false;

  // br doesn't have delete; we tombstone it
  brSafe(cwd, `update ${brId} --status closed --add-label "deleted"`);
  return true;
}

export function appendTaskProgress(
  cwd: string,
  _sessionId: string,
  taskId: string,
  agentName: string,
  message: string
): void {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return;

  // Store progress as a br comment
  brSafe(cwd, `comments add ${brId} "${message.replace(/"/g, '\\"')}" --author "${agentName}"`);

  // Also write to the legacy spec file for backward compat
  const specDir = path.join(cwd, '.pi', 'messenger', 'tasks', _sessionId);
  const specFile = path.join(specDir, `${taskId}.md`);
  if (fs.existsSync(specFile)) {
    const existing = fs.readFileSync(specFile, 'utf-8');
    fs.writeFileSync(
      specFile,
      `${existing}\n\n## Progress [${new Date().toISOString()}] ${agentName}\n${message}`,
      'utf-8'
    );
  }
}

// ========== Query API (same shape as task-store/queries.js) ==========

export function getTasks(cwd: string, _sessionId: string): SwarmTask[] {
  const output = brSafe(cwd, 'list --json');
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    const issues = (parsed.issues ?? []) as Record<string, unknown>[];
    const map = loadMap(cwd);
    // Filter to only swarm-labeled issues
    return issues
      .filter((issue) => {
        const labels = (issue.labels as string[]) ?? [];
        return labels.some((l) => l.startsWith('swarm:') || l.startsWith('channel:'));
      })
      .map((issue) => brIssueToTask(issue, map));
  } catch {
    return [];
  }
}

export function getAllTasks(cwd: string, sessionId: string): SwarmTask[] {
  return getTasks(cwd, sessionId);
}

export function getTask(cwd: string, _sessionId: string, taskId: string): SwarmTask | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) {
    // Try direct br lookup (might be a br ID already)
    const output = brSafe(cwd, `show ${taskId} --json`);
    if (!output) return null;
    try {
      const parsed = JSON.parse(output);
      const issue = Array.isArray(parsed) ? parsed[0] : parsed;
      return brIssueToTask(issue, map);
    } catch {
      return null;
    }
  }

  const output = brSafe(cwd, `show ${brId} --json`);
  if (!output) return null;

  try {
    const parsed = JSON.parse(output);
    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
    return brIssueToTask(issue, map);
  } catch {
    return null;
  }
}

export function taskExists(cwd: string, sessionId: string, taskId: string): boolean {
  return getTask(cwd, sessionId, taskId) !== null;
}

export function getReadyTasks(cwd: string, _sessionId: string): SwarmTask[] {
  const output = brSafe(cwd, 'ready --json');
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    const issues = (parsed.issues ?? []) as Record<string, unknown>[];
    const map = loadMap(cwd);
    return issues
      .filter((issue) => {
        const labels = (issue.labels as string[]) ?? [];
        return labels.some((l) => l.startsWith('swarm:') || l.startsWith('channel:'));
      })
      .map((issue) => brIssueToTask(issue, map));
  } catch {
    return [];
  }
}

export function getReadyTasksForTasks(
  cwd: string,
  sessionId: string,
  _tasks: SwarmTask[]
): SwarmTask[] {
  return getReadyTasks(cwd, sessionId);
}

export function getStalledTasks(cwd: string, sessionId: string): SwarmTask[] {
  // br has `br stale` which lists stale issues
  const output = brSafe(cwd, 'stale --json');
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    const issues = (parsed.issues ?? parsed ?? []) as Record<string, unknown>[];
    const map = loadMap(cwd);
    return (Array.isArray(issues) ? issues : [])
      .filter((issue) => {
        const labels = ((issue as Record<string, unknown>).labels as string[]) ?? [];
        return labels.some((l) => l.startsWith('swarm:') || l.startsWith('channel:'));
      })
      .map((issue) => brIssueToTask(issue, map));
  } catch {
    return [];
  }
}

export function getSummary(
  cwd: string,
  sessionId: string
): {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
} {
  const tasks = getTasks(cwd, sessionId);
  return {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };
}

export function getSummaryForTasks(
  cwd: string,
  sessionId: string,
  tasks: SwarmTask[]
): { total: number; todo: number; in_progress: number; done: number; blocked: number } {
  return {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };
}

export function getTaskSpec(cwd: string, _sessionId: string, taskId: string): string | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  const output = brSafe(cwd, `show ${brId}`);
  if (!output) return null;

  // Extract description from br show output
  return output;
}

export function getTaskProgress(cwd: string, _sessionId: string, taskId: string): string | null {
  const map = loadMap(cwd);
  const brId = map[taskId];
  if (!brId) return null;

  // Get comments (which store progress)
  const output = brSafe(cwd, `comments list ${brId} --json`);
  if (!output) return null;

  try {
    const comments = JSON.parse(output) as Array<{
      author: string;
      text: string;
      created_at: string;
    }>;
    if (!Array.isArray(comments) || comments.length === 0) return null;
    return comments.map((c) => `[${c.created_at}] ${c.author}: ${c.text}`).join('\n');
  } catch {
    return null;
  }
}

/** No-op for br adapter — cleanup is handled by br's own stale detection. */
export function cleanupStaleTaskClaims(): void {}

/** Ensure br is initialized in the project. */
export function ensureBrInitialized(cwd: string): boolean {
  const beadsDir = path.join(cwd, '.beads');
  if (fs.existsSync(path.join(beadsDir, 'beads.db'))) return true;

  try {
    br(cwd, 'init');
    return true;
  } catch {
    return false;
  }
}
