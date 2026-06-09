/**
 * Br Beads Adapter — replaces JSONL task-store with br CLI (.beads/) backend.
 *
 * Maps swarm task concepts to br beads:
 *   SwarmTask.id         → br issue ID (e.g. "zxc-abc") with swarm:task: label
 *   SwarmTask.status     → br status (open/in_progress/blocked/closed)
 *   SwarmTask.depends    → br dep add/remove
 *   SwarmTask.progress   → br comments add
 *   SwarmTask.channel    → br label "swarm:channel:<name>"
 *   SwarmTask.claimed    → br --claim (atomic assignee + in_progress)
 *   SwarmTask spec       → br --description
 *
 * Artifacts (br-specific):
 *   design               → br --design
 *   acceptance_criteria  → br --acceptance-criteria
 *   notes                → br --notes
 *   agent_context        → br --agent-context (JSON for spawn instructions)
 *
 * All br calls use --json for machine-readable output.
 * Auto-detects .beads/ in cwd — falls back to JSONL if unavailable.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence, SwarmSummary } from '../types.js';

// ── Artifact types ─────────────────────────────────────────────────────────

/** Structured artifacts stored as br fields */
export interface BrTaskArtifacts {
  /** Design notes — br --design */
  design?: string;
  /** Acceptance criteria — br --acceptance-criteria */
  acceptanceCriteria?: string;
  /** Additional notes — br --notes */
  notes?: string;
  /** Agent context JSON — br --agent-context (spawn instructions, role, objective) */
  agentContext?: Record<string, unknown>;
  /** External reference URL — br --external-ref */
  externalRef?: string;
  /** Time estimate in minutes — br --estimate */
  estimate?: number;
  /** Due date (RFC3339 or relative) — br --due */
  due?: string;
  /** Parent issue ID — br --parent */
  parent?: string;
  /** Priority 0-4 — br --priority */
  priority?: number;
}

/** Extended create input with artifacts */
export interface BrTaskCreateInput extends SwarmTaskCreateInput {
  artifacts?: BrTaskArtifacts;
}

// ── br CLI helper ──────────────────────────────────────────────────────────

interface BrResult {
  stdout: string;
  exitCode: number;
}

