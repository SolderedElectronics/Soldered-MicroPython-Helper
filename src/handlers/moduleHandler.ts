import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { HandlerContext } from '../types';
import { execCommand } from '../utils/execUtils';
import { downloadFile } from './flashHandler';
import { closeAllSerial } from './serialHandler';

const PACKAGES_API_URL = 'https://5jzpvxny0g.execute-api.ap-southeast-2.amazonaws.com/packages';
const CACHE_KEY = 'mp.packagesCache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ALLOWED_STATUSES = ['HUMAN_REVIEWED', 'VALID'];

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

interface RawPackage {
  id: string;
  name: string;
  prettyName?: string;
  author: string;
  description: string;
  url: string;
  tags: string[];
  version: string;
  license: string;
  status: string;
  defaultBranch?: string;
  createdAt: string;
  updatedAt: string;
  submitter: string;
}

export interface PackageInfo extends RawPackage {
  host: 'github' | 'other';
}

interface PackagesCache {
  timestamp: number;
  packages: PackageInfo[];
}

interface ResolvedFile {
  name: string;
  download_url: string;
}

interface ResolvedFiles {
  libraryFiles: ResolvedFile[];
  exampleFiles: ResolvedFile[];
}

interface ParsedGithubUrl {
  owner: string;
  repo: string;
  ref?: string;
  subPath: string;
}

/**
 * GETs a URL and parses the response body as JSON. Rejects on network
 * errors, non-2xx status codes, or unparseable bodies.
 */
function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function getCachedPackages(ctx: HandlerContext): PackagesCache | null {
  const cached = ctx.extensionContext.globalState.get<PackagesCache>(CACHE_KEY);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached;
  }
  return null;
}

async function setCachedPackages(ctx: HandlerContext, packages: PackageInfo[]): Promise<PackagesCache> {
  const cache: PackagesCache = { timestamp: Date.now(), packages };
  await ctx.extensionContext.globalState.update(CACHE_KEY, cache);
  return cache;
}

/**
 * Fetches the full checkmim.com package list, keeping only reviewed/valid
 * entries and tagging each with whether it's GitHub-hosted (the only host
 * we can currently auto-install from).
 */
async function fetchPackages(): Promise<PackageInfo[]> {
  const raw: RawPackage[] = await fetchJson(PACKAGES_API_URL);
  return raw
    .filter(p => ALLOWED_STATUSES.includes(p.status))
    .map(p => ({
      ...p,
      host: /^https:\/\/github\.com\//i.test(p.url || '') ? 'github' as const : 'other' as const,
    }));
}

/**
 * Returns the cached (or freshly fetched) package list to the webview.
 * Pass force: true to bypass the cache.
 */
export async function handleGetPackages(ctx: HandlerContext, message: any = {}): Promise<void> {
  const { force } = message;

  if (!force) {
    const cached = getCachedPackages(ctx);
    if (cached) {
      ctx.postMessage({ command: 'setPackages', packages: cached.packages, cachedAt: cached.timestamp });
      return;
    }
  }

  ctx.postMessage({ command: 'setPackagesLoading' });

  try {
    const packages = await fetchPackages();
    const cache = await setCachedPackages(ctx, packages);
    ctx.postMessage({ command: 'setPackages', packages, cachedAt: cache.timestamp });
  } catch (err: any) {
    ctx.outputChannel.appendLine(`[ERROR] Failed to fetch package list: ${err.message}`);
    ctx.postMessage({ command: 'setPackages', packages: [], cachedAt: 0 });
  }
}

/**
 * Parses a checkmim package's `url` into the GitHub location it should be
 * installed from. Handles repo-root URLs (most third-party packages) and
 * tree-style URLs with an explicit branch/subfolder (e.g. micropython-lib's
 * stdlib packages, which live as subfolders of one monorepo). Returns null
 * for anything not hosted on github.com.
 */
function parseGithubUrl(pkg: PackageInfo): ParsedGithubUrl | null {
  if (!pkg.url) return null;

  let m = pkg.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/i);
  if (m) return { owner: m[1], repo: m[2], ref: m[3], subPath: m[4] };

  m = pkg.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (m) return { owner: m[1], repo: m[2], ref: pkg.defaultBranch, subPath: '' };

  return null;
}

