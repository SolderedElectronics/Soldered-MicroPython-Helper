import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SerialPort } from 'serialport';
import { ChildProcess } from 'child_process';

import { HandlerContext } from './types';
import { startSerialMonitor, handleRunPythonFile, handleStopRunningCode, closeAllSerial } from './handlers/serialHandler';
import { handleFlashFromWeb, handleFlashFirmware, fetchFirmwareList } from './handlers/flashHandler';
import { handleListFiles, handleDeleteFile, handleDeleteAllFiles } from './handlers/fileHandler';
import { handleUploadPythonAsIs, handleUploadPythonFromPc, handleOpenFileFromDevice } from './handlers/uploadHandler';
import { handleFetchModule, handleGetCategories, handleGetModulesForCategory, handleGetAllModules } from './handlers/moduleHandler';
import { execMpremote } from './utils/execUtils';

const IGNORED_PORT_PATTERNS = ['debug-console', 'Bluetooth-Incoming-Port'];

function filterPorts(ports: { path: string }[]): string[] {
  return ports
    .map(p => p.path)
    .filter(p => !IGNORED_PORT_PATTERNS.some(pattern => p.includes(pattern)));
}

export class EspFlasherViewProvider implements vscode.WebviewViewProvider {

  private mpRunProc: ChildProcess | null = null;
  private runSerial: SerialPort | null = null;
  private _view?: vscode.WebviewView;
  private outputChannel = vscode.window.createOutputChannel('ESP Output');
  private serialMonitor: SerialPort | null = null;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * Builds a HandlerContext object that always reflects current class state
   * via getter properties for serialMonitor and mpRunProc.
   */
  private getHandlerContext(): HandlerContext {
    const self = this;
    return {
      postMessage: (msg: any) => self._view?.webview.postMessage(msg),
      outputChannel: this.outputChannel,
      get serialMonitor() { return self.serialMonitor; },
      setSerialMonitor: (s: SerialPort | null) => { self.serialMonitor = s; },
      get mpRunProc() { return self.mpRunProc; },
      setMpRunProc: (p: ChildProcess | null) => { self.mpRunProc = p; },
      get runSerial() { return self.runSerial; },
      setRunSerial: (s: SerialPort | null) => { self.runSerial = s; },
      extensionContext: this.context,
    };
  }

  /**
   * Triggers a file list refresh on the connected device.
   * Called from extension.ts after mp.savePython uploads a file.
   */
  public refreshFileListOnDevice(port: string): void {
    this._view?.webview.postMessage({ command: 'triggerListFiles', port });
  }

  /**
   * Returns the shared output channel for logging.
   */
  public getOutputChannel(): vscode.OutputChannel {
    return this.outputChannel;
  }

  /**
   * Closes all active serial connections so the port is free for external callers
   * (e.g. mp.savePython in extension.ts which calls uploadFileToDevice directly).
   */
  public async releasePort(): Promise<void> {
    await closeAllSerial(this.getHandlerContext());
  }

  /**
   * Fetches available serial ports and sends them to the webview.
   * Also triggers an initial file list refresh on the first port found.
   */
  private async refreshState(): Promise<void> {
    const ports = filterPorts(await SerialPort.list());
    this._view?.webview.postMessage({
      command: 'populatePorts',
      ports,
    });
  }

