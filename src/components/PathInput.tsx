import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Folder, FolderGit2, FolderOpen } from "lucide-react";
import * as api from "../lib/api";
import { HostFileBrowser } from "./HostFileBrowser";

interface PathInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function PathInput({ value, onChange, placeholder, className }: PathInputProps) {
  const [suggestions, setSuggestions] = useState<api.FsEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dirIsGit, setDirIsGit] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextFetch = useRef(false);
  const requestIdRef = useRef(0);

  const fetchSuggestions = useCallback(async (path: string) => {
    if (!path) {
      requestIdRef.current++;
      setSuggestions([]);
      setDirIsGit(false);
      setOpen(false);
      return;
    }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const { results, dirIsGit: isGit } = await api.completePath(path);
      if (requestId !== requestIdRef.current) return;
      setSuggestions(results);
      setDirIsGit(isGit);
      setSelectedIdx(0);
      setOpen(!isGit && results.length > 0);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setSuggestions([]);
      setDirIsGit(false);
      setOpen(false);
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    if (skipNextFetch.current) {
      skipNextFetch.current = false;
      return;
    }
    fetchTimer.current = setTimeout(() => fetchSuggestions(value), 100);
    return () => { if (fetchTimer.current) clearTimeout(fetchTimer.current); };
  }, [value, fetchSuggestions]);

  useEffect(() => {
    const item = listRef.current?.children[selectedIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const accept = (entry: api.FsEntry) => {
    const newPath = entry.path + "/";
    skipNextFetch.current = true;
    onChange(newPath);
    fetchSuggestions(newPath);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) {
      if (event.key === "Tab") {
        event.preventDefault();
        fetchSuggestions(value);
      }
      if (event.key === "ArrowDown" && suggestions.length > 0) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIdx((index) => Math.min(index + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIdx((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      accept(suggestions[selectedIdx]);
    } else if (event.key === "Escape") {
      setOpen(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      if (suggestions.length === 1) {
        accept(suggestions[0]);
      } else {
        const prefix = longestCommonPrefix(suggestions.map((entry) => entry.path));
        if (prefix.length > value.replace(/\/$/, "").length) {
          skipNextFetch.current = true;
          onChange(prefix);
          fetchSuggestions(prefix);
        } else {
          accept(suggestions[selectedIdx]);
        }
      }
    }
  };

  return (
    <div className="relative">
      <FolderGit2 className="absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-gray-500" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (suggestions.length > 0 && !dirIsGit) setOpen(true); }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={className}
        style={{ paddingRight: dirIsGit && value ? "8.5rem" : "3.25rem" }}
      />

      {dirIsGit && value && (
        <div className="absolute right-11 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-md border border-green-500/30 bg-green-500/15 px-2 py-0.5">
          <Check className="h-3.5 w-3.5 text-green-400" />
          <span className="text-[10px] font-medium text-green-400">Git repo</span>
        </div>
      )}
      <button type="button" onClick={() => { setOpen(false); setPickerOpen(true); }} className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-[var(--color-surface-raised)] hover:text-white" title="Browse host" aria-label="Browse host folders">
        <FolderOpen className="h-4 w-4" />
      </button>
      {loading && !dirIsGit && (
        <div className="absolute right-11 top-1/2 h-3 w-3 -translate-y-1/2 animate-spin rounded-full border border-gray-500 border-t-gray-300" />
      )}

      {open && suggestions.length > 0 && (
        <div ref={listRef} className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-overlay)] shadow-xl">
          {suggestions.map((entry, index) => (
            <button key={entry.path} type="button" onMouseDown={(event) => { event.preventDefault(); accept(entry); }} onMouseEnter={() => setSelectedIdx(index)} className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${index === selectedIdx ? "bg-[var(--color-accent-muted)] text-white" : "text-gray-300 hover:bg-[var(--color-surface-raised)]"}`}>
              {entry.isGit ? <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-gray-500" />}
              <span className="truncate font-mono">{entry.name}/</span>
              {entry.isGit && <span className="ml-auto shrink-0 rounded bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] text-[var(--color-accent)]">git</span>}
            </button>
          ))}
        </div>
      )}

      <HostFileBrowser
        open={pickerOpen}
        initialPath={value || undefined}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          skipNextFetch.current = true;
          onChange(path);
          setDirIsGit(true);
          setSuggestions([]);
          setOpen(false);
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

function longestCommonPrefix(strings: string[]): string {
  if (strings.length === 0) return "";
  let prefix = strings[0];
  for (let index = 1; index < strings.length; index++) {
    while (!strings[index].startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
      if (!prefix) return "";
    }
  }
  return prefix;
}
