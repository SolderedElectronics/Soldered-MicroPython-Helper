import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SerialPort } from 'serialport';
import { ChildProcess } from 'child_process';

import { HandlerContext } from './types';
import { startSerialMonitor, handleRunPythonFile, handleStopRunningCode } from './handlers/serialHandler';
import { handleFlashFromWeb, handleFlashFirmware, fetchFirmwareList } from './handlers/flashHandler';
import { handleListFiles, handleDeleteFile } from './handlers/fileHandler';
import { handleUploadPython, handleUploadPythonAsIs, handleUploadPythonFromPc, handleOpenFileFromDevice } from './handlers/uploadHandler';
import { handleFetchModule, handleGetCategories, handleGetModulesForCategory } from './handlers/moduleHandler';

export class EspFlasherViewProvider implements vscode.WebviewViewProvider {

  private mpRunProc: ChildProcess | null = null;
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
   * Fetches available serial ports and sends them to the webview.
   * Also triggers an initial file list refresh on the first port found.
   */
  private async refreshState(): Promise<void> {
    const ports = await SerialPort.list();
    this._view?.webview.postMessage({
      command: 'populatePorts',
      ports: ports.map(p => p.path),
    });
    if (ports.length > 0) {
      this._view?.webview.postMessage({
        command: 'triggerListFiles',
        port: ports[0].path,
      });
    }
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

    const ports = await SerialPort.list();
    webviewView.webview.postMessage({
      command: 'populatePorts',
      ports: ports.map(p => p.path),
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      const { port } = message;

      // Persist last-used port for mp.savePython
      if (port && typeof port === 'string' && port.trim() !== '') {
        await this.context.globalState.update('mp.lastPort', port);
      }

      // Guard: most commands need a port
      const needsPort = !['flashFirmware', 'getPorts', 'getCategories', 'getModulesForCategory', 'getFirmwareOptions', 'requestRefresh', 'noop'].includes(message.command);
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

        case 'uploadPython':
          await handleUploadPython(ctx, message);
          break;

        case 'listFiles':
          handleListFiles(ctx, message);
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
          this._view?.webview.postMessage({ command: 'flashStatusUpdate', text: 'start' });
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
          const availablePorts = await SerialPort.list();
          this._view?.webview.postMessage({
            command: 'populatePorts',
            ports: availablePorts.map(p => p.path),
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

        case 'deleteFile':
          handleDeleteFile(ctx, message);
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
