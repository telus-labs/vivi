import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { statSync, chmodSync, rmSync, mkdirSync } = vi.hoisted(() => ({
  statSync: vi.fn(),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: { statSync, chmodSync, rmSync, mkdirSync },
  statSync, chmodSync, rmSync, mkdirSync,
}));

vi.mock("./paths.js", () => ({
  paths: () => ({ dataDir: "C:\\vivi\\data" }),
  toHostPath: (value: string) => value.replace("C:\\vivi\\data", "D:\\host\\data"),
}));

import {
  clearCodexAuth,
  getCodexAuthStatus,
  getHostCodexAuthFile,
  secureCodexAuthFile,
} from "./codex-auth.js";

beforeEach(() => {
  vi.clearAllMocks();
  statSync.mockReturnValue({ isFile: () => true, size: 123 });
});

afterEach(() => vi.restoreAllMocks());

describe("Codex account auth", () => {
  it("reports a non-empty auth file and maps it to the host data path", () => {
    expect(getCodexAuthStatus()).toEqual({ authenticated: true });
    expect(getHostCodexAuthFile()).toBe("D:\\host\\data\\codex-auth\\auth.json");
  });

  it("secures and removes only auth.json", () => {
    expect(secureCodexAuthFile()).toBe(true);
    expect(chmodSync).toHaveBeenCalledWith("C:\\vivi\\data\\codex-auth\\auth.json", 0o600);
    clearCodexAuth();
    expect(rmSync).toHaveBeenCalledWith("C:\\vivi\\data\\codex-auth\\auth.json", { force: true });
  });

  it("reports missing auth without throwing", () => {
    statSync.mockImplementation(() => { throw new Error("missing"); });
    expect(getCodexAuthStatus()).toEqual({ authenticated: false });
  });
});
