/** Host-managed Codex account authentication. */

import fs from "node:fs";
import path from "node:path";
import { paths, toHostPath } from "./paths.js";

const AUTH_DIR_NAME = "codex-auth";
const AUTH_FILE_NAME = "auth.json";

export interface CodexAuthStatus {
  authenticated: boolean;
}

export function getCodexAuthDir(): string {
  const dir = path.join(paths().dataDir, AUTH_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on Windows */ }
  return dir;
}

export function getCodexAuthFile(): string {
  return path.join(getCodexAuthDir(), AUTH_FILE_NAME);
}

export function getHostCodexAuthFile(): string {
  return toHostPath(getCodexAuthFile());
}

export function getCodexAuthStatus(): CodexAuthStatus {
  try {
    const stat = fs.statSync(getCodexAuthFile());
    return { authenticated: stat.isFile() && stat.size > 0 };
  } catch {
    return { authenticated: false };
  }
}

export function secureCodexAuthFile(): boolean {
  const authFile = getCodexAuthFile();
  try {
    const stat = fs.statSync(authFile);
    if (!stat.isFile() || stat.size === 0) return false;
    try { fs.chmodSync(authFile, 0o600); } catch { /* best effort on Windows */ }
    return true;
  } catch {
    return false;
  }
}

export function clearCodexAuth(): void {
  try { fs.rmSync(getCodexAuthFile(), { force: true }); } catch (error: any) {
    throw new Error(`Unable to remove Codex authentication: ${error.message}`);
  }
}
