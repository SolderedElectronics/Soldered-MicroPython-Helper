import { exec, ChildProcess } from 'child_process';
import type { OutputChannel } from 'vscode';

/**
 * Executes a shell command.
 * If outputChannel is provided, logs stdout/stderr there; otherwise logs to console.
 * Resolves on success, rejects on error.
 */
export function execCommand(command: string, outputChannel?: OutputChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (stdout) {
        outputChannel ? outputChannel.appendLine(stdout.trimEnd()) : console.log(stdout);
      }
      if (stderr) {
        outputChannel ? outputChannel.appendLine(stderr.trimEnd()) : console.error(stderr);
      }
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Executes a shell command with a hard timeout.
 * If the process exceeds ms, it is killed and the promise resolves (not rejects).
 */
export function execWithTimeout(cmd: string, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = exec(cmd, (err, _o, se) => {
      if (err) {
        if ((child as any).killed) return resolve();
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
