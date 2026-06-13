import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeTaskBr,
  getTaskBr,
  getTaskProgressBr,
  listTasksBr,
} from '../../swarm/task-store/br-adapter.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(spawnSync);

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-br-adapter-'));
  roots.add(cwd);
  fs.mkdirSync(path.join(cwd, '.beads'), { recursive: true });
  return cwd;
}

function writeTaskMap(cwd: string, entries: Array<{ swarmId: string; brId: string }>): void {
  fs.writeFileSync(
    path.join(cwd, '.beads', 'swarm-task-map.json'),
    JSON.stringify(entries),
    'utf-8'
  );
}

function spawnResult(stdout: unknown, status = 0) {
  return {
    stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
    stderr: '',
    status,
  } as ReturnType<typeof spawnSync>;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('br task-store adapter', () => {
  it('formats br comments that use the current text field', () => {
    const cwd = createTempCwd();
    writeTaskMap(cwd, [{ swarmId: 'task-1', brId: 'zxc-abc' }]);

    mockSpawnSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      if (argv.join(' ') === 'comments list zxc-abc --json') {
        return spawnResult([
          {
            id: 1,
            author: 'AgentA',
            text: 'visible progress from br text field',
            created_at: '2026-06-10T00:00:00Z',
          },
        ]);
      }
      return spawnResult('', 1);
    });

    const progress = getTaskProgressBr(cwd, 'session', 'task-1');

    expect(progress).toContain('AgentA');
    expect(progress).toContain('visible progress from br text field');
    expect(progress).not.toContain('undefined');
  });

  it('hydrates progress_log from br comment text fields', () => {
    const cwd = createTempCwd();
    writeTaskMap(cwd, [{ swarmId: 'task-1', brId: 'zxc-abc' }]);

    mockSpawnSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      const command = argv.join(' ');
      if (command === 'show zxc-abc --json') {
        return spawnResult([
          {
            id: 'zxc-abc',
            title: 'Example',
            status: 'open',
            priority: 1,
            issue_type: 'task',
            created_at: '2026-06-10T00:00:00Z',
            updated_at: '2026-06-10T00:00:00Z',
            labels: ['swarm:channel:alpha', 'swarm:task:task-1'],
          },
        ]);
      }
      if (command === 'dep list zxc-abc --json') return spawnResult([]);
      if (command === 'comments list zxc-abc --json') {
        return spawnResult([
          {
            id: 1,
            author: 'AgentA',
            text: 'progress log message',
            created_at: '2026-06-10T00:00:00Z',
          },
        ]);
      }
      return spawnResult('', 1);
    });

    const task = getTaskBr(cwd, 'session', 'task-1');

    expect(task?.progress_log?.[0]?.message).toBe('progress log message');
  });

  it('adds completion summaries as br comments with the supported author flag', () => {
    const cwd = createTempCwd();
    writeTaskMap(cwd, [{ swarmId: 'task-1', brId: 'zxc-abc' }]);
    const commands: string[] = [];

    mockSpawnSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      const command = argv.join(' ');
      commands.push(command);
      if (command === 'show zxc-abc --json') {
        return spawnResult([
          {
            id: 'zxc-abc',
            title: 'Example',
            status: 'closed',
            priority: 1,
            issue_type: 'task',
            assignee: 'AgentA',
            created_at: '2026-06-10T00:00:00Z',
            updated_at: '2026-06-10T00:00:00Z',
            closed_at: '2026-06-10T00:00:00Z',
            labels: ['swarm:channel:alpha', 'swarm:task:task-1'],
          },
        ]);
      }
      if (command === 'dep list zxc-abc --json') return spawnResult([]);
      if (command === 'comments list zxc-abc --json') return spawnResult([]);
      return spawnResult({ ok: true });
    });

    const task = completeTaskBr(cwd, 'session', 'task-1', 'AgentA', 'completion summary');

    expect(task?.status).toBe('done');
    expect(commands).toContain('comments add zxc-abc completion summary --author AgentA --json');
    expect(commands).not.toContain('comments add zxc-abc completion summary --actor AgentA --json');
  });

  it('maps br dependency rows to swarm task ids', () => {
    const cwd = createTempCwd();
    writeTaskMap(cwd, [
      { swarmId: 'task-1', brId: 'zxc-one' },
      { swarmId: 'task-2', brId: 'zxc-two' },
    ]);

    mockSpawnSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      const command = argv.join(' ');
      if (command === 'list --all --json') {
        return spawnResult({
          issues: [
            {
              id: 'zxc-two',
              title: 'Dependent task',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              created_at: '2026-06-10T00:00:00Z',
              updated_at: '2026-06-10T00:00:00Z',
              labels: ['swarm:channel:alpha', 'swarm:task:task-2'],
            },
          ],
        });
      }
      if (command === 'dep list zxc-two --json') {
        return spawnResult([
          {
            issue_id: 'zxc-two',
            depends_on_id: 'zxc-one',
            type: 'blocks',
          },
        ]);
      }
      return spawnResult('', 1);
    });

    const tasks = listTasksBr(cwd, 'session', 'alpha');

    expect(tasks[0].depends_on).toEqual(['task-1']);
    expect(tasks[0].depends_on).not.toContain('[object Object]');
  });

  it('filters br-backed task lists to the requested channel', () => {
    const cwd = createTempCwd();
    writeTaskMap(cwd, [
      { swarmId: 'task-1', brId: 'zxc-one' },
      { swarmId: 'task-2', brId: 'zxc-two' },
    ]);

    mockSpawnSync.mockImplementation((_cmd, args) => {
      const argv = args as string[];
      const command = argv.join(' ');
      if (command === 'list --all --json') {
        return spawnResult({
          issues: [
            {
              id: 'zxc-one',
              title: 'Alpha task',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              created_at: '2026-06-10T00:00:00Z',
              updated_at: '2026-06-10T00:00:00Z',
              labels: ['swarm:channel:alpha', 'swarm:task:task-1'],
            },
            {
              id: 'zxc-two',
              title: 'Beta task',
              status: 'open',
              priority: 1,
              issue_type: 'task',
              created_at: '2026-06-10T00:00:00Z',
              updated_at: '2026-06-10T00:00:00Z',
              labels: ['swarm:channel:beta', 'swarm:task:task-2'],
            },
          ],
        });
      }
      if (command.startsWith('dep list ')) return spawnResult([]);
      return spawnResult('', 1);
    });

    const alphaTasks = listTasksBr(cwd, 'session', 'alpha');

    expect(alphaTasks).toHaveLength(1);
    expect(alphaTasks[0].id).toBe('task-1');
    expect(alphaTasks[0].channel).toBe('alpha');
  });
});
