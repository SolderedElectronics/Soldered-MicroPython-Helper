import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { ChildProcess } from 'child_process';

/**
 * Shared context passed to all handler functions.
 * Uses getters so serialMonitor and mpRunProc always reflect current class state.
 */
export interface HandlerContext {
  postMessage(msg: any): void;
  outputChannel: vscode.OutputChannel;
  readonly serialMonitor: SerialPort | null;
  setSerialMonitor(s: SerialPort | null): void;
  readonly mpRunProc: ChildProcess | null;
  setMpRunProc(p: ChildProcess | null): void;
  readonly runSerial: SerialPort | null;
  setRunSerial(s: SerialPort | null): void;
  extensionContext: vscode.ExtensionContext;
}
