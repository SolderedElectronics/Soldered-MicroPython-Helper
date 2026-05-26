import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HandlerContext } from '../types';
import { execMpremote, withRetry } from '../utils/execUtils';

/**
 * Lists files on the connected MicroPython device as a recursive tree and sends to the webview.
 * Each node: { name, type: 'file'|'dir', path, children? }
 */
export async function handleListFiles(ctx: HandlerContext, message: any): Promise<void> {
  const { port } = message;

  const script = `import os, json
def tree(p):
    r = []
    try:
        entries = sorted(os.listdir(p))
    except:
        return r
    for n in entries:
        fp = p.rstrip('/') + '/' + n
        try:
            os.listdir(fp)
            r.append({'name': n, 'type': 'dir', 'path': fp, 'children': tree(fp)})
        except:
            r.append({'name': n, 'type': 'file', 'path': fp})
    return r
print(json.dumps(tree('/')))
`;

  const tempPath = path.join(os.tmpdir(), '__list_files__.py');

  try {
    await fs.promises.writeFile(tempPath, script, 'utf8');
    const stdout = await withRetry(
      () => execMpremote(`mpremote connect ${port} run "${tempPath}"`),
      5, 500, 'listFiles', ctx.outputChannel
    );
    const match = stdout.match(/\[[\s\S]*\]/);
    const files = match ? JSON.parse(match[0]) : [];
    ctx.postMessage({ command: 'displayFiles', files });
  } catch (err: any) {
    ctx.outputChannel.appendLine(`[WARN] Failed to list files: ${err.message}`);
    ctx.postMessage({ command: 'displayFiles', files: [] });
  }
}

/**
 * Deletes a file or folder (recursively) from the connected MicroPython device.
 * Confirms before deleting directories.
 */
export async function handleDeleteFile(ctx: HandlerContext, message: any): Promise<void> {
  const { port, filename, type } = message;

  if (type === 'dir') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete folder "${filename}" and all its contents?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;
  }

  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before deleting...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const b64name = Buffer.from(filename).toString('base64');
  const script = `import os, ubinascii
def rm(p):
    try:
        os.remove(p)
    except OSError:
        for f in os.listdir(p):
            rm(p + '/' + f)
        os.rmdir(p)
rm(ubinascii.a2b_base64('${b64name}').decode())
`;

  const tempPath = path.join(os.tmpdir(), '__delete__.py');

  try {
    await fs.promises.writeFile(tempPath, script, 'utf8');
    await execMpremote(`mpremote connect ${port} run "${tempPath}"`);
    vscode.window.showInformationMessage(`Deleted ${filename} successfully.`);
    ctx.postMessage({ command: 'triggerListFiles', port });
  } catch (err: any) {
    ctx.outputChannel.appendLine(`[WARN] Failed to delete: ${err.message}`);
    vscode.window.showErrorMessage(`Failed to delete: ${err.message}`);
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
