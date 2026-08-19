#!/bin/bash
set -euo pipefail

if [ -f /etc/sandbox-secrets ]; then
  # shellcheck disable=SC1091
  . /etc/sandbox-secrets
fi

agent="${1:-${VIVI_AGENT:-claude}}"
prompt="${VIVI_INITIAL_PROMPT:-}"

case "$agent" in
  claude)
    args=(--dangerously-skip-permissions)
    [ -n "$prompt" ] && args+=("$prompt")
    exec claude "${args[@]}"
    ;;
  codex)
    # Prefer host-managed ChatGPT auth; retain API-key auth as a fallback.
    if codex login status >/dev/null 2>&1; then
      :
    elif [ -n "${OPENAI_API_KEY:-}" ]; then
      # Persist only Vivi's dummy placeholder; the proxy retains the real key.
      printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null
    fi
    args=(--dangerously-bypass-approvals-and-sandbox --no-alt-screen)
    [ -n "$prompt" ] && args+=("$prompt")
    exec codex "${args[@]}"
    ;;
  *)
    echo "Unsupported Vivi agent: $agent" >&2
    exit 64
    ;;
esac
