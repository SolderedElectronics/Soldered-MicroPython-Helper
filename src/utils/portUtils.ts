import * as vscode from 'vscode';
import { SerialPort } from 'serialport';
import { HandlerContext } from '../types';

/**
 * Returns the last-used port from globalState, or prompts the user to pick one.
 * Saves the selection to globalState for future reuse.
 */
export async function pickPort(ctx: Pick<HandlerContext, 'outputChannel' | 'extensionContext'>): Promise<string | undefined> {
  const lastPort = ctx.extensionContext.globalState.get<string>('mp.lastPort');
  if (lastPort) {
    ctx.outputChannel.appendLine(`Using last selected port: ${lastPort}`);
    return lastPort;
  }

  const ports = await SerialPort.list();
  if (!ports.length) {
    vscode.window.showErrorMessage('No serial ports available.');
    ctx.outputChannel.appendLine('[ERROR] No serial ports available.');
    return undefined;
  }

  const chosen = await vscode.window.showQuickPick(
    ports.map(p => p.path),
    { placeHolder: 'Select a serial port' }
  );

  if (chosen) {
    await ctx.extensionContext.globalState.update('mp.lastPort', chosen);
    ctx.outputChannel.appendLine(`Selected port: ${chosen} (saved as lastPort)`);
    return chosen;
  }

  ctx.outputChannel.appendLine('User cancelled port selection.');
  return undefined;
}
