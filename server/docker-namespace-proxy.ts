/**
 * Per-session Docker socket proxy.
 *
 * Each sandbox session gets its own Unix socket at /tmp/docker-ns-{sessionId}.sock.
 * That socket is bind-mounted into the sandbox container as /var/run/docker.sock,
 * so the sandbox can run docker commands without direct access to the dind daemon.
 *
 * The proxy enforces session namespacing:
 *   - POST /containers/create        → injects vivi.session=<id> label; rejects
 *                                       escape-prone HostConfig (see validateHostConfig)
 *   - GET  /containers/json          → scopes the list to this session's label
 *   - /containers/<id>/* and DELETE  → verified to belong to this session before
 *     /containers/<id>                forwarding (defense-in-depth if an id leaks)
 *   - Everything else                → piped through unchanged
 *
 * Security model: the sandbox network is internal (no internet access), so sandbox
 * containers cannot reach dind directly — they can only speak Docker through this proxy.
 *
 * Known shared surface (single dind daemon): the image cache and any agent-created
 * volumes/networks are NOT namespaced per session. See docs/infra-limitations.md.
 */

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync, exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { runtime } from "./runtime.js";
import { paths } from "./paths.js";

const execAsync = promisify(exec);

// When the app runs inside a container on a user-defined bridge network
// (e.g. compose), DIND is reachable via its service hostname, not on the
// app's loopback. Allow the compose file / operator to override.
const DIND_HOST = process.env.DIND_HOST || "127.0.0.1";
const DIND_PORT = Number(process.env.DIND_PORT) || 2375;
const SOCKET_DIR = paths().socketsDir;
export const SESSION_LABEL = "vivi.session";

// TCP port range for per-session proxies (used when Podman can't mount sockets)
const TCP_PROXY_PORT_START = 18000;
const TCP_PROXY_PORT_MAX = 18999;
const allocatedTcpPorts = new Set<number>();

const activeProxies = new Map<string, net.Server>();

export interface SessionProxyInfo {
  /** "socket" for Docker (bind-mount), "tcp" for Podman (DOCKER_HOST env var) */
  mode: "socket" | "tcp";
  /** Socket path (mode=socket) or TCP port (mode=tcp) */
  socketPath?: string;
  tcpPort?: number;
}

const sessionProxyInfo = new Map<string, SessionProxyInfo>();

function allocateTcpPort(): number {
  for (let port = TCP_PROXY_PORT_START; port <= TCP_PROXY_PORT_MAX; port++) {
    if (!allocatedTcpPorts.has(port)) {
      allocatedTcpPorts.add(port);
      return port;
    }
  }
  throw new Error("No available TCP ports for Docker namespace proxy");
}

export function getSessionSocketPath(sessionId: string): string {
  return path.join(SOCKET_DIR, `docker-ns-${sessionId}.sock`);
}

export function getSessionProxyInfo(sessionId: string): SessionProxyInfo | undefined {
  return sessionProxyInfo.get(sessionId);
}

export function startSessionProxy(sessionId: string): Promise<SessionProxyInfo> {
  const useTcp = runtime.bin === "podman";

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      handleConnection(client, sessionId);
    });

    server.on("error", (err) => {
      console.error(`[docker-proxy:${sessionId}] Error:`, err.message);
      reject(err);
    });

    if (useTcp) {
      const port = allocateTcpPort();
      server.listen(port, "127.0.0.1", () => {
        console.log(`[docker-proxy:${sessionId}] Listening on tcp://127.0.0.1:${port}`);
        activeProxies.set(sessionId, server);
        const info: SessionProxyInfo = { mode: "tcp", tcpPort: port };
        sessionProxyInfo.set(sessionId, info);
        resolve(info);
      });
    } else {
      const socketPath = getSessionSocketPath(sessionId);
      try { fs.unlinkSync(socketPath); } catch {
        // Socket file may not exist yet — expected on first start
      }
      server.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o666); } catch (err: any) {
          console.warn(`[docker-proxy:${sessionId}] Failed to chmod socket: ${err.message}`);
        }
        console.log(`[docker-proxy:${sessionId}] Listening on ${socketPath}`);
        activeProxies.set(sessionId, server);
        const info: SessionProxyInfo = { mode: "socket", socketPath };
        sessionProxyInfo.set(sessionId, info);
        resolve(info);
      });
    }
  });
}

