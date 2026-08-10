#!/bin/bash
# 00-base-setup.sh — Base sandbox setup: CA cert, git clone, git config,
# git hooks, profile load, user-level CLAUDE.md render, git daemon

echo "[00-base-setup] Starting base sandbox setup..."

# Export SESSION_ID so gh-wrapper and open-port scripts can use it
export SESSION_ID="${SESSION_ID:-}"

# Trust proxy's CA cert for TLS interception (runs as root)
if [ -f /proxy-ca/ca-cert.pem ]; then
  cp /proxy-ca/ca-cert.pem /usr/local/share/ca-certificates/proxy-ca.crt
  update-ca-certificates 2>/dev/null || true
  echo "[sandbox] Installed proxy CA certificate"
fi

# Clone repo from bundle if workspace is empty
if [ -f /staging/repo.bundle ] && [ ! -d /workspace/.git ]; then
  echo "[sandbox] Cloning repo from bundle..."
  git clone /staging/repo.bundle /workspace 2>&1
  echo "[sandbox] Clone complete"
fi

cd /workspace

echo "[00-base-setup] Configuring git..."
git config --global --add safe.directory /workspace
# Use host user identity if provided, otherwise fall back to sandbox defaults
git config user.name "${HOST_GIT_NAME:-Vivi Sandbox}"
git config user.email "${HOST_GIT_EMAIL:-sandbox@vivi.local}"

# Set remote URL for fetch support (if provided)
if [ -n "$GIT_REMOTE_URL" ] && [ -d .git ]; then
  git remote set-url origin "$GIT_REMOTE_URL" 2>/dev/null || \
    git remote add origin "$GIT_REMOTE_URL" 2>/dev/null || true
  echo "[sandbox] Remote origin set to $GIT_REMOTE_URL"
fi

# Inject session ID header into all git HTTP requests so the MITM proxy
# can identify which session is pushing when it intercepts git push.
if [ -n "$SESSION_ID" ]; then
  HOME=/home/agent git config --global http.extraheader "X-Vivi-Session: $SESSION_ID"
fi

# Detect the default branch (whatever HEAD was in the git bundle)
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

echo "[sandbox] Starting on $DEFAULT_BRANCH branch"

echo "[00-base-setup] Installing git hooks..."
if [ -d /workspace/.git ]; then
  mkdir -p /workspace/.git/hooks
  cat > /workspace/.git/hooks/prepare-commit-msg << 'HOOK'
#!/bin/sh
# Append the selected coding agent's co-author trailer if not already present.
COMMIT_MSG_FILE="$1"
if ! grep -q "Co-authored-by:" "$COMMIT_MSG_FILE" 2>/dev/null; then
  printf '\nCo-authored-by: %s <%s>\n' "${VIVI_AGENT_NAME:-Vivi Agent}" "${VIVI_AGENT_EMAIL:-noreply@vivi.local}" >> "$COMMIT_MSG_FILE"
fi
HOOK
  chmod +x /workspace/.git/hooks/prepare-commit-msg
  echo "[sandbox] Installed prepare-commit-msg hook for agent co-authorship"
fi

# Load the selected agent profile if one was mounted.
AGENT_CONFIG_DIR="/home/agent/.${VIVI_AGENT:-claude}"
if [ -d /agent-profile ] && [ "$(ls -A /agent-profile 2>/dev/null)" ]; then
  echo "[sandbox] Loading ${VIVI_AGENT:-claude} profile into ${AGENT_CONFIG_DIR}..."
  mkdir -p "$AGENT_CONFIG_DIR"
  if [ "${VIVI_AGENT:-claude}" = "codex" ]; then
    # Account credentials are managed globally by Vivi and mounted separately.
    tar -C /agent-profile --exclude='./auth.json' -cf - . | tar -C "$AGENT_CONFIG_DIR" -xf -
  else
    cp -rT /agent-profile "$AGENT_CONFIG_DIR"
  fi
  echo "[sandbox] Profile loaded"
fi

# Render Vivi sandbox instructions into the agent's user-level CLAUDE.md.
# Keeping this outside /workspace means it never appears in the user's repo
# diff/status. Appending preserves any CLAUDE.md that came from the profile.
if [ -f /opt/vivi/sandbox-CLAUDE.md ]; then
  case "${VIVI_AGENT:-claude}" in
    codex) INSTRUCTIONS_FILE="/home/agent/.codex/AGENTS.md" ;;
    *) INSTRUCTIONS_FILE="/home/agent/.claude/CLAUDE.md" ;;
  esac
  mkdir -p "$(dirname "$INSTRUCTIONS_FILE")"
  if ! grep -q "running in a sandboxed Vivi environment" "$INSTRUCTIONS_FILE" 2>/dev/null; then
    if [ -s "$INSTRUCTIONS_FILE" ]; then
      printf '\n\n' >> "$INSTRUCTIONS_FILE"
    fi
    sed "s|__DEFAULT_BRANCH__|${DEFAULT_BRANCH}|g" /opt/vivi/sandbox-CLAUDE.md \
      >> "$INSTRUCTIONS_FILE"
  fi
  echo "[sandbox] Rendered sandbox instructions to ${INSTRUCTIONS_FILE}"
fi

echo "[00-base-setup] Configuring secrets auto-sourcing..."
cat >> /home/agent/.bashrc << 'BASHRC_SECRETS'
# Source sandbox secrets if available (hot-updated by Vivi host)
if [ -f /etc/sandbox-secrets ]; then
  . /etc/sandbox-secrets
fi

# Wrapper function for request-secret so env vars are set in the current shell.
# The script polls until the secret appears, then we source the file here.
request-secret() {
  /usr/local/bin/request-secret "$@"
  local rc=$?
  # Re-source secrets in case they were updated while polling
  if [ -f /etc/sandbox-secrets ]; then
    . /etc/sandbox-secrets
  fi
  return $rc
}
BASHRC_SECRETS

echo "[00-base-setup] Fixing file ownership..."
chown -R agent:agent /workspace /home/agent/.claude /home/agent/.claude.json /home/agent/.codex 2>/dev/null || true

# Allow agent user to access the Docker socket (mounted from per-session proxy)
chmod 666 /var/run/docker.sock 2>/dev/null || true

echo "[00-base-setup] Starting git daemon..."
if [ -d /workspace/.git ]; then
  gosu agent git daemon \
    --reuseaddr \
    --base-path=/workspace \
    --export-all \
    --enable=receive-pack \
    --listen=0.0.0.0 \
    --port=9418 \
    /workspace &
  echo "[sandbox] Git daemon started on port 9418"

  # Register the git server port with open-port (background — non-blocking)
  (sleep 1 && open-port --label "Git Server" --type git 9418) &
fi

echo "[00-base-setup] Base sandbox setup complete"
