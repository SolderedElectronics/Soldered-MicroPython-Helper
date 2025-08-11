// author Marko Toldi @Soldered

// VS Code API for interacting with the editor, showing messages, progress, etc.
import * as vscode from 'vscode';

// Allows executing terminal/CLI commands like `mpremote` and `esptool`
import { exec, spawn } from 'child_process';

// Used to list available serial ports for device connection
import { SerialPort } from 'serialport';

// Node.js core modules for filesystem, paths, OS temp directory, HTTPS requests
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';

// Cheerio is a fast, flexible jQuery-like HTML parser for scraping the Micropython firmware page
import * as cheerio from 'cheerio';

// Fuse.js provides fuzzy searching to find the best matching firmware options based on user input
import Fuse from 'fuse.js';

// Called when the extension is activated (e.g. VS Code starts or user opens the view)
export function activate(context: vscode.ExtensionContext) {
  // Create and register the Webview provider (also holds the shared OutputChannel / serial monitor)
  const provider = new EspFlasherViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('espFlasherWebview', provider)
  );

  // Reuse the same output channel the webview/serial monitor uses
  const out = provider.getOutputChannel();

  // Narrowed save targets
  type SaveMode = 'pc' | 'device' | 'both';
  // Setting can be either a concrete mode or "ask" (prompt the user)
  type SavePromptMode = 'ask' | SaveMode;

  /**
   * Resolve the final SaveMode using extension settings.
   * - If "save to device on save" is enabled, optionally also save locally.
   * - Otherwise, respect "savePromptMode" (and prompt if it's "ask").
   */
  const resolveSaveMode = async (cfg: vscode.WorkspaceConfiguration): Promise<SaveMode> => {
    const saveToDeviceOnSave = cfg.get<boolean>('mp.saveToDeviceOnSave', true);
    const alsoSaveLocally    = cfg.get<boolean>('mp.alsoSaveLocally', false);

    // Fast-path: automatic device save (with optional local save)
    if (saveToDeviceOnSave) {
      return alsoSaveLocally ? 'both' : 'device';
    }

    // Otherwise, check prompt mode (may be "ask")
    let m = cfg.get<SavePromptMode>('mp.savePromptMode', 'ask');
    if (m === 'ask') {
      // Ask the user how to save the current .py file
      const pick = await vscode.window.showQuickPick(
        [
          { label: '💾 Save to PC',       value: 'pc'     as const },
          { label: '⬆️ Save to device',   value: 'device' as const },
          { label: '🔀 Save to both',     value: 'both'   as const }
        ],
        { placeHolder: 'Where do you want to save this .py?' }
      );
      if (!pick) throw new Error('cancelled'); // user dismissed the picker
      return pick.value;
    }

    // Already a concrete mode
    return m;
  };

  /**
   * Command: mp.savePython
   * - Different saves:
   *   - Save only to PC
   *   - Save only to device
   *   - Or both (depending on settings / prompt)
   * - Uses last selected COM port (remembered by webview) for device uploads.
   * - After device upload, tells the webview to refresh the file list.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand('mp.savePython', async () => {
      out.appendLine('▶ mp.savePython invoked');
      out.show(true);

      // Ensure there is an active Python editor; otherwise fall back to normal save
      const editor0 = vscode.window.activeTextEditor;
      if (!editor0 || editor0.document.languageId !== 'python') {
        out.appendLine('No Python editor active → falling back to normal save');
        await vscode.commands.executeCommand('workbench.action.files.save');
        return;
      }

      // Read settings
      const cfg        = vscode.workspace.getConfiguration();
      const saveAsMain = cfg.get<boolean>('mp.saveDeviceAsMain', false);

      // Decide final mode (pc / device / both)
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
        out.appendLine(`❌ Resolve mode error: ${msg}`);
        return;
      }

      // Track the document reference (it may change after an "untitled" save)
      let doc = editor0.document;

      /**
       * Ensure the file is persisted to disk and up-to-date.
       * - For untitled: prompt "Save As", write buffer, open the saved file.
       * - For titled: trigger normal save.
       * Returns false if user cancels or no active editor afterwards.
       */
      const ensureOnDisk = async (): Promise<boolean> => {
        if (doc.isUntitled) {
          out.appendLine('Document is untitled → prompting for save location…');
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

        // Refresh doc reference (it may have changed if it was untitled)
        const ed = vscode.window.activeTextEditor;
        if (!ed) {
          out.appendLine('❌ No active editor after save.');
          return false;
        }
        doc = ed.document;
        return true;
      };

      /**
       * Pick a serial port to use for mpremote uploads.
       * - Uses lastPort stored by the webview when you choose a port there.
       * - If missing, quick-pick available ports and store the choice.
       */
      const pickPort = async (): Promise<string | undefined> => {
        const lastPort = context.globalState.get<string>('mp.lastPort');
        if (lastPort) {
          out.appendLine(`Using last selected port: ${lastPort}`);
          return lastPort;
        }

        const ports = await SerialPort.list();
        if (!ports.length) {
          vscode.window.showErrorMessage('No serial ports available.');
          out.appendLine('❌ No serial ports available.');
          return;
        }

        const chosen = await vscode.window.showQuickPick(
          ports.map(p => p.path),
          { placeHolder: 'Select a serial port' }
        );

        if (chosen) {
          await context.globalState.update('mp.lastPort', chosen);
          out.appendLine(`Selected port: ${chosen} (saved as lastPort)`);
        } else {
          out.appendLine('User cancelled port selection.');
        }
        return chosen || undefined;
      };

      /**
       * Upload current buffer/file to the device via mpremote.
       * - For "device" mode: writes buffer to temp and uploads (no local save).
       * - For "both" mode: ensures local save, then uploads the saved file.
       * - After upload, asks the webview to refresh device file list.
       */
      const uploadToDevice = async () => {
        const port = await pickPort();
        if (!port) return;

        if (mode === 'device') {
          // Write current buffer to a temp file, then upload to device
          const tmpDir  = path.join(os.tmpdir(), 'mp-save');
          await fs.promises.mkdir(tmpDir, { recursive: true });

          const fname   = saveAsMain ? 'main.py' : (path.basename(doc.fileName || 'code.py') || 'code.py');
          const tmpPath = path.join(tmpDir, fname);

          await fs.promises.writeFile(tmpPath, doc.getText(), 'utf8');
          out.appendLine(`Uploading buffer → temp: ${tmpPath} → device:${saveAsMain ? 'main.py' : fname} on ${port}`);

          await new Promise<void>((resolve, reject) => {
            const cmd = `mpremote connect ${port} fs cp "${tmpPath}" :${saveAsMain ? 'main.py' : `"${fname}"`}`;
            out.appendLine(`Exec: ${cmd}`);
            exec(cmd, (err, _o, stderr) => {
              if (err) {
                out.appendLine(`❌ Upload failed: ${stderr || err}`);
                reject(new Error(stderr || String(err)));
              } else {
                out.appendLine('✅ Upload successful (device-only).');
                resolve();
              }
            });
          });

          vscode.window.showInformationMessage(`✅ Saved to device (${fname}).`);
          (provider as any).refreshFileListOnDevice?.(port); // tell the webview to refresh files
          return;
        }

        // "pc" or "both": ensure saved to disk first, then upload that on-disk file
        const ok = await ensureOnDisk();
        if (!ok) return;

        const localPath  = doc.fileName;
        const deviceName = saveAsMain ? 'main.py' : path.basename(localPath);
        out.appendLine(`Uploading disk file: ${localPath} → device:${deviceName} on ${port}`);

        await new Promise<void>((resolve, reject) => {
          const cmd = `mpremote connect ${port} fs cp "${localPath}" :${saveAsMain ? 'main.py' : `"${deviceName}"`}`;
          out.appendLine(`Exec: ${cmd}`);
          exec(cmd, (err, _o, stderr) => {
            if (err) {
              out.appendLine(`❌ Upload failed: ${stderr || err}`);
              reject(new Error(stderr || String(err)));
            } else {
              out.appendLine('✅ Upload successful (pc/both).');
              resolve();
            }
          });
        });

        vscode.window.showInformationMessage(`⬆️ Uploaded to device (${deviceName}).`);
        (provider as any).refreshFileListOnDevice?.(port); // tell the webview to refresh files
      };

      // Execute the chosen flow
      try {
        if (mode === 'pc') {
          const ok = await ensureOnDisk();
          if (!ok) return;
          out.appendLine('Done: saved to PC only.');
          vscode.window.setStatusBarMessage('💾 Saved to PC', 1500);

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
        out.appendLine(`❌ Save flow error: ${msg}`);
      }
    })
  );
}