export function stopSessionProxy(sessionId: string): void {
  const server = activeProxies.get(sessionId);
  if (server) {
    server.close();
    activeProxies.delete(sessionId);
  }
  const info = sessionProxyInfo.get(sessionId);
  if (info?.mode === "socket" && info.socketPath) {
    try { fs.unlinkSync(info.socketPath); } catch {
      // Socket file may already be removed
    }
  }
  if (info?.mode === "tcp" && info.tcpPort) {
    allocatedTcpPorts.delete(info.tcpPort);
  }
  sessionProxyInfo.delete(sessionId);
}

export function cleanupSessionContainers(sessionId: string): void {
  try {
    const ids = execSync(
      `${runtime.bin} -H tcp://${DIND_HOST}:${DIND_PORT} ps -aq --filter label=${SESSION_LABEL}=${sessionId}`,
      { encoding: "utf-8", timeout: 10_000, stdio: "pipe" },
    ).trim();
    if (ids) {
      execSync(
        `${runtime.bin} -H tcp://${DIND_HOST}:${DIND_PORT} rm -f ${ids}`,
        { stdio: "pipe", timeout: 15_000 },
      );
      console.log(`[docker-proxy:${sessionId}] Removed dind containers for session`);
    }
  } catch (err: any) {
    // dind may not be running, or session had no containers
    console.warn(`[docker-proxy:${sessionId}] Failed to clean up dind containers: ${err.message}`);
  }
}

export async function listSessionContainers(sessionId: string): Promise<DockerContainerInfo[]> {
  try {
    const { stdout } = await execAsync(
      `${runtime.bin} -H tcp://${DIND_HOST}:${DIND_PORT} ps -a --filter label=${SESSION_LABEL}=${sessionId} --format "{{json .}}"`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    const out = stdout.trim();
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const r = JSON.parse(line);
        return {
          id: r.ID,
          name: (r.Names || "").replace(/^\//, ""),
          image: r.Image,
          status: r.Status,
          state: r.State,
          ports: r.Ports || "",
          createdAt: r.CreatedAt,
        };
      });
  } catch (err: any) {
    // DinD may not be running or session has no containers
    console.warn(`[docker-proxy] Failed to list containers for session ${sessionId}: ${err.message}`);
    return [];
  }
}

export interface DockerContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
}

/**
 * Inspect a container, returning the full Docker inspect JSON.
 * Validates that the container belongs to the given session (label check).
 */
export async function inspectContainer(
  sessionId: string,
  containerId: string,
): Promise<Record<string, any>> {
  // Sanitize containerId to prevent injection
  const safeId = containerId.replace(/[^a-zA-Z0-9_.-]/g, "");
  const { stdout } = await execAsync(
    `${runtime.bin} -H tcp://${DIND_HOST}:${DIND_PORT} inspect ${safeId}`,
    { encoding: "utf-8", timeout: 10_000 },
  );
  const arr = JSON.parse(stdout);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error("Container not found");
  }
  const info = arr[0];
  // Security: verify session ownership
  const label = info.Config?.Labels?.[SESSION_LABEL];
  if (label !== sessionId) {
    throw new Error("Container does not belong to this session");
  }
  return info;
}

/**
 * Stream logs from a container. Returns the spawned child process.
 * Caller should listen on stdout/stderr and kill when done.
 * Validates session ownership before streaming.
 */
