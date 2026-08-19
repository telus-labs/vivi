import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type HostFileKind = "directory" | "file" | "symlink";

export interface HostFileEntry {
  name: string;
  path: string;
  kind: HostFileKind;
  isDirectory: boolean;
  isGit: boolean;
  isHidden: boolean;
  isAccessible: boolean;
  size: number | null;
  modifiedAt: string | null;
}

export interface HostDirectoryListing {
  root: string;
  path: string;
  parent: string | null;
  isGit: boolean;
  entries: HostFileEntry[];
  truncated: boolean;
}

const MAX_ENTRIES = 2_000;

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function configuredRoot(): string {
  const configured = process.env.VIVI_FILE_BROWSER_ROOT || process.cwd();
  if (!path.isAbsolute(configured)) {
    throw new Error("VIVI_FILE_BROWSER_ROOT must be an absolute path");
  }
  try {
    return fs.realpathSync(configured);
  } catch {
    throw new Error(`File browser root is unavailable: ${configured}`);
  }
}

function expandInput(input: string | undefined, root: string): string {
  const value = (input || "").trim();
  if (!value || value === "~") return root;
  if (value.startsWith("~/") || value.startsWith(`~${path.sep}`)) {
    return path.resolve(root, value.slice(2));
  }
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

function resolveExisting(input: string | undefined, expected: "directory" | "any" = "any"): { root: string; resolved: string } {
  const root = configuredRoot();
  const candidate = expandInput(input, root);
  if (!isWithin(root, candidate)) throw new Error("Path is outside the configured file browser root");

  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`Path does not exist: ${candidate}`);
  }
  if (!isWithin(root, resolved)) throw new Error("Symlink target is outside the configured file browser root");
  if (expected === "directory" && !fs.statSync(resolved).isDirectory()) {
    throw new Error("Path is not a directory");
  }
  return { root, resolved };
}

function isGitDirectory(directory: string): boolean {
  return fs.existsSync(path.join(directory, ".git"));
}

function entryFromDirent(root: string, directory: string, dirent: fs.Dirent): HostFileEntry | null {
  const visiblePath = path.join(directory, dirent.name);
  let kind: HostFileKind = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "directory" : "file";
  let isDirectory = dirent.isDirectory();
  let isAccessible = true;
  let stats: fs.Stats | null = null;

  try {
    const resolved = fs.realpathSync(visiblePath);
    if (!isWithin(root, resolved)) isAccessible = false;
    if (isAccessible) {
      stats = fs.statSync(resolved);
      isDirectory = stats.isDirectory();
    }
  } catch {
    isAccessible = false;
  }

  if (!isAccessible && kind !== "symlink") return null;
  return {
    name: dirent.name,
    path: visiblePath,
    kind,
    isDirectory,
    isGit: isAccessible && isDirectory && isGitDirectory(visiblePath),
    isHidden: dirent.name.startsWith("."),
    isAccessible,
    size: stats && !isDirectory ? stats.size : null,
    modifiedAt: stats ? stats.mtime.toISOString() : null,
  };
}

export function getBrowserRoot(): string {
  return configuredRoot();
}

export function listDirectory(input?: string, showHidden = false): HostDirectoryListing {
  const { root, resolved } = resolveExisting(input, "directory");
  const dirents = fs.readdirSync(resolved, { withFileTypes: true });
  const entries = dirents
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .slice(0, MAX_ENTRIES)
    .map((entry) => entryFromDirent(root, resolved, entry))
    .filter((entry): entry is HostFileEntry => entry !== null)
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });

  return {
    root,
    path: resolved,
    parent: resolved === root ? null : path.dirname(resolved),
    isGit: isGitDirectory(resolved),
    entries,
    truncated: dirents.length > MAX_ENTRIES,
  };
}

export function completeDirectoryPath(input: string): { dir: string; dirIsGit: boolean; results: Array<{ name: string; path: string; isDir: true; isGit: boolean }> } {
  const root = configuredRoot();
  const expanded = expandInput(input, root);
  const wantsChildren = input.endsWith("/") || input.endsWith(path.sep);
  const parentInput = wantsChildren ? expanded : path.dirname(expanded);
  const prefix = wantsChildren ? "" : path.basename(expanded).toLowerCase();
  const { resolved: directory } = resolveExisting(parentInput, "directory");
  const results = listDirectory(directory, prefix.startsWith("."))
    .entries
    .filter((entry) => entry.isDirectory && entry.isAccessible && (!prefix || entry.name.toLowerCase().startsWith(prefix)))
    .map((entry) => ({ name: entry.name, path: entry.path, isDir: true as const, isGit: entry.isGit }));
  return { dir: directory, dirIsGit: isGitDirectory(expanded), results };
}

function configuredOwner(): { uid: number; gid: number } | null {
  const uid = Number(process.env.VIVI_FILE_BROWSER_UID);
  const gid = Number(process.env.VIVI_FILE_BROWSER_GID);
  return Number.isInteger(uid) && uid >= 0 && Number.isInteger(gid) && gid >= 0 ? { uid, gid } : null;
}

function chownTree(target: string, uid: number, gid: number): void {
  const stats = fs.lstatSync(target);
  if (stats.isDirectory()) {
    for (const child of fs.readdirSync(target)) chownTree(path.join(target, child), uid, gid);
  }
  fs.chownSync(target, uid, gid);
}

export function createDirectory(parentInput: string, rawName: string, initializeGit = false): HostFileEntry {
  const name = rawName.trim();
  if (!name || name === "." || name === ".." || name.length > 128 || /[\\/\0]/.test(name)) {
    throw new Error("Folder name must be 1–128 characters and cannot contain slashes");
  }

  const { root, resolved: parent } = resolveExisting(parentInput, "directory");
  const target = path.join(parent, name);
  if (!isWithin(root, target)) throw new Error("New directory would be outside the configured root");
  if (fs.existsSync(target)) throw new Error(`A file or folder named “${name}” already exists`);

  fs.mkdirSync(target, { mode: 0o755 });
  if (initializeGit) {
    try {
      execFileSync("git", ["init", "--initial-branch=main", target], { stdio: "pipe", timeout: 15_000 });
      execFileSync("git", ["-C", target, "-c", "user.name=Vivi", "-c", "user.email=vivi@local", "commit", "--allow-empty", "-m", "Initial commit"], { stdio: "pipe", timeout: 15_000 });
    } catch (error) {
      throw new Error(`Directory was created, but Git initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const owner = configuredOwner();
  if (owner) chownTree(target, owner.uid, owner.gid);
  const entry = entryFromDirent(root, parent, { name, isDirectory: () => true, isFile: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isSymbolicLink: () => false, isFIFO: () => false, isSocket: () => false } as fs.Dirent);
  if (!entry) throw new Error("Directory was created but could not be inspected");
  return entry;
}