/**
 * Builds a GitHub Contents API URL. Omitting `ref` is intentional (not just
 * a fallback) - the Contents API resolves it to the repo's default branch on
 * its own, so repo-root packages that don't carry a defaultBranch need no
 * extra API round-trip to discover it.
 */
function contentsApiUrl(owner: string, repo: string, subPath: string, ref?: string): string {
  const base = `https://api.github.com/repos/${owner}/${repo}/contents/${subPath}`;
  return ref ? `${base}?ref=${encodeURIComponent(ref)}` : base;
}

/**
 * Ref to use when building raw.githubusercontent.com URLs directly (used
 * for the package.json-manifest path, which doesn't go through the Contents
 * API and so doesn't get its "omit ref = default branch" behavior for free).
 * 'HEAD' is a raw.githubusercontent.com alias for the default branch.
 */
function resolveRawRef(parsed: ParsedGithubUrl): string {
  return parsed.ref || 'HEAD';
}

function buildRawUrl(owner: string, repo: string, ref: string, targetPath: string): string {
  const encodedPath = targetPath.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${encodedPath}`;
}

/**
 * Tries to fetch a package's mip manifest (package.json) - the authoritative
 * file list when present. Returns null if there's no manifest at this
 * location (caller falls back to a plain folder scan), not on any other
 * kind of failure.
 */
async function fetchManifestFiles(
  owner: string, repo: string, subPath: string, ref: string, ctx: HandlerContext
): Promise<ResolvedFiles | null> {
  const manifestPath = subPath ? `${subPath}/package.json` : 'package.json';
  const manifestUrl = buildRawUrl(owner, repo, ref, manifestPath);

  let manifest: any;
  try {
    manifest = await fetchJson(manifestUrl);
  } catch {
    return null;
  }
  if (!manifest || !Array.isArray(manifest.urls)) return null;

  if (Array.isArray(manifest.deps) && manifest.deps.length > 0) {
    ctx.outputChannel.appendLine(
      `[WARN] Package at ${owner}/${repo} declares dependencies (${manifest.deps.join(', ')}) - ` +
      `dependency resolution isn't supported yet, only this package's own files will be installed.`
    );
  }

  const libraryFiles: ResolvedFile[] = [];
  const exampleFiles: ResolvedFile[] = [];

  for (const entry of manifest.urls) {
    const targetPath: string | undefined = Array.isArray(entry) ? entry[0] : undefined;
    if (!targetPath) continue;
    const fullPath = subPath ? `${subPath}/${targetPath}` : targetPath;
    const file: ResolvedFile = {
      name: targetPath.split('/').pop() || targetPath,
      download_url: buildRawUrl(owner, repo, ref, fullPath),
    };
    if (/^examples\//i.test(targetPath)) exampleFiles.push(file);
    else libraryFiles.push(file);
  }

  return { libraryFiles, exampleFiles };
}

/**
 * Fallback for packages with no mip manifest (e.g. micropython-lib's
 * stdlib/extmod packages, which use a build-time manifest.py instead): grabs
 * .py files directly in the folder, plus an "examples" subfolder if present.
 */
async function fetchFolderScanFiles(
  owner: string, repo: string, subPath: string, ref: string | undefined, headers: Record<string, string>
): Promise<ResolvedFiles> {
  const items = await fetchJson(contentsApiUrl(owner, repo, subPath, ref), headers);
  const list = Array.isArray(items) ? items : [];

  const libraryFiles: ResolvedFile[] = list
    .filter((f: any) => f.type === 'file' && f.name.endsWith('.py') && !['manifest.py', 'setup.py'].includes(f.name.toLowerCase()))
    .map((f: any) => ({ name: f.name, download_url: f.download_url }));

  const examplesDir = list.find((f: any) => f.type === 'dir' && f.name.toLowerCase() === 'examples');
  let exampleFiles: ResolvedFile[] = [];
  if (examplesDir) {
    try {
      const exampleSubPath = subPath ? `${subPath}/${examplesDir.name}` : examplesDir.name;
      const exampleItems = await fetchJson(contentsApiUrl(owner, repo, exampleSubPath, ref), headers);
      exampleFiles = (Array.isArray(exampleItems) ? exampleItems : [])
        .filter((f: any) => f.type === 'file' && f.name.endsWith('.py'))
        .map((f: any) => ({ name: f.name, download_url: f.download_url }));
    } catch {
      // No examples reachable - not fatal, library files are still useful.
    }
  }

  return { libraryFiles, exampleFiles };
}

/**
 * Downloads and uploads all .py files in the given list to the device.
 */
async function uploadDirectoryFiles(files: ResolvedFile[], port: string, ctx: HandlerContext): Promise<void> {
  const pyFiles = files.filter(f => f.name.endsWith('.py'));
  if (pyFiles.length === 0) {
    vscode.window.showWarningMessage(`No .py files found.`);
    return;
  }

  for (const file of pyFiles) {
    const uploadName = file.name.replace(/-/g, '_');
    const tempPath = path.join(os.tmpdir(), uploadName);
    await downloadFile(file.download_url, tempPath);
    ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
    await execCommand(`mpremote connect "${port}" fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
  }
}

