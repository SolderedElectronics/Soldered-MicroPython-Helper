import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { HandlerContext } from '../types';

/**
 * Uploads the active editor's Python file to the device as main.py.
 */
export async function handleUploadPython(ctx: HandlerContext, message: any): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before proceeding...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.languageId !== 'python') {
    vscode.window.showErrorMessage('No active Python file to upload.');
    return;
  }

  const filePath = activeEditor.document.fileName;
  const { port } = message;
  const uploadCmd = `mpremote connect ${port} fs cp "${filePath}" :main.py`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Uploading Python file as main.py...', cancellable: false },
    () => new Promise<void>((resolve, reject) => {
      exec(uploadCmd, (uploadError, _stdout, uploadStderr) => {
        if (uploadError) {
          vscode.window.showErrorMessage(`Upload failed: ${uploadStderr || uploadError.message}`);
          reject(uploadError);
          return;
        }
        vscode.window.showInformationMessage('Python file uploaded successfully as main.py!');
        ctx.postMessage({ command: 'triggerListFiles', port });
        resolve();
      });
    })
  );
}

/**
 * Uploads the active editor's Python file to the device preserving its original filename.
 */
export async function handleUploadPythonAsIs(ctx: HandlerContext, message: any): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before proceeding...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.languageId !== 'python') {
    vscode.window.showErrorMessage('No active Python file to upload.');
    return;
  }

  const filePath = activeEditor.document.fileName;
  const fileName = filePath.split(/[/\\]/).pop()!;
  const { port } = message;
  const uploadCmd = `mpremote connect ${port} fs cp "${filePath}" :"${fileName}"`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Uploading ${fileName} to device...`, cancellable: false },
    () => new Promise<void>((resolve, reject) => {
      exec(uploadCmd, (uploadError, _stdout, uploadStderr) => {
        if (uploadError) {
          vscode.window.showErrorMessage(`Upload failed: ${uploadStderr || uploadError.message}`);
          reject(uploadError);
          return;
        }
        vscode.window.showInformationMessage(`${fileName} uploaded successfully!`);
        ctx.postMessage({ command: 'triggerListFiles', port });
        resolve();
      });
    })
  );
}

/**
 * Prompts user to pick a single .py file or folder, then uploads to device.
 */
export async function handleUploadPythonFromPc(ctx: HandlerContext, message: any): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before proceeding...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  const choice = await vscode.window.showQuickPick(
    ['Single Python File', 'Folder of Python Files (including subfolders)'],
    { placeHolder: 'Do you want to upload a single file or a folder?' }
  );
  if (!choice) return;

  let selection: vscode.Uri[] | undefined;
  if (choice === 'Single Python File') {
    selection = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { 'Python Files': ['py'] },
    });
  } else {
    selection = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
  }

  if (!selection || selection.length === 0) {
    vscode.window.showErrorMessage('No file or folder selected.');
    return;
  }

  const selectedPath = selection[0].fsPath;
  const stats = fs.lstatSync(selectedPath);
  const uploadCommands: string[] = [];
  const { port } = message;

  if (stats.isDirectory()) {
    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          const fileName = path.basename(fullPath);
          uploadCommands.push(`mpremote connect ${port} fs cp "${fullPath}" :"${fileName}"`);
        }
      }
    };

    walk(selectedPath);

    if (uploadCommands.length === 0) {
      vscode.window.showErrorMessage('Selected folder does not contain any .py files.');
      return;
    }
  } else {
    const fileName = path.basename(selectedPath);
    uploadCommands.push(`mpremote connect ${port} fs cp "${selectedPath}" :"${fileName}"`);
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Uploading Python file(s)...', cancellable: false },
    async () => {
      try {
        for (const cmd of uploadCommands) {
          await new Promise<void>((resolve, reject) => {
            exec(cmd, (err, _stdout, stderr) => {
              if (err) {
                vscode.window.showErrorMessage(`Upload failed: ${stderr || err.message}`);
                reject(err);
              } else {
                resolve();
              }
            });
          });
        }
        vscode.window.showInformationMessage('All .py files uploaded successfully!');
        ctx.postMessage({ command: 'triggerListFiles', port });
      } catch (err) {
        ctx.outputChannel.appendLine(`[ERROR] Upload error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

/**
 * Downloads a file from the device to a temp location and opens it in the editor.
 */
export async function handleOpenFileFromDevice(ctx: HandlerContext, message: any): Promise<void> {
  const { port, filename } = message;
  const tempDir = path.join(os.tmpdir(), 'esp-temp');
  const localPath = path.join(tempDir, filename);

  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
    const cmd = `mpremote connect ${port} fs cp :"${filename}" "${localPath}"`;

    ctx.outputChannel.appendLine(`Downloading ${filename} from device...`);
    exec(cmd, async (err, _stdout, stderr) => {
      if (err) {
        vscode.window.showErrorMessage(`Failed to download file: ${stderr || err.message}`);
        return;
      }

      const doc = await vscode.workspace.openTextDocument(localPath);
      await vscode.window.showTextDocument(doc, { preview: false });
      vscode.window.showInformationMessage(`Opened ${filename} from device.`);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to prepare file for editing: ${msg}`);
  }
}