// Called when the extension is deactivated (e.g. when VS Code shuts down or the extension is disabled)
export function deactivate() {}

/**
 * Executes a shell command asynchronously.
 * Wraps Node.js `exec` in a Promise so we can use async/await.
 * 
 * @param command The shell command to execute.
 * @returns Promise<void> that resolves on success, rejects on error.
 */
function execCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      // Log standard output if present
      if (stdout) console.log(stdout);

      // Log standard error if present
      if (stderr) console.error(stderr);

      // Reject the promise if an error occurred
      if (err) {
        reject(err);
      } else {
        // Resolve the promise on success
        resolve();
      }
    });
  });
}


// Class that provides the Webview View for the ESP Flasher extension.
// It also manages communication between the webview (frontend) and extension (backend),
// and exposes utility methods like refreshing the file list and accessing the output channel.
class EspFlasherViewProvider implements vscode.WebviewViewProvider {

  private mpRunProc: import('child_process').ChildProcess | null = null;


  // Holds the reference to the current webview instance
  private _view?: vscode.WebviewView;

  // Dedicated output channel for logging ESP-related operations
  private outputChannel = vscode.window.createOutputChannel("ESP Output");

  // Store the extension context for later use (e.g., accessing globalState, resources)
  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Sends a message to the webview to trigger file listing on the connected device.
   * This is typically called after uploading a file, so the UI updates automatically.
   *
   * @param port - The serial port of the connected MicroPython device
   */
  public refreshFileListOnDevice(port: string) {
    this._view?.webview.postMessage({ command: 'triggerListFiles', port });
  }

