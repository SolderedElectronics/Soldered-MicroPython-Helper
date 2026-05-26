// author Marko Toldi @Soldered

import * as vscode from 'vscode';
import * as path from 'path';

import { EspFlasherViewProvider } from './EspFlasherProvider';
import { uploadFileToDevice } from './utils/uploadUtils';
import { lookupDeviceFile } from './handlers/uploadHandler';

export function activate(context: vscode.ExtensionContext) {
  const provider = new EspFlasherViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('espFlasherWebview', provider)
  );

  const out = provider.getOutputChannel();

  /**
   * Command: mp.savePython
   * Triggered by Ctrl+S / Cmd+S on Python files.
   *
   * Flow:
   *  1. Always save to disk first — PC always has the latest version.
   *  2. If a device port is selected and upload is configured, upload to device.
   *     - If file was opened from device, uploads back to its original device path.
   *     - If no port is connected, falls back silently to PC-only with status bar hint.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('mp.savePython', async () => {
      out.appendLine('mp.savePython invoked');

      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        await vscode.commands.executeCommand('workbench.action.files.save');
        return;
      }

      const cfg              = vscode.workspace.getConfiguration();
      const saveToDevice     = cfg.get<boolean>('mp.saveToDeviceOnSave', true);
      const saveAsMain       = cfg.get<boolean>('mp.saveDeviceAsMain', false);
      const savePromptMode   = cfg.get<string>('mp.savePromptMode', 'ask');

      let doc = editor.document;

      // Step 1: Always save to disk
      if (doc.isUntitled) {
        const uri = await vscode.window.showSaveDialog({ filters: { Python: ['py'] } });
        if (!uri) { return; }
        await vscode.workspace.fs.writeFile(uri, Buffer.from(doc.getText(), 'utf8'));
        const diskDoc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(diskDoc, { preview: false });
        doc = diskDoc;
      } else {
        await vscode.commands.executeCommand('workbench.action.files.save');
        doc = vscode.window.activeTextEditor?.document || doc;
      }
      out.appendLine(`Saved to disk: ${doc.fileName}`);

      // Step 2: Decide whether to upload to device
      let shouldUpload = false;
      if (saveToDevice) {
        shouldUpload = true;
      } else {
        let mode = savePromptMode;
        if (mode === 'ask') {
          // File is already on disk — only ask about device upload
          const pick = await vscode.window.showQuickPick(
            [
              { label: 'PC only',               description: 'Already saved to disk', value: 'pc'     },
              { label: 'Also upload to device',                                        value: 'device' },
            ],
            { placeHolder: 'File saved to PC — also upload to connected device?' }
          );
          if (!pick) { return; }
          mode = (pick as any).value;
        }
        shouldUpload = (mode === 'device' || mode === 'both');
      }

      if (!shouldUpload) {
        vscode.window.setStatusBarMessage('Saved to PC', 1500);
        return;
      }

      // Step 3: Get port — no disruptive prompt; fall back silently if missing
      const port = context.globalState.get<string>('mp.lastPort');
      if (!port) {
        vscode.window.setStatusBarMessage('Saved locally — no device connected', 3000);
        out.appendLine('[INFO] No port selected — saved to PC only.');
        return;
      }

      // Step 4: Determine device path
      // Files opened from device have a registered path that preserves their subdirectory
      const deviceInfo = lookupDeviceFile(doc.fileName);
      const devicePath = deviceInfo
        ? deviceInfo.devicePath
        : saveAsMain ? '/main.py' : '/' + path.basename(doc.fileName);

      // Step 5: Upload
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading to device...', cancellable: false },
          async () => { await uploadFileToDevice(doc.fileName, devicePath, port, out); }
        );
        vscode.window.showInformationMessage(`Uploaded to device (${path.basename(devicePath)}).`);
        provider.refreshFileListOnDevice(port);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Upload failed: ${err.message}`);
        out.appendLine(`[ERROR] Upload error: ${err.message}`);
      }
    })
  );
}

export function deactivate() {}