/**
 * Shows a multi-select QuickPick over the given example files, uploads
 * chosen ones.
 */
async function uploadExamplesWithPicker(files: ResolvedFile[], port: string, packageLabel: string, ctx: HandlerContext): Promise<void> {
  const pyFiles = files.filter(f => f.name.endsWith('.py'));
  if (pyFiles.length === 0) {
    vscode.window.showWarningMessage(`No example files found for "${packageLabel}".`);
    return;
  }

  const items = pyFiles.map(f => ({ label: f.name, picked: true, file: f }));
  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `Select examples to download for "${packageLabel}" (all pre-selected)`,
    title: 'Download Examples',
  });

  if (!selected || selected.length === 0) return;

  for (const item of selected) {
    const uploadName = item.file.name.replace(/-/g, '_');
    const tempPath = path.join(os.tmpdir(), uploadName);
    await downloadFile(item.file.download_url, tempPath);
    ctx.outputChannel.appendLine(`Uploading ${uploadName}`);
    await execCommand(`mpremote connect "${port}" fs cp "${tempPath}" :"${uploadName}"`, ctx.outputChannel);
  }
}

/**
 * Fetches a checkmim package (library/examples/both) and uploads it to the
 * device.
 */
export async function handleFetchModule(ctx: HandlerContext, message: any): Promise<void> {
  const { packageId, port, mode } = message;

  await closeAllSerial(ctx);

  if (!packageId || !port) {
    vscode.window.showErrorMessage('Package and port are required.');
    return;
  }

  let packages = getCachedPackages(ctx)?.packages;
  if (!packages) {
    try {
      packages = await fetchPackages();
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to fetch package list: ${err.message}`);
      return;
    }
  }

  const pkg = packages.find(p => p.id === packageId);
  if (!pkg) {
    vscode.window.showErrorMessage(`Could not find package "${packageId}".`);
    return;
  }
  const label = pkg.prettyName || pkg.name;

  if (pkg.host !== 'github') {
    vscode.window.showErrorMessage(`"${label}" is hosted outside GitHub and can't be auto-installed yet. Open it manually: ${pkg.url}`);
    return;
  }

  const parsed = parseGithubUrl(pkg);
  if (!parsed) {
    vscode.window.showErrorMessage(`Could not determine where to fetch "${label}" from.`);
    return;
  }

  const ref = resolveRawRef(parsed);
  const headers = await githubHeaders();

  let resolved: ResolvedFiles | null = await fetchManifestFiles(parsed.owner, parsed.repo, parsed.subPath, ref, ctx);
  if (!resolved) {
    try {
      resolved = await fetchFolderScanFiles(parsed.owner, parsed.repo, parsed.subPath, parsed.ref, headers);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to fetch package "${label}": ${err.message}`);
      return;
    }
  }

  try {
    if (mode === 'library' || mode === 'all') {
      await uploadDirectoryFiles(resolved.libraryFiles, port, ctx);
    }
    if (mode === 'examples' || mode === 'all') {
      if (resolved.exampleFiles.length > 0) {
        await uploadExamplesWithPicker(resolved.exampleFiles, port, label, ctx);
      }
      // no examples for this package - skip silently, same as before
    }

    vscode.window.showInformationMessage(`Downloaded ${mode} files for "${label}"`);
    ctx.postMessage({ command: 'triggerListFiles', port });
    ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'done' });
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to fetch module: ${err.message}`);
    ctx.outputChannel.appendLine(`[ERROR] ${err.message}`);
    ctx.postMessage({ command: 'moduleFetchStatus', mode, status: 'error' });
  }
}
