/**
 * Task Store — unified API that auto-routes to br beads or JSONL.
 *
 * When .beads/ exists in cwd and br is available:
 *   - create/claim/complete/etc. → br CLI calls
 *   - artifacts (design, acceptance_criteria, notes, agent_context) stored in br
 *   - progress → br comments
 *   - dependencies → br dep
 *
 * Otherwise falls back to JSONL event-sourced store in .pi/messenger/tasks/
 */

// ── Types (always available) ───────────────────────────────────────────────
export type {
  TaskEvent,
  TaskEventType,
  CreatedPayload,
  ClaimedPayload,
  ProgressPayload,
  CompletedPayload,
} from './types.js';

// ── JSONL internals (for direct access / testing) ──────────────────────────
export { appendTaskEvent, replayEventsToMap, replayTasks, replayAllTasks } from './events.js';
export { getTasksJsonlPath, getTaskSpecsDir, taskSpecPath } from './persistence.js';
export { cleanupStaleTaskClaims } from './cleanup.js';

// ── Br adapter (for direct access) ─────────────────────────────────────────
export {
  isBrAvailable,
  createTaskBr,
  claimTaskBr,
  unclaimTaskBr,
  completeTaskBr,
  blockTaskBr,
  unblockTaskBr,
  resetTaskBr,
  archiveTaskBr,
  deleteTaskBr,
  appendTaskProgressBr,
  listTasksBr,
  getTaskBr,
  taskExistsBr,
  getSummaryBr,
  getReadyTasksBr,
  getTaskSpecBr,
  getTaskProgressBr,
  archiveDoneTasksBr,
  getStalledTasksBr,
  updateArtifactsBr,
  getArtifactsBr,
  getArtifactDirPath,
  getArtifactDirPathByBrId,
  listArtifactFilesBr,
  readArtifactFileBr,
  writeArtifactFileBr,
  appendSolveLedgerBr,
  type BrTaskArtifacts,
  type BrTaskCreateInput,
} from './br-adapter.js';

// ── Unified API (auto-routes based on .beads/ availability) ────────────────

import {
  isBrAvailable,
  createTaskBr,
  claimTaskBr,
  unclaimTaskBr,
  completeTaskBr,
  blockTaskBr,
  unblockTaskBr,
  resetTaskBr,
  archiveTaskBr,
  deleteTaskBr,
  appendTaskProgressBr,
  listTasksBr,
  getTaskBr,
  taskExistsBr,
  getSummaryBr,
  getReadyTasksBr,
  getTaskSpecBr,
  getTaskProgressBr,
  archiveDoneTasksBr,
  getStalledTasksBr,
} from './br-adapter.js';
import type { BrTaskCreateInput } from './br-adapter.js';
import * as jsonl from './commands.js';
import * as jsonlQ from './queries.js';
import type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence, SwarmSummary } from '../types.js';

function useBr(cwd: string): boolean {
  return isBrAvailable(cwd);
}

function filterTasksByChannel(tasks: SwarmTask[], channelId?: string): SwarmTask[] {
  if (!channelId) return tasks;
  return tasks.filter((task) => task.channel === channelId);
}

/** Check whether the cwd uses br beads backend */
export function useBrBackend(cwd: string): boolean {
  return useBr(cwd);
}

// ── Commands (createTask, claimTask, etc.) ──────────────────────────────────

export function createTask(
  cwd: string,
  sessionId: string,
  input: SwarmTaskCreateInput | BrTaskCreateInput,
  channelId: string
): SwarmTask {
  if (useBr(cwd)) {
    const result = createTaskBr(cwd, sessionId, input as BrTaskCreateInput, channelId);
    if (result) return result;
    // Fall back to JSONL if br fails
  }
  return jsonl.createTask(cwd, sessionId, input as SwarmTaskCreateInput, channelId);
}

export function claimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason?: string
): SwarmTask | null {
  if (useBr(cwd)) return claimTaskBr(cwd, sessionId, taskId, agentName, reason);
  return jsonl.claimTask(cwd, sessionId, taskId, agentName, reason);
}

export function unclaimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string
): SwarmTask | null {
  if (useBr(cwd)) return unclaimTaskBr(cwd, sessionId, taskId, agentName);
  return jsonl.unclaimTask(cwd, sessionId, taskId, agentName);
}

export function completeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  summary: string,
  evidence?: SwarmTaskEvidence
): SwarmTask | null {
  if (useBr(cwd)) return completeTaskBr(cwd, sessionId, taskId, agentName, summary, evidence);
  return jsonl.completeTask(cwd, sessionId, taskId, agentName, summary, evidence);
}

export function blockTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason: string
): SwarmTask | null {
  if (useBr(cwd)) return blockTaskBr(cwd, sessionId, taskId, agentName, reason);
  return jsonl.blockTask(cwd, sessionId, taskId, agentName, reason);
}

