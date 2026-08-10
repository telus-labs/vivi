/**
 * Update checker and applier.
 *
 * Checks the git remote for new commits on the current branch,
 * and applies updates by pulling, reinstalling deps, rebuilding,
 * and restarting the server process.
 */

import { execSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { runtime } from "./runtime.js";

const ROOT = path.resolve(import.meta.dirname, "..");

interface UpdateStatus {
  available: boolean;
  currentCommit: string;
  remoteCommit: string;
  behindCount: number;
  commitMessages: string[];
  supported: boolean;
  reason?: string;
}

let updateInProgress = false;

export function checkForUpdate(): UpdateStatus {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    return {
      available: false,
      currentCommit: "container-image",
      remoteCommit: "container-image",
      behindCount: 0,
      commitMessages: [],
      supported: false,
      reason: "Container releases are updated with `vivi update` on the host.",
    };
  }
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();

  // Fetch latest from origin (silently)
  try {
    execSync(`git fetch origin ${branch}`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 30_000,
    });
  } catch {
    // Fetch failed — network issue, report no update
    const current = execSync("git rev-parse HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    return {
      available: false,
      currentCommit: current,
      remoteCommit: current,
      behindCount: 0,
      commitMessages: [],
      supported: true,
    };
  }

  const currentCommit = execSync("git rev-parse HEAD", {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();

  const remoteCommit = execSync(`git rev-parse origin/${branch}`, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 5_000,
  }).trim();

  if (currentCommit === remoteCommit) {
    return {
      available: false,
      currentCommit,
      remoteCommit,
      behindCount: 0,
      commitMessages: [],
      supported: true,
    };
  }

  // Count commits behind (first-parent only so merge commits from feature
  // branches don't inflate the count — each merged PR counts as one).
  const behindCount = parseInt(
    execSync(`git rev-list --count --first-parent HEAD..origin/${branch}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 5_000,
    }).trim(),
    10,
  );

  // Get commit messages for the new commits (first-parent for same reason)
  const commitMessages = execSync(
    `git log --oneline --first-parent HEAD..origin/${branch}`,
    { cwd: ROOT, encoding: "utf-8", timeout: 5_000 },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  return {
    available: behindCount > 0,
    currentCommit,
    remoteCommit,
    behindCount,
    commitMessages,
    supported: true,
  };
}

export function isUpdateInProgress(): boolean {
  return updateInProgress;
}

export async function applyUpdate(): Promise<void> {
  if (updateInProgress) {
    throw new Error("Update already in progress");
  }

  updateInProgress = true;

  try {
    if (!fs.existsSync(path.join(ROOT, ".git"))) {
      throw new Error("Container releases must be updated with `vivi update` on the host.");
    }
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    console.log("[updater] Pulling latest changes...");
    execSync(`git pull origin ${branch}`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 60_000,
    });

    console.log("[updater] Installing dependencies...");
    execSync("bun install --frozen-lockfile", {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });

    console.log("[updater] Building frontend...");
    execSync("bun run build", {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });

    console.log("[updater] Rebuilding Docker images...");
    try {
      execSync(`${runtime.composeBin} build`, {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 300_000,
      });
    } catch (err: any) {
      console.warn("[updater] Docker compose build warning:", err.message);
      // Non-fatal — proxy image rebuild may fail if Docker isn't available
    }

    console.log("[updater] Update applied. Restarting server...");

    // Schedule restart after response is sent
    setTimeout(() => {
      // Re-execute the current process with the same arguments.
      // process.execArgv contains Node.js options (e.g. --import tsx) that are
      // not included in process.argv, so they must be added back explicitly.
      const args = [...process.execArgv, ...process.argv.slice(1)];
      const child = spawn(process.argv[0], args, {
        cwd: ROOT,
        stdio: "inherit",
        detached: true,
      });
      child.on("error", (err) => {
        console.error("[updater] Failed to restart process:", err);
        process.exit(1);
      });
      child.unref();

      // Exit current process
      process.exit(0);
    }, 500);
  } catch (err) {
    updateInProgress = false;
    throw err;
  }
}
