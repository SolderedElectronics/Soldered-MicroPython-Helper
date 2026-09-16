import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as cheerio from 'cheerio';
import { exec, spawn } from 'child_process';
import { HandlerContext } from '../types';
import { mpremoteQueue } from '../utils/execUtils';
import { closeAllSerial } from './serialHandler';

/**
 * Returns the correct flash start address for the given firmware filename.
 * ESP32-C2/C3/C6 and S3 use 0x0; original ESP32 and S2 use 0x1000.
 */
function getFlashAddress(firmwareName: string): string {
  // SOLDERED_NULA_MINI is ESP32-C6 based, but its filename doesn't carry a
  // chip suffix like the ESP32_GENERIC_* boards do, so it needs an explicit
  // override to avoid falling back to the wrong (0x1000) address.
  if (/^SOLDERED_NULA_MINI-/i.test(firmwareName)) return '0x0';
  // Inkplate 13SPECTRA/7SPECTRA firmware is ESP32-S3 based, but its filename
  // has no chip suffix either.
  if (/^inkplate13spectra-firmware/i.test(firmwareName)) return '0x0';
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

  const esp32Slugs  = ['ESP32_GENERIC', 'ESP32_GENERIC_C3', 'ESP32_GENERIC_C2', 'ESP32_GENERIC_C6', 'ESP32_GENERIC_S2', 'ESP32_GENERIC_S3', 'SOLDERED_NULA_MINI'];
  const rp2040Slugs = ['ARDUINO_NANO_RP2040_CONNECT', 'SPARKFUN_PROMICRO', 'RPI_PICO'];
  const rp2350Slugs = ['RPI_PICO2', 'RPI_PICO2_W', 'SPARKFUN_PROMICRO_RP2350', 'SOLDERED_NULA_MAX_RP2350'];

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

  // Inkplate firmware isn't versioned/released on micropython.org - it's built
  // and committed straight into the Inkplate-micropython repo's firmware/
  // folder, so fetch the current .bin files from there directly (via the
  // GitHub API, which resolves the default branch for us) instead of scraping
  // a fixed URL, so this always picks up the latest firmware on git.
  const fetchInkplateFirmware = () => {
    return new Promise<void>((resolve) => {
      https.get(
        'https://api.github.com/repos/SolderedElectronics/Inkplate-micropython/contents/firmware',
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const entries: { name: string; download_url: string | null; sha: string; type: string }[] = JSON.parse(data);
              for (const entry of entries) {
                if (entry.type === 'file' && entry.name.endsWith('.bin') && entry.download_url) {
                  allFirmwares.push({
                    name: entry.name,
                    url: entry.download_url,
                    boardType: 'Inkplate',
                    version: entry.sha.slice(0, 7),
                  });
                }
              }
            } catch (err: any) {
              ctx.outputChannel.appendLine(`[WARN] Failed to parse Inkplate firmware list: ${err.message}`);
            }
            resolve();
          });
        }
      ).on('error', err => {
        ctx.outputChannel.appendLine(`[WARN] Failed to fetch Inkplate firmware list: ${err.message}`);
        resolve();
      });
    });
  };

  await Promise.all([
    ...esp32Slugs.map(slug  => fetchForSlug(slug, '.bin', 'ESP32')),
    ...rp2040Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2040')),
    ...rp2350Slugs.map(slug => fetchForSlug(slug, '.uf2', 'RP2350')),
    fetchInkplateFirmware(),
  ]);

  return allFirmwares;
}

/**
 * Spawns esptool and streams its output, parsing progress percentage and
 * sending flashProgress messages to the webview as writing proceeds.
 *
 * Uses array-form args (no shell) so esptoolPath/port/file paths never need
 * manual quoting - a shell:true string built with template interpolation
 * (the previous approach) breaks outright on inputs containing spaces, e.g.
 * the very common Windows install path "C:\Program Files\esptool\esptool.exe".
 */
