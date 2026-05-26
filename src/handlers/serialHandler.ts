import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { SerialPort } from 'serialport';
import { HandlerContext } from '../types';
import { execCommand, execMpremote, execWithTimeout, killProc } from '../utils/execUtils';

/**
 * Starts the serial monitor on the given port.
 * Closes any existing monitor first.
 */
export function startSerialMonitor(ctx: HandlerContext, portPath: string): void {
  if (ctx.serialMonitor) {
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  ctx.outputChannel.appendLine(`Opening serial monitor on ${portPath}`);

  const monitor = new SerialPort({
    path: portPath,
    baudRate: 115200,
    autoOpen: true,
  });

  monitor.on('data', (data: Buffer) => {
    ctx.outputChannel.append(data.toString('utf-8'));
  });

  monitor.on('error', err => {
    ctx.outputChannel.appendLine(`Serial error: ${err.message}`);
  });

  monitor.on('close', () => {
    ctx.outputChannel.appendLine('Serial monitor closed.');
  });

  ctx.setSerialMonitor(monitor);
}

/**
 * Stops the serial monitor and sends a soft-reset to the device.
 */
export function stopSerialMonitorAndReset(ctx: HandlerContext, portPath: string): void {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.serialMonitor.close(err => {
      if (err) ctx.outputChannel.appendLine(`[ERROR] Error closing serial monitor: ${err.message}`);
    });
    ctx.setSerialMonitor(null);
  }

  execMpremote(`mpremote connect ${portPath} soft-reset`)
    .then(() => ctx.outputChannel.appendLine('Device reset successfully.'))
    .catch(err => ctx.outputChannel.appendLine(`[ERROR] Error resetting device: ${err.message}`));
}

/**
 * Downloads a device file to temp and runs it via mpremote, streaming output live.
 */
export async function handleRunPythonFile(ctx: HandlerContext, message: any): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before proceeding...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  if (ctx.mpRunProc) {
    try { ctx.mpRunProc.kill(); } catch {}
    ctx.setMpRunProc(null);
  }

  const { filename, port } = message;
  if (!filename || !port) {
    vscode.window.showErrorMessage('Filename and port are required to run the script.');
    ctx.outputChannel.appendLine('[WARN] Cannot run script: filename or port not provided.');
    return;
  }

  const tempPath = path.join(os.tmpdir(), `__run_tmp__-${path.basename(filename)}`);
  const downloadCmd = `mpremote connect ${port} fs cp :${filename} "${tempPath}"`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Preparing ${filename}...`, cancellable: false },
    async () => {
      await execCommand(downloadCmd, ctx.outputChannel);
    }
  );

  ctx.outputChannel.appendLine(`Running ${filename}`);
  ctx.outputChannel.show(true);

  const args = ['connect', port, 'run', tempPath];
  const child = spawn('mpremote', args, { shell: false });

  ctx.setMpRunProc(child);

  child.stdout.on('data', (data: Buffer) => {
    ctx.outputChannel.append(data.toString('utf-8'));
  });
  child.stderr.on('data', (data: Buffer) => {
    ctx.outputChannel.append(data.toString('utf-8'));
  });
  child.on('close', (code) => {
    ctx.outputChannel.appendLine(`\n[run exited with code ${code ?? 0}]`);
    ctx.setMpRunProc(null);
  });
  child.on('error', (err) => {
    vscode.window.showErrorMessage(`Failed to start mpremote run: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] Failed to start mpremote run: ${err.message}`);
    ctx.setMpRunProc(null);
  });

  vscode.window.showInformationMessage(`${filename} is running. Use "Stop" to interrupt.`);
}

/**
 * Stops any running mpremote process and sends Ctrl-C / Ctrl-D to the board.
 * Falls back to mpremote soft-reset / machine.reset() if serial write fails.
 */
export async function handleStopRunningCode(ctx: HandlerContext, message: any): Promise<void> {
  const { port, keepMonitor } = message as { port?: string; keepMonitor?: boolean };
  if (!port) {
    vscode.window.showErrorMessage('Port is required to stop running code.');
    return;
  }

  // 1) Kill active mpremote run process
  if (ctx.mpRunProc) {
    await killProc(ctx.mpRunProc);
    ctx.setMpRunProc(null);
  }

  // 2) Close serial monitor to free the port
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  // Short grace so OS releases the port handle
  await new Promise(r => setTimeout(r, 150));

  // 3) Send Ctrl-C, Ctrl-C, Ctrl-D directly over serial
  try {
    await new Promise<void>((resolve, reject) => {
      const tmp = new SerialPort({ path: port, baudRate: 115200, autoOpen: false });
      tmp.open(err => {
        if (err) return reject(err);
        const seq = Buffer.from([0x03, 0x03, 0x04]); // ^C ^C ^D
        tmp.write(seq, (werr) => {
          if (werr) return reject(werr);
          tmp.drain(() => tmp.close(() => resolve()));
        });
      });
    });
    ctx.outputChannel.appendLine('Stopping code');
  } catch (e: any) {
    ctx.outputChannel.appendLine(`[WARN] Could not send ^C/^D via serial: ${e?.message || e}`);

    // Fallback: mpremote soft-reset with timeout
    try {
      await execWithTimeout(`mpremote connect ${port} soft-reset`, 1500);
      ctx.outputChannel.appendLine('Soft reset via mpremote.');
    } catch {
      try {
        await execWithTimeout(`mpremote connect ${port} exec "import machine; machine.reset()"`, 2500);
        ctx.outputChannel.appendLine('Hard reset via machine.reset().');
      } catch (err2: any) {
        ctx.outputChannel.appendLine(`[ERROR] Reset fallback failed: ${err2?.message || String(err2)}`);
      }
    }
  }

  // 4) Optionally reopen the serial monitor
  if (keepMonitor) {
    await new Promise(r => setTimeout(r, 250));
    startSerialMonitor(ctx, port);
    ctx.outputChannel.appendLine('Serial monitor reopened.');
  }
}
