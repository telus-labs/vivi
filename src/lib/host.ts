import { getConfig } from "./api";

let cachedHost: string | null = null;
let fetchPromise: Promise<string> | null = null;

/**
 * Clear the host cache so the next fetchHost() call re-fetches from the server.
 * Used when switching backends.
 */
export function resetHostCache(): void {
  cachedHost = null;
  fetchPromise = null;
}

/**
 * Fetch the configured HOST from the server (cached after first call).
 * Falls back to "localhost" on error.
 */
export async function fetchHost(): Promise<string> {
  if (cachedHost !== null) return cachedHost;
  if (fetchPromise) return fetchPromise;

  fetchPromise = getConfig()
    .then((cfg) => {
      cachedHost = cfg.host;
      return cachedHost;
    })
    .catch((err) => {
      console.warn("fetchHost: failed to fetch config, defaulting to localhost", err);
      // Don't cache the fallback — let the next call retry once the backend is reachable.
      fetchPromise = null;
      return "localhost";
    });

  return fetchPromise;
}

/**
 * Build a git remote URL for a forwarded port.
 */
export function gitRemoteUrl(host: string, hostPort: number): string {
  return `git://${host}:${hostPort}/`;
}