  /**
   * Called when the webview is resolved and ready.
   * Sets up HTML, sends initial port list, wires all message handlers.
   */
  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this._view = webviewView;

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) this.refreshState();
    });

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.postMessage({
      command: 'populatePorts',
      ports: filterPorts(await SerialPort.list()),
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const { port } = message;

      // Persist last-used port for mp.savePython
      if (port && typeof port === 'string' && port.trim() !== '') {
        await this.context.globalState.update('mp.lastPort', port);
      }

      // Guard: most commands need a port
      const needsPort = !['flashFirmware', 'getPorts', 'getCategories', 'getModulesForCategory', 'getAllModules', 'getFirmwareOptions', 'requestRefresh', 'noop'].includes(message.command);
      if (needsPort && (!port || typeof port !== 'string' || port.trim() === '')) {
        this.outputChannel.appendLine(`[WARN] Ignoring ${message.command} - no port provided yet.`);
        return;
      }

      const ctx = this.getHandlerContext();

      switch (message.command) {

        case 'flashFirmware':
          await handleFlashFirmware(ctx, message);
          break;

        case 'requestRefresh':
          await this.refreshState();
          break;

        case 'listFiles':
          await handleListFiles(ctx, message);
          break;

        case 'getFirmwareOptions': {
          const firmwareList = await fetchFirmwareList(ctx);
          this._view?.webview.postMessage({ command: 'setFirmwareOptions', options: firmwareList });
          break;
        }

        case 'flashFromWeb':
          if (!message.firmwareUrl || !message.port) {
            vscode.window.showErrorMessage('Firmware URL and port are required for flashing.');
            return;
          }
          await handleFlashFromWeb(ctx, message.firmwareUrl, message.port);
          break;

        case 'openFileFromDevice':
          await handleOpenFileFromDevice(ctx, message);
          break;

        case 'uploadPythonAsIs':
          await handleUploadPythonAsIs(ctx, message);
          break;

        case 'runPythonFile':
          await handleRunPythonFile(ctx, message);
          break;

        case 'stopRunningCode':
          await handleStopRunningCode(ctx, message);
          break;

        case 'getPorts': {
          this._view?.webview.postMessage({
            command: 'populatePorts',
            ports: filterPorts(await SerialPort.list()),
          });
          break;
        }

        case 'startSerialMonitor':
          if (!message.port) {
            vscode.window.showErrorMessage('Please select a port.');
            return;
          }
          startSerialMonitor(ctx, message.port);
          break;

        case 'uploadPythonFromPc':
          await handleUploadPythonFromPc(ctx, message);
          break;

        case 'fetchModule':
          await handleFetchModule(ctx, message);
          break;

        case 'getCategories':
          await handleGetCategories(ctx);
          break;

        case 'getModulesForCategory':
          await handleGetModulesForCategory(ctx, message);
          break;

        case 'getAllModules':
          await handleGetAllModules(ctx, message);
          break;

        case 'deleteFile':
          await handleDeleteFile(ctx, message);
          break;

        case 'deleteAllFiles':
          await handleDeleteAllFiles(ctx, message);
          break;

        case 'checkMicroPython':
          await closeAllSerial(ctx);
          execMpremote(`mpremote connect ${port} exec "import sys; print(sys.implementation.name)"`)
            .then(stdout => {
              const installed = stdout.trim().toLowerCase().includes('micropython');
              this._view?.webview.postMessage({ command: 'micropythonStatus', installed });
            })
            .catch(() => {
              this._view?.webview.postMessage({ command: 'micropythonStatus', installed: false });
            });
          break;

        case 'stopSerialMonitor':
          if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
            ctx.serialMonitor.close();
            ctx.setSerialMonitor(null);
          }
          break;

        case 'sendSerial':
          if (ctx.runSerial && ctx.runSerial.isOpen) {
            // Raw REPL run: no newline — sys.stdin.read(1) reads exact chars
            ctx.runSerial.write(message.data, (err) => {
              if (err) ctx.outputChannel.appendLine(`[ERROR] Serial write failed: ${err.message}`);
            });
          } else if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
            ctx.serialMonitor.write(message.data + '\n', (err) => {
              if (err) ctx.outputChannel.appendLine(`[ERROR] Serial write failed: ${err.message}`);
            });
          } else if (ctx.mpRunProc?.stdin) {
            ctx.mpRunProc.stdin.write(message.data + '\n', (err) => {
              if (err) ctx.outputChannel.appendLine(`[ERROR] stdin write failed: ${err?.message}`);
            });
          }
          break;

        case 'noop':
          break;

        default:
          this.outputChannel.appendLine(`[INFO] Unknown command from webview: ${message.command}`);
      }
    });
  }

  /**
   * Reads the webview HTML from disk and injects the icon URI.
   */
  private getHtml(): string {
    const htmlPath = path.join(this.context.extensionPath, 'src', 'panel', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const mpIconUri = this._view?.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'mp.svg')
    );
    html = html.replace('{{mpIconUri}}', mpIconUri?.toString() || '');
    return html;
  }
}
