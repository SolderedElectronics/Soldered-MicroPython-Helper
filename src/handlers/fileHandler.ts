import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HandlerContext } from '../types';
import { execMpremote } from '../utils/execUtils';

/**
 * Lists files on the connected MicroPython device and sends them to the webview.
 */
export async function handleListFiles(ctx: HandlerContext, message: any): Promise<void> {
  const { port } = message;
  const listCmd = `mpremote connect ${port} exec "import os, json; print(json.dumps(os.listdir()))"`;

  try {
    const stdout = await execMpremote(listCmd);
    const match = stdout.match(/\[.*\]/);
    const files: string[] = match ? JSON.parse(match[0]) : [];
    ctx.postMessage({ command: 'displayFiles', files });
  } catch (err: any) {
    ctx.outputChannel.appendLine(`[WARN] Failed to list files: ${err.message}`);
  }
}

/**
 * Deletes a file from the connected MicroPython device.
 */
export async function handleDeleteFile(ctx: HandlerContext, message: any): Promise<void> {
  const { port, filename } = message;

  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before deleting...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const safeFilename = filename.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const delCmd = `mpremote connect ${port} exec "import os; os.remove('${safeFilename}')"`;

  try {
    await execMpremote(delCmd);
    vscode.window.showInformationMessage(`Deleted ${filename} successfully.`);
    ctx.postMessage({ command: 'triggerListFiles', port });
  } catch (err: any) {
    ctx.outputChannel.appendLine(`[WARN] Failed to delete file: ${err.message}`);
  }
}

/**
 * Deletes all files and folders on the device except boot.py and main.py.
 * Uses a temp Python script run via mpremote to handle recursive deletion.
 */
export async function handleDeleteAllFiles(ctx: HandlerContext, message: any): Promise<void> {
  const { port } = message;

  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before deleting...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const script = `
import os
def rm(p):
    try:
        os.remove(p)
    except OSError:
        for f in os.listdir(p):
            rm(p + '/' + f)
        os.rmdir(p)
for f in os.listdir():
    if f not in ('boot.py', 'main.py'):
        rm(f)
print('done')
`;

  const tempPath = path.join(os.tmpdir(), '__delete_all__.py');

  try {
    await fs.promises.writeFile(tempPath, script, 'utf8');
    ctx.outputChannel.appendLine('Deleting all files from device...');
    await execMpremote(`mpremote connect ${port} run "${tempPath}"`);
    vscode.window.showInformationMessage('All files deleted (boot.py and main.py kept).');
    ctx.postMessage({ command: 'triggerListFiles', port });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to delete files: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] Delete all failed: ${err.message}`);
  }
}
