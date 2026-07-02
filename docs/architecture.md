# Architecture

## Overview

```
You (browser) ──── REST + WebSocket ────► Vivi server (Express, port 7700)
                                              │
                                              │ docker run / exec
                                              ▼
                                   ┌─── Docker network (internal) ───┐
                                   │                                  │
                                   │  Sandbox container(s)            │
                                   │  • Claude Code (no permissions)  │
                                   │  • git + gh + Docker CLI         │
                                   │  • git daemon for push/pull      │
                                   │                                  │
                                   │  MITM Proxy ◄─ all egress        │
                                   │  • injects API keys              │
                                   │  • intercepts git push           │
                                   │  • enforces allowlist            │
                                   │        ▲                         │
                                   │  DinD daemon (shared) ───────────┘
                                   │  • per-session socket proxies    │
                                   │  • egress firewall → proxy relay │
                                   └──────────────────────────────────┘
```

> Both the sandbox process **and** containers it launches in DinD egress through
> the MITM proxy: DinD drops direct public traffic and forwards a relay to the
> proxy, and the per-session socket proxy injects the proxy env into every nested
> container. The shared DinD image cache and agent-created volumes/networks are
> not namespaced per session.

## Components

### Vivi server (`server/`)

Express + WebSocket server running on the host. Manages container lifecycle, bridges terminals, handles PR approval, and serves the React UI.

| Module | Role |
|--------|------|
| `index.ts` | REST + WebSocket routes, rate limiting, graceful shutdown |
| `container.ts` | Multi-session lifecycle — `docker run`, git bundle, session restore |
| `pty.ts` | WebSocket PTY bridge, persistent Claude sessions that survive tab switches |
| `pr.ts` | PR interception, approval workflow, git bundle extraction |
| `ports.ts` | TCP port forwarding via `docker exec` + socat |
| `secrets.ts` | Secret store (SQLite) + proxy config sync |
| `allowlist.ts` | Network allowlist management |
| `docker-namespace-proxy.ts` | Per-session Docker socket proxy (prevents namespace escape) |
| `docker-events.ts` | Event-driven container state tracking (replaces polling) |
| `monitor.ts` | Activity monitor for agent health tracking |
| `profiles.ts` | Named Claude profile management (`~/.claude` persistence) |
| `github-issues.ts` | GitHub Issues integration |
| `sandbox-images.ts` | Sandbox image registry (CRUD + validation) |
| `updater.ts` | Git-based auto-update detection |
| `auth.ts` | OAuth token capture |
| `db.ts` | SQLite setup |
| `migrate.ts` | Migration runner |

### Frontend (`src/`)

React + Vite SPA with a multi-tab session interface.

| Component | Role |
|-----------|------|
| `App.tsx` | Session management, tab routing, panel layout |
| `Terminal.tsx` | ghostty-web WASM terminal emulator |
| `Approvals.tsx` | Branch approval sidebar (pull local / create PR) |
| `PortForwards.tsx` | Port forwarding panel |
| `SecretManager.tsx` | API key management + OAuth |
| `SandboxLogs.tsx` | Container log viewer |
| `Allowlist.tsx` | Network rules editor |
| `DockerContainers.tsx` | DinD container listing with live logs and inspect |
| `LiveDiffView.tsx` | Real-time working tree diff |
| `DiffView.tsx` | Branch diff viewer |
| `SandboxImages.tsx` | Sandbox image management |
| `ProfileManager.tsx` | Profile CRUD |
| `GitHubIssues.tsx` | Issue-to-session launcher |

### Docker infrastructure (`docker/`)

| File | Role |
|------|------|
| `proxy.ts` | MITM proxy — key injection, push interception, credential proxying |
| `Dockerfile.sandbox` | Sandbox image (Claude Code + git + gh + socat + Docker CLI) |
| `Dockerfile.proxy` | Proxy image |
| `entrypoint.sh` | Sandbox init (bundle clone, git config, CLAUDE.md, git daemon) |
| `open-port.sh` | Port forwarding request script |
| `open-git.sh` | Git server management |

### Orchestration

| File | Role |
|------|------|
| `docker-compose.yml` | Proxy + DinD daemon |
| `docker-compose.full.yml` | Full stack (app + proxy + DinD) for containerized deployment |

## Request flow

### Session start

1. User enters repo path + task description in UI
2. Server creates a git bundle of tracked files (`.env` and gitignored files excluded)
3. Server ensures proxy + DinD are running via docker-compose
4. Server starts a per-session Docker socket proxy
5. Server runs `docker run` with the sandbox image, mounting the bundle and proxy CA
6. Sandbox entrypoint clones from the bundle, configures git, starts git daemon
7. Server waits for readiness signal, then connects the browser terminal via WebSocket PTY

### API key injection

1. User adds a secret in the UI (e.g., Anthropic API key)
2. Server stores the real key and generates a placeholder (`sk-sandbox-{id}`)
3. Placeholder is injected into the sandbox as an env var
4. When the sandbox makes an API request, the MITM proxy swaps the placeholder for the real key
5. The sandbox never sees or logs the real credential

### Git push / PR approval

1. Agent runs `git push origin my-branch` inside the sandbox
2. MITM proxy intercepts the GitHub API call
3. Proxy sends the branch metadata to the Vivi server
4. Server surfaces it in the UI as a pending approval
5. User reviews the diff and chooses: pull locally or create a GitHub PR
6. Server extracts changes via git bundle and executes the chosen action on the host

## Security model

| Layer | Enforcement |
|-------|-------------|
| Git bundle | Only tracked files enter the sandbox |
| Internal Docker network | Sandbox process has no direct internet access |
| MITM proxy | HTTPS inspected; allowlist enforced |
| Sandbox→host route lockdown | The proxy's `vivi.internal` route only forwards `/api/sandbox/*` (traversal/encoding-normalized); credential, secrets, allowlist, git-policy, and updater endpoints are unreachable from the sandbox |
| Internal API token | Proxy attaches `x-vivi-internal-token` (from `VIVI_INTERNAL_TOKEN`) to sandbox→host calls; the app enforces it on credential + `/api/sandbox/*` routes (constant-time compare). Set identically on the proxy and app services; the CLI generates and persists it automatically |
| Browser boundary | CORS restricted to same-origin + dev origins; WebSocket upgrades reject cross-origin |
| DinD egress lockdown | Nested containers' direct public egress is firewalled and forced through the proxy relay; the DinD daemon port is blocked on the container bridge (INPUT) and the cloud-metadata IP is dropped (`docker/dind-entrypoint.sh`) |
| Credential proxy | Real keys exist only in the proxy process |
| Docker namespace proxy | Default-deny request classification (unknown/unversioned paths rejected, not passed through), per-session ownership checks on containers **and** exec (versioned or not), chunked bodies framed + re-validated, create-time escape/escalation denial (`validateHostConfig`) |
| Rate limiting | `express-rate-limit` on expensive endpoints |
| Shell injection prevention | `execFileSync`/arg-array invocation; MITM cert hostnames, GitHub owner/repo, port-forward targets, and git refs validated before use |
| Path traversal prevention | `path.resolve()` + prefix validation on all file access |

The shared DinD daemon's image cache and agent-created volumes/networks are not
namespaced per session — a known trade-off of one DinD daemon for all sessions.

**Boundaries this does _not_ cover** (see [infra-limitations.md](infra-limitations.md)):
containers the agent launches in the shared DinD daemon have unproxied internet
egress; the DinD daemon, its image cache, and agent-created volumes/networks are
shared across sessions with no per-session quota.
