# Infrastructure limitations & residual risk

Vivi runs untrusted AI coding agents in Docker sandboxes. The [security
model](architecture.md#security-model) describes the boundaries that are
enforced. This document is the honest counterpart: what those boundaries do
**not** cover, so operators can decide how to deploy.

## Control-plane exposure

The Express + WebSocket control plane supports HTTP Basic operator
authentication when `VIVI_OPERATOR_PASSWORD` is set. The release CLI creates
and persists a strong password automatically. Authentication covers REST,
terminal/monitor/container WebSockets, and forwarded application ports.

It is also protected by:

- **Published bind address** — release Compose publishes to loopback by
  default. Set `APP_BIND_ADDRESS` to one specific private/VPN address when
  remote access is required.
- **CORS + WS origin checks** — a drive-by website cannot read API responses or
  open the terminal/monitor/docker WebSockets cross-origin.

**Limitation:** authentication is opt-in when running directly from source; an
unset `VIVI_OPERATOR_PASSWORD` preserves the local developer workflow. CORS
does not constrain non-browser clients. Never publish an unauthenticated source
deployment beyond loopback, and keep an interface-specific firewall rule even
when operator authentication is enabled.

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
