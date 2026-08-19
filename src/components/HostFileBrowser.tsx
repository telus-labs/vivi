import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft, Check, ChevronRight, Eye, EyeOff, File, Folder, FolderGit2,
  FolderPlus, Link2, Loader2, RefreshCw, Server, X,
} from "lucide-react";
import * as api from "../lib/api";

interface HostFileBrowserProps {
  open: boolean;
  initialPath?: string;
  onClose: () => void;
  onSelect: (path: string) => void;
}

export function HostFileBrowser({ open, initialPath, onClose, onSelect }: HostFileBrowserProps) {
  const [listing, setListing] = useState<api.HostDirectoryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [initializeGit, setInitializeGit] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdMessage, setCreatedMessage] = useState<string | null>(null);
  const newFolderRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (path?: string, hidden = showHidden) => {
    setLoading(true);
    setError(null);
    try {
      setListing(await api.browseHostDirectory(path, hidden));
    } catch (err) {
      if (path) {
        try {
          setListing(await api.browseHostDirectory(undefined, hidden));
          setError("That path is unavailable. Showing the allowed root instead.");
        } catch {
          setError(err instanceof Error ? err.message : "Could not open this folder");
        }
      } else {
        setError(err instanceof Error ? err.message : "Could not open this folder");
      }
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    if (!open) return;
    setCreateOpen(false);
    setCreatedMessage(null);
    load(initialPath || undefined, showHidden);
  }, [open, initialPath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (createOpen) setCreateOpen(false);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, createOpen, onClose]);

  useEffect(() => {
    if (createOpen) window.setTimeout(() => newFolderRef.current?.focus(), 50);
  }, [createOpen]);

  const breadcrumbs = useMemo(() => {
    if (!listing) return [];
    const relative = listing.path.slice(listing.root.length).replace(/\\/g, "/").replace(/^\/+/, "");
    const parts = relative ? relative.split("/") : [];
    const separator = listing.root.includes("\\") ? "\\" : "/";
    return [
      { label: "Home", path: listing.root },
      ...parts.map((part, index) => ({
        label: part,
        path: listing.root + separator + parts.slice(0, index + 1).join(separator),
      })),
    ];
  }, [listing]);

  const handleHiddenToggle = () => {
    const next = !showHidden;
    setShowHidden(next);
    load(listing?.path || initialPath || undefined, next);
  };

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!listing || !newFolderName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createHostDirectory(listing.path, newFolderName, initializeGit);
      setNewFolderName("");
      setCreateOpen(false);
      setCreatedMessage(`${created.name} created`);
      await load(created.path, showHidden);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the folder");
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  const currentName = listing?.path.split(/[\\/]/).filter(Boolean).pop() || "Host files";

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Choose a project folder">
      <div className="host-file-browser flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--color-surface)] sm:h-[min(760px,92dvh)] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-[var(--color-border-bright)] sm:shadow-2xl">
        <header className="shrink-0 border-b border-[var(--color-border)] bg-[#101721] px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6 sm:pt-5">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-400/20 bg-sky-400/10 text-sky-300">
              <Server className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-sky-300/70">Host filesystem</div>
              <h2 className="mt-0.5 truncate text-xl font-semibold tracking-tight text-white">{currentName}</h2>
              <p className="mt-0.5 truncate font-mono text-[11px] text-gray-500">{listing?.path || "Connecting…"}</p>
            </div>
            <button type="button" onClick={onClose} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-white/5 hover:text-white" aria-label="Close file browser">
              <X className="h-5 w-5" />
            </button>
          </div>

          <nav className="mt-3 flex items-center gap-1 overflow-x-auto pb-1" aria-label="Folder breadcrumbs">
            {breadcrumbs.map((crumb, index) => (
              <div key={crumb.path} className="flex shrink-0 items-center gap-1">
                {index > 0 && <ChevronRight className="h-3 w-3 text-gray-600" />}
                <button type="button" onClick={() => load(crumb.path)} className={`rounded-md px-2 py-1 font-mono text-[11px] transition-colors ${index === breadcrumbs.length - 1 ? "bg-white/[0.08] text-gray-200" : "text-gray-500 hover:bg-white/5 hover:text-gray-300"}`}>
                  {crumb.label}
                </button>
              </div>
            ))}
          </nav>
        </header>

        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)]/60 px-3 py-2 sm:px-5">
          <button type="button" disabled={!listing?.parent || loading} onClick={() => listing?.parent && load(listing.parent)} className="flex h-10 items-center gap-2 rounded-lg px-3 text-xs font-medium text-gray-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30">
            <ArrowLeft className="h-4 w-4" /> Up
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} disabled={!listing || loading} className="flex h-10 items-center gap-2 rounded-lg bg-sky-400/10 px-3 text-xs font-semibold text-sky-300 transition-colors hover:bg-sky-400/15 disabled:opacity-30">
            <FolderPlus className="h-4 w-4" /> New folder
          </button>
          <div className="flex-1" />
          <button type="button" onClick={handleHiddenToggle} className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200" aria-label={showHidden ? "Hide dotfiles" : "Show dotfiles"} title={showHidden ? "Hide dotfiles" : "Show dotfiles"}>
            {showHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button type="button" onClick={() => load(listing?.path)} disabled={loading} className="flex h-10 w-10 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-200 disabled:opacity-40" aria-label="Refresh folder">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {createOpen && (
          <form onSubmit={handleCreate} className="shrink-0 border-b border-sky-400/20 bg-sky-400/[0.055] px-4 py-4 sm:px-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-white"><FolderPlus className="h-4 w-4 text-sky-300" /> Create inside {currentName}</div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input ref={newFolderRef} value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="project-name" maxLength={128} className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--color-border-bright)] bg-[#0a0f16] px-3 font-mono text-sm text-white outline-none transition-colors placeholder:text-gray-600 focus:border-sky-400" />
              <div className="flex gap-2">
                <button type="button" onClick={() => setCreateOpen(false)} className="h-11 flex-1 rounded-lg px-4 text-sm text-gray-400 hover:bg-white/5 hover:text-white sm:flex-none">Cancel</button>
                <button type="submit" disabled={!newFolderName.trim() || creating} className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:opacity-40 sm:flex-none">
                  {creating && <Loader2 className="h-4 w-4 animate-spin" />} Create
                </button>
              </div>
            </div>
            <label className="mt-3 flex min-h-10 cursor-pointer items-center gap-3 rounded-lg text-xs text-gray-400">
              <input type="checkbox" checked={initializeGit} onChange={(event) => setInitializeGit(event.target.checked)} className="h-4 w-4 rounded border-gray-600 bg-black accent-sky-500" />
              Initialize Git on <code className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-gray-300">main</code> with an initial commit so Vivi can launch it immediately
            </label>
          </form>
        )}

        {error && (
          <div className="mx-4 mt-3 shrink-0 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300 sm:mx-6">{error}</div>
        )}
        {createdMessage && !error && (
          <div className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 sm:mx-6"><Check className="h-4 w-4" /> {createdMessage}</div>
        )}

        <main className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-4" aria-busy={loading}>
          {loading && !listing ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading host…</div>
          ) : listing?.entries.length === 0 ? (
            <div className="flex h-full min-h-48 flex-col items-center justify-center px-8 text-center">
              <Folder className="h-9 w-9 text-gray-700" />
              <p className="mt-3 text-sm font-medium text-gray-300">This folder is empty</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-600">Create a project folder here, or go back to choose another shelf.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.045]">
              {listing?.entries.map((entry) => (
                <button key={entry.path} type="button" disabled={!entry.isDirectory || !entry.isAccessible} onClick={() => entry.isDirectory && entry.isAccessible && load(entry.path)} className="group flex min-h-[58px] w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.045] disabled:cursor-default disabled:hover:bg-transparent">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${entry.isGit ? "bg-violet-400/10 text-violet-300" : entry.isDirectory ? "bg-sky-400/[0.07] text-sky-300/80" : "bg-white/[0.03] text-gray-600"}`}>
                    {entry.kind === "symlink" ? <Link2 className="h-4 w-4" /> : entry.isGit ? <FolderGit2 className="h-4 w-4" /> : entry.isDirectory ? <Folder className="h-4 w-4" /> : <File className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate font-mono text-[13px] ${entry.isAccessible ? entry.isDirectory ? "text-gray-200" : "text-gray-500" : "text-red-400/70"}`}>{entry.name}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-600">
                      <span>{entry.isDirectory ? entry.isGit ? "Git repository" : "Folder" : formatBytes(entry.size)}</span>
                      {entry.modifiedAt && <><span>·</span><span>{formatDate(entry.modifiedAt)}</span></>}
                      {!entry.isAccessible && <><span>·</span><span>Outside allowed root</span></>}
                    </div>
                  </div>
                  {entry.isGit && <span className="rounded-md border border-violet-400/15 bg-violet-400/[0.07] px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-violet-300/80">git</span>}
                  {entry.isDirectory && entry.isAccessible && <ChevronRight className="h-4 w-4 shrink-0 text-gray-700 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-400" />}
                </button>
              ))}
            </div>
          )}
          {listing?.truncated && <p className="py-3 text-center text-xs text-amber-400/70">Showing the first 2,000 entries.</p>}
        </main>

        <footer className="shrink-0 border-t border-[var(--color-border)] bg-[#101721] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-4">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-medium ${listing?.isGit ? "text-emerald-300" : "text-gray-500"}`}>{listing?.isGit ? "Ready to launch" : "Choose a Git repository"}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-gray-600">{listing?.path}</p>
            </div>
            <button type="button" disabled={!listing?.isGit} onClick={() => listing && onSelect(listing.path)} className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-gray-950 transition-transform hover:-translate-y-px disabled:translate-y-0 disabled:bg-gray-800 disabled:text-gray-600">
              <Check className="h-4 w-4" /> Use folder
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function formatBytes(size: number | null): string {
  if (size === null) return "File";
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  if (size < 1_073_741_824) return `${(size / 1_048_576).toFixed(1)} MB`;
  return `${(size / 1_073_741_824).toFixed(1)} GB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
