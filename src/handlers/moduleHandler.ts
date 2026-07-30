import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { HandlerContext } from '../types';
import { execCommand } from '../utils/execUtils';
import { downloadFile } from './flashHandler';
import { closeAllSerial } from './serialHandler';

// micropython-registry integration (test-only: worker is run locally via `wrangler dev`, not deployed yet)
const REGISTRY_INDEX_URL = 'https://raw.githubusercontent.com/SolderedElectronics/micropython-registry/dist/index.json';
const REGISTRY_WORKER_URL = 'http://localhost:8787';

/**
 * Fetches the micropython-registry's built index and returns the package list
 * (name/version/description/category) to the webview's "Fetch MicroPython
 * module" section.
 * Read straight from GitHub raw (same source the worker itself uses server-side) —
 * the local worker has no list-all endpoint, only per-package install lookups.
 */
export async function handleGetRegistryModules(ctx: HandlerContext): Promise<void> {
  return new Promise((resolve) => {
    https.get(REGISTRY_INDEX_URL, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const index = JSON.parse(data);
          ctx.postMessage({ command: 'setRegistryModules', modules: index.packages ?? [] });
        } catch {
          ctx.outputChannel.appendLine('[WARN] Failed to parse micropython-registry index.');
          ctx.postMessage({ command: 'setRegistryModules', modules: [] });
        }
        resolve();
      });
    }).on('error', err => {
      ctx.outputChannel.appendLine(`[WARN] Failed to fetch micropython-registry index: ${err.message}`);
      ctx.postMessage({ command: 'setRegistryModules', modules: [] });
      resolve();
    });
  });
}

/**
 * Fetches a package's install manifest (mip package.json shape) from the local
 * micropython-registry worker and uploads its files to the device via fs cp.
 * Test-only: expects `wrangler dev` running locally, not a deployed worker.
 */
export async function handleFetchRegistryModule(ctx: HandlerContext, message: any): Promise<void> {
  const { name, port } = message;

  if (!name || !port) {
    vscode.window.showErrorMessage('Module name and port are required.');
    return;
  }

  await closeAllSerial(ctx);

  const manifestUrl = `${REGISTRY_WORKER_URL}/package/latest/${name}/latest.json`;
  try {
    const manifest: any = await new Promise((resolve, reject) => {
      http.get(manifestUrl, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Worker returned ${res.statusCode}: ${data}`));
            return;
          }
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });

    const urls: [string, string][] = manifest.urls ?? [];
    if (urls.length === 0) {
      vscode.window.showWarningMessage(`No files listed for "${name}".`);
      return;
    }

    for (const [destPath, url] of urls) {
      const uploadName = path.basename(destPath).replace(/-/g, '_');
      const tempPath = path.join(os.tmpdir(), uploadName);
      await downloadFile(url, tempPath);
      ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
      await execCommand(`mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
    }

    vscode.window.showInformationMessage(`Installed "${name}" from registry`);
    ctx.postMessage({ command: 'triggerListFiles', port });
    ctx.postMessage({ command: 'registryFetchStatus', status: 'done' });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to fetch registry module: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] ${err.message}`);
    ctx.postMessage({ command: 'registryFetchStatus', status: 'error' });
  }
}
