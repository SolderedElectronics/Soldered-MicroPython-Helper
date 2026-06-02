import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HandlerContext } from '../types';
import { execCommand, execMpremote, withRetry } from '../utils/execUtils';
import { uploadFileToDevice } from '../utils/uploadUtils';
import { closeAllSerial } from './serialHandler';

/**
 * Tracks files downloaded from the device so Ctrl+S can upload back
 * to the correct device path (including subdirectories).
 * Key: local temp path. Value: { port, devicePath }.
 */
const deviceFileRegistry = new Map<string, { port: string; devicePath: string }>();

export function registerDeviceFile(localPath: string, port: string, devicePath: string): void {
  deviceFileRegistry.set(localPath, { port, devicePath });
}

export function lookupDeviceFile(localPath: string): { port: string; devicePath: string } | undefined {
  return deviceFileRegistry.get(localPath);
}

/**
 * Uploads the active editor's Python file to the device preserving its original filename.
 * Flushes any unsaved buffer changes to disk first so the device gets the latest content.
 */
export async function handleUploadPythonAsIs(ctx: HandlerContext, message: any): Promise<void> {
  await closeAllSerial(ctx);

  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor || activeEditor.document.languageId !== 'python') {
    vscode.window.showErrorMessage('No active Python file to upload.');
    return;
  }

  const doc = activeEditor.document;

  if (doc.isUntitled) {
    vscode.window.showErrorMessage('Save the file locally first before uploading to device.');
    return;
  }

  // Flush buffer to disk so the device receives the current editor content
  if (doc.isDirty) {
    await vscode.workspace.save(doc.uri);
  }

  const filePath = doc.fileName;
  const fileName = path.basename(filePath);
  const { port } = message;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Uploading ${fileName} to device...`, cancellable: false },
    async () => {
      try {
        await uploadFileToDevice(filePath, `/${fileName}`, port, ctx.outputChannel);
        vscode.window.showInformationMessage(`${fileName} uploaded successfully!`);
        ctx.postMessage({ command: 'triggerListFiles', port });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
        ctx.outputChannel.appendLine(`[ERROR] Upload error: ${err.message}`);
      }
    }
  );
}

/**
 * Prompts user to pick a single .py file or folder, then uploads to device.
 * Preserves directory structure relative to the selected folder root.
 */
export async function handleUploadPythonFromPc(ctx: HandlerContext, message: any): Promise<void> {
  await closeAllSerial(ctx);

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
  const stats = await fs.promises.lstat(selectedPath);
  const { port } = message;

  interface UploadFile { localPath: string; devicePath: string; }
  const uploadFiles: UploadFile[] = [];
  const mkdirPaths: string[] = [];

  if (stats.isDirectory()) {
    const walk = async (dir: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.py')) {
          const relPath = path.relative(selectedPath, fullPath).replace(/\\/g, '/');
          uploadFiles.push({ localPath: fullPath, devicePath: '/' + relPath });
        }
      }
    };
    await walk(selectedPath);

    if (uploadFiles.length === 0) {
      vscode.window.showErrorMessage('Selected folder does not contain any .py files.');
      return;
    }

    // Collect unique device-side parent dirs, shallowest first
    const dirsSet = new Set<string>();
    uploadFiles.forEach(({ devicePath }) => {
      const parts = devicePath.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        dirsSet.add('/' + parts.slice(0, i).join('/'));
      }
    });
    mkdirPaths.push(
      ...Array.from(dirsSet).sort((a, b) => a.split('/').length - b.split('/').length)
    );
  } else {
    uploadFiles.push({ localPath: selectedPath, devicePath: '/' + path.basename(selectedPath) });
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Uploading Python file(s)...', cancellable: false },
    async () => {
      try {
        // Create directories on device (ignore errors — dir may already exist)
        for (const dir of mkdirPaths) {
          const b64 = Buffer.from(dir).toString('base64');
          await execCommand(
            `mpremote connect ${port} exec "import os,ubinascii; os.mkdir(ubinascii.a2b_base64('${b64}').decode())"`,
            ctx.outputChannel
          ).catch(() => {});
        }
        for (const { localPath, devicePath } of uploadFiles) {
          await uploadFileToDevice(localPath, devicePath, port, ctx.outputChannel);
        }
        vscode.window.showInformationMessage('All .py files uploaded successfully!');
        ctx.postMessage({ command: 'triggerListFiles', port });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
        ctx.outputChannel.appendLine(`[ERROR] Upload error: ${err.message}`);
      }
    }
  );
}

/**
 * Downloads a file from the device to a temp location and opens it in the editor.
 * Registers the device path so Ctrl+S uploads back to the correct location.
 */
export async function handleOpenFileFromDevice(ctx: HandlerContext, message: any): Promise<void> {
  await closeAllSerial(ctx);

  const { port, filename } = message;
  const tempDir = path.join(os.tmpdir(), 'esp-temp');
  const localPath = path.join(tempDir, path.basename(filename));

  try {
    await fs.promises.mkdir(tempDir, { recursive: true });
    const cmd = `mpremote connect ${port} fs cp :"${filename}" "${localPath}"`;
    ctx.outputChannel.appendLine(`Downloading ${filename} from device...`);

    await withRetry(() => execMpremote(cmd), 5, 500, 'openFile', ctx.outputChannel);

    // Track mapping: local temp path → device path so Ctrl+S uploads back correctly
    registerDeviceFile(localPath, port, filename);

    const doc = await vscode.workspace.openTextDocument(localPath);
    await vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Opened ${filename} from device.`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to download file: ${err.message}`);
  }
}
