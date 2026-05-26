import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SerialPort } from 'serialport';
import { HandlerContext } from '../types';
import { execCommand, execMpremote, execWithTimeout, killProc, withRetry } from '../utils/execUtils';

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
    ctx.postMessage({ command: 'serialMonitorStatus', active: false });
  });

  ctx.setSerialMonitor(monitor);
  ctx.postMessage({ command: 'serialMonitorStatus', active: true });
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
 * Downloads a device file to temp and runs it via raw REPL over serial.
 * This gives full bidirectional stdin/stdout — sys.stdin.read() works.
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

  if (ctx.runSerial && ctx.runSerial.isOpen) {
    ctx.runSerial.close();
    ctx.setRunSerial(null);
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
      await withRetry(() => execCommand(downloadCmd, ctx.outputChannel), 5, 500, 'runFile-download', ctx.outputChannel);
    }
  );

  const scriptContent = fs.readFileSync(tempPath);

  ctx.outputChannel.appendLine(`Running ${filename}`);
  ctx.outputChannel.show(true);

  const serial = new SerialPort({ path: port, baudRate: 115200, autoOpen: false });

  serial.open((openErr) => {
    if (openErr) {
      vscode.window.showErrorMessage(`Failed to open serial port: ${openErr.message}`);
      ctx.outputChannel.appendLine(`[ERROR] Failed to open serial port: ${openErr.message}`);
      ctx.postMessage({ command: 'runStatus', running: false });
      return;
    }

    ctx.setRunSerial(serial);
    ctx.postMessage({ command: 'runStatus', running: true, filename });
    vscode.window.showInformationMessage(`${filename} is running. Use "Stop" to interrupt.`);

    // State machine: waiting_prompt → waiting_ok → running
    let state: 'waiting_prompt' | 'waiting_ok' | 'running' = 'waiting_prompt';
    let buf = '';
    let isDone = false;

    // Timeout if raw REPL prompt never arrives (board unresponsive)
    const promptTimeout = setTimeout(() => {
      if (state !== 'waiting_prompt') { return; }
      ctx.outputChannel.appendLine('[ERROR] Timeout: raw REPL prompt not received. Board may be unresponsive.');
      vscode.window.showErrorMessage('Failed to enter raw REPL mode. Board may be unresponsive.');
      serial.close();
    }, 3000);

    const finish = () => {
      if (isDone) { return; }
      isDone = true;
      ctx.setRunSerial(null);
      ctx.postMessage({ command: 'runStatus', running: false });
    };

    serial.on('close', () => {
      clearTimeout(promptTimeout);
      finish();
      ctx.outputChannel.appendLine('\n[run finished]');
      setTimeout(() => {
        startSerialMonitor(ctx, port);
        ctx.outputChannel.appendLine('Serial monitor reopened.');
      }, 250);
    });

    serial.on('error', (err: Error) => {
      clearTimeout(promptTimeout);
      ctx.outputChannel.appendLine(`[ERROR] Serial error during run: ${err.message}`);
      finish();
    });

    // Processes output in 'running' state — strips \x04 protocol bytes,
    // detects end-of-execution (\x04[stderr]\x04) to close cleanly.
    const processRunningData = (chunk: string) => {
      buf += chunk;

      const firstEot = buf.indexOf('\x04');
      if (firstEot === -1) {
        // No end marker — flush all output
        ctx.outputChannel.append(buf);
        buf = '';
        return;
      }

      // Output everything before the first end-of-stdout marker
      if (firstEot > 0) {
        ctx.outputChannel.append(buf.slice(0, firstEot));
      }

      // Check for second EOT: end of stderr — script execution complete
      const secondEot = buf.indexOf('\x04', firstEot + 1);
      if (secondEot !== -1) {
        const stderrOut = buf.slice(firstEot + 1, secondEot);
        if (stderrOut.trim()) {
          ctx.outputChannel.append(stderrOut);
        }
        buf = '';
        finish();
        serial.close(); // triggers 'close' → logs, reopens monitor
      } else {
        // Have first \x04 but not second yet — keep buffered
        buf = buf.slice(firstEot);
      }
    };

    serial.on('data', (data: Buffer) => {
      const chunk = data.toString('utf-8');

      if (state === 'waiting_prompt') {
        buf += chunk;
        // Raw REPL mode prompt ends with \r\n>
        if (buf.includes('\r\n>')) {
          clearTimeout(promptTimeout);
          state = 'waiting_ok';
          buf = '';
          serial.write(scriptContent);
          serial.write(Buffer.from([0x04])); // Ctrl-D: execute
        }
        return;
      }

      if (state === 'waiting_ok') {
        buf += chunk;
        const okIdx = buf.indexOf('OK');
        if (okIdx !== -1) {
          state = 'running';
          const rest = buf.slice(okIdx + 2);
          buf = '';
          if (rest) { processRunningData(rest); }
        }
        return;
      }

      processRunningData(chunk);
    });

    // Interrupt any running code, then enter raw REPL mode
    serial.write(Buffer.from([0x03, 0x03, 0x01])); // Ctrl-C, Ctrl-C, Ctrl-A
  });
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

  // 1) Stop raw REPL run (primary path — handleRunPythonFile sets runSerial)
  if (ctx.runSerial) {
    try {
      if (ctx.runSerial.isOpen) {
        ctx.runSerial.write(Buffer.from([0x03, 0x03])); // Ctrl-C to interrupt
        await new Promise(r => setTimeout(r, 200));
        ctx.runSerial.close(); // 'close' event in handleRunPythonFile handles cleanup + monitor reopen
      }
    } catch (e: any) {
      ctx.outputChannel.appendLine(`[WARN] Error stopping run: ${e.message}`);
      ctx.setRunSerial(null);
      ctx.postMessage({ command: 'runStatus', running: false });
    }
    return;
  }

  // 2) Legacy path: kill mpremote run process
  if (ctx.mpRunProc) {
    await killProc(ctx.mpRunProc);
    ctx.setMpRunProc(null);
  }

  // 3) Close serial monitor to free the port
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  // Short grace so OS releases the port handle
  await new Promise(r => setTimeout(r, 150));

  // 4) Send Ctrl-C, Ctrl-C, Ctrl-D directly over serial
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

  // 5) Optionally reopen the serial monitor
  if (keepMonitor) {
    await new Promise(r => setTimeout(r, 250));
    startSerialMonitor(ctx, port);
    ctx.outputChannel.appendLine('Serial monitor reopened.');
  }
}
