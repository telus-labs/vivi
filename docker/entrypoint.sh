#!/bin/bash
# Intentionally NOT `set -e`: drop-ins are sourced into this shell, so under
# errexit a single non-zero line (e.g. an optional cp/chown) would abort boot
# before /tmp/.sandbox-ready is created — leaving the container to time out with
# no shell to debug from. We log drop-in failures and keep going instead.

echo "[entrypoint] Running drop-in init scripts..."

# Run all drop-in init scripts in order
for f in /docker-entrypoint.d/*.sh; do
  if [ -x "$f" ]; then
    echo "[entrypoint] Running $(basename "$f")..."
    if source "$f"; then
      echo "[entrypoint] Finished $(basename "$f")"
    else
      echo "[entrypoint] WARNING: $(basename "$f") exited $? — continuing so the sandbox still boots"
    fi
  fi
done

echo "[entrypoint] All init scripts complete"

# Signal that setup is complete
touch /tmp/.sandbox-ready
echo "[entrypoint] Sandbox ready"

# Drop to the unprivileged agent user and keep the sandbox service alive.
# The persistent browser PTY launches the selected agent and supplies the
# initial prompt. Keeping PID 1 idle makes its output reconnectable.
exec gosu agent "$@"
