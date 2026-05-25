import * as vscode from 'vscode';
import { exec } from 'child_process';
import { HandlerContext } from '../types';

/**
 * Lists files on the connected MicroPython device and sends them to the webview.
 */
export function handleListFiles(ctx: HandlerContext, message: any): void {
  const { port } = message;
  // Use json.dumps so output is valid JSON — no quote-replacement hacks needed
  const listCmd = `mpremote connect ${port} exec "import os, json; print(json.dumps(os.listdir()))"`;

  exec(listCmd, (err, stdout, stderr) => {
    if (err) {
      vscode.window.showErrorMessage(`Failed to list files: ${stderr || err.message}`);
      return;
    }

    try {
      // Find the JSON array line — mpremote may print extra lines/warnings before it
      const match = stdout.match(/\[.*\]/);
      const files: string[] = match ? JSON.parse(match[0]) : [];
      ctx.postMessage({ command: 'displayFiles', files });
    } catch (_e) {
      vscode.window.showErrorMessage('Failed to parse file list.');
    }
  });
}

/**
 * Deletes a file from the connected MicroPython device.
 */
export function handleDeleteFile(ctx: HandlerContext, message: any): void {
  const { port, filename } = message;

  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before deleting...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const safeFilename = filename.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const delCmd = `mpremote connect ${port} exec "import os; os.remove('${safeFilename}')"`;
  exec(delCmd, (err, _stdout, stderr) => {
    if (err) {
      vscode.window.showErrorMessage(`Failed to delete file: ${stderr || err.message}`);
    } else {
      vscode.window.showInformationMessage(`Deleted ${filename} successfully.`);
      ctx.postMessage({ command: 'triggerListFiles', port });
    }
  });
}
