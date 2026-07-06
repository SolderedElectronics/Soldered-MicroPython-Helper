import type { OutputChannel } from 'vscode';
import { execCommand, withRetry } from './execUtils';

/**
 * Uploads a local file to the connected device at devicePath.
 * Retries up to 5 times on transient mpremote failures.
 */
export async function uploadFileToDevice(
  localPath: string,
  devicePath: string,
  port: string,
  outputChannel: OutputChannel
): Promise<void> {
  const cmd = `mpremote connect ${port} fs cp "${localPath}" :"${devicePath}"`;
  outputChannel.appendLine(`Uploading ${localPath} → device:${devicePath}`);
  await withRetry(
    () => execCommand(cmd, outputChannel),
    5, 500, `upload:${devicePath}`, outputChannel
  );
}
