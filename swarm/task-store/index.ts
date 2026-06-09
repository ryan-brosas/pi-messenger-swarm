/**
 * Task store barrel export.
 *
 * When BR_TASK_STORE=1 is set and br is initialized (.beads/beads.db exists),
 * task operations are routed through the br (beads_rust) adapter instead of
 * the legacy JSONL event store. The br adapter provides SQLite-backed queries,
 * dependency-aware ready/blocked, content hashing, and audit events.
 *
 * Phase 1: tasks → br, channels/agents/feed remain on JSONL.
 *
 * The exported function signatures match the originals exactly:
 *   (cwd, sessionId, ...) — callers pass cwd explicitly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// Types are always from the legacy module (they're identical for both backends)
export type {
  TaskEvent,
  TaskEventType,
  CreatedPayload,
  ClaimedPayload,
  ProgressPayload,
  CompletedPayload,
  BlockedPayload,
} from './types.js';

// Legacy-only exports (internal use, not in the br path)
export { appendTaskEvent, replayEventsToMap, replayTasks, replayAllTasks } from './events.js';
export { getTasksJsonlPath, getTaskSpecsDir, taskSpecPath } from './persistence.js';

// Import both backends
import * as legacy from './legacy-exports.js';

function isBrEnabled(cwd?: string): boolean {
  if (process.env.BR_TASK_STORE !== '1') return false;
  if (!cwd) cwd = process.env.PI_MESSENGER_CWD ?? process.cwd();
  return fs.existsSync(path.join(cwd, '.beads', 'beads.db'));
}

// Re-export everything, dispatching to br when enabled.
// Signatures match the originals: (cwd, sessionId, ...)

export function getTasks(cwd: string, sessionId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getTasks(cwd, sessionId)
    : legacy.jsonlQueries.getTasks(cwd, sessionId);
}

export function getAllTasks(cwd: string, sessionId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getAllTasks(cwd, sessionId)
    : legacy.jsonlQueries.getAllTasks(cwd, sessionId);
}

export function getTask(cwd: string, sessionId: string, taskId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getTask(cwd, sessionId, taskId)
    : legacy.jsonlQueries.getTask(cwd, sessionId, taskId);
}

export function taskExists(cwd: string, sessionId: string, taskId: string): boolean {
  return isBrEnabled(cwd)
    ? legacy.brQueries.taskExists(cwd, sessionId, taskId)
    : legacy.jsonlQueries.taskExists(cwd, sessionId, taskId);
}

export function getSummary(cwd: string, sessionId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getSummary(cwd, sessionId)
    : legacy.jsonlQueries.getSummary(cwd, sessionId);
}

export function getSummaryForTasks(cwd: string, sessionId: string, tasks: legacy.SwarmTask[]) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getSummaryForTasks(cwd, sessionId, tasks)
    : legacy.jsonlQueries.getSummaryForTasks(tasks);
}

export function getReadyTasks(cwd: string, sessionId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getReadyTasks(cwd, sessionId)
    : legacy.jsonlQueries.getReadyTasks(cwd, sessionId);
}

export function getReadyTasksForTasks(cwd: string, sessionId: string, tasks: legacy.SwarmTask[]) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getReadyTasksForTasks(cwd, sessionId, tasks)
    : legacy.jsonlQueries.getReadyTasksForTasks(tasks);
}

export function getStalledTasks(cwd: string, sessionId: string) {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getStalledTasks(cwd, sessionId)
    : legacy.jsonlQueries.getStalledTasks(cwd, sessionId);
}

export function getTaskSpec(cwd: string, sessionId: string, taskId: string): string | null {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getTaskSpec(cwd, sessionId, taskId)
    : legacy.jsonlQueries.getTaskSpec(cwd, sessionId, taskId);
}

export function getTaskProgress(cwd: string, sessionId: string, taskId: string): string | null {
  return isBrEnabled(cwd)
    ? legacy.brQueries.getTaskProgress(cwd, sessionId, taskId)
    : legacy.jsonlQueries.getTaskProgress(cwd, sessionId, taskId);
}

export function _resetCleanupThrottle(cwd?: string, sessionId?: string): void {
  return legacy.jsonlQueries._resetCleanupThrottle(cwd, sessionId);
}

export function createTask(
  cwd: string,
  sessionId: string,
  input: legacy.SwarmTaskCreateInput,
  channelId: string
): legacy.SwarmTask {
  return isBrEnabled(cwd)
    ? legacy.brCommands.createTask(cwd, sessionId, input, channelId)
    : legacy.jsonlCommands.createTask(cwd, sessionId, input, channelId);
}

export function claimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason?: string
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.claimTask(cwd, sessionId, taskId, agentName, reason)
    : legacy.jsonlCommands.claimTask(cwd, sessionId, taskId, agentName, reason);
}

export function unclaimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.unclaimTask(cwd, sessionId, taskId, agentName)
    : legacy.jsonlCommands.unclaimTask(cwd, sessionId, taskId, agentName);
}

export function blockTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason: string
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.blockTask(cwd, sessionId, taskId, agentName, reason)
    : legacy.jsonlCommands.blockTask(cwd, sessionId, taskId, agentName, reason);
}

export function unblockTask(
  cwd: string,
  sessionId: string,
  taskId: string
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.unblockTask(cwd, sessionId, taskId)
    : legacy.jsonlCommands.unblockTask(cwd, sessionId, taskId);
}

export function completeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  summary: string,
  evidence?: legacy.SwarmTaskEvidence
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.completeTask(cwd, sessionId, taskId, agentName, summary, evidence)
    : legacy.jsonlCommands.completeTask(cwd, sessionId, taskId, agentName, summary, evidence);
}

export function resetTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  cascade?: boolean
): legacy.SwarmTask[] {
  return isBrEnabled(cwd)
    ? legacy.brCommands.resetTask(cwd, sessionId, taskId, cascade)
    : legacy.jsonlCommands.resetTask(cwd, sessionId, taskId, cascade);
}

export function archiveTask(
  cwd: string,
  sessionId: string,
  taskId: string
): legacy.SwarmTask | null {
  return isBrEnabled(cwd)
    ? legacy.brCommands.archiveTask(cwd, sessionId, taskId)
    : legacy.jsonlCommands.archiveTask(cwd, sessionId, taskId);
}

export function archiveDoneTasks(cwd: string, sessionId: string): number {
  return isBrEnabled(cwd)
    ? legacy.brCommands.archiveDoneTasks(cwd, sessionId)
    : legacy.jsonlCommands.archiveDoneTasks(cwd, sessionId);
}

export function deleteTask(cwd: string, sessionId: string, taskId: string): boolean {
  return isBrEnabled(cwd)
    ? legacy.brCommands.deleteTask(cwd, sessionId, taskId)
    : legacy.jsonlCommands.deleteTask(cwd, sessionId, taskId);
}

export function appendTaskProgress(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  message: string
): void {
  return isBrEnabled(cwd)
    ? legacy.brCommands.appendTaskProgress(cwd, sessionId, taskId, agentName, message)
    : legacy.jsonlCommands.appendTaskProgress(cwd, sessionId, taskId, agentName, message);
}

export function cleanupStaleTaskClaims(cwd: string, sessionId: string): void {
  if (isBrEnabled(cwd)) {
    legacy.brCommands.cleanupStaleTaskClaims();
  } else {
    legacy.jsonlCleanup.cleanupStaleTaskClaims(cwd, sessionId);
  }
}