export function unblockTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  if (useBr(cwd)) return unblockTaskBr(cwd, sessionId, taskId);
  return jsonl.unblockTask(cwd, sessionId, taskId);
}

export function resetTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  cascade: boolean = false
): SwarmTask[] {
  if (useBr(cwd)) return resetTaskBr(cwd, sessionId, taskId, cascade);
  return jsonl.resetTask(cwd, sessionId, taskId, cascade);
}

export function archiveTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  if (useBr(cwd)) return archiveTaskBr(cwd, sessionId, taskId);
  return jsonl.archiveTask(cwd, sessionId, taskId);
}

export function archiveDoneTasks(cwd: string, sessionId: string): number {
  if (useBr(cwd)) return archiveDoneTasksBr(cwd, sessionId);
  return jsonl.archiveDoneTasks(cwd, sessionId);
}

export function deleteTask(cwd: string, sessionId: string, taskId: string): boolean {
  if (useBr(cwd)) return deleteTaskBr(cwd, sessionId, taskId);
  return jsonl.deleteTask(cwd, sessionId, taskId);
}

export function appendTaskProgress(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  message: string
): void {
  if (useBr(cwd)) return appendTaskProgressBr(cwd, sessionId, taskId, agentName, message);
  return jsonl.appendTaskProgress(cwd, sessionId, taskId, agentName, message);
}

// ── Queries (getTasks, getTask, etc.) ──────────────────────────────────────

export function getTasks(cwd: string, sessionId: string, channelId?: string): SwarmTask[] {
  if (useBr(cwd)) return listTasksBr(cwd, sessionId, channelId);
  return filterTasksByChannel(jsonlQ.getTasks(cwd, sessionId), channelId);
}

export function getAllTasks(cwd: string, sessionId: string, channelId?: string): SwarmTask[] {
  if (useBr(cwd)) return listTasksBr(cwd, sessionId, channelId); // br doesn't filter archived differently
  return filterTasksByChannel(jsonlQ.getAllTasks(cwd, sessionId), channelId);
}

export function getTask(cwd: string, sessionId: string, taskId: string): SwarmTask | undefined {
  if (useBr(cwd)) return getTaskBr(cwd, sessionId, taskId) ?? undefined;
  return jsonlQ.getTask(cwd, sessionId, taskId);
}

export function taskExists(cwd: string, sessionId: string, taskId: string): boolean {
  if (useBr(cwd)) return taskExistsBr(cwd, sessionId, taskId);
  return jsonlQ.taskExists(cwd, sessionId, taskId);
}

export function getSummary(cwd: string, sessionId: string, channelId?: string): SwarmSummary {
  if (useBr(cwd)) return getSummaryBr(cwd, sessionId, channelId);
  if (channelId) return getSummaryForTasks(getTasks(cwd, sessionId, channelId));
  return jsonlQ.getSummary(cwd, sessionId);
}

export function getSummaryForTasks(tasks: SwarmTask[]): SwarmSummary {
  return jsonlQ.getSummaryForTasks(tasks);
}

export function getReadyTasks(cwd: string, sessionId: string, channelId?: string): SwarmTask[] {
  if (useBr(cwd)) return getReadyTasksBr(cwd, sessionId, channelId);
  if (channelId) return getReadyTasksForTasks(getTasks(cwd, sessionId, channelId));
  return jsonlQ.getReadyTasks(cwd, sessionId);
}

export function getReadyTasksForTasks(tasks: SwarmTask[]): SwarmTask[] {
  return jsonlQ.getReadyTasksForTasks(tasks);
}

export function getStalledTasks(
  cwd: string,
  sessionId: string,
  stallMs?: number,
  channelId?: string
): SwarmTask[] {
  if (useBr(cwd)) return getStalledTasksBr(cwd, sessionId, stallMs, channelId);
  const stalled = jsonlQ.getStalledTasks(cwd, sessionId, stallMs);
  return filterTasksByChannel(stalled, channelId);
}

export function getTaskSpec(cwd: string, sessionId: string, taskId: string): string | null {
  if (useBr(cwd)) return getTaskSpecBr(cwd, sessionId, taskId);
  return jsonlQ.getTaskSpec(cwd, sessionId, taskId);
}

export function getTaskProgress(cwd: string, sessionId: string, taskId: string): string | null {
  if (useBr(cwd)) return getTaskProgressBr(cwd, sessionId, taskId);
  return jsonlQ.getTaskProgress(cwd, sessionId, taskId);
}

export function _resetCleanupThrottle(cwd?: string, sessionId?: string): void {
  jsonlQ._resetCleanupThrottle(cwd, sessionId);
}
