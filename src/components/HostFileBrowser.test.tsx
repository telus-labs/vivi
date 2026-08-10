import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { HostFileBrowser } from "./HostFileBrowser";

vi.mock("../lib/api", () => ({
  browseHostDirectory: vi.fn(),
  createHostDirectory: vi.fn(),
}));

const rootListing: api.HostDirectoryListing = {
  root: "/home/andrew",
  path: "/home/andrew",
  parent: null,
  isGit: false,
  truncated: false,
  entries: [
    { name: "code", path: "/home/andrew/code", kind: "directory", isDirectory: true, isGit: false, isHidden: false, isAccessible: true, size: null, modifiedAt: "2026-08-09T00:00:00.000Z" },
    { name: "notes.txt", path: "/home/andrew/notes.txt", kind: "file", isDirectory: false, isGit: false, isHidden: false, isAccessible: true, size: 42, modifiedAt: "2026-08-09T00:00:00.000Z" },
  ],
};

beforeEach(() => {
  vi.mocked(api.browseHostDirectory).mockReset().mockResolvedValue(rootListing);
  vi.mocked(api.createHostDirectory).mockReset();
});

describe("HostFileBrowser", () => {
  it("renders host folders and files in a modal", async () => {
    render(<HostFileBrowser open onClose={() => {}} onSelect={() => {}} />);
    expect(await screen.findByText("code")).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Choose a project folder" })).toBeInTheDocument();
  });

  it("creates a Git project folder and navigates into it", async () => {
    const created: api.HostFileEntry = { name: "vivi-next", path: "/home/andrew/vivi-next", kind: "directory", isDirectory: true, isGit: true, isHidden: false, isAccessible: true, size: null, modifiedAt: "2026-08-09T00:00:00.000Z" };
    vi.mocked(api.createHostDirectory).mockResolvedValue(created);
    vi.mocked(api.browseHostDirectory).mockImplementation(async (path) => path === created.path
      ? { ...rootListing, path: created.path, parent: rootListing.path, isGit: true, entries: [] }
      : rootListing);

    render(<HostFileBrowser open onClose={() => {}} onSelect={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: /new folder/i }));
    fireEvent.change(screen.getByPlaceholderText("project-name"), { target: { value: "vivi-next" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(api.createHostDirectory).toHaveBeenCalledWith("/home/andrew", "vivi-next", true));
    expect(await screen.findByText("Ready to launch")).toBeInTheDocument();
  });

  it("selects only a Git directory", async () => {
    const onSelect = vi.fn();
    vi.mocked(api.browseHostDirectory).mockResolvedValue({ ...rootListing, isGit: true });
    render(<HostFileBrowser open onClose={() => {}} onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole("button", { name: /use folder/i }));
    expect(onSelect).toHaveBeenCalledWith("/home/andrew");
  });
});
