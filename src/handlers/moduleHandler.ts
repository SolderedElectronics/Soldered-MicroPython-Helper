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
const CACHE_KEY = 'mp.modulesCache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// GitHub token cache — undefined = not yet checked, null = not available
let cachedGithubToken: string | null | undefined = undefined;

async function getGithubToken(): Promise<string | null> {
  if (cachedGithubToken) return cachedGithubToken; // only cache real tokens; null/undefined re-checks each time
  try {
    const session = await vscode.authentication.getSession('github', [], { createIfNone: false });
    const token = session?.accessToken ?? null;
    if (token) cachedGithubToken = token;
    return token;
  } catch {
    return null;
  }
}

async function githubHeaders(): Promise<Record<string, string>> {
  const token = await getGithubToken();
  const headers: Record<string, string> = { 'User-Agent': 'vscode-extension' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

interface ModulesCache {
  timestamp: number;
  categories: string[];
  modules: { [category: string]: string[] };
}

function getCachedModules(ctx: HandlerContext): ModulesCache | null {
  const cached = ctx.extensionContext.globalState.get<ModulesCache>(CACHE_KEY);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached;
  }
  return null;
}

async function setCachedModules(ctx: HandlerContext, categories: string[], modules: { [category: string]: string[] }): Promise<ModulesCache> {
  const cache: ModulesCache = { timestamp: Date.now(), categories, modules };
  await ctx.extensionContext.globalState.update(CACHE_KEY, cache);
  return cache;
}

/**
 * Fetches all top-level directory names from the repo root.
 * Falls back to hardcoded list if the request fails.
 */
async function fetchCategories(): Promise<string[]> {
  const headers = await githubHeaders();
  return new Promise((resolve) => {
    https.get(REPO_ROOT, { headers }, res => {
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
 * Uses cache if available.
 */
export async function handleGetCategories(ctx: HandlerContext): Promise<void> {
  const cached = getCachedModules(ctx);
  if (cached) {
    ctx.postMessage({ command: 'setCategories', categories: cached.categories });
    return;
  }
  const categories = await fetchCategories();
  ctx.postMessage({ command: 'setCategories', categories });
}

/**
 * Fetches all modules across all categories in parallel.
 * Returns a map of { [category]: string[] } to the webview.
 * Uses globalState cache with 24hr TTL. Pass force: true to bypass cache.
 */
export async function handleGetAllModules(ctx: HandlerContext, message: any = {}): Promise<void> {
  const { force } = message;

  if (!force) {
    const cached = getCachedModules(ctx);
    if (cached) {
      ctx.postMessage({ command: 'setCategories', categories: cached.categories });
      ctx.postMessage({ command: 'setAllModules', modules: cached.modules, cachedAt: cached.timestamp });
      return;
    }
  }

  ctx.postMessage({ command: 'setAllModulesLoading' });

  const categories = await fetchCategories();
  const headers = await githubHeaders();

  const results = await Promise.all(
    categories.map(category =>
      new Promise<{ category: string; modules: string[] }>(resolve => {
        const apiUrl = `${REPO_ROOT}/${category}`;
        https.get(apiUrl, { headers }, res => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const items = JSON.parse(data);
              let modules = items.filter((f: any) => f.type === 'dir').map((f: any) => f.name);
              // flat-structure category (e.g. Qwiic): no subdirs, .py files directly inside
              if (modules.length === 0) {
                modules = items
                  .filter((f: any) => f.type === 'file' && f.name.endsWith('.py'))
                  .map((f: any) => f.name.replace(/\.py$/, ''));
              }
              resolve({ category, modules });
            } catch {
              resolve({ category, modules: [] });
            }
          });
        }).on('error', () => resolve({ category, modules: [] }));
      })
    )
  );

  const moduleMap: { [category: string]: string[] } = {};
  results.forEach(({ category, modules }) => {
    if (modules.length > 0) moduleMap[category] = modules;
  });

  const cache = await setCachedModules(ctx, categories, moduleMap);
  ctx.postMessage({ command: 'setCategories', categories });
  ctx.postMessage({ command: 'setAllModules', modules: moduleMap, cachedAt: cache.timestamp });
}

/**
 * Returns all module folders inside a given category.
 * Uses cache if available, otherwise fetches from GitHub.
 */
export async function handleGetModulesForCategory(ctx: HandlerContext, message: any): Promise<void> {
  const { category } = message;
  if (!category) {
    ctx.postMessage({ command: 'setModulesForCategory', modules: [] });
    return;
  }

  // Use cache if available
  const cached = getCachedModules(ctx);
  if (cached && cached.modules[category]) {
    ctx.postMessage({ command: 'setModulesForCategory', modules: cached.modules[category] });
    return;
  }

  const apiUrl = `${REPO_ROOT}/${category}`;
  const headers = await githubHeaders();
  return new Promise((resolve) => {
    https.get(apiUrl, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const items = JSON.parse(data);
          let modules = items.filter((f: any) => f.type === 'dir').map((f: any) => f.name);
          if (modules.length === 0) {
            modules = items
              .filter((f: any) => f.type === 'file' && f.name.endsWith('.py'))
              .map((f: any) => f.name.replace(/\.py$/, ''));
          }
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
 * Fetches all .py files from a GitHub API URL and uploads them to the device.
 */
async function uploadDirectoryFiles(url: string, port: string, ctx: HandlerContext): Promise<void> {
  const headers = await githubHeaders();
  const files: any[] = await new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  const pyFiles = files.filter((f: any) => f.name.endsWith('.py'));
  if (pyFiles.length === 0) {
    vscode.window.showWarningMessage(`No .py files found.`);
    return;
  }

  for (const file of pyFiles) {
    const uploadName = file.name.replace(/-/g, '_');
    const tempPath = path.join(os.tmpdir(), uploadName);
    await downloadFile(file.download_url, tempPath);
    ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
    await execCommand(`mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
  }
}

/**
 * Fetches example files, shows a multi-select QuickPick, uploads chosen files.
 */
async function uploadExamplesWithPicker(url: string, port: string, sensor: string, ctx: HandlerContext): Promise<void> {
  const headers = await githubHeaders();
  const files: any[] = await new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  const pyFiles = files.filter((f: any) => f.name.endsWith('.py'));
  if (pyFiles.length === 0) {
    vscode.window.showWarningMessage(`No example files found for "${sensor}".`);
    return;
  }

  const items = pyFiles.map((f: any) => ({ label: f.name, picked: true, file: f }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Select examples to download for "${sensor}" (all pre-selected)`,
    title: 'Download Examples',
  });

  if (!selected || selected.length === 0) return;

  for (const item of selected) {
    const uploadName = item.file.name.replace(/-/g, '_');
    const tempPath = path.join(os.tmpdir(), uploadName);
    await downloadFile(item.file.download_url, tempPath);
    ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
    await execCommand(`mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
  }
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
  const headers = await githubHeaders();
  let baseUrl: string | undefined;
  let flatDownloadUrl: string | undefined; // set only for flat-structure modules (e.g. Qwiic)

  // Use cache to narrow down which category to check first
  const cached = getCachedModules(ctx);
  const searchCategories: string[] = [];
  if (cached) {
    for (const [cat, mods] of Object.entries(cached.modules)) {
      if (mods.includes(sensor)) { searchCategories.unshift(cat); break; }
    }
  }
  // append remaining categories as fallback
  for (const cat of categories) {
    if (!searchCategories.includes(cat)) searchCategories.push(cat);
  }

  for (const category of searchCategories) {
    // Try standard deep path: category/module/module/
    const deepUrl = `${REPO_ROOT}/${category}/${sensor}/${sensor}`;
    const deepRes: any = await new Promise((resolve) => {
      https.get(deepUrl, { headers }, resolve).on('error', () => resolve(undefined));
    });
    if (deepRes?.statusCode === 200) {
      baseUrl = deepUrl;
      break;
    }

    // Try flat path: category/module.py (e.g. Qwiic/qwiic.py)
    const categoryListData: string | undefined = await new Promise((resolve) => {
      https.get(`${REPO_ROOT}/${category}`, { headers }, res => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => resolve(data));
      }).on('error', () => resolve(undefined));
    });
    if (categoryListData) {
      try {
        const items = JSON.parse(categoryListData);
        const match = items.find((f: any) =>
          f.type === 'file' && f.name.toLowerCase() === `${sensor.toLowerCase()}.py`
        );
        if (match) {
          baseUrl = `${REPO_ROOT}/${category}`;
          flatDownloadUrl = match.download_url;
          break;
        }
      } catch {}
    }
  }

  if (!baseUrl) {
    vscode.window.showErrorMessage(`Could not find module "${sensor}" in any category.`);
    return;
  }

  try {
    if (mode === 'library' || mode === 'all') {
      if (flatDownloadUrl) {
        // flat module: single .py file directly in category folder
        const uploadName = `${sensor}.py`.replace(/-/g, '_');
        const tempPath = path.join(os.tmpdir(), uploadName);
        await downloadFile(flatDownloadUrl, tempPath);
        ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
        await execCommand(`mpremote connect ${port} fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
      } else {
        await uploadDirectoryFiles(baseUrl, port, ctx);
      }
    }
    if (mode === 'examples' || mode === 'all') {
      if (!flatDownloadUrl) {
        await uploadExamplesWithPicker(`${baseUrl}/Examples`, port, sensor, ctx);
      }
      // flat modules have no examples — skip silently
    }

    vscode.window.showInformationMessage(`Downloaded ${mode} files for "${sensor}"`);
    ctx.postMessage({ command: 'triggerListFiles', port });
    ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'done' });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to fetch module: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] ${err.message}`);
    ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'error' });
  }
}