function br(args: string[], cwd: string, timeoutMs = 10_000): BrResult {
  try {
    const result = child_process.spawnSync('br', args, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return {
      stdout: (result.stdout as string) ?? '',
      exitCode: result.status ?? 1,
    };
  } catch {
    return { stdout: '', exitCode: 1 };
  }
}

/** Check if br is available and .beads exists in cwd */
export function isBrAvailable(cwd: string): boolean {
  const beadsDir = path.join(cwd, '.beads');
  if (!fs.existsSync(beadsDir)) return false;
  const result = br(['--version'], cwd, 3_000);
  return result.exitCode === 0;
}

// ── Status mapping ─────────────────────────────────────────────────────────

type BrStatus = 'open' | 'in_progress' | 'blocked' | 'closed';

function swarmStatusToBr(status: string): BrStatus {
  switch (status) {
    case 'todo':
      return 'open';
    case 'in_progress':
      return 'in_progress';
    case 'blocked':
      return 'blocked';
    case 'done':
      return 'closed';
    case 'archived':
      return 'closed';
    default:
      return 'open';
  }
}

function brStatusToSwarm(status: string): SwarmTask['status'] {
  switch (status) {
    case 'open':
      return 'todo';
    case 'in_progress':
      return 'in_progress';
    case 'blocked':
      return 'blocked';
    case 'closed':
      return 'done';
    default:
      return 'todo';
  }
}

// ── br JSON types ──────────────────────────────────────────────────────────

interface BrIssue {
  id: string;
  title: string;
  description?: string;
  design?: string;
  acceptance_criteria?: string;
  notes?: string;
  agent_context?: string;
  external_ref?: string;
  status: string;
  priority: number;
  issue_type: string;
  assignee?: string;
  created_at: string;
  created_by?: string;
  updated_at: string;
  closed_at?: string;
  close_reason?: string;
  labels?: string[];
  dependency_count?: number;
  dependent_count?: number;
  estimate?: number;
  due?: string;
  parent?: string;
}

interface BrComment {
  id: string;
  author: string;
  body: string;
  created_at: string;
}

// ── Task ID mapping ────────────────────────────────────────────────────────

/**
 * Swarm uses numeric task IDs (task-1, task-2).
 * br uses prefixed IDs (zxc-abc).
 * We store the mapping in .beads/swarm-task-map.json
 */

interface TaskMapEntry {
  swarmId: string; // e.g. "task-1"
  brId: string; // e.g. "zxc-abc"
}

const TASK_MAP_FILE = 'swarm-task-map.json';

function getTaskMapPath(cwd: string): string {
  return path.join(cwd, '.beads', TASK_MAP_FILE);
}

function loadTaskMap(cwd: string): TaskMapEntry[] {
  const mapPath = getTaskMapPath(cwd);
  if (!fs.existsSync(mapPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveTaskMap(cwd: string, entries: TaskMapEntry[]): void {
  const mapPath = getTaskMapPath(cwd);
  const beadsDir = path.dirname(mapPath);
  if (!fs.existsSync(beadsDir)) fs.mkdirSync(beadsDir, { recursive: true });
  fs.writeFileSync(mapPath, JSON.stringify(entries, null, 2), 'utf-8');
}

function addMapping(cwd: string, swarmId: string, brId: string): void {
  const entries = loadTaskMap(cwd);
  const filtered = entries.filter((e) => e.swarmId !== swarmId);
  filtered.push({ swarmId, brId });
  saveTaskMap(cwd, filtered);
}

function removeMapping(cwd: string, swarmId: string): void {
  const entries = loadTaskMap(cwd);
  const filtered = entries.filter((e) => e.swarmId !== swarmId);
  saveTaskMap(cwd, filtered);
}

function swarmToBrId(cwd: string, swarmId: string): string | null {
  const entries = loadTaskMap(cwd);
  const entry = entries.find((e) => e.swarmId === swarmId);
  return entry?.brId ?? null;
}

function brToSwarmId(cwd: string, brId: string): string | null {
  const entries = loadTaskMap(cwd);
  const entry = entries.find((e) => e.brId === brId);
  return entry?.swarmId ?? null;
}

function nextSwarmId(cwd: string): string {
  const entries = loadTaskMap(cwd);
  const maxNum = entries.reduce((max, e) => {
    const match = e.swarmId.match(/(\d+)$/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  return `task-${maxNum + 1}`;
}

// ── Label helpers ──────────────────────────────────────────────────────────

function channelLabel(channel: string): string {
  return `swarm:channel:${channel}`;
}

function swarmTaskLabel(swarmId: string): string {
  return `swarm:task:${swarmId}`;
}

/** Extract channel from br labels */
function extractChannel(labels: string[] | undefined): string | undefined {
  if (!labels) return undefined;
  const ch = labels.find((l) => l.startsWith('swarm:channel:'));
  return ch ? ch.replace('swarm:channel:', '') : undefined;
}

/** Extract swarm task ID from br labels */
function extractSwarmTaskId(labels: string[] | undefined): string | undefined {
  if (!labels) return undefined;
  const t = labels.find((l) => l.startsWith('swarm:task:'));
  return t ? t.replace('swarm:task:', '') : undefined;
}

// ── Convert br issue → SwarmTask ──────────────────────────────────────────

function brIssueToSwarmTask(cwd: string, issue: BrIssue): SwarmTask {
  const swarmId = brToSwarmId(cwd, issue.id) ?? extractSwarmTaskId(issue.labels) ?? issue.id;
  const channel = extractChannel(issue.labels);
  let status = brStatusToSwarm(issue.status);

  const task: SwarmTask = {
    id: swarmId,
    title: issue.title,
    status,
    depends_on: [], // filled lazily via getBrDependencies
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    created_by: issue.created_by,
    attempt_count: issue.assignee ? 1 : 0,
    channel,
  };

  if (issue.assignee) {
    task.claimed_by = issue.assignee;
    task.claimed_at = issue.updated_at;
  }

  if (issue.status === 'closed') {
    task.completed_at = issue.closed_at ?? issue.updated_at;
    task.completed_by = issue.assignee;
    task.status = 'done';
    status = 'done';
  }

  if (issue.status === 'blocked') {
    task.blocked_reason = 'Blocked';
    task.blocked_by = issue.assignee;
  }

  return task;
}

// ── Dependency helpers ─────────────────────────────────────────────────────

function getBrDependencies(cwd: string, brId: string): string[] {
  const result = br(['dep', 'list', brId, '--json'], cwd);
  if (result.exitCode !== 0) return [];
  try {
    const deps = JSON.parse(result.stdout);
    if (Array.isArray(deps)) {
      return deps.map((d: { id?: string }) => {
        const depBrId = d.id ?? String(d);
        return brToSwarmId(cwd, depBrId) ?? depBrId;
      });
    }
    return [];
  } catch {
    return [];
  }
}

// ── Progress (comments) helpers ────────────────────────────────────────────

function getBrProgressComments(
  cwd: string,
  brId: string
): Array<{ timestamp: string; agent: string; message: string }> {
  const result = br(['comments', 'list', brId, '--json'], cwd);
  if (result.exitCode !== 0) return [];
  try {
    const comments: BrComment[] = JSON.parse(result.stdout);
    return comments.map((c) => ({
      timestamp: c.created_at,
      agent: c.author,
      message: c.body,
    }));
  } catch {
    return [];
  }
}

// ── Public API — mirrors task-store/commands.ts ────────────────────────────

export function createTaskBr(
  cwd: string,
  _sessionId: string,
  input: BrTaskCreateInput | SwarmTaskCreateInput,
  channelId: string
): SwarmTask | null {
  const brInput = input as BrTaskCreateInput;
  const artifacts = brInput.artifacts;
  const labels = [channelLabel(channelId)];

  const args: string[] = ['create', input.title, '--json', '-t', 'task'];

  // Priority
  if (artifacts?.priority !== undefined) {
    args.push('-p', String(artifacts.priority));
  } else {
    args.push('-p', '1');
  }

  // Description — use content as description
  if (input.content) {
    args.push('-d', input.content);
  }

  // Actor
  if (input.createdBy) {
    args.push('--actor', input.createdBy);
  }

  // Labels
  if (labels.length > 0) {
    args.push('-l', labels.join(','));
  }

  // Artifact: external ref
  if (artifacts?.externalRef) {
    args.push('--external-ref', artifacts.externalRef);
  }

  // Artifact: estimate
  if (artifacts?.estimate !== undefined) {
    args.push('-e', String(artifacts.estimate));
  }

  // Artifact: due date
  if (artifacts?.due) {
    args.push('--due', artifacts.due);
  }

  // Artifact: parent
  if (artifacts?.parent) {
    args.push('--parent', artifacts.parent);
  }

  const result = br(args, cwd);
  if (result.exitCode !== 0) return null;

  try {
    const issue: BrIssue = JSON.parse(result.stdout);
    const swarmId = nextSwarmId(cwd);

    addMapping(cwd, swarmId, issue.id);

    // Add swarm:task label for cross-referencing
    br(['label', 'add', issue.id, swarmTaskLabel(swarmId), '--json'], cwd);

    // Add dependencies
    if (input.dependsOn && input.dependsOn.length > 0) {
      for (const depSwarmId of input.dependsOn) {
        const depBrId = swarmToBrId(cwd, depSwarmId);
        if (depBrId) {
          br(['dep', 'add', issue.id, depBrId, '--json'], cwd);
        }
      }
    }

    // Artifact: design (update after create)
    if (artifacts?.design) {
      br(['update', issue.id, '--design', artifacts.design, '--json'], cwd);
    }

    // Artifact: acceptance criteria
    if (artifacts?.acceptanceCriteria) {
      br(
        ['update', issue.id, '--acceptance-criteria', artifacts.acceptanceCriteria, '--json'],
        cwd
      );
    }

    // Artifact: notes
    if (artifacts?.notes) {
      br(['update', issue.id, '--notes', artifacts.notes, '--json'], cwd);
    }

    // Artifact: agent context (JSON for spawn)
    if (artifacts?.agentContext) {
      const ctxJson = JSON.stringify(artifacts.agentContext);
      br(['update', issue.id, '--agent-context', ctxJson, '--json'], cwd);
    }

    // Re-fetch to get the full issue with all fields
    const updated = br(['show', issue.id, '--json'], cwd);
    if (updated.exitCode === 0) {
      try {
        const parsed = JSON.parse(updated.stdout);
        const fullIssue: BrIssue = Array.isArray(parsed) ? parsed[0] : parsed;
        const task = brIssueToSwarmTask(cwd, fullIssue);
        task.id = swarmId;
        task.depends_on = input.dependsOn ?? [];
        return task;
      } catch {
        // fall through
      }
    }

    // Fallback
    return {
      id: swarmId,
      title: issue.title,
      status: 'todo',
      depends_on: input.dependsOn ?? [],
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      created_by: input.createdBy,
      attempt_count: 0,
      channel: channelId,
    };
  } catch {
    return null;
  }
}

export function claimTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  agentName: string,
  _reason?: string
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  // Use --claim for atomic assignee + status change
  const result = br(['update', brId, '--claim', '--actor', agentName, '--json'], cwd);
  if (result.exitCode !== 0) return null;

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function unclaimTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  _agentName: string
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  // Clear assignee and set status back to open
  br(['update', brId, '--assignee', '', '--status', 'open', '--json'], cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function completeTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  agentName: string,
  summary: string,
  _evidence?: SwarmTaskEvidence
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  // Add summary as comment
  br(['comments', 'add', brId, summary, '--actor', agentName, '--json'], cwd);

  // Close the issue
  br(['close', brId, '--json'], cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function blockTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  agentName: string,
  reason: string
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  br(['update', brId, '--status', 'blocked', '--actor', agentName, '--json'], cwd);
  br(['comments', 'add', brId, `Blocked: ${reason}`, '--actor', agentName, '--json'], cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function unblockTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  br(['update', brId, '--status', 'open', '--json'], cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function resetTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  _cascade: boolean = false
): SwarmTask[] {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return [];

  br(['update', brId, '--status', 'open', '--assignee', '', '--json'], cwd);

  const task = getTaskBr(cwd, _sessionId, swarmTaskId);
  return task ? [task] : [];
}

export function archiveTaskBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  br(['close', brId, '--json'], cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

export function deleteTaskBr(cwd: string, _sessionId: string, swarmTaskId: string): boolean {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return false;

  const result = br(['delete', brId], cwd);
  if (result.exitCode === 0) {
    removeMapping(cwd, swarmTaskId);
    return true;
  }
  return false;
}

export function appendTaskProgressBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  agentName: string,
  message: string
): void {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return;

  br(['comments', 'add', brId, message, '--author', agentName, '--json'], cwd);
}

// ── Artifact API ───────────────────────────────────────────────────────────

/** Update artifacts on an existing br issue */
export function updateArtifactsBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string,
  artifacts: Partial<BrTaskArtifacts>
): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  const args: string[] = ['update', brId, '--json'];

  if (artifacts.design !== undefined) args.push('--design', artifacts.design);
  if (artifacts.acceptanceCriteria !== undefined)
    args.push('--acceptance-criteria', artifacts.acceptanceCriteria);
  if (artifacts.notes !== undefined) args.push('--notes', artifacts.notes);
  if (artifacts.externalRef !== undefined) args.push('--external-ref', artifacts.externalRef);
  if (artifacts.estimate !== undefined) args.push('--estimate', String(artifacts.estimate));
  if (artifacts.due !== undefined) args.push('--due', artifacts.due);
  if (artifacts.priority !== undefined) args.push('-p', String(artifacts.priority));
  if (artifacts.parent !== undefined) args.push('--parent', artifacts.parent);
  if (artifacts.agentContext !== undefined) {
    args.push('--agent-context', JSON.stringify(artifacts.agentContext));
  }

  br(args, cwd);

  return getTaskBr(cwd, _sessionId, swarmTaskId);
}

/** Read artifacts from a br issue */
export function getArtifactsBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string
): BrTaskArtifacts | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  const result = br(['show', brId, '--json'], cwd);
  if (result.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    const issue: BrIssue = Array.isArray(parsed) ? parsed[0] : parsed;

    const artifacts: BrTaskArtifacts = {};

    if (issue.design) artifacts.design = issue.design;
    if (issue.acceptance_criteria) artifacts.acceptanceCriteria = issue.acceptance_criteria;
    if (issue.notes) artifacts.notes = issue.notes;
    if (issue.agent_context) {
      try {
        artifacts.agentContext = JSON.parse(issue.agent_context);
      } catch {
        artifacts.agentContext = { raw: issue.agent_context };
      }
    }
    if (issue.external_ref) artifacts.externalRef = issue.external_ref;
    if (issue.estimate !== undefined) artifacts.estimate = issue.estimate;
    if (issue.due) artifacts.due = issue.due;
    if (issue.parent) artifacts.parent = issue.parent;
    if (issue.priority !== undefined) artifacts.priority = issue.priority;

    return artifacts;
  } catch {
    return null;
  }
}

// ── Queries ────────────────────────────────────────────────────────────────

export function listTasksBr(cwd: string, _sessionId: string): SwarmTask[] {
  const result = br(['list', '--json'], cwd);
  if (result.exitCode !== 0) return [];

  try {
    const response = JSON.parse(result.stdout);
    const issues: BrIssue[] = response.issues ?? response;
    if (!Array.isArray(issues)) return [];

    return issues
      .filter((issue) => {
        const labels = issue.labels ?? [];
        return labels.some((l) => l.startsWith('swarm:'));
      })
      .map((issue) => {
        const task = brIssueToSwarmTask(cwd, issue);
        // Fill dependencies
        task.depends_on = getBrDependencies(cwd, issue.id);
        return task;
      });
  } catch {
    return [];
  }
}

export function getTaskBr(cwd: string, _sessionId: string, swarmTaskId: string): SwarmTask | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  const result = br(['show', brId, '--json'], cwd);
  if (result.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    const issue: BrIssue = Array.isArray(parsed) ? parsed[0] : parsed;
    const task = brIssueToSwarmTask(cwd, issue);
    task.id = swarmTaskId;
    task.depends_on = getBrDependencies(cwd, issue.id);

    // Fill progress log from comments
    const progress = getBrProgressComments(cwd, issue.id);
    if (progress.length > 0) {
      task.progress_log = progress;
    }

    return task;
  } catch {
    return null;
  }
}

export function taskExistsBr(cwd: string, sessionId: string, swarmTaskId: string): boolean {
  return getTaskBr(cwd, sessionId, swarmTaskId) !== null;
}

export function getSummaryBr(cwd: string, sessionId: string): SwarmSummary {
  const tasks = listTasksBr(cwd, sessionId);
  return {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };
}

export function getReadyTasksBr(cwd: string, sessionId: string): SwarmTask[] {
  const tasks = listTasksBr(cwd, sessionId);
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks.filter((t) => t.status === 'todo' && t.depends_on.every((d) => doneIds.has(d)));
}

export function getTaskSpecBr(cwd: string, _sessionId: string, swarmTaskId: string): string | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  const result = br(['show', brId, '--json'], cwd);
  if (result.exitCode !== 0) return null;

  try {
    const parsed = JSON.parse(result.stdout);
    const issue: BrIssue = Array.isArray(parsed) ? parsed[0] : parsed;

    // Build spec from description + design + acceptance_criteria + notes
    const parts: string[] = [];
    if (issue.description) parts.push(issue.description);
    if (issue.design) parts.push(`\n## Design\n\n${issue.design}`);
    if (issue.acceptance_criteria)
      parts.push(`\n## Acceptance Criteria\n\n${issue.acceptance_criteria}`);
    if (issue.notes) parts.push(`\n## Notes\n\n${issue.notes}`);

    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return null;
  }
}

export function getTaskProgressBr(
  cwd: string,
  _sessionId: string,
  swarmTaskId: string
): string | null {
  const brId = swarmToBrId(cwd, swarmTaskId);
  if (!brId) return null;

  const result = br(['comments', 'list', brId, '--json'], cwd);
  if (result.exitCode !== 0) return null;

  try {
    const comments: BrComment[] = JSON.parse(result.stdout);
    if (comments.length === 0) return null;
    return comments
      .map((c) => `[${new Date(c.created_at).toLocaleString()}] ${c.author}: ${c.body}`)
      .join('\n');
  } catch {
    return null;
  }
}

export function archiveDoneTasksBr(cwd: string, sessionId: string): number {
  const tasks = listTasksBr(cwd, sessionId).filter((t) => t.status === 'done');
  for (const task of tasks) {
    archiveTaskBr(cwd, sessionId, task.id);
  }
  return tasks.length;
}

export function getStalledTasksBr(
  cwd: string,
  sessionId: string,
  stallThresholdMs: number = 10 * 60 * 1000
): SwarmTask[] {
  const tasks = listTasksBr(cwd, sessionId);
  const now = Date.now();
  return tasks.filter((task) => {
    if (task.status !== 'in_progress') return false;
    const lastActivity = task.progress_log?.length
      ? task.progress_log[task.progress_log.length - 1].timestamp
      : task.claimed_at;
    if (!lastActivity) return false;
    return now - Date.parse(lastActivity) >= stallThresholdMs;
  });
}
