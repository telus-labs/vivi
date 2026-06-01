# Infrastructure limitations & isolation boundaries

Vivi isolates the **sandbox container** strongly: it sits on an internal Docker
network with no direct internet, all of its traffic is forced through the MITM
proxy, and secrets are injected at the proxy so the sandbox only ever sees
placeholders. This document records where that boundary stops, so operators can
reason about residual risk instead of inferring guarantees that don't hold.

## 1. DinD-launched containers are *not* behind the proxy or allowlist

The agent can run `docker run …` inside the sandbox. Those containers are
created in the **shared DinD daemon**, which has its own NAT bridge with
ordinary outbound internet — they do **not** inherit the sandbox's internal
network, `HTTP_PROXY`/`HTTPS_PROXY`, the allowlist, or TLS interception.

So while `curl https://example.com` *from the sandbox process* is allowlisted
and MITM'd, `docker run alpine wget https://example.com` *is not*. The proxy
host (`proxy:7443`) isn't even resolvable from inside a DinD container — they're
on different networks.

What we **do** enforce on DinD containers, via the per-session socket proxy
(`server/docker-namespace-proxy.ts`):

- **Session namespacing** — `docker ps` is scoped to the session's label; a
  session can't enumerate, inspect, exec into, stop, or delete another session's
  containers (ownership is verified per request).
- **Escape/escalation denial at create** — `--privileged`, `--cap-add`,
  `--device`, host namespaces (`--pid/network/ipc/uts/userns/cgroupns=host`),
  unconfined seccomp/apparmor, and bind mounts of the docker socket or sensitive
  host paths (`/`, `/etc`, `/proc`, `/sys`, `/var/run`, `/var/lib/docker`, …) are
  rejected. See `validateHostConfig`.

What we **do not** control: egress from DinD containers, and the **shared image
cache / volumes / networks** in the single DinD daemon (not namespaced per
session — knowing a name is enough to touch them).

**If you need DinD egress controlled**, the proper fix is network-level: run the
DinD daemon on a restricted network and force its container traffic through the
proxy (or an egress firewall). That is a deliberate, larger change and is not
implemented today — treat DinD-launched containers as having open internet.

## 2. The DinD daemon is shared across all sessions

There is one `docker:dind` service and one `dind-storage` volume for every
session. Consequences:

- No per-session disk quota — one session can fill the shared volume.
- The image layer cache is shared (a feature for speed, but not isolation).
- Agent-created volumes/networks live in a flat namespace.

Per-session DinD daemons would fix this but multiply resource cost; it's a
known trade-off, not an oversight.

## 3. CA rotation is restart-time, not hot

The proxy regenerates its CA when missing or within 30 days of expiry, at
container start (`docker/proxy-entrypoint.sh`). A CA rotation only takes effect
for sandboxes that (re)start afterward and re-copy the CA — long-running
sandboxes created before a rotation would need a restart to trust the new CA.
With 10-year validity, rotation is rare in practice.

## 4. macOS bind-mount (TCC) restrictions

On macOS, the container runtime can be blocked from reading TCC-protected
folders (Documents/Desktop/Downloads). Vivi pre-flights this and returns an
actionable error, but the staging directory must live somewhere the runtime can
read. See `checkBindMountAccess` in `server/container.ts`.
