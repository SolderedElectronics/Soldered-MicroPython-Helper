import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as cheerio from 'cheerio';
import { exec, spawn } from 'child_process';
import { HandlerContext } from '../types';
import { mpremoteQueue } from '../utils/execUtils';

/**
 * Returns the correct flash start address for the given firmware filename.
 * ESP32-C2/C3/C6 and S3 use 0x0; original ESP32 and S2 use 0x1000.
 */
function getFlashAddress(firmwareName: string): string {
  return /esp32[_-].*(c2|c3|c6|s3)/i.test(firmwareName) ? '0x0' : '0x1000';
}

/**
 * Downloads a file from HTTPS URL to a local destination path.
 */
export async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https.get(url, response => {
      response.pipe(file);

      file.on('finish', () => {
        file.close(err => {
          if (err) reject(err);
          else resolve();
        });
      });
    }).on('error', err => {
      fs.unlink(dest, () => reject(err));
    });
  });
}

/**
 * Fetches the latest MicroPython firmware list from micropython.org.
 * Supports ESP32 (.bin), RP2040 (.uf2), and RP2350 (.uf2) boards.
 */
export async function fetchFirmwareList(
  ctx: Pick<HandlerContext, 'outputChannel'>
): Promise<{ name: string; url: string; boardType: string; version: string }[]> {
  const baseUrl = 'https://micropython.org';

  const esp32Slugs  = ['ESP32_GENERIC', 'ESP32_GENERIC_C3', 'ESP32_GENERIC_C2', 'ESP32_GENERIC_C6', 'ESP32_GENERIC_S2', 'ESP32_GENERIC_S3'];
  const rp2040Slugs = ['ARDUINO_NANO_RP2040_CONNECT', 'SPARKFUN_PROMICRO', 'RPI_PICO'];
  const rp2350Slugs = ['RPI_PICO2', 'RPI_PICO2_W', 'SPARKFUN_PROMICRO_RP2350'];

  const allFirmwares: { name: string; url: string; boardType: string; version: string }[] = [];

  const fetchForSlug = (slug: string, extension: string, boardType: string) => {
    return new Promise<void>((resolve) => {
      const fullUrl = `${baseUrl}/download/${slug}/`;

      https.get(fullUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const $ = cheerio.load(data);
          let found = false;

          $('a').each((_, el) => {
            if (found) return;

            const href = $(el).attr('href');
            if (
              href &&
              href.endsWith(extension) &&
              href.includes('/resources/firmware/') &&
              /v\d+\.\d+\.\d+/.test(href) &&
              !/(spiram|psram|ota|preview|test|IDF)/i.test(href)
            ) {
              const full = href.startsWith('http') ? href : `${baseUrl}${href}`;
              const versionMatch = href.match(/v(\d+\.\d+\.\d+)/);
              const version = versionMatch ? versionMatch[1] : 'unknown';

              allFirmwares.push({ name: path.basename(full), url: full, boardType, version });
              found = true;
            }
          });

          resolve();
        });
      }).on('error', err => {
        ctx.outputChannel.appendLine(`[WARN] Failed to fetch ${fullUrl}: ${err.message}`);
        resolve();
      });
    });
  };

  await Promise.all([
    ...esp32Slugs.map(slug  => fetchForSlug(slug, '.bin', 'ESP32')),
    ...rp2040Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2040')),
    ...rp2350Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2350')),
  ]);

  return allFirmwares;
}

/**
 * Spawns esptool and streams its output, parsing progress percentage and
 * sending flashProgress messages to the webview as writing proceeds.
 */
function streamFlashWithProgress(command: string, ctx: HandlerContext): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.outputChannel.appendLine(`Executing: ${command}`);
    const child = spawn(command, [], { shell: true });

    const handleChunk = (data: string) => {
      ctx.outputChannel.append(data);
      for (const segment of data.split(/[\r\n]+/)) {
        const pctMatch = segment.match(/(\d+(?:\.\d+)?)%/);
        if (pctMatch) {
          const pct = parseFloat(pctMatch[1]);
          ctx.postMessage({ command: 'flashProgress', percent: Math.round(pct), label: `Writing... ${pct}%` });
          continue;
        }
        if (/erasing flash/i.test(segment)) {
          ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Erasing flash...' });
        }
        if (/hash of data verified/i.test(segment)) {
          ctx.postMessage({ command: 'flashProgress', percent: 100, label: 'Verifying...' });
        }
      }
    };

    child.stdout.on('data', (d: Buffer) => handleChunk(d.toString()));
    child.stderr.on('data', (d: Buffer) => handleChunk(d.toString()));
    child.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`esptool exited with code ${code}`)); });
    child.on('error', reject);
  });
}

