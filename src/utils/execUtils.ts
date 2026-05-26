import { spawn, ChildProcess } from 'child_process';
import type { OutputChannel } from 'vscode';

const MPREMOTE_TIMEOUT_MS = 8000;

/**
 * Kills the process and its entire process group (children included).
 * Using detached spawn + process.kill(-pid) ensures grandchildren (e.g. mpremote
 * spawned by a shell) are also killed — plain child.kill() only kills the shell.
 */
function killGroup(child: ChildProcess): void {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

/**
 * Simple serial queue — ensures mpremote commands never run concurrently.
 * All enqueued tasks execute one at a time in submission order.
 * Call abort() to kill the current process group and flush pending items.
 */
class SerialQueue {
  private queue: Array<{ task: () => Promise<void>; reject: (e: Error) => void }> = [];
  private running = false;
  private currentProcess: ChildProcess | null = null;

  setCurrentProcess(proc: ChildProcess | null) {
    this.currentProcess = proc;
  }

  /**
   * Kills the currently running process group and rejects all pending queue items.
   * Use before exclusive port operations like esptool flash.
   */
  abort() {
    if (this.currentProcess) {
      killGroup(this.currentProcess);
      this.currentProcess = null;
    }
    const pending = this.queue.splice(0);
    pending.forEach(({ reject }) => reject(new Error('queue aborted')));
    this.running = false;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: async () => {
          try { resolve(await fn()); }
          catch (e) { reject(e); }
        },
        reject,
      });
      if (!this.running) { this.drain(); }
    });
  }

  private async drain() {
    this.running = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await item.task();
    }
    this.running = false;
  }
}

export const mpremoteQueue = new SerialQueue();

/**
 * Executes a shell command via the mpremote queue (serialized).
 * Uses spawn with detached:true so the entire process group can be killed.
 * Logs stdout/stderr to outputChannel if provided.
 */
export function execCommand(command: string, outputChannel?: OutputChannel): Promise<void> {
  return mpremoteQueue.enqueue(() => new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    mpremoteQueue.setCurrentProcess(child);

    child.stdout?.on('data', (d: Buffer) => {
      const s = d.toString();
      outputChannel ? outputChannel.appendLine(s.trimEnd()) : console.log(s);
    });
    child.stderr?.on('data', (d: Buffer) => {
      const s = d.toString();
      outputChannel ? outputChannel.appendLine(s.trimEnd()) : console.error(s);
    });
    child.on('close', (code) => {
      mpremoteQueue.setCurrentProcess(null);
      code === 0 ? resolve() : reject(new Error(`exit code ${code}`));
    });
    child.on('error', (err) => {
      mpremoteQueue.setCurrentProcess(null);
      reject(err);
    });
  }));
}

/**
 * Executes a shell command via the mpremote queue and returns stdout.
 * Uses spawn with detached:true — 8s timeout kills entire process group.
 * Rejects with stderr/message on error.
 */
export function execMpremote(command: string): Promise<string> {
  return mpremoteQueue.enqueue(() => new Promise<string>((resolve, reject) => {
    const child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    mpremoteQueue.setCurrentProcess(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      killGroup(child);
      mpremoteQueue.setCurrentProcess(null);
      reject(new Error('mpremote timed out'));
    }, MPREMOTE_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      mpremoteQueue.setCurrentProcess(null);
      if (code === 0 || code === null) { resolve(stdout); }
      else { reject(new Error(stderr.trim() || `exit code ${code}`)); }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      mpremoteQueue.setCurrentProcess(null);
      reject(err);
    });
  }));
}

/**
 * Executes a shell command with a hard timeout.
 * NOT queued — used for time-sensitive stop/reset operations.
 */
export function execWithTimeout(cmd: string, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
    const t = setTimeout(() => { killGroup(child); resolve(); }, ms);
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0 || code === null) { resolve(); }
      else { reject(new Error(`exit code ${code}`)); }
    });
    child.on('error', (err) => { clearTimeout(t); reject(err); });
  });
}

/**
 * Sends SIGINT to a child process, waits for exit, falls back to SIGKILL after timeoutMs.
 */
export function killProc(proc: ChildProcess, timeoutMs = 800): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { proc.kill('SIGINT'); } catch {}
    const t = setTimeout(() => { killGroup(proc); finish(); }, timeoutMs);
    proc.on('exit', () => { clearTimeout(t); finish(); });
    proc.on('close', () => { clearTimeout(t); finish(); });
    proc.on('error', () => { clearTimeout(t); finish(); });
  });
}