  /**
   * Returns the shared output channel used for logging extension events and actions.
   * Can be used from other parts of the extension to keep logs in one place.
   *
   * @returns The output channel instance.
   */
  public getOutputChannel(): vscode.OutputChannel {
    return this.outputChannel;
  }


/**
 * Handles firmware flashing when triggered from the Webview.
 * Supports both UF2 (RP boards) and .bin (ESP32) firmware formats.
 *
 * @param firmwareUrl - The URL of the firmware to flash.
 * @param port - The serial port of the connected device (ESP32 only).
 */
private async handleFlashFromWeb(firmwareUrl: string, port: string) {
  const firmwareName = path.basename(firmwareUrl);             // Extract file name from URL
  const tmpPath       = path.join(os.tmpdir(), firmwareName);  // Path to temporarily store firmware
  const isUF2         = firmwareUrl.endsWith('.uf2');          // Detect UF2 format

  // 1. Download firmware file to temp directory
  await this.downloadFile(firmwareUrl, tmpPath);

  if (isUF2) {
    // --- UF2 flashing (RP2040 / RP2350 boards) ---
    const selectedFolder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Select RP drive (mass storage)',
    });

    // If user cancels folder selection
    if (!selectedFolder || selectedFolder.length === 0) {
      vscode.window.showWarningMessage('Firmware flash cancelled (no folder selected).');
      this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'error' });
      return;
    }

    const dest = path.join(selectedFolder[0].fsPath, firmwareName);

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Flashing firmware...',
        cancellable: false,
      },
      () =>
        new Promise<void>((resolve, reject) => {
          // Notify webview that flashing has started
          this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'start' });
          this.outputChannel.appendLine(`📤 Copying UF2 to: ${dest}`);

          try {
            // Copy UF2 file to selected mass storage device
            fs.copyFileSync(tmpPath, dest);
            vscode.window.showInformationMessage('UF2 firmware copied successfully!');
            this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'done' });
            this.outputChannel.appendLine(`✅ UF2 copied to: ${dest}, unplug and replug your board now`);
            resolve();
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to copy UF2 file: ${err.message}`);
            this.outputChannel.appendLine(`❌ Failed to copy UF2: ${err.message}`);
            this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'error' });
            reject(err);
          }
        })
    );

  } else {
    // --- ESP32 flashing using esptool.py ---
    const command = `python -u -m esptool --port ${port} --baud 115200 write_flash --flash_mode keep --flash_size keep --erase-all 0x1000 "${tmpPath}"`;
    this.outputChannel.appendLine(`📤 Executing: ${command}`);

    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Flashing firmware...',
        cancellable: false,
      },
      () =>
        new Promise<void>((resolve, reject) => {
          exec(command, (err, stdout, stderr) => {
            // Show command output in Output Channel
            this.outputChannel.appendLine('[stdout]');
            this.outputChannel.appendLine(stdout);
            if (stderr) {
              this.outputChannel.appendLine('[stderr]');
              this.outputChannel.appendLine(stderr);
            }

            if (err) {
              // Flashing failed
              vscode.window.showErrorMessage(`Flash failed: ${stderr || err.message}`);
              reject(err);
              this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'error' });
            } else {
              // Flashing succeeded
              vscode.window.showInformationMessage('Flash successful!');
              resolve();
              this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'done' });
              this._view?.webview.postMessage({ command: 'triggerListFiles', port });
            }
          });
        })
    );
  }
}

/**
 * Fetches the latest MicroPython firmware list for supported boards.
 * Scans micropython.org download pages for ESP32, RP2040, and RP2350 slugs.
 *
 * @returns Array of firmware objects containing name, URL, board type, and version.
 */
private async fetchFirmwareList(): Promise<{ name: string, url: string, boardType: string, version: string }[]> {
  const baseUrl = 'https://micropython.org';

  // Board slugs for each platform type
  const esp32Slugs  = ['ESP32_GENERIC', 'ESP32_GENERIC_C3', 'ESP32_GENERIC_C2', 'ESP32_GENERIC_C6', 'ESP32_GENERIC_S2', 'ESP32_GENERIC_S3'];
  const rp2040Slugs = ['ARDUINO_NANO_RP2040_CONNECT', 'SPARKFUN_PROMICRO', 'RPI_PICO'];
  const rp2350Slugs = ['RPI_PICO2', 'RPI_PICO2_W', 'SPARKFUN_PROMICRO_RP2350'];

  // Will store all discovered firmwares
  const allFirmwares: { name: string, url: string, boardType: string, version: string }[] = [];

  /**
   * Helper to fetch and parse firmware download links for a given board slug.
   *
   * @param slug - Board identifier slug used in the micropython.org URL.
   * @param extension - Expected firmware file extension (".bin" or ".uf2").
   * @param boardType - Friendly board type label ("ESP32", "RP2040", "RP2350").
   */
  const fetchForSlug = (slug: string, extension: string, boardType: string) => {
    return new Promise<void>((resolve) => {
      const fullUrl = `${baseUrl}/download/${slug}/`;

      // Request the board's download page
      https.get(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let data = '';

        // Accumulate HTML content
        res.on('data', chunk => data += chunk);

        res.on('end', () => {
          const $ = cheerio.load(data);
          let found = false;

          // Scan all anchor tags for matching firmware links
          $('a').each((_, el) => {
            if (found) return; // Only store the first match

            const href = $(el).attr('href');
            if (
              href &&
              href.endsWith(extension) &&                // Correct file extension
              href.includes('/resources/firmware/') &&   // Correct folder path
              /v\d+\.\d+\.\d+/.test(href) &&              // Matches version pattern vX.Y.Z
              !/(spiram|psram|ota|preview|test|IDF)/i.test(href) // Exclude unwanted builds
            ) {
              const full = href.startsWith('http') ? href : `${baseUrl}${href}`;

              // Extract version from the filename or URL
              const versionMatch = href.match(/v(\d+\.\d+\.\d+)/);
              const version = versionMatch ? versionMatch[1] : 'unknown';

              // Store firmware info
              allFirmwares.push({
                name: path.basename(full),
                url: full,
                boardType,
                version
              });

              found = true;
            }
          });

          resolve();
        });
      }).on('error', err => {
        // Log but don't fail the entire process
        this.outputChannel.appendLine(`⚠️ Failed to fetch ${fullUrl}: ${err.message}`);
        resolve();
      });
    });
  };

  // Fetch firmwares for all board types in parallel
  await Promise.all([
    ...esp32Slugs.map(slug  => fetchForSlug(slug, '.bin', 'ESP32')),
    ...rp2040Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2040')),
    ...rp2350Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2350')),
  ]);

  return allFirmwares;
}

/**
 * Downloads a file from the given HTTPS URL and saves it to the specified destination path.
 *
 * @param url  - The URL of the file to download.
 * @param dest - The local file system path where the file should be saved.
 * @returns Promise<void> that resolves when the file is successfully downloaded.
 */
private async downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Create a writable stream for the destination file
    const file = fs.createWriteStream(dest);

    // Start an HTTPS GET request for the file
    https.get(url, response => {
      // Pipe the response stream directly into the file stream
      response.pipe(file);

      // When the file has finished writing
      file.on('finish', () => {
        // Close the file stream to flush all data to disk
        file.close(err => {
          if (err) {
            reject(err); // Reject if closing the file fails
          } else {
            resolve();   // Resolve successfully
          }
        });
      });

    }).on('error', err => {
      // On error, remove the partially downloaded file and reject
      fs.unlink(dest, () => reject(err));
    });
  });
}

// Holds the active SerialPort instance for the live monitor
private serialMonitor: SerialPort | null = null;

/**
 * Starts the serial monitor for the given COM port path.
 * Streams all incoming serial data directly into the extension's output channel.
 *
 * @param portPath - The system path of the serial port (e.g., "COM3" or "/dev/ttyUSB0")
 */
private startSerialMonitor(portPath: string) {
  // Close any existing monitor before starting a new one
  if (this.serialMonitor) {
    this.serialMonitor.close();
    this.serialMonitor = null;
  }

  // Log opening action
  this.outputChannel.appendLine(`🔌 Opening serial monitor on ${portPath}`);

  // Initialize the serial port
  this.serialMonitor = new SerialPort({
    path: portPath,
    baudRate: 115200, // Adjust if your microcontroller uses a different baud rate
    autoOpen: true,
  });

  // Handle incoming serial data
  this.serialMonitor.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    this.outputChannel.append(text); // Append as-is, without trimming newlines
  });

  // Handle serial port errors
  this.serialMonitor.on('error', err => {
    this.outputChannel.appendLine(`Serial error: ${err.message}`);
  });

  // Log when the monitor is closed
  this.serialMonitor.on('close', () => {
    this.outputChannel.appendLine(`🔌 Serial monitor closed.`);
  });
}

/**
 * Stops the serial monitor (if running) and sends a reset command to the device.
 * This is useful to stop execution of main.py or reboot the board.
 *
 * @param portPath - The system path of the serial port to reset
 */
private stopSerialMonitorAndReset(portPath: string) {
  // Close the serial monitor if it's currently open
  if (this.serialMonitor && this.serialMonitor.isOpen) {
    this.serialMonitor.close(err => {
      if (err) {
        this.outputChannel.appendLine(`❌ Error closing serial monitor: ${err.message}`);
      }
    });
    this.serialMonitor = null;
  }

  // Optional: Send a reset command to the device
  const resetCmd = `mpremote connect ${portPath} soft-reset`;
  exec(resetCmd, (err, _stdout, stderr) => {
    if (err) {
      this.outputChannel.appendLine(`❌ Error resetting device: ${stderr || err.message}`);
    } else {
      this.outputChannel.appendLine(`🔁 Device reset successfully.`);
    }
  });
}

/**
 * Refreshes the extension's state by:
 * 1. Fetching the list of available serial ports.
 * 2. Sending the port list to the webview for UI population.
 * 3. Automatically triggering a file list refresh for the first detected port.
 */
private async refreshState() {
  // Get the list of available serial ports
  const ports = await SerialPort.list();

  // Send port list to the webview so it can populate the COM port dropdown
  this._view?.webview.postMessage({
    command: 'populatePorts',
    ports: ports.map(p => p.path),
  });

  // If at least one port exists, trigger a file list refresh for the first one
  if (ports.length > 0) {
    this._view?.webview.postMessage({
      command: 'triggerListFiles',
      port: ports[0].path,
    });
  }
}

/**
 * Called when the Webview view is resolved and ready to be displayed.
 * Sets up HTML, sends initial data, and wires message listeners.
 */
async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
  // Keep a reference to the view so we can post messages later
  this._view = webviewView;

  // Refresh state when the view becomes visible again
  webviewView.onDidChangeVisibility(() => {
    if (webviewView.visible) {
      this.refreshState();
    }
  });

  // Allow JavaScript in the webview
  webviewView.webview.options = { enableScripts: true };

  // Load the webview HTML
  webviewView.webview.html = this.getHtml();

  // Discover available serial ports (e.g., COM3, /dev/ttyUSB0)
  const ports = await SerialPort.list();

  // Send the initial port list to the frontend
  webviewView.webview.postMessage({
    command: 'populatePorts',
    ports: ports.map(p => p.path),
  });

  // If any ports are available, auto-list files on the first one and start serial
  if (ports.length > 0) {
    const defaultPort = ports[0].path;

    webviewView.webview.postMessage({
      command: 'triggerListFiles',
      port: defaultPort,
    });

    // ✅ Autostart serial monitor on the first port
    this.startSerialMonitor(defaultPort);
    this.outputChannel.show();
  }

  // Handle messages coming from the webview (frontend)
  webviewView.webview.onDidReceiveMessage(async (message) => {
    const { port } = message;

    // Remember last selected port so mp.savePython can reuse it
    if (port && typeof port === 'string' && port.trim() !== '') {
      await this.context.globalState.update('mp.lastPort', port);
    }

    // Some commands don't require a port; all others do
    const needsPort = !['flashFirmware', 'getPorts', 'searchModules'].includes(message.command);
    if (needsPort && (!port || typeof port !== 'string' || port.trim() === '')) {
      // Avoid noisy errors during startup or before UI finishes initializing
      this.outputChannel.appendLine(`⚠ Ignoring ${message.command} - no port provided yet.`);
      return;
    }

    // Route by command (behavior unchanged)
    switch (message.command) {
      // ---- Firmware flashing from a local .bin file ----
      case 'flashFirmware': {
        const fileUri = await vscode.window.showOpenDialog({
          filters: { 'BIN files': ['bin'] },
          canSelectMany: false,
        });
        if (!fileUri) {
          vscode.window.showErrorMessage('No firmware file selected.');
          return;
        }

        const firmwarePath = fileUri[0].fsPath;
        // Keep --chip generic for broader compatibility
        const cmd = `python -u -m esptool --port ${message.port} --baud 115200 write_flash --flash_mode keep --flash_size keep --erase-all 0x1000 "${firmwarePath}"`;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
          () =>
            new Promise<void>((resolve, reject) => {
              // Notify frontend that flashing has started
              this._view?.webview.postMessage({ command: 'uploadStatusUpdate', text: 'start' });

              exec(cmd, (error, stdout, stderr) => {
                console.log('Command:', cmd);
                console.log('STDOUT:', stdout);
                console.log('STDERR:', stderr);

                if (error) {
                  vscode.window.showErrorMessage(`Firmware flashing failed: ${stderr || error.message}`);
                  this._view?.webview.postMessage({ command: 'uploadStatusUpdate', text: 'error' });
                  reject(error);
                } else {
                  vscode.window.showInformationMessage('Firmware flashed successfully!');
                  this._view?.webview.postMessage({ command: 'uploadStatusUpdate', text: 'done' });
                  resolve();
                }
              });
            })
        );
        break;
      }

      // ---- Full UI refresh request (ports + initial file list) ----
      case 'requestRefresh': {
        await this.refreshState();
        break;
      }

      // ---- Upload active editor file to device as main.py ----
      case 'uploadPython': {
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('Stopping serial monitor before proceeding...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.languageId !== 'python') {
          vscode.window.showErrorMessage('No active Python file to upload.');
          return;
        }

        const filePath = activeEditor.document.fileName;
        const uploadCmd = `mpremote connect ${port} fs cp "${filePath}" :main.py`;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Uploading Python file as main.py...', cancellable: false },
          () =>
            new Promise<void>((resolve, reject) => {
              exec(uploadCmd, (uploadError, _stdout, uploadStderr) => {
                if (uploadError) {
                  vscode.window.showErrorMessage(`Upload failed: ${uploadStderr || uploadError.message}`);
                  reject(uploadError);
                  return;
                }

                vscode.window.showInformationMessage('Python file uploaded successfully as main.py!');
                // Ask the webview to refresh the device file list
                this._view?.webview.postMessage({ command: 'triggerListFiles', port: message.port });
                resolve();
              });
            })
        );
        break;
      }

      // ---- List files stored on the device ----
      case 'listFiles': {
        const listCmd = `mpremote connect ${port} exec "import os; print(os.listdir())"`;
        exec(listCmd, (err, stdout, stderr) => {
          if (err) {
            vscode.window.showErrorMessage(`Failed to list files: ${stderr || err.message}`);
            return;
          }

          try {
            // Extract the Python list literal from stdout and parse it
            const match = stdout.match(/\[[\s\S]*?\]/);
            const files = match ? JSON.parse(match[0].replace(/'/g, '"')) : [];
            this._view?.webview.postMessage({ command: 'displayFiles', files });
          } catch (_e) {
            vscode.window.showErrorMessage('Failed to parse file list.');
          }
        });
        break;
      }

      // ---- Search firmware options by name (fuzzy) ----
      case 'getFirmwareOptions': {
        const firmwareList = await this.fetchFirmwareList();

        const fuse = new Fuse(firmwareList, {
          keys: ['name'],
          threshold: 0.4, // lower = stricter
        });

        const matches = fuse.search(message.board || '');
        const filtered = matches.slice(0, 10).map(m => m.item);

        this._view?.webview.postMessage({
          command: 'setFirmwareOptions',
          options: filtered,
        });
        break;
      }

      // ---- Flash firmware directly from a selected URL (web) ----
      case 'flashFromWeb': {
        const { firmwareUrl, port } = message;
        if (!firmwareUrl || !port) {
          vscode.window.showErrorMessage('Firmware URL and port are required for flashing.');
          return;
        }

        await this.handleFlashFromWeb(firmwareUrl, port);

        // Tell the UI flashing has started (keep existing behavior)
        this._view?.webview.postMessage({
          command: 'flashStatusUpdate',
          text: 'start',
        });
        break;
      }

      // ---- Download a device file to temp and open in editor ----
      case 'openFileFromDevice': {
        const { port, filename } = message;
        const tempDir = path.join(os.tmpdir(), 'esp-temp');
        const localPath = path.join(tempDir, filename);

        try {
          await fs.promises.mkdir(tempDir, { recursive: true });
          const cmd = `mpremote connect ${port} fs cp :"${filename}" "${localPath}"`;

          this.outputChannel.appendLine(`📥 Downloading ${filename} from device...`);
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
        break;
      }

      // ---- Upload active editor file preserving its original filename ----
      case 'uploadPythonAsIs': {
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('🛑 Stopping serial monitor before proceeding...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor || activeEditor.document.languageId !== 'python') {
          vscode.window.showErrorMessage('No active Python file to upload.');
          return;
        }

        const filePath = activeEditor.document.fileName;
        const fileName = filePath.split(/[/\\]/).pop()!;
        const uploadCmd = `mpremote connect ${message.port} fs cp "${filePath}" :"${fileName}"`;

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Uploading ${fileName} to device...`, cancellable: false },
          () =>
            new Promise<void>((resolve, reject) => {
              exec(uploadCmd, (uploadError, _stdout, uploadStderr) => {
                if (uploadError) {
                  vscode.window.showErrorMessage(`Upload failed: ${uploadStderr || uploadError.message}`);
                  reject(uploadError);
                  return;
                }

                vscode.window.showInformationMessage(`${fileName} uploaded successfully!`);
                // Refresh file list in the webview
                this._view?.webview.postMessage({ command: 'triggerListFiles', port: message.port });
                resolve();
              });
            })
        );
        break;
      }

      // ---- Run (no main.py, no reset; stream output) ----
      case 'runPythonFile': {
        // Free the port from serial monitor
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('🛑 Stopping serial monitor before proceeding...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }
      
        // If a previous run is active, kill it
        if (this.mpRunProc) {
          try { this.mpRunProc.kill(); } catch {}
          this.mpRunProc = null;
        }
      
        const { filename, port } = message;
        if (!filename || !port) {
          vscode.window.showErrorMessage('Filename and port are required to run the script.');
          this.outputChannel.appendLine('⚠️ Cannot run script: filename or port not provided.');
          return;
        }
      
        // 1) Download the on-device file to a temp local path
        const tempPath = path.join(os.tmpdir(), `__run_tmp__-${path.basename(filename)}`);
        const downloadCmd = `mpremote connect ${port} fs cp :${filename} "${tempPath}"`;
      
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Preparing ${filename}...`, cancellable: false },
          async () => {
            //this.outputChannel.appendLine(`⬇ Downloading ${filename} to temp: ${tempPath}`);
            await execCommand(downloadCmd);
          }
        );
      
        // 2) Run without writing main.py or resetting; stream output live
        this.outputChannel.appendLine(`▶ Running ${filename}`);
        this.outputChannel.show(true);
      
        const args = ['connect', port, 'run', tempPath];
        const child = spawn('mpremote', args, { shell: false });
      
        this.mpRunProc = child;
      
        child.stdout.on('data', (data: Buffer) => {
          this.outputChannel.append(data.toString('utf-8'));
        });
        child.stderr.on('data', (data: Buffer) => {
          this.outputChannel.append(data.toString('utf-8'));
        });
        child.on('close', (code) => {
          this.outputChannel.appendLine(`\n[run exited with code ${code ?? 0}]`);
          this.mpRunProc = null;
        });
        child.on('error', (err) => {
          vscode.window.showErrorMessage(`Failed to start mpremote run: ${err.message}`);
          this.outputChannel.appendLine(`❌ Failed to start mpremote run: ${err.message}`);
          this.mpRunProc = null;
        });
      
        vscode.window.showInformationMessage(`${filename} is running. Use “Stop” to interrupt.`);
        break;
      }

      case 'stopRunningCode': {
        const { port, keepMonitor } = message as { port?: string; keepMonitor?: boolean };
        if (!port) {
          vscode.window.showErrorMessage('Port is required to stop running code.');
          return;
        }
      
        // 1) Stop any active 'mpremote run' process
        const killProc = (proc: import('child_process').ChildProcess, timeoutMs = 800) =>
          new Promise<void>((resolve) => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            try { proc.kill('SIGINT'); } catch {}
            const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} finish(); }, timeoutMs);
            proc.on('exit', () => { clearTimeout(t); finish(); });
            proc.on('close', () => { clearTimeout(t); finish(); });
            proc.on('error', () => { clearTimeout(t); finish(); });
          });
        
        if (this.mpRunProc) {
          await killProc(this.mpRunProc);
          this.mpRunProc = null;
        }
      
        // 2) Close serial monitor to free the port (we'll optionally reopen later)
        const wantReopen = !!keepMonitor;
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.serialMonitor.close();
          this.serialMonitor = null;
        }
      
        // Short grace so the OS releases the port handle
        await new Promise(r => setTimeout(r, 150));
      
        // 3) Send Ctrl-C, Ctrl-C, Ctrl-D directly over serial (interrupt + soft reset)
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
          this.outputChannel.appendLine('Stopping code (interrupt & soft reset)');
        } catch (e: any) {
          this.outputChannel.appendLine(`⚠️ Could not send ^C/^D via serial: ${e?.message || e}`);
          // Fallback: do a quick reset via mpremote, but with a hard timeout so we never hang
          const execWithTimeout = (cmd: string, ms: number) =>
            new Promise<void>((resolve, reject) => {
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
          
          try {
            await execWithTimeout(`mpremote connect ${port} soft-reset`, 1500);
            this.outputChannel.appendLine('🔁 Soft reset via mpremote.');
          } catch {
            try {
              await execWithTimeout(`mpremote connect ${port} exec "import machine; machine.reset()"`, 2500);
              this.outputChannel.appendLine('🔁 Hard reset via machine.reset().');
            } catch (err2: any) {
              this.outputChannel.appendLine(`❌ Reset fallback failed: ${err2?.message || String(err2)}`);
            }
          }
        }
      
        // 4) Optionally reopen the serial monitor so the user can see the fresh prompt
        if (wantReopen) {
          await new Promise(r => setTimeout(r, 250));
          this.startSerialMonitor(port);
          this.outputChannel.appendLine('📡 Serial monitor reopened.');
        }
      
        break;
      }
    
          // ---- Ask for an updated list of ports ----
      case 'getPorts': {
        const ports = await SerialPort.list();
        this._view?.webview.postMessage({
          command: 'populatePorts',
          ports: ports.map(p => p.path),
        });
        break;
      }

      // ---- Start serial monitor manually ----
      case 'startSerialMonitor': {
        const { port } = message;
        if (!port) {
          vscode.window.showErrorMessage('Please select a port.');
          return;
        }
        this.startSerialMonitor(port);
        break;
      }

      // ---- Upload one file or a folder of .py files from PC ----
      case 'uploadPythonFromPc': {
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('🛑 Stopping serial monitor before proceeding...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }

        const choice = await vscode.window.showQuickPick(
          ['Single Python File', 'Folder of Python Files (including subfolders)'],
          { placeHolder: 'Do you want to upload a single file or a folder?' }
        );
        if (!choice) return;

        // Show proper picker based on choice
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

        if (stats.isDirectory()) {
          // Recursively gather all .py files (flattened)
          const walk = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile() && entry.name.endsWith('.py')) {
                const fileName = path.basename(fullPath);
                uploadCommands.push(`mpremote connect ${message.port} fs cp "${fullPath}" :"${fileName}"`);
              }
            }
          };

          walk(selectedPath);

          if (uploadCommands.length === 0) {
            vscode.window.showErrorMessage('Selected folder does not contain any .py files.');
            return;
          }
        } else {
          // Single .py file
          const fileName = path.basename(selectedPath);
          uploadCommands.push(`mpremote connect ${message.port} fs cp "${selectedPath}" :"${fileName}"`);
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
              this._view?.webview.postMessage({ command: 'triggerListFiles', port: message.port });
            } catch (err) {
              this.outputChannel.appendLine(`❌ Upload error: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        );
        break;
      }

      // ---- Fetch Soldered module files (library/examples/both) ----
      case 'fetchModule': {
        const { sensor, port, mode } = message;

        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('🛑 Stopping serial monitor before fetching module...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }

        if (!sensor || !port) {
          vscode.window.showErrorMessage('Module name and port are required.');
          return;
        }

        const categories = ['Sensors', 'Displays', 'Actuators'];
        let baseUrl: string | undefined;

        // Try to detect the correct category by probing GitHub
        for (const category of categories) {
          const testUrl = `https://api.github.com/repos/SolderedElectronics/Soldered-MicroPython-Modules/contents/${category}/${sensor}/${sensor}`;
          const res: any = await new Promise((resolve) => {
            https.get(testUrl, { headers: { 'User-Agent': 'vscode-extension' } }, resolve)
              .on('error', () => resolve(undefined));
          });
          if (res?.statusCode === 200) {
            baseUrl = testUrl;
            break;
          }
        }

        if (!baseUrl) {
          vscode.window.showErrorMessage(`❌ Could not find module "${sensor}" in any known category.`);
          return;
        }

        const targets: string[] = [];
        if (mode === 'library' || mode === 'all') targets.push(baseUrl);
        if (mode === 'examples' || mode === 'all') targets.push(`${baseUrl}/Examples`);

        for (const url of targets) {
          await new Promise<void>((resolve) => {
            https.get(url, { headers: { 'User-Agent': 'vscode-extension' } }, res => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', async () => {
                try {
                  const files = JSON.parse(data);
                  const pyFiles = files.filter((f: any) => f.name.endsWith('.py'));

                  if (pyFiles.length === 0) {
                    vscode.window.showWarningMessage(`No .py files found in ${url}`);
                    return resolve();
                  }

                  for (const file of pyFiles) {
                    const uploadName = file.name.replace(/-/g, '_'); // normalize filename for device
                    const tempPath = path.join(os.tmpdir(), uploadName);
                    await this.downloadFile(file.download_url, tempPath);

                    const uploadCmd = `mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`;
                    this.outputChannel.appendLine(`⬆ Uploading ${uploadName}`);
                    await execCommand(uploadCmd);
                  }

                  resolve();
                } catch (err) {
                  vscode.window.showErrorMessage(`Failed to process ${url}`);
                  this.outputChannel.appendLine(`❌ Error: ${err}`);
                  this._view?.webview.postMessage({ command: 'moduleFetchStatus', mode, status: 'error' });
                  resolve();
                }
              });
            }).on('error', err => {
              vscode.window.showErrorMessage(`Failed to fetch ${url}: ${err.message}`);
              resolve();
            });
          });
        }

        vscode.window.showInformationMessage(`✅ Downloaded ${mode} files for "${sensor}"`);
        this._view?.webview.postMessage({ command: 'triggerListFiles', port });
        this._view?.webview.postMessage({ command: 'moduleFetchStatus', mode, status: 'done' });
        break;
      }

      // ---- Search Soldered modules by keyword ----
      case 'searchModules': {
        const keyword = message.keyword || '';
        const categories = ['Sensors', 'Displays', 'Actuators'];
        const allModules: string[] = [];

        await Promise.all(categories.map(category => {
          const apiUrl = `https://api.github.com/repos/SolderedElectronics/Soldered-MicroPython-Modules/contents/${category}`;
          return new Promise<void>((resolve) => {
            https.get(apiUrl, { headers: { 'User-Agent': 'vscode-extension' } }, res => {
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => {
                try {
                  const folders = JSON.parse(data)
                    .filter((f: any) => f.type === 'dir')
                    .map((f: any) => f.name);
                  allModules.push(...folders);
                } catch (_err) {
                  vscode.window.showErrorMessage(`Failed to parse module list for ${category}.`);
                }
                resolve();
              });
            }).on('error', err => {
              vscode.window.showErrorMessage(`GitHub API error for ${category}: ${err.message}`);
              resolve();
            });
          });
        }));

        const fuse = new Fuse(allModules, {
          threshold: 0.4,
          ignoreLocation: true,
          isCaseSensitive: false,
        });

        const matches = fuse.search(keyword).slice(0, 15).map(m => m.item);
        this._view?.webview.postMessage({ command: 'setModuleMatches', matches });
        break;
      }

      // ---- Delete a file on the device ----
      case 'deleteFile': {
        if (this.serialMonitor && this.serialMonitor.isOpen) {
          this.outputChannel.appendLine('🛑 Stopping serial monitor before deleting...');
          this.serialMonitor.close();
          this.serialMonitor = null;
        }

        const delCmd = `mpremote connect ${port} exec "import os; os.remove('${message.filename}')"`;
        exec(delCmd, (err, _stdout, stderr) => {
          if (err) {
            vscode.window.showErrorMessage(`Failed to delete file: ${stderr || err.message}`);
          } else {
            vscode.window.showInformationMessage(`Deleted ${message.filename} successfully.`);
            this._view?.webview.postMessage({ command: 'triggerListFiles', port });
          }
        });
        break;
      }

      // Optional: allow a no-op to just set lastPort from the webview
      case 'noop': {
        // Intentionally empty
        break;
      }

      default: {
        this.outputChannel.appendLine(`ℹ Unknown command from webview: ${message.command}`);
        break;
      }
    }
  });
}

// Loads the HTML content for the Webview panel from an external file
private getHtml(): string {
  const htmlPath = path.join(this.context.extensionPath, 'src', 'panel', 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  // Convert mp.png to a webview-safe URI
  const mpIconUri = this._view?.webview.asWebviewUri(
    vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'mp.svg')
  );

  // Inject the URI into HTML placeholder
  html = html.replace('{{mpIconUri}}', mpIconUri?.toString() || '');

  return html;
}
}