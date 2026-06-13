/**
 * Team Handler — orchestrates multi-agent team execution.
 *
 * Reads a team definition, creates br epic + child tasks with
 * agent-context, adds dependencies, then spawns agents wave by wave.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import {
  loadTeamDefinition,
  computeWaves,
  type TeamDefinition,
  type TeamStep,
} from '../team-loader.js';
import {
  spawnSubagent,
  getRunningSpawnCount,
  getRunningSpawnCountByProvider,
  onSpawnCompletion,
} from '../spawn.js';
import type { SpawnRequest } from '../types.js';
import { formatRoleLabel } from '../labels.js';
import * as taskStore from '../task-store/index.js';

// ── Shared provider extraction utility ────────────────────────────────────

/** Extract provider from model string ("provider/model" → "provider") */
function extractProvider(model: string | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf('/');
  return slash > 0 ? model.slice(0, slash) : null;
}

// ── Active team tracking for auto-advance ──────────────────────────────────

interface ActiveTeam {
  def: TeamDefinition;
  stepTaskIds: Map<string, string>;
  cwd: string;
  sessionId: string;
  channel: string | undefined;
  agentName: string;
  maxConcurrentSpawns?: number;
  providerConcurrency?: Record<string, number>;
  completedSteps: Set<string>;
  failedSteps: Set<string>;
}

const activeTeams: ActiveTeam[] = [];

/** Register a team for auto-advance tracking */
function registerActiveTeam(team: ActiveTeam): void {
  activeTeams.push(team);
}

/** Try to advance a team when a task completes */
function tryAdvanceTeam(
  _agentId: string,
  taskId: string | undefined,
  status: 'completed' | 'failed' | 'stopped',
  cwd: string,
  _sessionId: string
): void {
  if (!taskId) return;

  for (const team of activeTeams) {
    if (team.cwd !== cwd) continue;

    // Find which step this task belongs to
    let completedStepId: string | undefined;
    for (const [stepId, tid] of team.stepTaskIds) {
      if (tid === taskId) {
        completedStepId = stepId;
        break;
      }
    }
    if (!completedStepId) continue;

    if (status === 'completed') {
      team.completedSteps.add(completedStepId);
    } else {
      team.failedSteps.add(completedStepId);
    }

    // Check if any new steps are now ready
    const waves = computeWaves(team.def.steps);
    for (const step of team.def.steps) {
      // Skip if already completed, failed, or spawned
      if (team.completedSteps.has(step.id) || team.failedSteps.has(step.id)) continue;

      // Skip if the step's task isn't in our map
      const stepTaskId = team.stepTaskIds.get(step.id);
      if (!stepTaskId) continue;

      // Check if all dependencies are completed
      const deps = step.dependsOn || [];
      const allDepsComplete = deps.every((d) => team.completedSteps.has(d));
      if (!allDepsComplete) continue;

      // Check if any dependency failed
      const anyDepFailed = deps.some((d) => team.failedSteps.has(d));
      if (anyDepFailed) {
        logFeedEvent(
          team.cwd,
          team.agentName,
          'message',
          undefined,
          `team: skipping step '${step.id}' — dependency failed`,
          team.channel
        );
        team.failedSteps.add(step.id);
        continue;
      }

      // Check concurrency limits
      const globalLimit = team.maxConcurrentSpawns ?? 6;
      if (getRunningSpawnCount(cwd) >= globalLimit) {
        logFeedEvent(
          team.cwd,
          team.agentName,
          'message',
          undefined,
          `team: deferring step '${step.id}' — global limit reached`,
          team.channel
        );
        continue;
      }

      if (team.providerConcurrency && Object.keys(team.providerConcurrency).length > 0) {
        const provider = extractProvider(step.model);
        if (provider && team.providerConcurrency[provider] !== undefined) {
          const providerCounts = getRunningSpawnCountByProvider(cwd);
          const providerRunning = providerCounts[provider] || 0;
          const providerLimit = team.providerConcurrency[provider];
          if (providerRunning >= providerLimit) {
            logFeedEvent(
              team.cwd,
              team.agentName,
              'message',
              undefined,
              `team: deferring step '${step.id}' — ${provider} at capacity`,
              team.channel
            );
            continue;
          }
        }
      }

      // Spawn the next step's agent
      const request: SpawnRequest = {
        role: step.role,
        model: step.model,
        agentFile: step.agentFile,
        objective: step.objective,
        context: team.def.context || step.persona,
        taskId: stepTaskId,
        name: step.id,
      };

      try {
        const record = spawnSubagent(cwd, request, team.sessionId, team.channel);
        logFeedEvent(
          team.cwd,
          team.agentName,
          'message',
          undefined,
          `team: auto-advanced step '${step.id}' → spawned ${record.name} (${step.model})`,
          team.channel
        );
      } catch (err) {
        logFeedEvent(
          team.cwd,
          team.agentName,
          'message',
          undefined,
          `team: failed to auto-advance step '${step.id}': ${err instanceof Error ? err.message : String(err)}`,
          team.channel
        );
      }
    }

    // Clean up if all steps are done or failed
    const allDone = team.def.steps.every(
      (s) => team.completedSteps.has(s.id) || team.failedSteps.has(s.id)
    );
    if (allDone) {
      const idx = activeTeams.indexOf(team);
      if (idx >= 0) activeTeams.splice(idx, 1);
      logFeedEvent(
        team.cwd,
        team.agentName,
        'message',
        undefined,
        `team: '${team.def.name}' complete — ${team.completedSteps.size} succeeded, ${team.failedSteps.size} failed`,
        team.channel
      );
    }
  }
}

