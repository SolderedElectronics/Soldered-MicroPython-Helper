// author Marko Toldi @Soldered

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { exec } from 'child_process';
import { SerialPort } from 'serialport';

import { EspFlasherViewProvider } from './EspFlasherProvider';
import { pickPort } from './utils/portUtils';

export function activate(context: vscode.ExtensionContext) {
  const provider = new EspFlasherViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('espFlasherWebview', provider)
  );

  const out = provider.getOutputChannel();

  // Narrowed save targets
  type SaveMode = 'pc' | 'device' | 'both';
  type SavePromptMode = 'ask' | SaveMode;

  /**
   * Resolves the final SaveMode from extension settings.
   * - If "save to device on save" is enabled, optionally also save locally.
   * - Otherwise respects "savePromptMode" (and prompts if "ask").
   */
  const resolveSaveMode = async (cfg: vscode.WorkspaceConfiguration): Promise<SaveMode> => {
    const saveToDeviceOnSave = cfg.get<boolean>('mp.saveToDeviceOnSave', true);
    const alsoSaveLocally    = cfg.get<boolean>('mp.alsoSaveLocally', false);

    if (saveToDeviceOnSave) {
      return alsoSaveLocally ? 'both' : 'device';
    }

    let m = cfg.get<SavePromptMode>('mp.savePromptMode', 'ask');
    if (m === 'ask') {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Save to PC',     value: 'pc'     as const },
          { label: 'Save to device', value: 'device' as const },
          { label: 'Save to both',   value: 'both'   as const },
        ],
        { placeHolder: 'Where do you want to save this .py?' }
      );
      if (!pick) throw new Error('cancelled');
      return pick.value;
    }

    return m;
  };

  /**
   * Command: mp.savePython
   * Triggered by Ctrl+S / Cmd+S on Python files.
   * Saves to PC, device, or both based on settings.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('mp.savePython', async () => {
      out.appendLine('mp.savePython invoked');
      out.show(true);

      const editor0 = vscode.window.activeTextEditor;
      if (!editor0 || editor0.document.languageId !== 'python') {
        out.appendLine('No Python editor active - falling back to normal save');
        await vscode.commands.executeCommand('workbench.action.files.save');
        return;
      }

      const cfg        = vscode.workspace.getConfiguration();
      const saveAsMain = cfg.get<boolean>('mp.saveDeviceAsMain', false);

      let mode: SaveMode;
      try {
        mode = await resolveSaveMode(cfg);
        out.appendLine(`Resolved save mode: ${mode}`);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === 'cancelled') {
          out.appendLine('User cancelled save mode quick pick.');
          return;
        }
        vscode.window.showErrorMessage(`Save error: ${msg}`);
        out.appendLine(`[ERROR] Resolve mode error: ${msg}`);
        return;
      }

      let doc = editor0.document;

      /**
       * Ensures the file is persisted to disk.
       * For untitled files: prompts Save As.
       * For titled files: triggers normal save.
       */
      const ensureOnDisk = async (): Promise<boolean> => {
        if (doc.isUntitled) {
          out.appendLine('Document is untitled - prompting for save location...');
          const uri = await vscode.window.showSaveDialog({ filters: { Python: ['py'] } });
          if (!uri) {
            out.appendLine('User cancelled Save Dialog.');
            return false;
          }
          await vscode.workspace.fs.writeFile(uri, Buffer.from(doc.getText(), 'utf8'));
          const diskDoc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(diskDoc, { preview: false });
          out.appendLine(`Saved untitled doc to: ${uri.fsPath}`);
        } else {
          out.appendLine(`Saving to disk: ${doc.fileName}`);
          await vscode.commands.executeCommand('workbench.action.files.save');
        }

        const ed = vscode.window.activeTextEditor;
        if (!ed) {
          out.appendLine('[ERROR] No active editor after save.');
          return false;
        }
        doc = ed.document;
        return true;
      };

      /**
       * Uploads the current file/buffer to the device via mpremote.
       */
      const uploadToDevice = async () => {
        const port = await pickPort({ outputChannel: out, extensionContext: context });
        if (!port) return;

        if (mode === 'device') {
          const tmpDir  = path.join(os.tmpdir(), 'mp-save');
          await fs.promises.mkdir(tmpDir, { recursive: true });

          const fname   = saveAsMain ? 'main.py' : (path.basename(doc.fileName || 'code.py') || 'code.py');
          const tmpPath = path.join(tmpDir, fname);

          await fs.promises.writeFile(tmpPath, doc.getText(), 'utf8');
          out.appendLine(`Uploading buffer - temp: ${tmpPath} - device: ${fname} on ${port}`);

          await new Promise<void>((resolve, reject) => {
            const cmd = `mpremote connect ${port} fs cp "${tmpPath}" :${saveAsMain ? 'main.py' : `"${fname}"`}`;
            out.appendLine(`Exec: ${cmd}`);
            exec(cmd, (err, _o, stderr) => {
              if (err) {
                out.appendLine(`[ERROR] Upload failed: ${stderr || err}`);
                reject(new Error(stderr || String(err)));
              } else {
                out.appendLine('Upload successful (device-only).');
                resolve();
              }
            });
          });

          vscode.window.showInformationMessage(`Saved to device (${fname}).`);
          provider.refreshFileListOnDevice(port);
          return;
        }

        const ok = await ensureOnDisk();
        if (!ok) return;

        const localPath  = doc.fileName;
        const deviceName = saveAsMain ? 'main.py' : path.basename(localPath);
        out.appendLine(`Uploading disk file: ${localPath} - device: ${deviceName} on ${port}`);

        await new Promise<void>((resolve, reject) => {
          const cmd = `mpremote connect ${port} fs cp "${localPath}" :${saveAsMain ? 'main.py' : `"${deviceName}"`}`;
          out.appendLine(`Exec: ${cmd}`);
          exec(cmd, (err, _o, stderr) => {
            if (err) {
              out.appendLine(`[ERROR] Upload failed: ${stderr || err}`);
              reject(new Error(stderr || String(err)));
            } else {
              out.appendLine('Upload successful (pc/both).');
              resolve();
            }
          });
        });

        vscode.window.showInformationMessage(`Uploaded to device (${deviceName}).`);
        provider.refreshFileListOnDevice(port);
      };

      // Execute the chosen flow
      try {
        if (mode === 'pc') {
          const ok = await ensureOnDisk();
          if (!ok) return;
          out.appendLine('Done: saved to PC only.');
          vscode.window.setStatusBarMessage('Saved to PC', 1500);

        } else if (mode === 'device') {
          await uploadToDevice();

        } else if (mode === 'both') {
          const ok = await ensureOnDisk();
          if (!ok) return;
          await uploadToDevice();
        }

      } catch (e: any) {
        const msg = e?.message || String(e);
        vscode.window.showErrorMessage(`Save error: ${msg}`);
        out.appendLine(`[ERROR] Save flow error: ${msg}`);
      }
    })
  );
}

export function deactivate() {}
