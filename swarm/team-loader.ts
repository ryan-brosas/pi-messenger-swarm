/**
 * Team Definition Loader — parses team YAML/MD files.
 *
 * A team file defines a pipeline of agents with roles, models,
 * dependencies, and output wiring. When run, it creates a br epic
 * with child tasks, sets agent-context, adds deps, and spawns agents.
 *
 * File format (YAML frontmatter + optional body):
 *
 *   ---
 *   name: Plan → Implement → Audit
 *   description: GPT plans, GLM implements, MiMo audits
 *   ---
 *   Optional free-text context appended to every agent's objective.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

export interface TeamStep {
  /** Unique step ID within the team */
  id: string;
  /** Agent role label */
  role: string;
  /** LLM model (provider/model format) */
  model: string;
  /** Path to agent-file (optional, overrides role/persona/objective) */
  agentFile?: string;
  /** Default objective template — {input} is replaced by parent step output */
  objective: string;
  /** Step IDs this step depends on (must complete first) */
  dependsOn?: string[];
  /** Which step's output to use as input (default: last dependency) */
  input?: string;
  /** Priority for br task (0-4) */
  priority?: number;
  /** Time estimate in minutes */
  estimate?: number;
  /** Persona override */
  persona?: string;
}

export interface TeamDefinition {
  /** Team name */
  name: string;
  /** Team description */
  description?: string;
  /** Steps in the pipeline */
  steps: TeamStep[];
  /** Global context appended to every agent's objective */
  context?: string;
  /** Max concurrent agents for this team (overrides global) */
  maxConcurrent?: number;
}

/**
 * Parse a team definition file.
 *
 * Supports two formats:
 * 1. Pure YAML file (entire file is YAML)
 * 2. Markdown with YAML frontmatter (--- delimiters)
 *
 * In format 2, the body after frontmatter becomes the global context.
 */
export function loadTeamDefinition(filePath: string): TeamDefinition {
  const resolved = path.resolve(filePath);
  const content = fs.readFileSync(resolved, 'utf-8');
  const ext = path.extname(resolved).toLowerCase();

  // Try frontmatter format first (works for .md and .yaml)
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  let yamlContent: string;
  let bodyContext: string | undefined;

  if (fmMatch) {
    yamlContent = fmMatch[1];
    const body = fmMatch[2].trim();
    if (body) bodyContext = body;
  } else {
    // Pure YAML
    yamlContent = content;
  }

  const parsed = yaml.parse(yamlContent);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid team definition: ${filePath}`);
  }

  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error(`Team definition missing 'name': ${filePath}`);
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    throw new Error(`Team definition missing 'steps' array: ${filePath}`);
  }

  const steps: TeamStep[] = parsed.steps.map((step: any, i: number) => {
    if (!step.id) throw new Error(`Step ${i} missing 'id'`);
    if (!step.role) throw new Error(`Step ${step.id} missing 'role'`);
    if (!step.model) throw new Error(`Step ${step.id} missing 'model'`);
    if (!step.objective) throw new Error(`Step ${step.id} missing 'objective'`);

    // Resolve agent-file path relative to the team file's directory
    let agentFile: string | undefined;
    if (step.agent_file || step.agentFile) {
      const raw = step.agent_file || step.agentFile;
      agentFile = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(resolved), raw);
    }

    return {
      id: step.id,
      role: step.role,
      model: step.model,
      agentFile,
      objective: step.objective,
      dependsOn: step.depends_on || step.dependsOn,
      input: step.input,
      priority: step.priority,
      estimate: step.estimate,
      persona: step.persona,
    };
  });

  // Validate: all dependsOn references must exist
  const stepIds = new Set(steps.map((s) => s.id));
  for (const step of steps) {
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep)) {
          throw new Error(`Step '${step.id}' depends on unknown step '${dep}'`);
        }
      }
    }
    if (step.input && !stepIds.has(step.input)) {
      throw new Error(`Step '${step.id}' references unknown input step '${step.input}'`);
    }
  }

  return {
    name: parsed.name,
    description: parsed.description,
    steps,
    context: bodyContext || parsed.context,
    maxConcurrent: parsed.max_concurrent || parsed.maxConcurrent,
  };
}

/**
 * Compute execution waves — groups of steps that can run in parallel.
 * Wave 0 has no dependencies, wave 1 depends only on wave 0, etc.
 */
export function computeWaves(steps: TeamStep[]): TeamStep[][] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const waveOf = new Map<string, number>();
  const computing = new Set<string>(); // Cycle detection

  function getWave(id: string): number {
    if (waveOf.has(id)) return waveOf.get(id)!;
    if (computing.has(id)) {
      throw new Error(
        `Circular dependency detected involving step '${id}'. ` +
          `Cycle: ${[...computing, id].join(' → ')}`
      );
    }
    computing.add(id);
    const step = stepMap.get(id)!;
    if (!step.dependsOn || step.dependsOn.length === 0) {
      waveOf.set(id, 0);
      computing.delete(id);
      return 0;
    }
    const wave = Math.max(...step.dependsOn.map((d) => getWave(d))) + 1;
    waveOf.set(id, wave);
    computing.delete(id);
    return wave;
  }

  for (const step of steps) getWave(step.id);

  const maxWave = Math.max(0, ...Array.from(waveOf.values()));
  const waves: TeamStep[][] = Array.from({ length: maxWave + 1 }, () => []);

  for (const step of steps) {
    waves[waveOf.get(step.id)!].push(step);
  }

  return waves;
}