export async function streamContainerLogs(
  sessionId: string,
  containerId: string,
  tail: number = 200,
): Promise<ChildProcess> {
  // Validate ownership first
  const safeId = containerId.replace(/[^a-zA-Z0-9_.-]/g, "");
  const { stdout } = await execAsync(
    `${runtime.bin} -H tcp://${DIND_HOST}:${DIND_PORT} inspect --format '{{index .Config.Labels "${SESSION_LABEL}"}}' ${safeId}`,
    { encoding: "utf-8", timeout: 5_000 },
  );
  if (stdout.trim() !== sessionId) {
    throw new Error("Container does not belong to this session");
  }

  const proc = spawn(runtime.bin, [
    "-H", `tcp://${DIND_HOST}:${DIND_PORT}`,
    "logs", "--follow", "--timestamps", "--tail", String(tail),
    safeId,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  return proc;
}

// ---------------------------------------------------------------------------
// HostConfig validation — reject container creates that could escape the
// dind boundary or escalate to the dind daemon itself.
// ---------------------------------------------------------------------------

// Bind/mount sources that hand a nested container control of the daemon or the
// dind host filesystem. Mounting the docker socket is a full escape (the nested
// container talks to dind directly, bypassing this proxy).
const FORBIDDEN_MOUNT_SOURCES = [
  /docker\.sock$/i,
  /^\/var\/run(\/|$)/,
  /^\/run(\/|$)/,
  /^\/proc(\/|$)/,
  /^\/sys(\/|$)/,
  /^\/dev(\/|$)/,
  /^\/var\/lib\/docker(\/|$)/,
  /^\/etc(\/|$)/,
  /^\/$/,
];

function isForbiddenMountSource(src: string): boolean {
  const s = (src || "").trim();
  if (!s) return false;
  return FORBIDDEN_MOUNT_SOURCES.some((re) => re.test(s));
}

export interface HostConfigVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * Decide whether a `POST /containers/create` body is safe to run inside the
 * shared dind daemon. Default-deny on the known escape/escalation vectors;
 * everything else (ordinary images, named volumes, port maps) is allowed.
 */
export function validateHostConfig(bodyObj: any): HostConfigVerdict {
  const hc = bodyObj?.HostConfig ?? {};

  if (hc.Privileged) return { allowed: false, reason: "privileged containers are not allowed" };
  if (Array.isArray(hc.CapAdd) && hc.CapAdd.length > 0)
    return { allowed: false, reason: "adding Linux capabilities (--cap-add) is not allowed" };
  if (Array.isArray(hc.Devices) && hc.Devices.length > 0)
    return { allowed: false, reason: "device passthrough (--device) is not allowed" };

  for (const mode of ["PidMode", "NetworkMode", "IpcMode", "UTSMode", "UsernsMode", "CgroupnsMode"] as const) {
    const v = hc[mode];
    if (typeof v === "string" && (v === "host" || v.startsWith("host:")))
      return { allowed: false, reason: `${mode}=host is not allowed` };
  }

  if (Array.isArray(hc.SecurityOpt)) {
    for (const opt of hc.SecurityOpt) {
      const o = String(opt).toLowerCase().replace(/\s/g, "");
      if (o.includes("seccomp=unconfined") || o.includes("apparmor=unconfined") ||
          o.includes("systempaths=unconfined") || o === "label=disable")
        return { allowed: false, reason: `security-opt "${opt}" is not allowed` };
    }
  }

  // Legacy string binds: "src:dst[:opts]"
  if (Array.isArray(hc.Binds)) {
    for (const bind of hc.Binds) {
      const src = String(bind).split(":")[0];
      if (isForbiddenMountSource(src))
        return { allowed: false, reason: `bind mount of "${src}" is not allowed` };
    }
  }

  // Newer Mounts API: [{ Type, Source, Target }]
  if (Array.isArray(hc.Mounts)) {
    for (const m of hc.Mounts) {
      if ((m?.Type === "bind" || !m?.Type) && isForbiddenMountSource(m?.Source))
        return { allowed: false, reason: `bind mount of "${m?.Source}" is not allowed` };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Per-container endpoint namespacing
// ---------------------------------------------------------------------------

// Matches /v1.43/containers/<id>/<op> and bare /v1.43/containers/<id>.
// Returns the <id> for ownership-checked ops, or null for collection endpoints
// (create/json/prune) and non-container paths.
const CONTAINER_SCOPED_RE = /^\/v[\d.]+\/containers\/([^/?]+)(?:\/[^?]*)?(?:\?.*)?$/;
const CONTAINER_COLLECTION_IDS = new Set(["create", "json", "prune"]);

export function parseContainerScopedId(urlPath: string): string | null {
  const m = CONTAINER_SCOPED_RE.exec(urlPath);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  if (CONTAINER_COLLECTION_IDS.has(id)) return null;
  return id;
}

/**
 * Look up the vivi.session label of a dind container by id/name.
 * Returns the label value, or null if the container is missing/unlabeled/unreachable.
 */
function lookupContainerSession(id: string): Promise<string | null> {
  return new Promise((resolve) => {
    const safeId = encodeURIComponent(id);
    const req = http.get(
      { host: DIND_HOST, port: DIND_PORT, path: `/containers/${safeId}/json`, timeout: 5_000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          try {
            const info = JSON.parse(data);
            resolve(info?.Config?.Labels?.[SESSION_LABEL] ?? null);
          } catch { resolve(null); }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function denyRequest(client: net.Socket, upstream: net.Socket, status: number, message: string): void {
  const body = JSON.stringify({ message });
  client.write(
    `HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Error"}\r\n` +
    `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  client.end();
  upstream.destroy();
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

function handleConnection(client: net.Socket, sessionId: string): void {
  const upstream = net.connect(DIND_PORT, DIND_HOST);

  upstream.on("data", (chunk) => client.write(chunk));
  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());

  // Re-enter header-listening mode to handle HTTP keep-alive connections.
  // The Docker CLI reuses a single TCP connection for multiple requests
  // (e.g. HEAD /_ping then POST /containers/create), so we must intercept
  // each request individually rather than switching to pass-through after
  // the first one.
  const listenForNextRequest = (initial?: Buffer) => {
    let buf = initial ?? Buffer.alloc(0);

    const headerListener = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return; // still collecting headers

      client.removeListener("data", headerListener);

      const headerSection = buf.slice(0, sep).toString("utf-8");
      const rest = buf.slice(sep + 4);
      const lines = headerSection.split("\r\n");
      const firstLine = lines[0] ?? "";
      const spaceIdx = firstLine.indexOf(" ");
      const method = firstLine.slice(0, spaceIdx).toUpperCase();
      const urlPath = firstLine.slice(spaceIdx + 1, firstLine.lastIndexOf(" "));

      const scopedId =
        method !== "POST" || !/^\/v[\d.]+\/containers\/create/.test(urlPath)
          ? parseContainerScopedId(urlPath)
          : null;

      if (method === "POST" && /^\/v[\d.]+\/containers\/create/.test(urlPath)) {
        interceptContainerCreate(client, upstream, listenForNextRequest, lines, rest, sessionId);
      } else if (method === "GET" && /^\/v[\d.]+\/containers\/json/.test(urlPath)) {
        const newPath = injectLabelFilter(urlPath, `${SESSION_LABEL}=${sessionId}`);
        const newHeader = `GET ${newPath} ${firstLine.slice(firstLine.lastIndexOf(" ") + 1)}\r\n`
          + lines.slice(1).join("\r\n") + "\r\n\r\n";
        upstream.write(newHeader);
        // GET has no request body — continue listening with leftover data
        listenForNextRequest(rest.length ? rest : undefined);
      } else if (scopedId !== null) {
        handleContainerScoped(client, upstream, listenForNextRequest, lines, rest, sessionId, scopedId);
      } else {
        // Non-intercepted request — forward headers and consume body (if any)
        // before re-entering listen mode for the next request.
        upstream.write(buf.slice(0, sep + 4));
        const clLine = lines.find((l) => /^content-length:/i.test(l));
        const contentLength = clLine ? parseInt(clLine.split(":")[1].trim(), 10) : 0;
        if (contentLength === 0) {
          listenForNextRequest(rest.length ? rest : undefined);
        } else {
          forwardBodyThenListen(client, upstream, rest, contentLength, listenForNextRequest);
        }
      }
    };

    // Process any buffered data immediately
    if (buf.length > 0) {
      headerListener(Buffer.alloc(0));
    }

    client.on("data", headerListener);
  };

  listenForNextRequest();
}

/**
 * Forward exactly `contentLength` bytes of request body to upstream,
 * then re-enter header-listening mode with any leftover data.
 */
function forwardBodyThenListen(
  client: net.Socket,
  upstream: net.Socket,
  initial: Buffer,
  contentLength: number,
  onDone: (leftover?: Buffer) => void,
): void {
  let received = initial;

  const flush = () => {
    if (received.length < contentLength) return;
    client.removeListener("data", bodyListener);

    upstream.write(received.slice(0, contentLength));
    const extra = received.slice(contentLength);
    onDone(extra.length ? extra : undefined);
  };

  const bodyListener = (chunk: Buffer) => {
    received = Buffer.concat([received, chunk]);
    flush();
  };

  client.on("data", bodyListener);
  flush();
}

function interceptContainerCreate(
  client: net.Socket,
  upstream: net.Socket,
  onDone: (leftover?: Buffer) => void,
  headerLines: string[],
  rest: Buffer,
  sessionId: string,
): void {
  const clLine = headerLines.find((l) => /^content-length:/i.test(l));
  const contentLength = clLine ? parseInt(clLine.split(":")[1].trim(), 10) : 0;

  let body = rest;

  const tryIntercept = () => {
    if (body.length < contentLength) return; // need more data

    client.removeListener("data", bodyListener);

    let bodyObj: any;
    try {
      bodyObj = JSON.parse(body.slice(0, contentLength).toString("utf-8"));
    } catch {
      // Unparseable — forward as-is
      upstream.write(Buffer.from(headerLines.join("\r\n") + "\r\n\r\n"));
      upstream.write(body.slice(0, contentLength));
      const extra = body.slice(contentLength);
      onDone(extra.length ? extra : undefined);
      return;
    }

    // Reject escape-prone container configs (privileged, host namespaces,
    // capability/device passthrough, docker-socket and host-path mounts, …).
    const verdict = validateHostConfig(bodyObj);
    if (!verdict.allowed) {
      denyRequest(client, upstream, 403, `${verdict.reason} in the Vivi sandbox`);
      return;
    }

    // Inject session label
    bodyObj.Labels = { ...(bodyObj.Labels ?? {}), [SESSION_LABEL]: sessionId };

    const newBodyBuf = Buffer.from(JSON.stringify(bodyObj));
    const newHeaderSection = headerLines
      .map((l) => (/^content-length:/i.test(l) ? `Content-Length: ${newBodyBuf.length}` : l))
      .join("\r\n") + "\r\n\r\n";

    upstream.write(newHeaderSection);
    upstream.write(newBodyBuf);

    const extra = body.slice(contentLength);
    onDone(extra.length ? extra : undefined);
  };

  const bodyListener = (chunk: Buffer) => {
    body = Buffer.concat([body, chunk]);
    tryIntercept();
  };

  client.on("data", bodyListener);
  tryIntercept();
}

/**
 * Forward a request targeting a specific container only if that container
 * belongs to this session. Buffers incoming bytes during the async ownership
 * check so no body data is lost, then either forwards header+body or rejects.
 */
function handleContainerScoped(
  client: net.Socket,
  upstream: net.Socket,
  onDone: (leftover?: Buffer) => void,
  headerLines: string[],
  rest: Buffer,
  sessionId: string,
  containerId: string,
): void {
  // No data listener is attached right now (the header listener removed itself),
  // so buffer anything that arrives while we await the ownership lookup.
  let buffered = rest;
  const buffering = (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); };
  client.on("data", buffering);

  lookupContainerSession(containerId)
    .then((owner) => {
      client.removeListener("data", buffering);

      if (owner !== sessionId) {
        denyRequest(client, upstream, 403,
          "container does not belong to this session (or does not exist)");
        return;
      }

      // Owned — forward the original headers unchanged.
      upstream.write(Buffer.from(headerLines.join("\r\n") + "\r\n\r\n"));

      const isChunked = headerLines.some((l) => /^transfer-encoding:\s*chunked/i.test(l));
      if (isChunked) {
        // Body length is unknown; forward what we have and raw-pipe the rest of
        // this connection. Safe: every byte belongs to an owned container.
        if (buffered.length) upstream.write(buffered);
        client.on("data", (c: Buffer) => { upstream.write(c); });
        return;
      }

      const clLine = headerLines.find((l) => /^content-length:/i.test(l));
      const contentLength = clLine ? parseInt(clLine.split(":")[1].trim(), 10) : 0;
      if (contentLength === 0) {
        onDone(buffered.length ? buffered : undefined);
      } else {
        forwardBodyThenListen(client, upstream, buffered, contentLength, onDone);
      }
    })
    .catch(() => {
      client.removeListener("data", buffering);
      denyRequest(client, upstream, 502, "ownership check failed");
    });
}

function injectLabelFilter(urlPath: string, label: string): string {
  const qIdx = urlPath.indexOf("?");
  const base = qIdx === -1 ? urlPath : urlPath.slice(0, qIdx);
  const qs = qIdx === -1 ? "" : urlPath.slice(qIdx + 1);

  const params = new URLSearchParams(qs);
  let filters: Record<string, string[]> = {};
  const existing = params.get("filters");
  if (existing) {
    try { filters = JSON.parse(decodeURIComponent(existing)); } catch (err: any) {
      console.warn(`[docker-proxy] Failed to parse existing filters: ${err.message}`);
    }
  }
  // Docker clients serialize filter values inconsistently:
  // CLI/SDK uses arrays ["val"], compose uses objects {"val": true}.
  // Normalize all values to arrays before mutating.
  for (const key of Object.keys(filters)) {
    const v = filters[key];
    if (Array.isArray(v)) continue;
    if (v && typeof v === "object") filters[key] = Object.keys(v);
    else if (v != null) filters[key] = [String(v)];
  }
  filters.label = [...(filters.label ?? []), label];
  params.set("filters", JSON.stringify(filters));

  return `${base}?${params.toString()}`;
}