function streamFlashWithProgress(esptoolPath: string, args: string[], ctx: HandlerContext): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.outputChannel.appendLine(`Executing: ${esptoolPath} ${args.join(' ')}`);
    const child = spawn(esptoolPath, args, { windowsHide: true });

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
export async function handleFlashFromWeb(ctx: HandlerContext, firmwareUrl: string, port?: string): Promise<void> {
  await closeAllSerial(ctx);
  await mpremoteQueue.abort();
  await new Promise(r => setTimeout(r, 500)); // extra settle time for the OS/driver to release the port

  const firmwareName = path.basename(firmwareUrl);
  const tmpPath = path.join(os.tmpdir(), firmwareName);
  const isUF2 = firmwareUrl.endsWith('.uf2');

  // Flip the button into its "working" state immediately, and make sure any
  // failure below - including the download itself - always reaches the user
  // instead of dying as a silent unhandled rejection in the extension host.
  ctx.postMessage({ command: 'flashStatusUpdate', text: 'start' });

  try {
    ctx.outputChannel.appendLine(`Downloading firmware from: ${firmwareUrl}`);
    await downloadFile(firmwareUrl, tmpPath);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to download firmware: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] Failed to download firmware: ${err.message}`);
    ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
    return;
  }

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
        ctx.outputChannel.appendLine(`Copying UF2 to: ${dest}`);
        ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Copying to drive...' });

        try {
          fs.copyFileSync(tmpPath, dest);

          // copyFileSync only guarantees the bytes reached the OS's page
          // cache, not the physical drive - on a removable UF2 volume that
          // gap is exactly what the bootloader watches to know the write is
          // finished. fsync-ing the file (and its containing directory, so
          // the directory entry/size update lands too) forces the flush
          // before we tell the user it's safe to unplug the board; skipping
          // this risks a truncated firmware write that never boots and never
          // shows up as a serial port again.
          const fileFd = fs.openSync(dest, 'r+');
          try { fs.fsyncSync(fileFd); } finally { fs.closeSync(fileFd); }
          try {
            const dirFd = fs.openSync(path.dirname(dest), 'r');
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
          } catch {
            // Directory fsync isn't supported on every platform/filesystem
            // (e.g. some FAT drivers) - the file-level fsync above is the
            // part that actually matters, so ignore failures here.
          }

          ctx.postMessage({ command: 'flashProgress', percent: 100, label: 'Done' });
          vscode.window.showInformationMessage('UF2 firmware copied successfully! Wait for the drive to disappear/reboot on its own before unplugging.');
          ctx.postMessage({ command: 'flashStatusUpdate', text: 'done' });
          ctx.outputChannel.appendLine(`UF2 copied to: ${dest} - the board should auto-eject and reboot into the new firmware; wait for that before unplugging.`);
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
    const args = ['--port', port!, '--baud', '115200', 'write-flash', '--flash-mode', 'keep', '--flash-size', 'keep', '--erase-all', flashAddr, tmpPath];

    ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Starting...' });

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
      async () => {
        try {
          await streamFlashWithProgress(esptoolPath, args, ctx);
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
  await closeAllSerial(ctx);
  await mpremoteQueue.abort();
  await new Promise(r => setTimeout(r, 500)); // extra settle time for the OS/driver to release the port

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
  const args = ['--port', message.port, '--baud', '115200', 'write-flash', '--flash-mode', 'keep', '--flash-size', 'keep', '--erase-all', flashAddr, firmwarePath];

  ctx.postMessage({ command: 'flashStatusUpdate', text: 'start' });
  ctx.postMessage({ command: 'flashProgress', percent: 0, label: 'Starting...' });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Flashing firmware...', cancellable: false },
    async () => {
      try {
        await streamFlashWithProgress(esptoolPath, args, ctx);
        vscode.window.showInformationMessage('Firmware flashed successfully!');
        ctx.postMessage({ command: 'flashStatusUpdate', text: 'done' });
        await new Promise(r => setTimeout(r, 3000));
        ctx.postMessage({ command: 'triggerListFiles', port: message.port });
      } catch (err: any) {
        vscode.window.showErrorMessage(`Firmware flashing failed: ${err.message}`);
        ctx.postMessage({ command: 'flashStatusUpdate', text: 'error' });
      }
    }
  );
}