/**
 * Handles firmware flashing triggered from the webview (web download).
 * Supports UF2 (RP boards) and .bin (ESP32) formats.
 */
export async function handleFlashFromWeb(ctx: HandlerContext, firmwareUrl: string, port: string): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before flashing...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }
  mpremoteQueue.abort();
  await new Promise(r => setTimeout(r, 500)); // let OS release the port

  const firmwareName = path.basename(firmwareUrl);
  const tmpPath = path.join(os.tmpdir(), firmwareName);
  const isUF2 = firmwareUrl.endsWith('.uf2');

  await downloadFile(firmwareUrl, tmpPath);

  if (isUF2) {
    const selectedFolder = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      openLabel: 'Select RP drive (mass storage)',
    });

    if (!selectedFolder || selectedFolder.length === 0) {
      vscode.window.showWarningMessage('Firmware flash cancelled (no folder selected).');
      ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
      return;
    }

    const dest = path.join(selectedFolder[0].fsPath, firmwareName);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
      () => new Promise<void>((resolve, reject) => {
        ctx.postMessage({ command: 'flashStatusUpdate', text: 'start' });
        ctx.outputChannel.appendLine(`Copying UF2 to: ${dest}`);

        try {
          fs.copyFileSync(tmpPath, dest);
          vscode.window.showInformationMessage('UF2 firmware copied successfully!');
          ctx.postMessage({ command: 'flashStatusUpdate', text: 'done' });
          ctx.outputChannel.appendLine(`UF2 copied to: ${dest} - unplug and replug your board now`);
          resolve();
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to copy UF2 file: ${err.message}`);
          ctx.outputChannel.appendLine(`[ERROR] Failed to copy UF2: ${err.message}`);
          ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
          reject(err);
        }
      })
    );

  } else {
    const esptoolPath = vscode.workspace.getConfiguration('mp').get<string>('esptoolPath', 'esptool');
    const flashAddr = getFlashAddress(firmwareName);
    const command = `${esptoolPath} --port ${port} --baud 115200 write_flash --flash_mode keep --flash_size keep --erase-all ${flashAddr} "${tmpPath}"`;

    ctx.postMessage({ command: 'flashStatusUpdate', text: 'start' });
    ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Starting...' });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
      async () => {
        try {
          await streamFlashWithProgress(command, ctx);
          vscode.window.showInformationMessage('Flash successful!');
          ctx.postMessage({ command: 'flashStatusUpdate', text: 'done' });
          // wait for board to finish booting before listing files
          await new Promise(r => setTimeout(r, 3000));
          ctx.postMessage({ command: 'triggerListFiles', port });
        } catch (err: any) {
          vscode.window.showErrorMessage(`Flash failed: ${err.message}`);
          ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
        }
      }
    );
  }
}

/**
 * Handles flashing a locally selected .bin firmware file.
 */
export async function handleFlashFirmware(ctx: HandlerContext, message: any): Promise<void> {
  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before flashing...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }
  mpremoteQueue.abort();
  await new Promise(r => setTimeout(r, 500)); // let OS release the port

  const fileUri = await vscode.window.showOpenDialog({
    filters: { 'BIN files': ['bin'] },
    canSelectMany: false,
  });
  if (!fileUri) {
    vscode.window.showErrorMessage('No firmware file selected.');
    return;
  }

  const firmwarePath = fileUri[0].fsPath;
  const esptoolPath = vscode.workspace.getConfiguration('mp').get<string>('esptoolPath', 'esptool');
  const flashAddr = getFlashAddress(path.basename(firmwarePath));
  const cmd = `${esptoolPath} --port ${message.port} --baud 115200 write_flash --flash_mode keep --flash_size keep --erase-all ${flashAddr} "${firmwarePath}"`;

  ctx.postMessage({ command: 'flashStatusUpdate', text: 'start' });
  ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Starting...' });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
    async () => {
      try {
        await streamFlashWithProgress(cmd, ctx);
        vscode.window.showInformationMessage('Firmware flashed successfully!');
        ctx.postMessage({ command: 'flashStatusUpdate', text: 'done' });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Firmware flashing failed: ${err.message}`);
        ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
      }
    }
  );
}
