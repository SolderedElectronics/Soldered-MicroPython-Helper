import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { HandlerContext } from '../types';
import { execCommand } from '../utils/execUtils';
import { downloadFile } from './flashHandler';

const REPO_ROOT = 'https://api.github.com/repos/SolderedElectronics/Soldered-MicroPython-Modules/contents';
const FALLBACK_CATEGORIES = ['Sensors', 'Displays', 'Actuators'];
const IGNORE_FOLDERS = ['.github', 'moduletemplate', 'img'];

/**
 * Fetches all top-level directory names from the repo root.
 * Falls back to hardcoded list if the request fails.
 */
async function fetchCategories(): Promise<string[]> {
  return new Promise((resolve) => {
    https.get(REPO_ROOT, { headers: { 'User-Agent': 'vscode-extension' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const items = JSON.parse(data);
          const folders = items
            .filter((f: any) => f.type === 'dir' && !IGNORE_FOLDERS.includes(f.name.toLowerCase()))
            .map((f: any) => f.name);
          resolve(folders.length ? folders : FALLBACK_CATEGORIES);
        } catch {
          resolve(FALLBACK_CATEGORIES);
        }
      });
    }).on('error', () => resolve(FALLBACK_CATEGORIES));
  });
}

/**
 * Returns all top-level category folders from the repo to the webview.
 */
export async function handleGetCategories(ctx: HandlerContext): Promise<void> {
  const categories = await fetchCategories();
  ctx.postMessage({ command: 'setCategories', categories });
}

/**
 * Returns all module folders inside a given category.
 */
export async function handleGetModulesForCategory(ctx: HandlerContext, message: any): Promise<void> {
  const { category } = message;
  if (!category) {
    ctx.postMessage({ command: 'setModulesForCategory', modules: [] });
    return;
  }

  const apiUrl = `${REPO_ROOT}/${category}`;
  return new Promise((resolve) => {
    https.get(apiUrl, { headers: { 'User-Agent': 'vscode-extension' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const modules = JSON.parse(data)
            .filter((f: any) => f.type === 'dir')
            .map((f: any) => f.name);
          ctx.postMessage({ command: 'setModulesForCategory', modules });
        } catch {
          ctx.outputChannel.appendLine(`[WARN] Failed to fetch modules for ${category}`);
          ctx.postMessage({ command: 'setModulesForCategory', modules: [] });
        }
        resolve();
      });
    }).on('error', err => {
      ctx.outputChannel.appendLine(`[WARN] GitHub API error for ${category}: ${err.message}`);
      ctx.postMessage({ command: 'setModulesForCategory', modules: [] });
      resolve();
    });
  });
}

/**
 * Fetches a Soldered module (library/examples/both) from GitHub and uploads to device.
 */
export async function handleFetchModule(ctx: HandlerContext, message: any): Promise<void> {
  const { sensor, port, mode } = message;

  if (ctx.serialMonitor && ctx.serialMonitor.isOpen) {
    ctx.outputChannel.appendLine('Stopping serial monitor before fetching module...');
    ctx.serialMonitor.close();
    ctx.setSerialMonitor(null);
  }

  if (!sensor || !port) {
    vscode.window.showErrorMessage('Module name and port are required.');
    return;
  }

  const categories = await fetchCategories();
  let baseUrl: string | undefined;

  for (const category of categories) {
    const testUrl = `${REPO_ROOT}/${category}/${sensor}/${sensor}`;
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
    vscode.window.showErrorMessage(`Could not find module "${sensor}" in any category.`);
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
              const uploadName = file.name.replace(/-/g, '_');
              const tempPath = path.join(os.tmpdir(), uploadName);
              await downloadFile(file.download_url, tempPath);

              const uploadCmd = `mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`;
              ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
              await execCommand(uploadCmd, ctx.outputChannel);
            }

            resolve();
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to process ${url}`);
            ctx.outputChannel.appendLine(`[ERROR] ${err}`);
            ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'error' });
            resolve();
          }
        });
      }).on('error', err => {
        vscode.window.showErrorMessage(`Failed to fetch ${url}: ${err.message}`);
        resolve();
      });
    });
  }

  vscode.window.showInformationMessage(`Downloaded ${mode} files for "${sensor}"`);
  ctx.postMessage({ command: 'triggerListFiles', port });
  ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'done' });
}
