/**
 * RPC connection to a pi subagent process.
 *
 * Spawns `pi --mode rpc` and provides a typed API for sending commands
 * and receiving events over the JSONL stdin/stdout protocol.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field + optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`
 * - Events: AgentSessionEvent objects streamed as they occur
 */

import { spawn, type ChildProcess } from 'node:child_process';

export interface RpcConnectionOptions {
  cwd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Called when the child process exits (code or signal). */
  onExit?: (code: number | null, signal: string | null) => void;
}

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

export type EventListener = (event: AgentEvent) => void;

export class RpcConnection {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (response: unknown) => void; reject: (error: Error) => void }
  >();
  private eventListeners: EventListener[] = [];
  private stdoutBuffer = '';
  private stderr = '';
  private destroyed = false;
  private _exitCode: number | null = null;
  private _signalCode: string | null = null;
  private onExitCallback?: (code: number | null, signal: string | null) => void;

  get pid(): number | undefined {
    return this.process?.pid;
  }

  get exitCode(): number | null {
    // Prefer stored value (set by close handler), fall back to process.exitCode
    if (this._exitCode !== null) return this._exitCode;
    return this.process?.exitCode ?? null;
  }

  get signalCode(): string | null {
    if (this._signalCode !== null) return this._signalCode;
    return this.process?.signalCode ?? null;
  }

  get isAlive(): boolean {
    return (
      !this.destroyed && this.process !== null && this.exitCode === null && this.signalCode === null
    );
  }

  get collectedStderr(): string {
    return this.stderr;
  }

  start(options: RpcConnectionOptions): void {
    if (this.process) {
      throw new Error('Connection already started');
    }

    this.onExitCallback = options.onExit;

    this.process = spawn('pi', options.args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env,
    });

    this.process.stderr?.on('data', (data: Buffer | string) => {
      this.stderr += data.toString();
    });

    this.process.stdout?.on('data', (data: Buffer | string) => {
      this.stdoutBuffer += data.toString();
      this.drainStdout();
    });

    this.process.stdout?.on('end', () => {
      if (this.stdoutBuffer.length > 0) {
        this.handleLine(this.stdoutBuffer);
        this.stdoutBuffer = '';
      }
    });

    this.process.on('close', (code, signal) => {
      this._exitCode = code ?? (signal ? 1 : null);
      this._signalCode = signal;
      this.onExitCallback?.(code ?? null, signal);
    });
  }

  /** Send a prompt to the agent. Returns immediately; use onEvent() for streaming. */
  async prompt(message: string): Promise<void> {
    await this.send({ type: 'prompt', message });
  }

  /** Queue a steering message to interrupt the agent mid-run. */
  async steer(message: string): Promise<void> {
    await this.send({ type: 'steer', message });
  }

  /** Queue a follow-up message for after the agent finishes. */
  async followUp(message: string): Promise<void> {
    await this.send({ type: 'follow_up', message });
  }

  /** Abort current operation. */
  async abort(): Promise<void> {
    await this.send({ type: 'abort' });
  }

  /** Subscribe to agent events. Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Kill the agent process.
   * Sends SIGTERM, then SIGKILL after 4 seconds if it hasn't exited.
   */
  kill(): void {
    if (!this.process || this.destroyed) return;
    this.process.kill('SIGTERM');
    setTimeout(() => {
      if (this.process && this.isAlive) {
        this.process.kill('SIGKILL');
      }
    }, 4000).unref();
  }

  /** Clean up resources. Call after the process has exited. */
  destroy(): void {
    this.destroyed = true;
    this.pendingRequests.clear();
    this.eventListeners = [];
    this.process = null;
  }

  private drainStdout(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }

    if (!data || typeof data !== 'object') return;
    const obj = data as Record<string, unknown>;

    // Response to a pending request
    if (obj.type === 'response' && typeof obj.id === 'string') {
      const pending = this.pendingRequests.get(obj.id);
      if (pending) {
        this.pendingRequests.delete(obj.id);
        pending.resolve(obj);
      }
      return;
    }

    // Agent event
    for (const listener of this.eventListeners) {
      try {
        listener(data as AgentEvent);
      } catch {
        // Listener errors should not break the event loop
      }
    }
  }

  private async send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin || this.destroyed) {
      throw new Error('Connection not started or destroyed');
    }

    const id = `swarm_${++this.requestId}`;
    const fullCommand = { ...command, id };
    const commandLine = JSON.stringify(fullCommand) + '\n';

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.process!.stdin!.write(commandLine);
    });
  }
}
