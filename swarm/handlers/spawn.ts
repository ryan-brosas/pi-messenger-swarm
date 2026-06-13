import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import { loadAgentDefinition } from '../agent-loader.js';
import {
  cleanupExitedSpawned,
  getRunningSpawnCount,
  getRunningSpawnCountByProvider,
  listSpawned,
  listSpawnedHistory,
  reconcileSpawnedAgents,
  spawnSubagent,
  stopSpawn,
} from '../spawn.js';
import type { SpawnRequest } from '../types.js';
import { formatRoleLabel } from '../labels.js';

/** Extract provider from model string ("provider/model" -> "provider") */
function extractProvider(model: string): string | null {
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

export function executeSpawn(
  op: string | null,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string,
  maxConcurrentSpawns?: number,
  providerConcurrency?: Record<string, number>
) {
  cleanupExitedSpawned(cwd, sessionId);
  reconcileSpawnedAgents(cwd, sessionId);

  if (!op) {
    return spawnCreate(params, state, cwd, sessionId, maxConcurrentSpawns, providerConcurrency);
  }

  if (op === 'list') {
    return spawnList(cwd, sessionId);
  }

  if (op === 'history') {
    return spawnHistory(cwd, sessionId);
  }

  if (op === 'stop') {
    return spawnStop(params, cwd);
  }

  return result(`Unknown spawn operation: ${op}`, {
    mode: 'spawn',
    error: 'unknown_operation',
    operation: op,
  });
}

function spawnList(cwd: string, sessionId: string) {
  const items = listSpawned(cwd, sessionId);
  if (items.length === 0) {
    return result('No spawned agents for this project.', {
      mode: 'spawn.list',
      agents: [],
    });
  }

  const lines = [
    '# Running Spawned Agents',
    '',
    ...items.map((agent) => {
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      return `- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${tail}`;
    }),
    '',
    `Use pi-messenger-swarm spawn history to see all agents including completed.`,
  ];

  return result(lines.join('\n'), {
    mode: 'spawn.list',
    agents: items,
  });
}

function spawnHistory(cwd: string, sessionId: string) {
  const items = listSpawnedHistory(cwd, sessionId);
  const running = items.filter((a) => a.status === 'running');
  const completed = items.filter((a) => a.status === 'completed');
  const failed = items.filter((a) => a.status === 'failed');
  const stopped = items.filter((a) => a.status === 'stopped');

  if (items.length === 0) {
    return result('No spawned agents for this project.', { mode: 'spawn.history', agents: [] });
  }

  const lines: string[] = ['# Spawned Agent History', ''];

  if (running.length > 0) {
    lines.push('## Running');
    for (const agent of running.slice(0, 8)) {
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}`);
    }
    lines.push('');
  }

  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})`);
    for (const agent of completed.slice(0, 10)) {
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
    }
    if (completed.length > 10) {
      lines.push(`... and ${completed.length - 10} more`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push(`## Failed (${failed.length})`);
    for (const agent of failed.slice(0, 5)) {
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
    }
    lines.push('');
  }

  if (stopped.length > 0) {
    lines.push(`## Stopped (${stopped.length})`);
    for (const agent of stopped.slice(0, 5)) {
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
    }
    lines.push('');
  }

  return result(lines.join('\n'), {
    mode: 'spawn.history',
    agents: items,
    counts: {
      running: running.length,
      completed: completed.length,
      failed: failed.length,
      stopped: stopped.length,
    },
  });
}

function spawnStop(params: { id?: string }, cwd: string) {
  const id = params.id;
  if (!id) {
    return result('Error: id required for spawn.stop', {
      mode: 'spawn.stop',
      error: 'missing_id',
    });
  }

  const stopped = stopSpawn(cwd, id);
  if (!stopped) {
    return result(`Error: could not stop spawn ${id}.`, {
      mode: 'spawn.stop',
      error: 'not_found_or_not_running',
      id,
    });
  }

  return result(`Stopping spawned agent ${id}...`, {
    mode: 'spawn.stop',
    id,
  });
}

function spawnCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string,
  maxConcurrentSpawns?: number,
  providerConcurrency?: Record<string, number>
) {
  // Guardrail: if the user has ready tasks but forgot --task-id, warn them
  // instead of letting an unbound agent float and accidentally claim/create
  // tasks that collide with the coordinator's intent.
  if (!params.taskId && !params.force) {
    const ready = taskStore.getReadyTasks(cwd, sessionId);
    if (ready.length > 0) {
      const list = ready.map((t) => `  ${t.id}: ${t.title}`).join('\n');
      return result(
        `⚠️  You have ${ready.length} ready task${ready.length === 1 ? '' : 's'} waiting to be claimed.\n${list}\n\n` +
          `Use --task-id to bind this spawn to a specific task:\n` +
          `  pi-messenger-swarm spawn --task-id ${ready[0].id} --role "${params.role ?? 'Subagent'}" "..."\n\n` +
          `This prevents the parent agent from accidentally owning work meant for the subagent.`,
        {
          mode: 'spawn',
          error: 'missing_task_id',
          readyTasks: ready.map((t) => ({ id: t.id, title: t.title })),
        }
      );
    }
  }

  // Enforce concurrency limits to prevent thundering-herd API failures.
  // Two levels of control:
  //   1. Global limit (maxConcurrentSpawns) — total running agents across all providers
  //   2. Per-provider limit (providerConcurrency) — e.g. {"makora": 6, "lilac": 4}
  // When more subagents run than the provider supports concurrently,
  // excess agents hit rate limits and spin on retries — wasting tokens
  // and making the whole swarm appear stuck.
  const running = getRunningSpawnCount(cwd);
  const globalLimit = maxConcurrentSpawns ?? 6;
  if (running >= globalLimit) {
    return result(
      `Error: ${running} subagent${running === 1 ? '' : 's'} already running (global limit: ${globalLimit}). ` +
        `Wait for one to complete or increase maxConcurrentSpawns in .pi/pi-messenger.json.`,
      {
        mode: 'spawn',
        error: 'concurrency_limit',
        running,
        limit: globalLimit,
        limitType: 'global',
      }
    );
  }

  // Per-provider concurrency check.
  // Resolve the model from CLI --model or agent-file frontmatter.
  // We need to check BEFORE spawning, so if agentFile is set, load its model.
  let resolvedModelForCheck = params.model;
  if (!resolvedModelForCheck && params.agentFile) {
    try {
      const def = loadAgentDefinition(path.resolve(cwd, params.agentFile));
      if (def.model) resolvedModelForCheck = def.model;
    } catch {
      // Best effort — if agent file can't be loaded, skip per-provider check
    }
  }
  if (providerConcurrency && Object.keys(providerConcurrency).length > 0 && resolvedModelForCheck) {
    const provider = extractProvider(resolvedModelForCheck);
    if (provider && providerConcurrency[provider] !== undefined) {
      const providerCounts = getRunningSpawnCountByProvider(cwd);
      const providerRunning = providerCounts[provider] || 0;
      const providerLimit = providerConcurrency[provider];
      if (providerRunning >= providerLimit) {
        return result(
          `Error: ${providerRunning} subagent${providerRunning === 1 ? '' : 's'} already running on ${provider} (limit: ${providerLimit}). ` +
            `Wait for one to complete or increase providerConcurrency.${provider} in .pi/pi-messenger.json.`,
          {
            mode: 'spawn',
            error: 'provider_concurrency_limit',
            running: providerRunning,
            limit: providerLimit,
            limitType: 'provider',
            provider,
            providerCounts,
          }
        );
      }
    }
  }

  // --message-file: read mission text from a file to avoid shell interpolation
  // of backticks, ${...}, parentheses, etc. in the prompt.
  let message = params.message?.trim() || params.prompt?.trim();
  if (params.messageFile) {
    try {
      const fileContent = fs.readFileSync(params.messageFile, 'utf-8').trim();
      if (fileContent) message = fileContent;
    } catch {
      return result(`Error: cannot read --message-file: ${params.messageFile}`, {
        mode: 'spawn',
        error: 'message_file_read_error',
      });
    }
  }

  // File-based spawn mode
  if (params.agentFile) {
    const request: SpawnRequest = {
      agentFile: params.agentFile,
      model: params.model, // CLI --model override takes precedence over agent-file frontmatter
      objective: params.objective,
      message,
      context: params.context,
      taskId: params.taskId,
      name: params.name,
    };

    try {
      const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
      const roleLabel = formatRoleLabel(record.role);
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `spawned ${record.name} (${roleLabel})`,
        state.currentChannel
      );

      return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
        mode: 'spawn',
        agent: record,
      });
    } catch (err) {
      return result(`Error: ${err instanceof Error ? err.message : String(err)}`, {
        mode: 'spawn',
        error: 'spawn_failed',
      });
    }
  }

  // Autoregressive spawn mode (traditional)
  const objective = params.objective?.trim() || message;
  if (!objective) {
    return result('Error: spawn requires mission text or --objective.', {
      mode: 'spawn',
      error: 'missing_objective',
    });
  }

  const role = params.role?.trim() || params.title?.trim() || 'Subagent';
  const request: SpawnRequest = {
    role,
    persona: params.persona,
    model: params.model, // CLI --model override
    objective,
    context: params.context,
    taskId: params.taskId,
    name: params.name,
  };

  const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
  const roleLabel = formatRoleLabel(record.role);
  logFeedEvent(
    cwd,
    state.agentName,
    'message',
    undefined,
    `spawned ${record.name} (${roleLabel})`,
    state.currentChannel
  );

  return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
    mode: 'spawn',
    agent: record,
  });
}
