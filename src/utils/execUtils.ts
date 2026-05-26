import { exec, ChildProcess } from 'child_process';
import type { OutputChannel } from 'vscode';

/**
 * Simple serial queue — ensures mpremote commands never run concurrently.
 * All enqueued tasks execute one at a time in submission order.
 */
class SerialQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = false;

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try { resolve(await fn()); }
        catch (e) { reject(e); }
      });
      if (!this.running) { this.drain(); }
    });
  }

  private async drain() {
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      await task();
    }
    this.running = false;
  }
}

export const mpremoteQueue = new SerialQueue();

/**
 * Executes a shell command via the mpremote queue (serialized).
 * Logs stdout/stderr to outputChannel if provided.
 * Resolves on success, rejects on error.
 */
export function execCommand(command: string, outputChannel?: OutputChannel): Promise<void> {
  return mpremoteQueue.enqueue(() => new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (stdout) { outputChannel ? outputChannel.appendLine(stdout.trimEnd()) : console.log(stdout); }
      if (stderr) { outputChannel ? outputChannel.appendLine(stderr.trimEnd()) : console.error(stderr); }
      if (err) { reject(err); } else { resolve(); }
    });
  }));
}

/**
 * Executes a shell command via the mpremote queue and returns stdout.
 * Rejects with stderr/message on error.
 */
export function execMpremote(command: string): Promise<string> {
  return mpremoteQueue.enqueue(() => new Promise<string>((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr?.trim() || err.message)); }
      else { resolve(stdout); }
    });
  }));
}

/**
 * Executes a shell command with a hard timeout.
 * NOT queued — used for time-sensitive stop/reset operations.
 */
export function execWithTimeout(cmd: string, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = exec(cmd, (err, _o, se) => {
      if (err) {
        if ((child as any).killed) { return resolve(); }
        return reject(new Error(se || err.message));
      }
      resolve();
    });
    const t = setTimeout(() => { try { child.kill(); } catch {} }, ms);
    child.on('exit', () => clearTimeout(t));
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
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, timeoutMs);
    proc.on('exit', () => { clearTimeout(t); finish(); });
    proc.on('close', () => { clearTimeout(t); finish(); });
    proc.on('error', () => { clearTimeout(t); finish(); });
  });
}
