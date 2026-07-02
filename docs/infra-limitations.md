# Infrastructure limitations & residual risk

Vivi runs untrusted AI coding agents in Docker sandboxes. The [security
model](architecture.md#security-model) describes the boundaries that are
enforced. This document is the honest counterpart: what those boundaries do
**not** cover, so operators can decide how to deploy.

## Control-plane exposure

The Express + WebSocket control plane does **not** authenticate operator
(browser) requests. It is protected by:

- **Bind address** — defaults to loopback (`127.0.0.1`). It binds `0.0.0.0`
  only when `HOST` is set to a hostname, which is an explicit "expose me"
  choice.
- **CORS + WS origin checks** — a drive-by website cannot read API responses or
  open the terminal/monitor/docker WebSockets cross-origin.

**Limitation:** once bound to `0.0.0.0`, any non-browser client on the network
(CORS does not constrain non-browsers) can drive the full API — start sessions,
open sandbox shells, trigger the self-updater. **If you expose Vivi beyond
loopback, put it behind an authenticating reverse proxy / tunnel** (e.g. the
documented Cloudflare Tunnel setup). Do not expose it directly on an untrusted
network.

The sandbox→host path *is* authenticated: the proxy's `vivi.internal` route is
restricted to `/api/sandbox/*` and (when `VIVI_INTERNAL_TOKEN` is set) carries a
shared secret the sandbox never holds, so a compromised agent cannot reach the
credential, secrets, allowlist, git-policy, or updater endpoints.

## DinD / nested containers

A single **privileged** Docker-in-Docker daemon is shared across all sessions.

- **Per-session namespacing** of *containers* and *exec* is enforced by the
  namespace proxy (default-deny classification, ownership checks). But the
  **image cache, volumes, and networks are shared** across sessions with no
  per-session quota — one session can see/evict another's cached images and
  create unbounded volumes/networks.
- **`/containers/prune` and `/commit`** reference targets by filter/query rather
  than path, so they are not per-session ownership-checked (a cross-session
  availability/read concern, not a host escape).
- **Kernel isolation:** because the DinD daemon is privileged and shares the
  host kernel, a genuine *kernel-level* container escape from a nested container
  would reach the host kernel. The namespace proxy blocks the reachable
  create-time escalation vectors (`--privileged`, dangerous caps/mounts/host
  namespaces), but this is defense-in-depth, not a hard VM/userns boundary. On
  macOS the "host" is the Docker VM (OrbStack/Colima/Docker Desktop), not the
  Mac itself; on Linux this is the standard DinD trade-off.

If a hard boundary against kernel-level escape is required, run the DinD layer
under a user-namespaced runtime (e.g. sysbox on Linux) or rootless DinD — see
the discussion in the repo history. These add host/runtime dependencies and are
not the default.

## What is enforced

For the controls that *are* in place (git bundle ingestion, MITM egress
allowlist, credential injection, nested-egress lockdown, injection/traversal
guards), see [architecture.md](architecture.md#security-model).