// Register the auto-advance callback once
onSpawnCompletion(tryAdvanceTeam);

interface TeamRunResult {
  epicId: string;
  taskIds: string[];
  spawnedAgents: string[];
}

export function executeTeam(
  op: string | null,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string,
  maxConcurrentSpawns?: number,
  providerConcurrency?: Record<string, number>
) {
  if (op === 'list') {
    return teamList();
  }

  if (op === 'show') {
    const file = params.agentFile || params.message;
    if (!file) {
      return result('Error: team show requires a file path.', {
        mode: 'team.show',
        error: 'missing_file',
      });
    }
    return teamShow(file);
  }

  // Default: team run
  return teamRun(params, state, cwd, sessionId, maxConcurrentSpawns, providerConcurrency);
}

function teamList() {
  // Scan ~/.pi/teams/ for team definition files
  const teamsDir = path.join(getAgentDir(), '..', 'teams');

  let files: string[] = [];
  try {
    if (fs.existsSync(teamsDir)) {
      files = fs
        .readdirSync(teamsDir)
        .filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md'))
        .sort();
    }
  } catch {
    // Directory doesn't exist
  }

  if (files.length === 0) {
    return result('No team definitions found. Create one in ~/.pi/teams/ (YAML or MD format).', {
      mode: 'team.list',
      teams: [],
    });
  }

  const lines: string[] = ['# Available Team Definitions', ''];
  for (const file of files) {
    try {
      const def = loadTeamDefinition(path.join(teamsDir, file));
      const stepCount = def.steps.length;
      const models = [...new Set(def.steps.map((s) => s.model))];
      lines.push(`- **${file}**: ${def.name} (${stepCount} steps, models: ${models.join(', ')})`);
    } catch (err) {
      lines.push(`- ${file}: ⚠️ parse error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  lines.push('', 'Use `pi-messenger-swarm team run <file> "objective"` to launch a team.');

  return result(lines.join('\n'), { mode: 'team.list', teams: files });
}

function teamShow(filePath: string) {
  try {
    const def = loadTeamDefinition(filePath);
    const waves = computeWaves(def.steps);

    const lines: string[] = [
      `# ${def.name}`,
      '',
      def.description ? `${def.description}` : '',
      '',
      '## Steps',
      '',
    ];

    for (let w = 0; w < waves.length; w++) {
      if (w > 0) lines.push('');
      lines.push(`### Wave ${w}${w === 0 ? ' (parallel)' : ' (after wave ' + (w - 1) + ')'}`);
      for (const step of waves[w]) {
        const deps = step.dependsOn?.length ? ` ← depends on ${step.dependsOn.join(', ')}` : '';
        const input = step.input ? ` ← input from ${step.input}` : '';
        lines.push(`- **${step.id}**: ${step.role} (${step.model})${deps}${input}`);
        lines.push(`  Objective: ${step.objective}`);
      }
    }

    return result(lines.join('\n'), { mode: 'team.show', definition: def, waves });
  } catch (err) {
    return result(`Error loading team: ${err instanceof Error ? err.message : String(err)}`, {
      mode: 'team.show',
      error: 'load_failed',
    });
  }
}

function teamRun(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string,
  maxConcurrentSpawns?: number,
  providerConcurrency?: Record<string, number>
) {
  const filePath = params.agentFile;
  const mission = params.message || params.objective || '';

  if (!filePath) {
    return result(
      'Error: team run requires --agent-file <path> pointing to a team definition.\n' +
        'Usage: pi-messenger-swarm team run --agent-file ~/.pi/teams/plan-implement-audit.yaml "Fix the auth bug"',
      { mode: 'team.run', error: 'missing_file' }
    );
  }

  // Load and validate team definition
  let def: TeamDefinition;
  try {
    def = loadTeamDefinition(filePath);
  } catch (err) {
    return result(
      `Error loading team definition: ${err instanceof Error ? err.message : String(err)}`,
      { mode: 'team.run', error: 'load_failed' }
    );
  }

  // Check concurrency
  const running = getRunningSpawnCount(cwd);
  const globalLimit = maxConcurrentSpawns ?? 6;
  if (running >= globalLimit) {
    return result(
      `Error: ${running} subagents already running (global limit: ${globalLimit}). Cannot launch team.`,
      { mode: 'team.run', error: 'concurrency_limit', running, limit: globalLimit }
    );
  }

  // Create tasks in two passes:
  // Pass 1: Create all tasks (no deps yet — ensures stepTaskIds is populated)
  // Pass 2: Set dependencies now that all task IDs are known
  const stepTaskIds: Map<string, string> = new Map();
  const createdTasks: string[] = [];

  for (const step of def.steps) {
    const objective = mission ? `${step.objective} — Mission: ${mission}` : step.objective;

    // Create the task without dependencies first
    const task = taskStore.createTask(
      cwd,
      sessionId,
      {
        title: `[${def.name}] ${step.id}: ${step.role} — ${objective.slice(0, 80)}`,
        content: objective,
        createdBy: state.agentName,
      },
      state.currentChannel || 'default'
    );

    if (task) {
      stepTaskIds.set(step.id, task.id);
      createdTasks.push(task.id);
    }
  }

  // Pass 2: Add dependencies now that all task IDs are known
  for (const step of def.steps) {
    if (!step.dependsOn || step.dependsOn.length === 0) continue;
    const taskId = stepTaskIds.get(step.id);
    if (!taskId) continue;
    const depIds = step.dependsOn.map((d) => stepTaskIds.get(d)).filter((id): id is string => !!id);
    if (depIds.length > 0) {
      // Update task dependencies via the task store
      // Since task-store doesn't have a direct "add deps" API,
      // we note deps in the task metadata via the context field
      const existingTask = taskStore.getTask(cwd, sessionId, taskId);
      if (existingTask) {
        existingTask.depends_on = depIds;
      }
    }
  }

  // Compute waves
  const waves = computeWaves(def.steps);

  // Spawn agents for wave 0 (no dependencies — ready immediately)
  const spawnedAgents: string[] = [];
  const wave0 = waves[0] || [];

  for (const step of wave0) {
    // Check per-provider limit
    if (providerConcurrency && Object.keys(providerConcurrency).length > 0) {
      const provider = extractProvider(step.model);
      if (provider && providerConcurrency[provider] !== undefined) {
        const providerCounts = getRunningSpawnCountByProvider(cwd);
        const providerRunning = providerCounts[provider] || 0;
        const providerLimit = providerConcurrency[provider];
        if (providerRunning >= providerLimit) {
          logFeedEvent(
            cwd,
            state.agentName,
            'message',
            undefined,
            `team: skipping ${step.id} (${step.model}) — ${provider} at capacity (${providerRunning}/${providerLimit})`,
            state.currentChannel
          );
          continue;
        }
      }
    }

    // Check global limit
    if (getRunningSpawnCount(cwd) >= globalLimit) {
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `team: skipping ${step.id} — global limit reached (${globalLimit})`,
        state.currentChannel
      );
      continue;
    }

    const taskId = stepTaskIds.get(step.id);
    const objective = mission ? `${step.objective} — Mission: ${mission}` : step.objective;

    const contextParts: string[] = [];
    if (def.context) contextParts.push(def.context);
    if (step.persona) contextParts.push(`Persona: ${step.persona}`);

    const request: SpawnRequest = {
      role: step.role,
      model: step.model,
      agentFile: step.agentFile,
      objective,
      context: contextParts.length > 0 ? contextParts.join('\n\n') : undefined,
      taskId: taskId,
      name: step.id,
    };

    try {
      const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
      const roleLabel = formatRoleLabel(record.role);
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `team: spawned ${record.name} (${roleLabel}, ${step.model}) for step '${step.id}'`,
        state.currentChannel
      );
      spawnedAgents.push(record.id);
    } catch (err) {
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `team: failed to spawn ${step.id}: ${err instanceof Error ? err.message : String(err)}`,
        state.currentChannel
      );
    }
  }

  // Build result
  const waveInfo = waves.map((w, i) => ({
    wave: i,
    steps: w.map((s) => s.id),
    spawned: w
      .filter((s) => i === 0) // only wave 0 is spawned now
      .map((s) => s.id)
      .filter((id) => spawnedAgents.some(() => stepTaskIds.has(id))),
  }));

  const lines: string[] = [
    `# 🏁 Team: ${def.name}`,
    '',
    `Mission: ${mission || '(none)'}`,
    `Steps: ${def.steps.length} across ${waves.length} wave(s)`,
    `Tasks created: ${createdTasks.length}`,
    `Agents spawned: ${spawnedAgents.length} (wave 0)`,
    '',
    '## Wave Plan',
  ];

  for (let i = 0; i < waves.length; i++) {
    const waveSteps = waves[i].map((s) => {
      const model = s.model.split('/').pop();
      return `${s.id} (${s.role}/${model})`;
    });
    const status = i === 0 ? '✅ spawned' : '⏳ waiting';
    lines.push(`- Wave ${i}: ${waveSteps.join(', ')} — ${status}`);
  }

  lines.push('');
  lines.push('Subsequent waves auto-start when dependencies complete.');
  lines.push('Monitor: `pi-messenger-swarm task list` | `pi-messenger-swarm spawn list`');

  // Register team for auto-advance tracking
  registerActiveTeam({
    def,
    stepTaskIds,
    cwd,
    sessionId,
    channel: state.currentChannel,
    agentName: state.agentName,
    maxConcurrentSpawns,
    providerConcurrency,
    completedSteps: new Set(),
    failedSteps: new Set(),
  });

  return result(lines.join('\n'), {
    mode: 'team.run',
    teamName: def.name,
    epicId: null,
    taskIds: createdTasks,
    spawnedAgents,
    waves: waveInfo,
  });
}
