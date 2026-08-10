import { useState, useEffect, useCallback, useRef } from "react";
import { UserCircle, Plus, Trash2 } from "lucide-react";
import type { AgentId, Profile } from "../lib/types";
import * as api from "../lib/api";

export function ProfileManager() {
  const [profileList, setProfileList] = useState<Profile[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string; agentId: AgentId }>({ name: "", description: "", agentId: "codex" });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); }, []);

  const refresh = useCallback(async () => {
    try {
      setProfileList(await api.listProfiles());
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await api.createProfile({ name: form.name.trim(), description: form.description.trim() || undefined, agentId: form.agentId });
      setForm({ name: "", description: "", agentId: "codex" });
      setShowForm(false);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmingId !== id) {
      setConfirmingId(id);
      confirmTimer.current = setTimeout(() => setConfirmingId(null), 3000);
      return;
    }
    setConfirmingId(null);
    setError(null);
    try {
      await api.deleteProfile(id);
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleToggleAutoSave = async (profile: Profile) => {
    try {
      await api.updateProfile(profile.id, { autoSave: !profile.autoSave });
      refresh();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCircle className="w-4 h-4 text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold">Agent Profiles</h2>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] text-white rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New
        </button>
      </div>

      <p className="text-xs text-gray-400">
        Profiles persist settings and history from <code className="font-mono">~/.claude</code> or <code className="font-mono">~/.codex</code> across sessions.
      </p>

      {error && (
        <div className="px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">{error}</div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="space-y-2 p-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
          <select
            value={form.agentId}
            onChange={(e) => setForm({ ...form, agentId: e.target.value as AgentId })}
            className="w-full px-3 py-1.5 text-sm bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none"
          >
            <option value="codex">OpenAI Codex</option>
            <option value="claude">Claude Code</option>
          </select>
          <input
            autoFocus
            required
            placeholder="Profile name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full px-3 py-1.5 text-sm bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none"
          />
          <input
            placeholder="Description (optional)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-1.5 text-sm bg-[var(--color-surface-raised)] border border-[var(--color-border)] rounded focus:border-[var(--color-accent)] focus:outline-none"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={creating} className="px-3 py-1 text-xs bg-[var(--color-accent-muted)] hover:bg-[var(--color-accent)] disabled:opacity-50 text-white rounded transition-colors">
              {creating ? "Creating..." : "Create"}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="px-3 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors">
              Cancel
            </button>
          </div>
        </form>
      )}

      {profileList.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-6">No profiles yet. Create one to persist agent state between sessions.</p>
      ) : (
        <div className="space-y-1.5">
          {profileList.map((p) => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2.5 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-lg">
              <UserCircle className="w-4 h-4 text-gray-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500">{p.agentId === "codex" ? "OpenAI Codex" : "Claude Code"}</div>
                {p.description && <div className="text-xs text-gray-400 truncate">{p.description}</div>}
                {p.lastUsedAt && <div className="text-xs text-gray-500">Last used {new Date(p.lastUsedAt).toLocaleDateString()}</div>}
              </div>
              <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer shrink-0" title={`Auto-save ~/.${p.agentId} on session stop`}>
                <input
                  type="checkbox"
                  checked={p.autoSave}
                  onChange={() => handleToggleAutoSave(p)}
                  className="accent-[var(--color-accent)]"
                />
                auto-save
              </label>
              <button
                onClick={() => handleDelete(p.id)}
                onBlur={() => setConfirmingId(null)}
                className={
                  confirmingId === p.id
                    ? "px-1 py-0.5 text-xs font-medium text-red-400 hover:text-red-300 transition-colors shrink-0"
                    : "p-1 text-gray-500 hover:text-red-400 transition-colors shrink-0"
                }
                title={confirmingId === p.id ? "Click again to delete" : "Delete profile"}
              >
                {confirmingId === p.id ? "Confirm?" : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
