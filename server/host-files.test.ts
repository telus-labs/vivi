import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeDirectoryPath, createDirectory, listDirectory } from "./host-files.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vivi-host-files-"));
  vi.stubEnv("VIVI_FILE_BROWSER_ROOT", root);
  vi.stubEnv("VIVI_FILE_BROWSER_UID", "");
  vi.stubEnv("VIVI_FILE_BROWSER_GID", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("host file browser", () => {
  it("lists directories before files and hides dotfiles by default", () => {
    fs.mkdirSync(path.join(root, "z-project"));
    fs.mkdirSync(path.join(root, "a-project"));
    fs.mkdirSync(path.join(root, ".private"));
    fs.writeFileSync(path.join(root, "notes.txt"), "hello");
    fs.mkdirSync(path.join(root, "a-project", ".git"));

    const listing = listDirectory(root);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a-project", "z-project", "notes.txt"]);
    expect(listing.entries[0]).toMatchObject({ isDirectory: true, isGit: true });
    expect(listDirectory(root, true).entries.some((entry) => entry.name === ".private")).toBe(true);
  });

  it("rejects paths outside the configured root", () => {
    expect(() => listDirectory(path.dirname(root))).toThrow("outside the configured file browser root");
    expect(() => listDirectory(path.join(root, ".."))).toThrow("outside the configured file browser root");
  });

  it("creates a selectable Git directory without recursive mkdir semantics", () => {
    const created = createDirectory(root, "fresh project", true);
    expect(created).toMatchObject({ name: "fresh project", isDirectory: true, isGit: true });
    expect(fs.existsSync(path.join(root, "fresh project", ".git"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "fresh project", ".git", "HEAD"), "utf8")).toContain("refs/heads/main");
    expect(() => createDirectory(root, "fresh project", false)).toThrow("already exists");
    expect(() => createDirectory(root, "../escape", false)).toThrow("cannot contain slashes");
  });

  it("completes directory prefixes within the root", () => {
    fs.mkdirSync(path.join(root, "alpha"));
    fs.mkdirSync(path.join(root, "alpine"));
    fs.mkdirSync(path.join(root, "beta"));

    const result = completeDirectoryPath(path.join(root, "al"));
    expect(result.results.map((entry) => entry.name)).toEqual(["alpha", "alpine"]);
  });
});
